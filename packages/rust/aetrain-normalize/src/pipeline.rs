use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
};

use aetrain_dataset::{
    DatasetBundle, DatasetMeta, EdgeGeometryArtifact, EdgeGeometryRecord, EdgeGeometrySource,
    PolylinePointE5, RuntimeAliasIndex, RuntimeAliasRecord, RuntimeCountryRecord,
    RuntimeDatasetBundle, RuntimeDatasetMeta, RuntimeEdgeGeometryArtifact,
    RuntimeEdgeGeometryRecord, RuntimeGraph, RuntimeStationArtifact, RuntimeStationRecord,
    SourceSnapshot,
};
use aetrain_domain::{City, GeoPoint, ServiceClass, ServiceKind};
use aetrain_registry::RegistryCanonicalBundle;
use anyhow::{Context, Result, bail};
use deunicode::deunicode;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    DuplicateCityReport, FetchedSource, GeometryAuthorityLoader, GeometryAuthorityRegistry,
    GeometryAuthorityRoutePolicyAction, GeometryAuthorityStatus, ManualOverrideRegistry,
    NormalizationIssue, SourceKind, SourceManifest, StationMappingReport, TargetDefinition,
    build_gtfs_basic_dataset, build_sncf_dataset, bundle_from_basic_output, bundle_from_output,
    rail_geometry::RailGeometryNetwork,
};

pub trait PipelineAdapter {
    fn adapter_id(&self) -> &'static str;
    fn build(&self, request: AdapterBuildRequest<'_>) -> Result<AdapterBuildArtifacts>;
}

#[derive(Clone, Copy)]
struct SncfAdapter;

#[derive(Clone, Copy)]
struct GtfsBasicAdapter;

#[derive(Clone, Copy)]
struct AggregateBundleAdapter;

#[derive(Clone)]
pub struct AdapterBuildRequest<'a> {
    pub manifest: &'a SourceManifest,
    pub manifest_dir: &'a Path,
    pub target: &'a TargetDefinition,
    pub sources: Vec<&'a FetchedSource>,
    pub output_root: &'a Path,
    pub dataset_version: &'a str,
    pub generated_at: &'a str,
    pub source_snapshots: Vec<SourceSnapshot>,
    pub overrides: &'a ManualOverrideRegistry,
}

impl<'a> AdapterBuildRequest<'a> {
    pub fn source_by_kind(&self, kind: SourceKind) -> Result<&'a FetchedSource> {
        self.sources
            .iter()
            .copied()
            .find(|source| source.definition.kind == kind)
            .with_context(|| format!("target {} is missing a {:?} source", self.target.id, kind))
    }

    pub fn source_by_role(&self, role: &str) -> Result<&'a FetchedSource> {
        self.sources
            .iter()
            .copied()
            .find(|source| source.definition.role.as_deref() == Some(role))
            .with_context(|| format!("target {} is missing a {role} source", self.target.id))
    }

    pub fn source_by_role_or_kind(
        &self,
        role: &str,
        kind: SourceKind,
    ) -> Result<&'a FetchedSource> {
        self.source_by_role(role)
            .or_else(|_| self.source_by_kind(kind))
    }

    pub fn optional_source_by_role(&self, role: &str) -> Option<&'a FetchedSource> {
        self.sources
            .iter()
            .copied()
            .find(|source| source.definition.role.as_deref() == Some(role))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AdapterBuildArtifacts {
    pub canonical: DatasetBundle,
    pub edge_geometries: Option<EdgeGeometryArtifact>,
    pub station_mappings: Option<StationMappingReport>,
    pub rejected_city_candidates: Option<crate::RejectedCityCandidateReport>,
    pub quarantined_fallback_gap_cities: Vec<PipelineQuarantinedFallbackGapCityRecord>,
    pub quarantined_promoted_attachment_gap_cities:
        Vec<PipelineQuarantinedPromotedAttachmentGapCityRecord>,
    pub duplicates: DuplicateCityReport,
    pub issues: Vec<NormalizationIssue>,
    pub counters: BTreeMap<String, u64>,
    pub notes: Vec<String>,
    pub source_artifacts: Vec<PipelineSourceArtifact>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineBuildSummary {
    pub city_count: usize,
    pub station_count: usize,
    pub edge_count: usize,
    pub alias_count: usize,
    pub duplicate_count: usize,
    pub issue_count: usize,
    pub counters: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineQualityGateResult {
    pub gate_id: String,
    pub metric: String,
    pub actual: u64,
    pub target: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineRegistryMatchReport {
    pub authoritative_city_count: usize,
    pub cities_with_wikidata_qid: usize,
    pub cities_with_population: usize,
    pub matched_count: u64,
    pub unmatched_count: u64,
    pub ambiguous_count: u64,
    pub country_correction_count: u64,
    pub station_rescue_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineCountryQualityRecord {
    pub country_code: String,
    pub city_count: usize,
    pub station_like_city_count: usize,
    pub zz_city_count: usize,
    pub wikidata_city_count: usize,
    pub population_city_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineCityQualityRecord {
    pub city_id: aetrain_domain::CityId,
    pub display_name: String,
    pub country_code: String,
    pub station_count: usize,
    pub wikidata_qid: Option<String>,
    pub population: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineAbbreviationCandidateRecord {
    pub city_id: aetrain_domain::CityId,
    pub display_name: String,
    pub country_code: String,
    pub normalized_name: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineRouteLikeResidualRecord {
    pub city_id: aetrain_domain::CityId,
    pub display_name: String,
    pub country_code: String,
    pub normalized_name: String,
    pub mapping_strategy: Option<String>,
    pub classification: String,
    pub suggested_action: String,
    pub derived_parent_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineRouteGeometryQualityRecord {
    pub from_city_id: aetrain_domain::CityId,
    pub from_display_name: String,
    pub from_country_code: String,
    pub to_city_id: aetrain_domain::CityId,
    pub to_display_name: String,
    pub to_country_code: String,
    pub duration_min: Option<u32>,
    pub geometry_source: EdgeGeometrySource,
    pub point_count: usize,
    pub geometry_resolution_status: String,
    pub provenance: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineRouteGeometryAnomalyRecord {
    pub from_city_id: aetrain_domain::CityId,
    pub from_display_name: String,
    pub to_city_id: aetrain_domain::CityId,
    pub to_display_name: String,
    pub from_country_code: String,
    pub to_country_code: String,
    pub duration_min: Option<u32>,
    pub geometry_source: EdgeGeometrySource,
    pub geometry_distance_km: u32,
    pub direct_distance_km: u32,
    pub detour_ratio_x100: Option<u32>,
    pub implied_speed_kmh: Option<u32>,
    pub anomaly_type: String,
    pub geometry_resolution_status: String,
    pub provenance: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineDomesticGeometryBacklogRecord {
    pub country_code: String,
    pub route_count: usize,
    pub example_routes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineCrossBorderGeometryBacklogRecord {
    pub corridor_id: String,
    pub from_country_code: String,
    pub to_country_code: String,
    pub route_count: usize,
    pub example_routes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineCountryGeometryAuthorityRecord {
    pub country_code: String,
    pub status: String,
    pub promoted: bool,
    pub source_id: Option<String>,
    pub missing_domestic_authority_count: u64,
    pub promoted_station_attachment_gap_count: u64,
    pub promoted_topology_no_route_gap_count: u64,
    pub promoted_rejected_implausible_authority_detour_count: u64,
    pub max_promoted_station_attachment_gap_count: Option<u64>,
    pub max_promoted_topology_no_route_gap_count: Option<u64>,
    pub max_promoted_rejected_implausible_authority_detour_count: Option<u64>,
    pub rejected_rail_authority_count: u64,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineCorridorGeometryAuthorityRecord {
    pub corridor_id: String,
    pub from_country_code: String,
    pub to_country_code: String,
    pub status: String,
    pub promoted: bool,
    pub source_id: Option<String>,
    pub cross_border_unresolved_count: u64,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineRailAuthorityDefectRecord {
    pub source_id: String,
    pub from_city_id: aetrain_domain::CityId,
    pub from_display_name: String,
    pub from_country_code: String,
    pub to_city_id: aetrain_domain::CityId,
    pub to_display_name: String,
    pub to_country_code: String,
    pub direct_distance_km: u32,
    pub geometry_distance_km: u32,
    pub detour_ratio_x100: Option<u32>,
    pub implied_speed_kmh: Option<u32>,
    pub start_snap_distance_m: Option<u32>,
    pub end_snap_distance_m: Option<u32>,
    pub route_found_in_authority_graph: bool,
    pub authority_defect_reason: String,
    pub routed_authority_distance_km: Option<u32>,
    pub routed_authority_point_count: Option<usize>,
    pub provenance: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineShapePlausibilityDefectRecord {
    pub source_id: Option<String>,
    pub from_city_id: aetrain_domain::CityId,
    pub from_display_name: String,
    pub from_country_code: String,
    pub to_city_id: aetrain_domain::CityId,
    pub to_display_name: String,
    pub to_country_code: String,
    pub duration_min: Option<u32>,
    pub direct_distance_km: u32,
    pub geometry_distance_km: u32,
    pub detour_ratio_x100: Option<u32>,
    pub implied_speed_kmh: Option<u32>,
    pub provenance: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelinePromotedDomesticAuthorityGapRecord {
    pub source_id: String,
    pub country_code: String,
    pub from_city_id: aetrain_domain::CityId,
    pub from_display_name: String,
    pub to_city_id: aetrain_domain::CityId,
    pub to_display_name: String,
    pub direct_distance_km: u32,
    pub duration_min: Option<u32>,
    pub start_snap_distance_m: Option<u32>,
    pub end_snap_distance_m: Option<u32>,
    pub route_found_in_authority_graph: bool,
    pub routed_authority_distance_km: Option<u32>,
    pub routed_authority_point_count: Option<usize>,
    pub routed_authority_detour_ratio_x100: Option<u32>,
    pub routed_authority_implied_speed_kmh: Option<u32>,
    pub authority_gap_reason: String,
    pub provenance: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineStationAttachmentAuditRecord {
    pub source_id: String,
    pub country_code: String,
    pub from_city_id: aetrain_domain::CityId,
    pub from_display_name: String,
    pub to_city_id: aetrain_domain::CityId,
    pub to_display_name: String,
    pub direct_distance_km: u32,
    pub duration_min: Option<u32>,
    pub from_local_candidate_distances_m: Vec<u32>,
    pub to_local_candidate_distances_m: Vec<u32>,
    pub from_expanded_candidate_distances_m: Vec<u32>,
    pub to_expanded_candidate_distances_m: Vec<u32>,
    pub provenance: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineAuthorityDetourCorridorRecord {
    pub source_id: String,
    pub from_country_code: String,
    pub to_country_code: String,
    pub corridor_key: String,
    pub route_count: u64,
    pub example_routes: Vec<String>,
    pub min_direct_distance_km: u32,
    pub max_direct_distance_km: u32,
    pub min_routed_authority_distance_km: u32,
    pub max_routed_authority_distance_km: u32,
    pub min_detour_ratio_x100: u32,
    pub max_detour_ratio_x100: u32,
    pub max_snap_distance_m: u32,
    pub recommended_policy: String,
    pub policy_reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineQuarantinedFallbackGapCityRecord {
    pub city_id: aetrain_domain::CityId,
    pub display_name: String,
    pub country_code: String,
    pub station_display_names: Vec<String>,
    pub classification: String,
    pub suggested_action: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineQuarantinedPromotedAttachmentGapCityRecord {
    pub city_id: aetrain_domain::CityId,
    pub display_name: String,
    pub country_code: String,
    pub station_display_names: Vec<String>,
    pub source_id: String,
    pub local_candidate_distances_m: Vec<u32>,
    pub expanded_candidate_distances_m: Vec<u32>,
    pub classification: String,
    pub suggested_action: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineQualityReport {
    pub gate_results: Vec<PipelineQualityGateResult>,
    pub registry_match_report: PipelineRegistryMatchReport,
    pub country_quality: Vec<PipelineCountryQualityRecord>,
    pub station_like_cities: Vec<PipelineCityQualityRecord>,
    pub zz_cities: Vec<PipelineCityQualityRecord>,
    pub abbreviation_candidates: Vec<PipelineAbbreviationCandidateRecord>,
    pub route_like_candidates: Vec<PipelineAbbreviationCandidateRecord>,
    pub route_like_residuals: Vec<PipelineRouteLikeResidualRecord>,
    pub non_railway_route_geometries: Vec<PipelineRouteGeometryQualityRecord>,
    pub route_geometry_anomalies: Vec<PipelineRouteGeometryAnomalyRecord>,
    pub domestic_geometry_backlog_by_country: Vec<PipelineDomesticGeometryBacklogRecord>,
    pub cross_border_geometry_backlog_by_corridor: Vec<PipelineCrossBorderGeometryBacklogRecord>,
    pub rejected_rail_authority_routes: Vec<PipelineRouteGeometryAnomalyRecord>,
    pub rejected_shape_plausibility_routes: Vec<PipelineRouteGeometryAnomalyRecord>,
    pub foreign_cross_border_leakage_routes: Vec<PipelineRouteGeometryAnomalyRecord>,
    pub impossible_edge_speed_routes: Vec<PipelineRouteGeometryAnomalyRecord>,
    pub country_geometry_authorities: Vec<PipelineCountryGeometryAuthorityRecord>,
    pub corridor_geometry_authorities: Vec<PipelineCorridorGeometryAuthorityRecord>,
    pub rail_authority_defect_details: Vec<PipelineRailAuthorityDefectRecord>,
    pub shape_plausibility_defect_details: Vec<PipelineShapePlausibilityDefectRecord>,
    pub promoted_domestic_authority_gap_details: Vec<PipelinePromotedDomesticAuthorityGapRecord>,
    pub promoted_station_attachment_gap_details: Vec<PipelineStationAttachmentAuditRecord>,
    pub authority_detour_corridors: Vec<PipelineAuthorityDetourCorridorRecord>,
    pub quarantined_fallback_gap_cities: Vec<PipelineQuarantinedFallbackGapCityRecord>,
    pub quarantined_promoted_attachment_gap_cities:
        Vec<PipelineQuarantinedPromotedAttachmentGapCityRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineSourceArtifact {
    pub source_id: String,
    pub local_path: String,
    pub fetched_at: String,
    pub sha256: String,
    pub version_hint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineOutputPaths {
    pub target_root: String,
    pub canonical_dir: Option<String>,
    pub web_dir: Option<String>,
    pub web_debug_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineArtifactManifest {
    pub dataset_id: String,
    pub target_id: String,
    pub adapter: String,
    pub dataset_version: String,
    pub generated_at: String,
    pub source_snapshots: Vec<SourceSnapshot>,
    pub source_artifacts: Vec<PipelineSourceArtifact>,
    pub outputs: PipelineOutputPaths,
    pub summary: PipelineBuildSummary,
    pub notes: Vec<String>,
}

const QUALITY_GATE_MAX_RESIDUAL_STATION_LIKE_CITIES: u64 = 100;
const QUALITY_GATE_MAX_RESIDUAL_ZZ_CITIES: u64 = 250;
const QUALITY_GATE_MAX_UNRESOLVED_ROUTE_LIKE_CITIES: u64 = 10;
const INVALID_RAILWAY_GEOMETRY_REJECTED_PROVENANCE: &str = "geometry:invalid-railway-path-rejected";
const INVALID_GTFS_SHAPE_GEOMETRY_REJECTED_PROVENANCE: &str =
    "geometry:invalid-gtfs-shape-rejected";
const REJECTED_RAIL_METRICS_PROVENANCE_PREFIX: &str = "geometry:rejected-rail-metrics:";
const REJECTED_SHAPE_METRICS_PROVENANCE_PREFIX: &str = "geometry:rejected-shape-metrics:";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineAttributionFile {
    pub dataset_id: String,
    pub target_id: String,
    pub dataset_version: String,
    pub generated_at: String,
    pub sources: Vec<PipelineSourceArtifact>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct ChunkedEdgeGeometryManifest {
    pub version: u8,
    pub total_geometry_count: usize,
    pub chunk_target_bytes: usize,
    pub chunks: Vec<ChunkedEdgeGeometryManifestChunk>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct ChunkedEdgeGeometryManifestChunk {
    pub file: String,
    pub geometry_count: usize,
}

const WEB_DEBUG_EDGE_GEOMETRY_CHUNK_TARGET_BYTES: usize = 20 * 1024 * 1024;
const AGGREGATE_CITY_MERGE_DISTANCE_METERS: u32 = 20_000;
const ROUTE_LIKE_PARENT_MAX_DISTANCE_METERS: u32 = 5_000;

struct MergedCityOutput {
    cities: Vec<aetrain_domain::City>,
    aliases: Vec<aetrain_dataset::AliasRecord>,
    city_id_remap: BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
    issues: Vec<NormalizationIssue>,
    route_like_demotion_stats: RouteLikeDemotionStats,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct RegistryOverlayStats {
    matched_count: u64,
    unmatched_count: u64,
    ambiguous_count: u64,
    country_corrected_count: u64,
    station_promoted_count: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct RouteLikeDemotionStats {
    demoted_count: u64,
    unresolved_count: u64,
    ambiguous_count: u64,
}

#[allow(clippy::too_many_arguments)] // Public API consumed by aetrain-pipeline.
pub fn build_pipeline_target(
    manifest: &SourceManifest,
    manifest_dir: &Path,
    target: &TargetDefinition,
    fetched_sources: &[FetchedSource],
    overrides: &ManualOverrideRegistry,
    output_root: &Path,
    dataset_version: &str,
    generated_at: &str,
) -> Result<PipelineArtifactManifest> {
    let source_map = fetched_sources
        .iter()
        .map(|source| (source.definition.id.clone(), source))
        .collect::<HashMap<_, _>>();
    let sources = target
        .source_ids
        .iter()
        .map(|source_id| {
            source_map.get(source_id).copied().with_context(|| {
                format!(
                    "target {} references missing source {}",
                    target.id, source_id
                )
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let source_snapshots = sources
        .iter()
        .map(|source| SourceSnapshot {
            source_id: source.definition.id.clone(),
            fetched_at: source.fetched_at.clone(),
            version_hint: source
                .probe_version
                .clone()
                .or_else(|| source.etag.clone())
                .or_else(|| source.last_modified.clone()),
        })
        .collect::<Vec<_>>();

    let request = AdapterBuildRequest {
        manifest,
        manifest_dir,
        target,
        sources: sources.clone(),
        output_root,
        dataset_version,
        generated_at,
        source_snapshots: source_snapshots.clone(),
        overrides,
    };

    let adapter = adapter_for(&target.adapter)
        .with_context(|| format!("unsupported adapter {}", target.adapter))?;
    let artifacts = adapter.build(request)?;
    let source_snapshots = artifacts.canonical.meta.source_snapshots.clone();
    export_pipeline_target(ExportPipelineTargetRequest {
        manifest,
        manifest_dir,
        target,
        artifacts: &artifacts,
        sources: &sources,
        output_root,
        dataset_version,
        generated_at,
        source_snapshots,
    })
}

pub fn sync_web_debug_artifacts(
    artifact_manifest: &PipelineArtifactManifest,
    destination: &Path,
) -> Result<()> {
    let Some(source_dir) = artifact_manifest.outputs.web_debug_dir.as_ref() else {
        bail!(
            "target {} does not export runtime/web-debug artifacts",
            artifact_manifest.target_id
        );
    };

    let source_dir = PathBuf::from(source_dir);
    recreate_dir(destination)?;
    copy_dir_contents(&source_dir, destination)?;

    Ok(())
}

struct ExportPipelineTargetRequest<'a> {
    manifest: &'a SourceManifest,
    manifest_dir: &'a Path,
    target: &'a TargetDefinition,
    artifacts: &'a AdapterBuildArtifacts,
    sources: &'a [&'a FetchedSource],
    output_root: &'a Path,
    dataset_version: &'a str,
    generated_at: &'a str,
    source_snapshots: Vec<SourceSnapshot>,
}

fn export_pipeline_target(
    request: ExportPipelineTargetRequest<'_>,
) -> Result<PipelineArtifactManifest> {
    let ExportPipelineTargetRequest {
        manifest,
        manifest_dir,
        target,
        artifacts,
        sources,
        output_root,
        dataset_version,
        generated_at,
        source_snapshots,
    } = request;
    let target_root = output_root.join(&target.id);
    fs::create_dir_all(&target_root)
        .with_context(|| format!("failed to create {}", target_root.display()))?;

    let source_artifacts = if artifacts.source_artifacts.is_empty() {
        sources
            .iter()
            .map(|source| PipelineSourceArtifact {
                source_id: source.definition.id.clone(),
                local_path: source_artifact_local_path_for_export(&source.local_path, &target_root),
                fetched_at: source.fetched_at.clone(),
                sha256: source.sha256.clone(),
                version_hint: source
                    .probe_version
                    .clone()
                    .or_else(|| source.etag.clone())
                    .or_else(|| source.last_modified.clone()),
            })
            .collect::<Vec<_>>()
    } else {
        artifacts.source_artifacts.clone()
    };

    let attribution = PipelineAttributionFile {
        dataset_id: manifest.dataset_id.clone(),
        target_id: target.id.clone(),
        dataset_version: dataset_version.to_string(),
        generated_at: generated_at.to_string(),
        sources: source_artifacts,
    };

    let canonical_dir = if target.canonical_export {
        let canonical_dir = target_root.join("canonical");
        recreate_dir(&canonical_dir)?;
        export_canonical_bundle(&canonical_dir, artifacts, &attribution)?;
        Some(canonical_dir)
    } else {
        None
    };

    let web_dir = if target.web_debug_export {
        let runtime_dir = target_root.join("runtime").join("web");
        recreate_dir(&runtime_dir)?;
        export_web_runtime_bundle(
            &runtime_dir,
            &artifacts.canonical,
            &artifacts.edge_geometries,
            &attribution,
        )?;
        Some(runtime_dir)
    } else {
        None
    };

    let web_debug_dir = if target.web_debug_export {
        let runtime_dir = target_root.join("runtime").join("web-debug");
        recreate_dir(&runtime_dir)?;
        export_web_debug_bundle(
            &runtime_dir,
            &artifacts.canonical.meta,
            &artifacts.canonical,
            &artifacts.edge_geometries,
            &attribution,
        )?;
        Some(runtime_dir)
    } else {
        None
    };

    let authority_registry = load_geometry_authority_registry(manifest_dir, target)?;
    let quality_report = build_quality_report(
        &artifacts.canonical.cities,
        &artifacts.canonical.edges,
        &resolved_edge_geometries(&artifacts.canonical, &artifacts.edge_geometries)?,
        artifacts.station_mappings.as_ref(),
        &artifacts.quarantined_fallback_gap_cities,
        &artifacts.quarantined_promoted_attachment_gap_cities,
        &artifacts.counters,
        artifacts.duplicates.candidates.len(),
        authority_registry.as_ref(),
        &attribution.sources,
        &target_root,
    );

    let summary = PipelineBuildSummary {
        city_count: artifacts.canonical.cities.len(),
        station_count: artifacts.canonical.stations.len(),
        edge_count: artifacts.canonical.edges.len(),
        alias_count: artifacts.canonical.aliases.len(),
        duplicate_count: artifacts.duplicates.candidates.len(),
        issue_count: artifacts.issues.len(),
        counters: artifacts.counters.clone(),
    };
    let mut notes = artifacts.notes.clone();
    let failing_gates = quality_report
        .gate_results
        .iter()
        .filter(|gate| gate.status == "fail")
        .map(|gate| format!("{}={} violates {}", gate.metric, gate.actual, gate.target))
        .collect::<Vec<_>>();
    if !failing_gates.is_empty() {
        notes.push(format!(
            "Data quality gates currently failing: {}.",
            failing_gates.join(", ")
        ));
    }

    let artifact_manifest = PipelineArtifactManifest {
        dataset_id: manifest.dataset_id.clone(),
        target_id: target.id.clone(),
        adapter: target.adapter.clone(),
        dataset_version: dataset_version.to_string(),
        generated_at: generated_at.to_string(),
        source_snapshots,
        source_artifacts: attribution.sources.clone(),
        outputs: PipelineOutputPaths {
            target_root: target_root.display().to_string(),
            canonical_dir: canonical_dir
                .as_ref()
                .map(|path| path.display().to_string()),
            web_dir: web_dir.as_ref().map(|path| path.display().to_string()),
            web_debug_dir: web_debug_dir
                .as_ref()
                .map(|path| path.display().to_string()),
        },
        summary,
        notes,
    };

    write_json(
        &target_root.join("artifact-manifest.json"),
        &artifact_manifest,
    )?;
    write_json(
        &target_root.join("summary.json"),
        &artifact_manifest.summary,
    )?;
    let quality_dir = target_root.join("quality");
    recreate_dir(&quality_dir)?;
    write_json(&quality_dir.join("quality-report.json"), &quality_report)?;
    write_json(
        &quality_dir.join("country-quality.json"),
        &quality_report.country_quality,
    )?;
    write_json(
        &quality_dir.join("registry-match-report.json"),
        &quality_report.registry_match_report,
    )?;
    write_json(
        &quality_dir.join("station-like-cities.json"),
        &quality_report.station_like_cities,
    )?;
    write_json(
        &quality_dir.join("zz-cities.json"),
        &quality_report.zz_cities,
    )?;
    write_json(
        &quality_dir.join("abbreviation-candidates.json"),
        &quality_report.abbreviation_candidates,
    )?;
    write_json(
        &quality_dir.join("route-like-candidates.json"),
        &quality_report.route_like_candidates,
    )?;
    write_json(
        &quality_dir.join("route-like-residuals.json"),
        &quality_report.route_like_residuals,
    )?;
    write_json(
        &quality_dir.join("non-railway-route-geometries.json"),
        &quality_report.non_railway_route_geometries,
    )?;
    write_json(
        &quality_dir.join("route-geometry-anomalies.json"),
        &quality_report.route_geometry_anomalies,
    )?;
    write_json(
        &quality_dir.join("domestic-geometry-backlog-by-country.json"),
        &quality_report.domestic_geometry_backlog_by_country,
    )?;
    write_json(
        &quality_dir.join("cross-border-geometry-backlog-by-corridor.json"),
        &quality_report.cross_border_geometry_backlog_by_corridor,
    )?;
    write_json(
        &quality_dir.join("rejected-rail-authority-routes.json"),
        &quality_report.rejected_rail_authority_routes,
    )?;
    write_json(
        &quality_dir.join("rejected-shape-plausibility-routes.json"),
        &quality_report.rejected_shape_plausibility_routes,
    )?;
    write_json(
        &quality_dir.join("foreign-cross-border-leakage-routes.json"),
        &quality_report.foreign_cross_border_leakage_routes,
    )?;
    write_json(
        &quality_dir.join("impossible-edge-speed-routes.json"),
        &quality_report.impossible_edge_speed_routes,
    )?;
    write_json(
        &quality_dir.join("country-geometry-authorities.json"),
        &quality_report.country_geometry_authorities,
    )?;
    write_json(
        &quality_dir.join("corridor-geometry-authorities.json"),
        &quality_report.corridor_geometry_authorities,
    )?;
    write_json(
        &quality_dir.join("rail-authority-defect-details.json"),
        &quality_report.rail_authority_defect_details,
    )?;
    write_json(
        &quality_dir.join("shape-plausibility-defect-details.json"),
        &quality_report.shape_plausibility_defect_details,
    )?;
    write_json(
        &quality_dir.join("promoted-domestic-authority-gap-details.json"),
        &quality_report.promoted_domestic_authority_gap_details,
    )?;
    write_json(
        &quality_dir.join("promoted-station-attachment-gap-details.json"),
        &quality_report.promoted_station_attachment_gap_details,
    )?;
    write_json(
        &quality_dir.join("authority-detour-corridors.json"),
        &quality_report.authority_detour_corridors,
    )?;
    write_json(
        &quality_dir.join("quarantined-fallback-gap-cities.json"),
        &quality_report.quarantined_fallback_gap_cities,
    )?;
    write_json(
        &quality_dir.join("quarantined-promoted-attachment-gap-cities.json"),
        &quality_report.quarantined_promoted_attachment_gap_cities,
    )?;
    Ok(artifact_manifest)
}

fn source_artifact_local_path_for_export(source_path: &Path, target_root: &Path) -> String {
    let Ok(source_path) = absolutize_existing_path(source_path) else {
        return source_path.display().to_string();
    };
    let Ok(target_root) = absolutize_existing_path(target_root) else {
        return source_path.display().to_string();
    };
    relative_path_between(&source_path, &target_root)
        .unwrap_or(source_path)
        .display()
        .to_string()
}

fn absolutize_existing_path(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    path.canonicalize()
        .with_context(|| format!("failed to canonicalize {}", path.display()))
}

fn relative_path_between(path: &Path, base_dir: &Path) -> Option<PathBuf> {
    let path_components = path.components().collect::<Vec<_>>();
    let base_components = base_dir.components().collect::<Vec<_>>();
    if path_components.first() != base_components.first() {
        return None;
    }

    let common_len = path_components
        .iter()
        .zip(base_components.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = PathBuf::new();
    for _ in common_len..base_components.len() {
        relative.push("..");
    }
    for component in &path_components[common_len..] {
        relative.push(component.as_os_str());
    }
    Some(relative)
}

fn load_geometry_authority_registry(
    manifest_dir: &Path,
    target: &TargetDefinition,
) -> Result<Option<GeometryAuthorityRegistry>> {
    let Some(path) = target.geometry_authority_registry_path.as_deref() else {
        return Ok(None);
    };
    let registry_path = manifest_dir.join(path);
    GeometryAuthorityRegistry::load(&registry_path).map(Some)
}

fn export_canonical_bundle(
    output_dir: &Path,
    artifacts: &AdapterBuildArtifacts,
    attribution: &PipelineAttributionFile,
) -> Result<()> {
    let edge_geometries =
        resolved_edge_geometries(&artifacts.canonical, &artifacts.edge_geometries)?;
    write_json(&output_dir.join("bundle.json"), &artifacts.canonical)?;
    write_json(&output_dir.join("meta.json"), &artifacts.canonical.meta)?;
    write_json(&output_dir.join("cities.json"), &artifacts.canonical.cities)?;
    write_json(
        &output_dir.join("stations.json"),
        &artifacts.canonical.stations,
    )?;
    write_json(&output_dir.join("edges.json"), &artifacts.canonical.edges)?;
    write_json(&output_dir.join("edge-geometries.json"), &edge_geometries)?;
    write_json(
        &output_dir.join("aliases.json"),
        &artifacts.canonical.aliases,
    )?;
    write_json(
        &output_dir.join("duplicate-candidates.json"),
        &artifacts.duplicates,
    )?;
    if let Some(station_mappings) = &artifacts.station_mappings {
        write_json(&output_dir.join("station-mappings.json"), station_mappings)?;
    }
    if let Some(rejected_city_candidates) = &artifacts.rejected_city_candidates {
        write_json(
            &output_dir.join("rejected-city-candidates.json"),
            rejected_city_candidates,
        )?;
    }
    write_json(&output_dir.join("issues.json"), &artifacts.issues)?;
    write_json(&output_dir.join("attribution.json"), attribution)?;
    Ok(())
}

fn build_quality_report(
    cities: &[aetrain_domain::City],
    edges: &[aetrain_domain::TravelEdge],
    edge_geometries: &EdgeGeometryArtifact,
    station_mappings: Option<&StationMappingReport>,
    quarantined_fallback_gap_cities: &[PipelineQuarantinedFallbackGapCityRecord],
    quarantined_promoted_attachment_gap_cities: &[PipelineQuarantinedPromotedAttachmentGapCityRecord],
    counters: &BTreeMap<String, u64>,
    duplicate_count: usize,
    authority_registry: Option<&GeometryAuthorityRegistry>,
    source_artifacts: &[PipelineSourceArtifact],
    target_root: &Path,
) -> PipelineQualityReport {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let registry_match_report = PipelineRegistryMatchReport {
        authoritative_city_count: cities
            .iter()
            .filter(|city| city.wikidata_qid.is_some() && city_id_has_registry_qid(city))
            .count(),
        cities_with_wikidata_qid: cities
            .iter()
            .filter(|city| city.wikidata_qid.is_some())
            .count(),
        cities_with_population: cities
            .iter()
            .filter(|city| city.population.is_some())
            .count(),
        matched_count: counter_value(counters, "registry_overlay_match_count"),
        unmatched_count: counter_value(counters, "registry_overlay_unmatched_count"),
        ambiguous_count: counter_value(counters, "registry_overlay_ambiguous_count"),
        country_correction_count: counter_value(
            counters,
            "registry_overlay_country_correction_count",
        ),
        station_rescue_count: counter_value(counters, "registry_overlay_station_rescue_count"),
    };

    let mut grouped = BTreeMap::<String, PipelineCountryQualityRecord>::new();
    for city in cities {
        let record = grouped.entry(city.country_code.clone()).or_insert_with(|| {
            PipelineCountryQualityRecord {
                country_code: city.country_code.clone(),
                city_count: 0,
                station_like_city_count: 0,
                zz_city_count: 0,
                wikidata_city_count: 0,
                population_city_count: 0,
            }
        });
        record.city_count += 1;
        if is_station_qualified_city_name(&city.display_name) {
            record.station_like_city_count += 1;
        }
        if city.country_code == "ZZ" {
            record.zz_city_count += 1;
        }
        if city.wikidata_qid.is_some() {
            record.wikidata_city_count += 1;
        }
        if city.population.is_some() {
            record.population_city_count += 1;
        }
    }

    let station_like_cities = cities
        .iter()
        .filter(|city| is_station_qualified_city_name(&city.display_name))
        .map(city_quality_record)
        .collect::<Vec<_>>();
    let zz_cities = cities
        .iter()
        .filter(|city| city.country_code == "ZZ")
        .map(city_quality_record)
        .collect::<Vec<_>>();
    let low_signal_candidates = cities
        .iter()
        .filter_map(abbreviation_candidate_record)
        .collect::<Vec<_>>();
    let (route_like_candidates, abbreviation_candidates): (
        Vec<PipelineAbbreviationCandidateRecord>,
        Vec<PipelineAbbreviationCandidateRecord>,
    ) = low_signal_candidates
        .into_iter()
        .partition(|record| record.reason == "digit_or_route_like_name");
    let route_like_residuals =
        build_route_like_residual_records(&route_like_candidates, station_mappings);
    let non_railway_route_geometries =
        build_non_railway_route_geometry_records(cities, edges, edge_geometries);
    let route_geometry_anomalies =
        build_route_geometry_anomaly_records(cities, edges, edge_geometries);
    let domestic_geometry_backlog_by_country =
        build_domestic_geometry_backlog_by_country(&route_geometry_anomalies);
    let cross_border_geometry_backlog_by_corridor =
        build_cross_border_geometry_backlog_by_corridor(&route_geometry_anomalies);
    let rejected_rail_authority_routes = route_geometry_anomalies
        .iter()
        .filter(|record| record.geometry_resolution_status == "rejected_rail_authority")
        .cloned()
        .collect::<Vec<_>>();
    let rejected_shape_plausibility_routes = route_geometry_anomalies
        .iter()
        .filter(|record| record.geometry_resolution_status == "rejected_shape_plausibility")
        .cloned()
        .collect::<Vec<_>>();
    let foreign_cross_border_leakage_routes = route_geometry_anomalies
        .iter()
        .filter(|record| record.geometry_resolution_status == "foreign_cross_border_leakage")
        .cloned()
        .collect::<Vec<_>>();
    let impossible_edge_speed_routes = route_geometry_anomalies
        .iter()
        .filter(|record| record.geometry_resolution_status == "impossible_edge_speed")
        .cloned()
        .collect::<Vec<_>>();
    let authority_networks =
        load_pipeline_authority_networks(authority_registry, source_artifacts, target_root);
    let rail_authority_defect_details = build_rail_authority_defect_details(
        &rejected_rail_authority_routes,
        cities,
        edge_geometries,
        authority_registry,
        &authority_networks,
    );
    let promoted_rejected_station_attachment_gap_count = rail_authority_defect_details
        .iter()
        .filter(|record| {
            record.from_country_code == record.to_country_code
                && authority_registry.is_some_and(|registry| {
                    registry
                        .country(&record.from_country_code)
                        .is_some_and(|entry| entry.status.is_promoted())
                })
                && record.authority_defect_reason == "authority_station_attachment_gap"
        })
        .count() as u64;
    let promoted_rejected_topology_no_route_gap_count = rail_authority_defect_details
        .iter()
        .filter(|record| {
            record.from_country_code == record.to_country_code
                && authority_registry.is_some_and(|registry| {
                    registry
                        .country(&record.from_country_code)
                        .is_some_and(|entry| entry.status.is_promoted())
                })
                && record.authority_defect_reason == "authority_topology_no_route"
        })
        .count() as u64;
    let promoted_rejected_implausible_detour_count = rail_authority_defect_details
        .iter()
        .filter(|record| {
            record.from_country_code == record.to_country_code
                && authority_registry.is_some_and(|registry| {
                    registry
                        .country(&record.from_country_code)
                        .is_some_and(|entry| entry.status.is_promoted())
                })
                && record.authority_defect_reason == "implausible_authority_detour"
        })
        .count() as u64;
    let shape_plausibility_defect_details =
        build_shape_plausibility_defect_details(&rejected_shape_plausibility_routes);
    let promoted_domestic_authority_gap_details = build_promoted_domestic_authority_gap_details(
        &route_geometry_anomalies,
        cities,
        edges,
        authority_registry,
        &authority_networks,
    );
    let promoted_station_attachment_gap_details = build_promoted_station_attachment_gap_details(
        &promoted_domestic_authority_gap_details,
        cities,
        &authority_networks,
    );
    let authority_detour_corridors =
        build_authority_detour_corridor_records(&rail_authority_defect_details);
    let promoted_station_attachment_gap_count = promoted_domestic_authority_gap_details
        .iter()
        .filter(|record| record.authority_gap_reason == "authority_station_attachment_gap")
        .count() as u64;
    let promoted_topology_no_route_gap_count = promoted_domestic_authority_gap_details
        .iter()
        .filter(|record| record.authority_gap_reason == "authority_topology_no_route")
        .count() as u64;
    let promoted_implausible_authority_detour_count = promoted_domestic_authority_gap_details
        .iter()
        .filter(|record| record.authority_gap_reason == "implausible_authority_detour")
        .count() as u64;
    let domestic_straight_line_fallback_count = route_geometry_anomalies
        .iter()
        .filter(|record| {
            record.anomaly_type == "straight_line_fallback"
                && cities_by_id
                    .get(&record.from_city_id)
                    .zip(cities_by_id.get(&record.to_city_id))
                    .is_some_and(|(from_city, to_city)| {
                        from_city.country_code == to_city.country_code
                    })
        })
        .count() as u64;
    let foreign_domestic_feed_leakage_count = route_geometry_anomalies
        .iter()
        .filter(|record| {
            record.anomaly_type == "straight_line_fallback"
                && infer_home_country_code_from_provenance(&record.provenance).is_some_and(
                    |home_country_code| {
                        cities_by_id
                            .get(&record.from_city_id)
                            .zip(cities_by_id.get(&record.to_city_id))
                            .is_some_and(|(from_city, to_city)| {
                                is_foreign_domestic_feed_leakage(
                                    home_country_code,
                                    &from_city.country_code,
                                    &to_city.country_code,
                                )
                            })
                    },
                )
        })
        .count() as u64;
    let foreign_cross_border_feed_leakage_count = route_geometry_anomalies
        .iter()
        .filter(|record| record.geometry_resolution_status == "foreign_cross_border_leakage")
        .count() as u64;
    let rejected_rail_authority_count = route_geometry_anomalies
        .iter()
        .filter(|record| record.geometry_resolution_status == "rejected_rail_authority")
        .count() as u64;
    let rejected_shape_plausibility_count = route_geometry_anomalies
        .iter()
        .filter(|record| record.geometry_resolution_status == "rejected_shape_plausibility")
        .count() as u64;
    let impossible_edge_speed_count = route_geometry_anomalies
        .iter()
        .filter(|record| record.geometry_resolution_status == "impossible_edge_speed")
        .count() as u64;
    let promoted_missing_domestic_authority_count = route_geometry_anomalies
        .iter()
        .filter(|record| {
            record.geometry_resolution_status == "missing_domestic_authority"
                && authority_registry.is_some_and(|registry| {
                    registry
                        .country(&record.from_country_code)
                        .is_some_and(|entry| entry.status.is_promoted())
                })
        })
        .count() as u64;
    let promoted_cross_border_unresolved_count = route_geometry_anomalies
        .iter()
        .filter(|record| {
            record.geometry_resolution_status == "cross_border_unresolved"
                && authority_registry.is_some_and(|registry| {
                    registry
                        .corridor(&record.from_country_code, &record.to_country_code)
                        .is_some_and(|entry| entry.status.is_promoted())
                })
        })
        .count() as u64;
    let promoted_rejected_rail_authority_count = route_geometry_anomalies
        .iter()
        .filter(|record| {
            record.geometry_resolution_status == "rejected_rail_authority"
                && authority_registry.is_some_and(|registry| {
                    registry
                        .country(&record.from_country_code)
                        .is_some_and(|entry| entry.status.is_promoted())
                })
        })
        .count() as u64;
    let country_geometry_authorities = build_country_geometry_authority_records(
        authority_registry,
        &route_geometry_anomalies,
        &promoted_domestic_authority_gap_details,
        &rail_authority_defect_details,
    );
    let corridor_geometry_authorities =
        build_corridor_geometry_authority_records(authority_registry, &route_geometry_anomalies);

    let gate_results = vec![
        quality_gate_equals(
            "registry_overlay_ambiguous_count_zero",
            "registry_overlay_ambiguous_count",
            counter_value(counters, "registry_overlay_ambiguous_count"),
            0,
        ),
        quality_gate_equals(
            "duplicate_count_zero",
            "duplicate_count",
            duplicate_count as u64,
            0,
        ),
        quality_gate_less_than(
            "residual_station_like_city_count",
            "residual_station_like_city_count",
            counter_value(counters, "residual_station_like_city_count"),
            QUALITY_GATE_MAX_RESIDUAL_STATION_LIKE_CITIES,
        ),
        quality_gate_less_than(
            "residual_zz_city_count",
            "residual_zz_city_count",
            counter_value(counters, "residual_zz_city_count"),
            QUALITY_GATE_MAX_RESIDUAL_ZZ_CITIES,
        ),
        quality_gate_less_than(
            "route_like_city_unresolved_count",
            "route_like_city_unresolved_count",
            counter_value(counters, "route_like_city_unresolved_count"),
            QUALITY_GATE_MAX_UNRESOLVED_ROUTE_LIKE_CITIES,
        ),
        quality_gate_equals(
            "foreign_domestic_feed_leakage_count_zero",
            "foreign_domestic_feed_leakage_count",
            foreign_domestic_feed_leakage_count,
            0,
        ),
        quality_gate_equals(
            "domestic_straight_line_fallback_count_zero",
            "domestic_straight_line_fallback_count",
            domestic_straight_line_fallback_count,
            0,
        ),
        quality_gate_equals(
            "foreign_cross_border_feed_leakage_count_zero",
            "foreign_cross_border_feed_leakage_count",
            foreign_cross_border_feed_leakage_count,
            0,
        ),
        quality_gate_equals(
            "rejected_rail_authority_count_zero",
            "rejected_rail_authority_count",
            rejected_rail_authority_count,
            0,
        ),
        quality_gate_equals(
            "rejected_shape_plausibility_count_zero",
            "rejected_shape_plausibility_count",
            rejected_shape_plausibility_count,
            0,
        ),
        quality_gate_equals(
            "impossible_edge_speed_count_zero",
            "impossible_edge_speed_count",
            impossible_edge_speed_count,
            0,
        ),
        quality_gate_equals(
            "promoted_domestic_authority_gap_count_zero",
            "promoted_domestic_authority_gap_count",
            promoted_missing_domestic_authority_count,
            0,
        ),
        quality_gate_equals(
            "promoted_station_attachment_gap_count_zero",
            "promoted_station_attachment_gap_count",
            promoted_station_attachment_gap_count,
            0,
        ),
        quality_gate_equals(
            "promoted_topology_no_route_gap_count_zero",
            "promoted_topology_no_route_gap_count",
            promoted_topology_no_route_gap_count,
            0,
        ),
        quality_gate_equals(
            "promoted_implausible_authority_detour_count_zero",
            "promoted_implausible_authority_detour_count",
            promoted_implausible_authority_detour_count,
            0,
        ),
        quality_gate_equals(
            "promoted_cross_border_authority_gap_count_zero",
            "promoted_cross_border_authority_gap_count",
            promoted_cross_border_unresolved_count,
            0,
        ),
        quality_gate_equals(
            "promoted_rejected_rail_authority_count_zero",
            "promoted_rejected_rail_authority_count",
            promoted_rejected_rail_authority_count,
            0,
        ),
        quality_gate_equals(
            "promoted_rejected_station_attachment_gap_count_zero",
            "promoted_rejected_station_attachment_gap_count",
            promoted_rejected_station_attachment_gap_count,
            0,
        ),
        quality_gate_equals(
            "promoted_rejected_topology_no_route_gap_count_zero",
            "promoted_rejected_topology_no_route_gap_count",
            promoted_rejected_topology_no_route_gap_count,
            0,
        ),
        quality_gate_equals(
            "promoted_rejected_implausible_authority_detour_count_zero",
            "promoted_rejected_implausible_authority_detour_count",
            promoted_rejected_implausible_detour_count,
            0,
        ),
    ];
    let mut gate_results = gate_results;
    for country in &country_geometry_authorities {
        if !country.promoted {
            continue;
        }
        if let Some(target) = country.max_promoted_station_attachment_gap_count {
            gate_results.push(quality_gate_less_than_or_equal(
                &format!(
                    "country_{}_promoted_station_attachment_gap_count_within_policy",
                    country.country_code.to_lowercase()
                ),
                &format!(
                    "country_{}_promoted_station_attachment_gap_count",
                    country.country_code.to_lowercase()
                ),
                country.promoted_station_attachment_gap_count,
                target,
            ));
        }
        if let Some(target) = country.max_promoted_topology_no_route_gap_count {
            gate_results.push(quality_gate_less_than_or_equal(
                &format!(
                    "country_{}_promoted_topology_no_route_gap_count_within_policy",
                    country.country_code.to_lowercase()
                ),
                &format!(
                    "country_{}_promoted_topology_no_route_gap_count",
                    country.country_code.to_lowercase()
                ),
                country.promoted_topology_no_route_gap_count,
                target,
            ));
        }
        if let Some(target) = country.max_promoted_rejected_implausible_authority_detour_count {
            gate_results.push(quality_gate_less_than_or_equal(
                &format!(
                    "country_{}_promoted_rejected_implausible_authority_detour_count_within_policy",
                    country.country_code.to_lowercase()
                ),
                &format!(
                    "country_{}_promoted_rejected_implausible_authority_detour_count",
                    country.country_code.to_lowercase()
                ),
                country.promoted_rejected_implausible_authority_detour_count,
                target,
            ));
        }
    }

    PipelineQualityReport {
        gate_results,
        registry_match_report,
        country_quality: grouped.into_values().collect(),
        station_like_cities,
        zz_cities,
        abbreviation_candidates,
        route_like_candidates,
        route_like_residuals,
        non_railway_route_geometries,
        route_geometry_anomalies,
        domestic_geometry_backlog_by_country,
        cross_border_geometry_backlog_by_corridor,
        rejected_rail_authority_routes,
        rejected_shape_plausibility_routes,
        foreign_cross_border_leakage_routes,
        impossible_edge_speed_routes,
        country_geometry_authorities,
        corridor_geometry_authorities,
        rail_authority_defect_details,
        shape_plausibility_defect_details,
        promoted_domestic_authority_gap_details,
        promoted_station_attachment_gap_details,
        authority_detour_corridors,
        quarantined_fallback_gap_cities: quarantined_fallback_gap_cities.to_vec(),
        quarantined_promoted_attachment_gap_cities:
            quarantined_promoted_attachment_gap_cities.to_vec(),
    }
}

fn build_country_geometry_authority_records(
    authority_registry: Option<&GeometryAuthorityRegistry>,
    route_geometry_anomalies: &[PipelineRouteGeometryAnomalyRecord],
    promoted_domestic_authority_gap_details: &[PipelinePromotedDomesticAuthorityGapRecord],
    rail_authority_defect_details: &[PipelineRailAuthorityDefectRecord],
) -> Vec<PipelineCountryGeometryAuthorityRecord> {
    let Some(authority_registry) = authority_registry else {
        return Vec::new();
    };

    authority_registry
        .countries
        .iter()
        .map(|entry| {
            let missing_domestic_authority_count = route_geometry_anomalies
                .iter()
                .filter(|record| {
                    record.geometry_resolution_status == "missing_domestic_authority"
                        && record.from_country_code == entry.country_code
                })
                .count() as u64;
            let promoted_station_attachment_gap_count = promoted_domestic_authority_gap_details
                .iter()
                .filter(|record| {
                    record.country_code == entry.country_code
                        && record.authority_gap_reason == "authority_station_attachment_gap"
                })
                .count() as u64;
            let promoted_topology_no_route_gap_count = promoted_domestic_authority_gap_details
                .iter()
                .filter(|record| {
                    record.country_code == entry.country_code
                        && record.authority_gap_reason == "authority_topology_no_route"
                })
                .count() as u64;
            let promoted_rejected_implausible_authority_detour_count =
                rail_authority_defect_details
                    .iter()
                    .filter(|record| {
                        record.from_country_code == entry.country_code
                            && record.to_country_code == entry.country_code
                            && record.authority_defect_reason == "implausible_authority_detour"
                    })
                    .count() as u64;
            PipelineCountryGeometryAuthorityRecord {
                country_code: entry.country_code.clone(),
                status: geometry_authority_status_label(&entry.status).to_string(),
                promoted: entry.status.is_promoted(),
                source_id: entry.source_id.clone(),
                missing_domestic_authority_count,
                promoted_station_attachment_gap_count,
                promoted_topology_no_route_gap_count,
                promoted_rejected_implausible_authority_detour_count,
                max_promoted_station_attachment_gap_count: entry
                    .max_promoted_station_attachment_gap_count,
                max_promoted_topology_no_route_gap_count: entry
                    .max_promoted_topology_no_route_gap_count,
                max_promoted_rejected_implausible_authority_detour_count: entry
                    .max_promoted_rejected_implausible_authority_detour_count,
                rejected_rail_authority_count: route_geometry_anomalies
                    .iter()
                    .filter(|record| {
                        record.geometry_resolution_status == "rejected_rail_authority"
                            && record.from_country_code == entry.country_code
                            && record.to_country_code == entry.country_code
                    })
                    .count() as u64,
                notes: entry.notes.clone(),
            }
        })
        .collect()
}

fn build_corridor_geometry_authority_records(
    authority_registry: Option<&GeometryAuthorityRegistry>,
    route_geometry_anomalies: &[PipelineRouteGeometryAnomalyRecord],
) -> Vec<PipelineCorridorGeometryAuthorityRecord> {
    let Some(authority_registry) = authority_registry else {
        return Vec::new();
    };

    authority_registry
        .corridors
        .iter()
        .map(|entry| PipelineCorridorGeometryAuthorityRecord {
            corridor_id: entry.corridor_id.clone(),
            from_country_code: entry.from_country_code.clone(),
            to_country_code: entry.to_country_code.clone(),
            status: geometry_authority_status_label(&entry.status).to_string(),
            promoted: entry.status.is_promoted(),
            source_id: entry.source_id.clone(),
            cross_border_unresolved_count: route_geometry_anomalies
                .iter()
                .filter(|record| {
                    record.geometry_resolution_status == "cross_border_unresolved"
                        && countries_match_corridor(
                            &record.from_country_code,
                            &record.to_country_code,
                            &entry.from_country_code,
                            &entry.to_country_code,
                        )
                })
                .count() as u64,
            notes: entry.notes.clone(),
        })
        .collect()
}

fn geometry_authority_status_label(status: &GeometryAuthorityStatus) -> &'static str {
    match status {
        GeometryAuthorityStatus::Planned => "planned",
        GeometryAuthorityStatus::Ingested => "ingested",
        GeometryAuthorityStatus::TopologyClean => "topology_clean",
        GeometryAuthorityStatus::ProductionReady => "production_ready",
    }
}

fn countries_match_corridor(
    left_from: &str,
    left_to: &str,
    right_from: &str,
    right_to: &str,
) -> bool {
    (left_from.eq_ignore_ascii_case(right_from) && left_to.eq_ignore_ascii_case(right_to))
        || (left_from.eq_ignore_ascii_case(right_to) && left_to.eq_ignore_ascii_case(right_from))
}

fn load_pipeline_authority_networks(
    authority_registry: Option<&GeometryAuthorityRegistry>,
    source_artifacts: &[PipelineSourceArtifact],
    target_root: &Path,
) -> BTreeMap<String, RailGeometryNetwork> {
    let Some(authority_registry) = authority_registry else {
        return BTreeMap::new();
    };

    let sources = authority_registry
        .countries
        .iter()
        .filter_map(|entry| {
            Some((
                entry.source_id.as_ref()?.clone(),
                entry.loader.as_ref()?.clone(),
            ))
        })
        .chain(authority_registry.corridors.iter().filter_map(|entry| {
            Some((
                entry.source_id.as_ref()?.clone(),
                entry.loader.as_ref()?.clone(),
            ))
        }))
        .collect::<BTreeMap<_, _>>();
    let mut networks = BTreeMap::new();

    for artifact in source_artifacts {
        let Some(loader) = sources.get(&artifact.source_id) else {
            continue;
        };
        let path =
            resolve_pipeline_source_artifact_path(artifact, &target_root.display().to_string());
        let network = match loader {
            GeometryAuthorityLoader::SncfRfnGeojson => {
                RailGeometryNetwork::load_sncf_rfn_geojson(&path)
            }
        };
        if let Ok(network) = network {
            networks.insert(artifact.source_id.clone(), network);
        }
    }

    networks
}

fn build_rail_authority_defect_details(
    rejected_rail_authority_routes: &[PipelineRouteGeometryAnomalyRecord],
    cities: &[City],
    edge_geometries: &EdgeGeometryArtifact,
    authority_registry: Option<&GeometryAuthorityRegistry>,
    authority_networks: &BTreeMap<String, RailGeometryNetwork>,
) -> Vec<PipelineRailAuthorityDefectRecord> {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let geometries_by_id = edge_geometries
        .geometries
        .iter()
        .map(|geometry| {
            (
                (geometry.from_city_id.clone(), geometry.to_city_id.clone()),
                geometry,
            )
        })
        .collect::<BTreeMap<_, _>>();

    rejected_rail_authority_routes
        .iter()
        .filter_map(|record| {
            let from_city = cities_by_id.get(&record.from_city_id)?;
            let to_city = cities_by_id.get(&record.to_city_id)?;
            let geometry =
                geometries_by_id.get(&(record.from_city_id.clone(), record.to_city_id.clone()))?;
            let source_id = infer_authority_source_id(
                authority_registry,
                &record.from_country_code,
                &record.to_country_code,
                &record.provenance,
            )?;
            let (
                rejected_geometry_distance_km,
                rejected_direct_distance_km,
                rejected_detour_ratio_x100,
                rejected_implied_speed_kmh,
            ) = parse_rejected_geometry_metrics_provenance(
                &geometry.provenance,
                REJECTED_RAIL_METRICS_PROVENANCE_PREFIX,
            )
            .unwrap_or((
                record.geometry_distance_km,
                record.direct_distance_km,
                record.detour_ratio_x100,
                record.implied_speed_kmh,
            ));
            let network = authority_networks.get(&source_id);
            let (
                start_snap_distance_m,
                end_snap_distance_m,
                route_found_in_authority_graph,
                routed_authority_distance_km,
                routed_authority_point_count,
            ) = if let Some(network) = network {
                let start_candidates = network.route_snap_candidates(from_city.location);
                let end_candidates = network.route_snap_candidates(to_city.location);
                let points = network.route_polyline_for_snap_candidates(
                    from_city.location,
                    to_city.location,
                    &start_candidates,
                    &end_candidates,
                );
                if let Some(points) = points {
                    let points_e5 = points
                        .into_iter()
                        .map(scale_geo_point_e5_for_pipeline)
                        .collect::<Vec<_>>();
                    (
                        start_candidates.first().map(|(_, distance)| *distance),
                        end_candidates.first().map(|(_, distance)| *distance),
                        true,
                        Some(meters_to_km_u32(edge_geometry_length_meters(&points_e5))),
                        Some(points_e5.len()),
                    )
                } else {
                    (
                        start_candidates.first().map(|(_, distance)| *distance),
                        end_candidates.first().map(|(_, distance)| *distance),
                        false,
                        None,
                        None,
                    )
                }
            } else {
                (None, None, false, None, None)
            };

            Some(PipelineRailAuthorityDefectRecord {
                source_id,
                from_city_id: record.from_city_id.clone(),
                from_display_name: record.from_display_name.clone(),
                from_country_code: record.from_country_code.clone(),
                to_city_id: record.to_city_id.clone(),
                to_display_name: record.to_display_name.clone(),
                to_country_code: record.to_country_code.clone(),
                direct_distance_km: rejected_direct_distance_km,
                geometry_distance_km: rejected_geometry_distance_km,
                detour_ratio_x100: rejected_detour_ratio_x100,
                implied_speed_kmh: rejected_implied_speed_kmh,
                start_snap_distance_m,
                end_snap_distance_m,
                route_found_in_authority_graph,
                authority_defect_reason: classify_authority_path_failure_reason(
                    start_snap_distance_m,
                    end_snap_distance_m,
                    route_found_in_authority_graph,
                )
                .to_string(),
                routed_authority_distance_km,
                routed_authority_point_count,
                provenance: geometry.provenance.clone(),
            })
        })
        .collect()
}

fn build_shape_plausibility_defect_details(
    rejected_shape_plausibility_routes: &[PipelineRouteGeometryAnomalyRecord],
) -> Vec<PipelineShapePlausibilityDefectRecord> {
    rejected_shape_plausibility_routes
        .iter()
        .map(|record| {
            let (geometry_distance_km, direct_distance_km, detour_ratio_x100, implied_speed_kmh) =
                parse_rejected_geometry_metrics_provenance(
                    &record.provenance,
                    REJECTED_SHAPE_METRICS_PROVENANCE_PREFIX,
                )
                .unwrap_or((
                    record.geometry_distance_km,
                    record.direct_distance_km,
                    record.detour_ratio_x100,
                    record.implied_speed_kmh,
                ));
            PipelineShapePlausibilityDefectRecord {
                source_id: infer_feed_source_id_from_provenance(&record.provenance),
                from_city_id: record.from_city_id.clone(),
                from_display_name: record.from_display_name.clone(),
                from_country_code: record.from_country_code.clone(),
                to_city_id: record.to_city_id.clone(),
                to_display_name: record.to_display_name.clone(),
                to_country_code: record.to_country_code.clone(),
                duration_min: record.duration_min,
                direct_distance_km,
                geometry_distance_km,
                detour_ratio_x100,
                implied_speed_kmh,
                provenance: record.provenance.clone(),
            }
        })
        .collect()
}

fn build_promoted_domestic_authority_gap_details(
    route_geometry_anomalies: &[PipelineRouteGeometryAnomalyRecord],
    cities: &[City],
    edges: &[aetrain_domain::TravelEdge],
    authority_registry: Option<&GeometryAuthorityRegistry>,
    authority_networks: &BTreeMap<String, RailGeometryNetwork>,
) -> Vec<PipelinePromotedDomesticAuthorityGapRecord> {
    let Some(authority_registry) = authority_registry else {
        return Vec::new();
    };
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let edge_by_id = edges
        .iter()
        .map(|edge| ((edge.from_city_id.clone(), edge.to_city_id.clone()), edge))
        .collect::<BTreeMap<_, _>>();

    route_geometry_anomalies
        .iter()
        .filter(|record| {
            record.geometry_resolution_status == "missing_domestic_authority"
                && authority_registry
                    .country(&record.from_country_code)
                    .is_some_and(|entry| entry.status.is_promoted())
        })
        .filter_map(|record| {
            let from_city = cities_by_id.get(&record.from_city_id)?;
            let to_city = cities_by_id.get(&record.to_city_id)?;
            let authority = authority_registry.country(&record.from_country_code)?;
            let source_id = authority.source_id.clone()?;
            let network = authority_networks.get(&source_id);
            let duration_min = edge_by_id
                .get(&(record.from_city_id.clone(), record.to_city_id.clone()))
                .map(|edge| edge.duration_min);
            let (
                start_snap_distance_m,
                end_snap_distance_m,
                route_found_in_authority_graph,
                routed_authority_distance_km,
                routed_authority_point_count,
                routed_authority_detour_ratio_x100,
                routed_authority_implied_speed_kmh,
            ) = if let Some(network) = network {
                let start_candidates = network.route_snap_candidates(from_city.location);
                let end_candidates = network.route_snap_candidates(to_city.location);
                let points = network.route_polyline_for_snap_candidates(
                    from_city.location,
                    to_city.location,
                    &start_candidates,
                    &end_candidates,
                );
                if let Some(points) = points {
                    let points_e5 = points
                        .into_iter()
                        .map(scale_geo_point_e5_for_pipeline)
                        .collect::<Vec<_>>();
                    let metrics = route_geometry_metrics(
                        &points_e5,
                        from_city.location,
                        to_city.location,
                        duration_min,
                    );
                    (
                        start_candidates.first().map(|(_, distance)| *distance),
                        end_candidates.first().map(|(_, distance)| *distance),
                        true,
                        Some(meters_to_km_u32(metrics.geometry_meters)),
                        Some(points_e5.len()),
                        metrics.detour_ratio_x100,
                        metrics.implied_speed_kmh,
                    )
                } else {
                    (
                        start_candidates.first().map(|(_, distance)| *distance),
                        end_candidates.first().map(|(_, distance)| *distance),
                        false,
                        None,
                        None,
                        None,
                        None,
                    )
                }
            } else {
                (None, None, false, None, None, None, None)
            };

            Some(PipelinePromotedDomesticAuthorityGapRecord {
                source_id,
                country_code: record.from_country_code.clone(),
                from_city_id: record.from_city_id.clone(),
                from_display_name: record.from_display_name.clone(),
                to_city_id: record.to_city_id.clone(),
                to_display_name: record.to_display_name.clone(),
                direct_distance_km: record.direct_distance_km,
                duration_min,
                start_snap_distance_m,
                end_snap_distance_m,
                route_found_in_authority_graph,
                routed_authority_distance_km,
                routed_authority_point_count,
                routed_authority_detour_ratio_x100,
                routed_authority_implied_speed_kmh,
                authority_gap_reason: classify_promoted_domestic_authority_gap_reason(
                    start_snap_distance_m,
                    end_snap_distance_m,
                    route_found_in_authority_graph,
                )
                .to_string(),
                provenance: record.provenance.clone(),
            })
        })
        .collect()
}

fn classify_promoted_domestic_authority_gap_reason(
    start_snap_distance_m: Option<u32>,
    end_snap_distance_m: Option<u32>,
    route_found_in_authority_graph: bool,
) -> &'static str {
    classify_authority_path_failure_reason(
        start_snap_distance_m,
        end_snap_distance_m,
        route_found_in_authority_graph,
    )
}

fn classify_authority_path_failure_reason(
    start_snap_distance_m: Option<u32>,
    end_snap_distance_m: Option<u32>,
    route_found_in_authority_graph: bool,
) -> &'static str {
    match (start_snap_distance_m, end_snap_distance_m, route_found_in_authority_graph) {
        (Some(_), Some(_), true) => "implausible_authority_detour",
        (Some(_), Some(_), false) => "authority_topology_no_route",
        _ => "authority_station_attachment_gap",
    }
}

fn build_promoted_station_attachment_gap_details(
    promoted_domestic_authority_gap_details: &[PipelinePromotedDomesticAuthorityGapRecord],
    cities: &[City],
    authority_networks: &BTreeMap<String, RailGeometryNetwork>,
) -> Vec<PipelineStationAttachmentAuditRecord> {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();

    promoted_domestic_authority_gap_details
        .iter()
        .filter(|record| record.authority_gap_reason == "authority_station_attachment_gap")
        .filter_map(|record| {
            let network = authority_networks.get(&record.source_id)?;
            let from_city = cities_by_id.get(&record.from_city_id)?;
            let to_city = cities_by_id.get(&record.to_city_id)?;
            Some(PipelineStationAttachmentAuditRecord {
                source_id: record.source_id.clone(),
                country_code: record.country_code.clone(),
                from_city_id: record.from_city_id.clone(),
                from_display_name: record.from_display_name.clone(),
                to_city_id: record.to_city_id.clone(),
                to_display_name: record.to_display_name.clone(),
                direct_distance_km: record.direct_distance_km,
                duration_min: record.duration_min,
                from_local_candidate_distances_m: network
                    .route_snap_candidates(from_city.location)
                    .into_iter()
                    .map(|(_, distance)| distance)
                    .collect(),
                to_local_candidate_distances_m: network
                    .route_snap_candidates(to_city.location)
                    .into_iter()
                    .map(|(_, distance)| distance)
                    .collect(),
                from_expanded_candidate_distances_m: network
                    .expanded_route_snap_candidates(from_city.location)
                    .into_iter()
                    .map(|(_, distance)| distance)
                    .collect(),
                to_expanded_candidate_distances_m: network
                    .expanded_route_snap_candidates(to_city.location)
                    .into_iter()
                    .map(|(_, distance)| distance)
                    .collect(),
                provenance: record.provenance.clone(),
            })
        })
        .collect()
}

fn build_authority_detour_corridor_records(
    rail_authority_defect_details: &[PipelineRailAuthorityDefectRecord],
) -> Vec<PipelineAuthorityDetourCorridorRecord> {
    let mut grouped = BTreeMap::<(String, String, String, String), Vec<&PipelineRailAuthorityDefectRecord>>::new();
    for record in rail_authority_defect_details
        .iter()
        .filter(|record| record.authority_defect_reason == "implausible_authority_detour")
    {
        let (left_id, left_name, left_country, right_id, right_name, right_country) =
            if record.from_city_id <= record.to_city_id {
                (
                    record.from_city_id.to_string(),
                    record.from_display_name.clone(),
                    record.from_country_code.clone(),
                    record.to_city_id.to_string(),
                    record.to_display_name.clone(),
                    record.to_country_code.clone(),
                )
            } else {
                (
                    record.to_city_id.to_string(),
                    record.to_display_name.clone(),
                    record.to_country_code.clone(),
                    record.from_city_id.to_string(),
                    record.from_display_name.clone(),
                    record.from_country_code.clone(),
                )
            };
        grouped
            .entry((
                record.source_id.clone(),
                left_id,
                right_id,
                format!("{left_name} ({left_country}) <-> {right_name} ({right_country})"),
            ))
            .or_default()
            .push(record);
    }

    grouped
        .into_iter()
        .map(|((source_id, _left_id, _right_id, corridor_key), records)| {
            let first = records[0];
            let max_snap_distance_m = records
                .iter()
                .flat_map(|record| {
                    [
                        record.start_snap_distance_m.unwrap_or(0),
                        record.end_snap_distance_m.unwrap_or(0),
                    ]
                })
                .max()
                .unwrap_or(0);
            let min_detour_ratio_x100 = records
                .iter()
                .filter_map(|record| record.detour_ratio_x100)
                .min()
                .unwrap_or(0);
            let max_detour_ratio_x100 = records
                .iter()
                .filter_map(|record| record.detour_ratio_x100)
                .max()
                .unwrap_or(0);
            let (recommended_policy, policy_reason) =
                classify_authority_detour_corridor_policy(
                    records.len() as u64,
                    max_snap_distance_m,
                    min_detour_ratio_x100,
                    max_detour_ratio_x100,
                );
            PipelineAuthorityDetourCorridorRecord {
                source_id,
                from_country_code: first.from_country_code.clone(),
                to_country_code: first.to_country_code.clone(),
                corridor_key,
                route_count: records.len() as u64,
                example_routes: records
                    .iter()
                    .take(6)
                    .map(|record| format!("{} -> {}", record.from_display_name, record.to_display_name))
                    .collect(),
                min_direct_distance_km: records
                    .iter()
                    .map(|record| record.direct_distance_km)
                    .min()
                    .unwrap_or(0),
                max_direct_distance_km: records
                    .iter()
                    .map(|record| record.direct_distance_km)
                    .max()
                    .unwrap_or(0),
                min_routed_authority_distance_km: records
                    .iter()
                    .filter_map(|record| record.routed_authority_distance_km)
                    .min()
                    .unwrap_or(0),
                max_routed_authority_distance_km: records
                    .iter()
                    .filter_map(|record| record.routed_authority_distance_km)
                    .max()
                    .unwrap_or(0),
                min_detour_ratio_x100,
                max_detour_ratio_x100,
                max_snap_distance_m,
                recommended_policy: recommended_policy.to_string(),
                policy_reason: policy_reason.to_string(),
            }
        })
        .collect()
}

fn classify_authority_detour_corridor_policy(
    route_count: u64,
    max_snap_distance_m: u32,
    min_detour_ratio_x100: u32,
    max_detour_ratio_x100: u32,
) -> (&'static str, &'static str) {
    if max_snap_distance_m > 1_000 {
        return (
            "tighten_authority_footprint",
            "corridor detours are mixed with large snap distances, so attachment or footprint should be fixed before suppressing routing",
        );
    }
    if route_count >= 2 && min_detour_ratio_x100 >= 180 && max_detour_ratio_x100 >= 300 {
        return (
            "suppress_authority_until_topology_fixed",
            "corridor repeatedly produces implausible authority paths despite close snaps, indicating a stable topology defect",
        );
    }
    (
        "review_authority_corridor",
        "corridor has repeated detours but does not yet clearly meet suppression or footprint-tightening criteria",
    )
}

fn infer_feed_source_id_from_provenance(provenance: &[String]) -> Option<String> {
    provenance.iter().find_map(|entry| {
        entry.split_once(':').and_then(|(source_id, _)| {
            (!source_id.starts_with("geometry")).then(|| source_id.to_string())
        })
    })
}

fn infer_authority_source_id(
    authority_registry: Option<&GeometryAuthorityRegistry>,
    from_country_code: &str,
    to_country_code: &str,
    provenance: &[String],
) -> Option<String> {
    if let Some(source_id) = provenance.iter().find_map(|entry| {
        entry
            .strip_prefix("geometry:")
            .map(str::to_string)
            .and_then(|value| {
                (value != "invalid-railway-path-rejected"
                    && value != "invalid-gtfs-shape-rejected"
                    && !value.starts_with("rejected-")
                    && !value.contains('='))
                .then_some(value)
            })
    }) {
        return Some(source_id);
    }

    let registry = authority_registry?;
    if from_country_code == to_country_code {
        return registry
            .country(from_country_code)
            .and_then(|entry| entry.source_id.clone());
    }
    registry
        .corridor(from_country_code, to_country_code)
        .and_then(|entry| entry.source_id.clone())
}

fn build_rejected_geometry_metrics_provenance(
    prefix: &str,
    metrics: &RouteGeometryMetrics,
) -> String {
    format!(
        "{prefix}geometry_km={};direct_km={};detour_ratio_x100={};implied_speed_kmh={}",
        meters_to_km_u32(metrics.geometry_meters),
        meters_to_km_u32(metrics.direct_meters),
        metrics.detour_ratio_x100.unwrap_or(0),
        metrics.implied_speed_kmh.unwrap_or(0),
    )
}

fn parse_rejected_geometry_metrics_provenance(
    provenance: &[String],
    prefix: &str,
) -> Option<(u32, u32, Option<u32>, Option<u32>)> {
    let payload = provenance
        .iter()
        .find_map(|entry| entry.strip_prefix(prefix))?;
    let mut geometry_km = None;
    let mut direct_km = None;
    let mut detour_ratio_x100 = None;
    let mut implied_speed_kmh = None;
    for part in payload.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let Ok(value) = value.parse::<u32>() else {
            continue;
        };
        match key {
            "geometry_km" => geometry_km = Some(value),
            "direct_km" => direct_km = Some(value),
            "detour_ratio_x100" => detour_ratio_x100 = (value > 0).then_some(value),
            "implied_speed_kmh" => implied_speed_kmh = (value > 0).then_some(value),
            _ => {}
        }
    }
    Some((
        geometry_km?,
        direct_km?,
        detour_ratio_x100,
        implied_speed_kmh,
    ))
}

fn build_non_railway_route_geometry_records(
    cities: &[aetrain_domain::City],
    edges: &[aetrain_domain::TravelEdge],
    edge_geometries: &EdgeGeometryArtifact,
) -> Vec<PipelineRouteGeometryQualityRecord> {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let duration_by_edge = edges
        .iter()
        .map(|edge| {
            (
                (edge.from_city_id.clone(), edge.to_city_id.clone()),
                edge.duration_min,
            )
        })
        .collect::<BTreeMap<_, _>>();

    edge_geometries
        .geometries
        .iter()
        .filter(|geometry| !is_railway_layer_geometry_source(&geometry.source))
        .filter_map(|geometry| {
            let from_city = cities_by_id.get(&geometry.from_city_id)?;
            let to_city = cities_by_id.get(&geometry.to_city_id)?;
            Some(PipelineRouteGeometryQualityRecord {
                from_city_id: geometry.from_city_id.clone(),
                from_display_name: from_city.display_name.clone(),
                from_country_code: from_city.country_code.clone(),
                to_city_id: geometry.to_city_id.clone(),
                to_display_name: to_city.display_name.clone(),
                to_country_code: to_city.country_code.clone(),
                duration_min: duration_by_edge
                    .get(&(geometry.from_city_id.clone(), geometry.to_city_id.clone()))
                    .copied(),
                geometry_source: geometry.source.clone(),
                point_count: geometry.points.len(),
                geometry_resolution_status: classify_geometry_resolution_status(
                    from_city.country_code.as_str(),
                    to_city.country_code.as_str(),
                    &geometry.source,
                    &geometry.provenance,
                    None,
                )
                .to_string(),
                provenance: geometry.provenance.clone(),
            })
        })
        .collect()
}

fn build_route_geometry_anomaly_records(
    cities: &[aetrain_domain::City],
    edges: &[aetrain_domain::TravelEdge],
    edge_geometries: &EdgeGeometryArtifact,
) -> Vec<PipelineRouteGeometryAnomalyRecord> {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let edge_by_id = edges
        .iter()
        .map(|edge| ((edge.from_city_id.clone(), edge.to_city_id.clone()), edge))
        .collect::<BTreeMap<_, _>>();

    edge_geometries
        .geometries
        .iter()
        .filter_map(|geometry| {
            let from_city = cities_by_id.get(&geometry.from_city_id)?;
            let to_city = cities_by_id.get(&geometry.to_city_id)?;
            let edge =
                edge_by_id.get(&(geometry.from_city_id.clone(), geometry.to_city_id.clone()));
            let metrics = route_geometry_metrics(
                &geometry.points,
                from_city.location,
                to_city.location,
                edge.map(|edge| edge.duration_min),
            );
            let anomaly_type = route_geometry_anomaly_type(geometry, edge.copied(), &metrics)?;
            Some(PipelineRouteGeometryAnomalyRecord {
                from_city_id: geometry.from_city_id.clone(),
                from_display_name: from_city.display_name.clone(),
                to_city_id: geometry.to_city_id.clone(),
                to_display_name: to_city.display_name.clone(),
                from_country_code: from_city.country_code.clone(),
                to_country_code: to_city.country_code.clone(),
                duration_min: edge.map(|edge| edge.duration_min),
                geometry_source: geometry.source.clone(),
                geometry_distance_km: meters_to_km_u32(metrics.geometry_meters),
                direct_distance_km: meters_to_km_u32(metrics.direct_meters),
                detour_ratio_x100: metrics.detour_ratio_x100,
                implied_speed_kmh: metrics.implied_speed_kmh,
                geometry_resolution_status: classify_geometry_resolution_status(
                    from_city.country_code.as_str(),
                    to_city.country_code.as_str(),
                    &geometry.source,
                    &geometry.provenance,
                    Some(anomaly_type.as_str()),
                )
                .to_string(),
                anomaly_type,
                provenance: geometry.provenance.clone(),
            })
        })
        .collect()
}

fn build_domestic_geometry_backlog_by_country(
    route_geometry_anomalies: &[PipelineRouteGeometryAnomalyRecord],
) -> Vec<PipelineDomesticGeometryBacklogRecord> {
    let mut grouped = BTreeMap::<String, Vec<&PipelineRouteGeometryAnomalyRecord>>::new();
    for record in route_geometry_anomalies {
        if record.geometry_resolution_status != "missing_domestic_authority" {
            continue;
        }
        grouped
            .entry(record.from_country_code.clone())
            .or_default()
            .push(record);
    }

    grouped
        .into_iter()
        .map(
            |(country_code, records)| PipelineDomesticGeometryBacklogRecord {
                country_code,
                route_count: records.len(),
                example_routes: records
                    .iter()
                    .take(5)
                    .map(|record| {
                        format!("{} -> {}", record.from_display_name, record.to_display_name)
                    })
                    .collect(),
            },
        )
        .collect()
}

fn build_cross_border_geometry_backlog_by_corridor(
    route_geometry_anomalies: &[PipelineRouteGeometryAnomalyRecord],
) -> Vec<PipelineCrossBorderGeometryBacklogRecord> {
    let mut grouped = BTreeMap::<(String, String), Vec<&PipelineRouteGeometryAnomalyRecord>>::new();
    for record in route_geometry_anomalies {
        if record.geometry_resolution_status != "cross_border_unresolved" {
            continue;
        }
        let (from_country_code, to_country_code) =
            canonicalize_corridor_country_pair(&record.from_country_code, &record.to_country_code);
        grouped
            .entry((from_country_code, to_country_code))
            .or_default()
            .push(record);
    }

    grouped
        .into_iter()
        .map(|((from_country_code, to_country_code), records)| {
            PipelineCrossBorderGeometryBacklogRecord {
                corridor_id: format!("{from_country_code}-{to_country_code}"),
                from_country_code,
                to_country_code,
                route_count: records.len(),
                example_routes: records
                    .iter()
                    .take(5)
                    .map(|record| {
                        format!("{} -> {}", record.from_display_name, record.to_display_name)
                    })
                    .collect(),
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug)]
struct RouteGeometryMetrics {
    geometry_meters: f64,
    direct_meters: f64,
    detour_ratio_x100: Option<u32>,
    implied_speed_kmh: Option<u32>,
}

fn canonicalize_corridor_country_pair(
    left_country_code: &str,
    right_country_code: &str,
) -> (String, String) {
    if left_country_code <= right_country_code {
        (
            left_country_code.to_string(),
            right_country_code.to_string(),
        )
    } else {
        (
            right_country_code.to_string(),
            left_country_code.to_string(),
        )
    }
}

fn route_geometry_metrics(
    points: &[PolylinePointE5],
    from_location: GeoPoint,
    to_location: GeoPoint,
    duration_min: Option<u32>,
) -> RouteGeometryMetrics {
    let geometry_meters = edge_geometry_length_meters(points);
    let direct_meters = geo_distance_meters(from_location, to_location);
    let detour_ratio_x100 =
        (direct_meters >= 1.0).then(|| ((geometry_meters / direct_meters) * 100.0).round() as u32);
    let implied_speed_kmh =
        duration_min
            .filter(|duration_min| *duration_min > 0)
            .map(|duration_min| {
                ((geometry_meters / 1_000.0) / (duration_min as f64 / 60.0)).round() as u32
            });

    RouteGeometryMetrics {
        geometry_meters,
        direct_meters,
        detour_ratio_x100,
        implied_speed_kmh,
    }
}

fn route_geometry_anomaly_type(
    geometry: &EdgeGeometryRecord,
    edge: Option<&aetrain_domain::TravelEdge>,
    metrics: &RouteGeometryMetrics,
) -> Option<String> {
    if geometry
        .provenance
        .iter()
        .any(|entry| entry == INVALID_RAILWAY_GEOMETRY_REJECTED_PROVENANCE)
    {
        return Some("rejected_invalid_railway_geometry".to_string());
    }
    if geometry
        .provenance
        .iter()
        .any(|entry| entry == INVALID_GTFS_SHAPE_GEOMETRY_REJECTED_PROVENANCE)
    {
        return Some("rejected_invalid_gtfs_shape_geometry".to_string());
    }

    if is_railway_layer_geometry_source(&geometry.source)
        && !route_geometry_distance_metrics_are_plausible(
            metrics.geometry_meters,
            metrics.direct_meters,
        )
    {
        return Some("railway_geometry_detour".to_string());
    }

    if edge.is_some() && route_geometry_speed_is_physically_impossible(metrics) {
        return Some("impossible_geometry_speed".to_string());
    }

    if geometry.source == EdgeGeometrySource::StraightLineFallback {
        return Some("straight_line_fallback".to_string());
    }

    None
}

fn route_geometry_speed_is_physically_impossible(metrics: &RouteGeometryMetrics) -> bool {
    metrics.implied_speed_kmh.is_some_and(|speed| speed > 380)
}

fn infer_home_country_code_from_provenance(provenance: &[String]) -> Option<&'static str> {
    for entry in provenance {
        if entry.starts_with("sncf-fr-gtfs:") {
            return Some("FR");
        }
        if entry.starts_with("ch-gtfs:") {
            return Some("CH");
        }
        if entry.starts_with("de-delfi-gtfs:") {
            return Some("DE");
        }
        if entry.starts_with("es-renfe-mainline-gtfs:")
            || entry.starts_with("es-renfe-cercanias-gtfs:")
        {
            return Some("ES");
        }
        if entry.starts_with("at-oebb-gtfs:") {
            return Some("AT");
        }
    }
    None
}

fn is_foreign_domestic_feed_leakage(
    home_country_code: &str,
    from_country_code: &str,
    to_country_code: &str,
) -> bool {
    from_country_code == to_country_code
        && from_country_code != "ZZ"
        && !from_country_code.eq_ignore_ascii_case(home_country_code)
}

fn is_foreign_cross_border_feed_leakage(
    home_country_code: &str,
    from_country_code: &str,
    to_country_code: &str,
) -> bool {
    from_country_code != "ZZ"
        && to_country_code != "ZZ"
        && !from_country_code.eq_ignore_ascii_case(to_country_code)
        && !from_country_code.eq_ignore_ascii_case(home_country_code)
        && !to_country_code.eq_ignore_ascii_case(home_country_code)
}

fn classify_geometry_resolution_status(
    from_country_code: &str,
    to_country_code: &str,
    geometry_source: &EdgeGeometrySource,
    provenance: &[String],
    anomaly_type: Option<&str>,
) -> &'static str {
    match anomaly_type {
        Some("rejected_invalid_railway_geometry") => return "rejected_rail_authority",
        Some("rejected_invalid_gtfs_shape_geometry") => return "rejected_shape_plausibility",
        Some("railway_geometry_detour") => return "railway_geometry_detour",
        Some("impossible_geometry_speed") => {
            return if *geometry_source == EdgeGeometrySource::GtfsShapeSegment {
                "rejected_shape_plausibility"
            } else {
                "impossible_edge_speed"
            };
        }
        _ => {}
    }

    if *geometry_source != EdgeGeometrySource::StraightLineFallback {
        return "resolved";
    }

    let Some(home_country_code) = infer_home_country_code_from_provenance(provenance) else {
        return "unclassified_straight_line";
    };

    if from_country_code == to_country_code {
        if is_foreign_domestic_feed_leakage(home_country_code, from_country_code, to_country_code) {
            return "foreign_domestic_leakage";
        }
        if from_country_code.eq_ignore_ascii_case(home_country_code) {
            return "missing_domestic_authority";
        }
        return "foreign_domestic_leakage";
    }

    if home_country_code.eq_ignore_ascii_case(from_country_code)
        || home_country_code.eq_ignore_ascii_case(to_country_code)
    {
        return "cross_border_unresolved";
    }

    if is_foreign_cross_border_feed_leakage(home_country_code, from_country_code, to_country_code) {
        return "foreign_cross_border_leakage";
    }

    "foreign_cross_border_leakage"
}

fn edge_geometry_length_meters(points: &[PolylinePointE5]) -> f64 {
    points
        .windows(2)
        .map(|window| {
            geo_distance_meters(
                polyline_point_to_geo(&window[0]),
                polyline_point_to_geo(&window[1]),
            )
        })
        .sum()
}

fn polyline_point_to_geo(point: &PolylinePointE5) -> GeoPoint {
    GeoPoint {
        lat: point.lat_e5 as f64 / 100_000.0,
        lon: point.lon_e5 as f64 / 100_000.0,
    }
}

fn meters_to_km_u32(meters: f64) -> u32 {
    (meters / 1_000.0).round().clamp(0.0, u32::MAX as f64) as u32
}

fn insert_route_geometry_coverage_counters(
    counters: &mut BTreeMap<String, u64>,
    edge_geometries: &EdgeGeometryArtifact,
) {
    let railway_layer_count = edge_geometries
        .geometries
        .iter()
        .filter(|geometry| is_railway_layer_geometry_source(&geometry.source))
        .count() as u64;
    let gtfs_shape_count = edge_geometries
        .geometries
        .iter()
        .filter(|geometry| geometry.source == EdgeGeometrySource::GtfsShapeSegment)
        .count() as u64;
    let straight_line_count = edge_geometries
        .geometries
        .iter()
        .filter(|geometry| geometry.source == EdgeGeometrySource::StraightLineFallback)
        .count() as u64;
    let non_railway_layer_count = edge_geometries.geometries.len() as u64 - railway_layer_count;

    counters.insert(
        "route_geometry_count".to_string(),
        edge_geometries.geometries.len() as u64,
    );
    counters.insert(
        "railway_layer_route_geometry_count".to_string(),
        railway_layer_count,
    );
    counters.insert(
        "non_railway_layer_route_geometry_count".to_string(),
        non_railway_layer_count,
    );
    counters.insert(
        "gtfs_shape_route_geometry_count".to_string(),
        gtfs_shape_count,
    );
    counters.insert(
        "straight_line_route_geometry_count".to_string(),
        straight_line_count,
    );
}

fn route_geometry_distance_metrics_are_plausible(geometry_meters: f64, direct_meters: f64) -> bool {
    if direct_meters < 1.0 {
        return geometry_meters <= 1_000.0;
    }
    geometry_meters <= max_plausible_route_geometry_meters(direct_meters)
}

fn max_plausible_route_geometry_meters(direct_meters: f64) -> f64 {
    if direct_meters < 1_000.0 {
        return direct_meters + 20_000.0;
    }
    if direct_meters < 30_000.0 {
        return (direct_meters * 6.0).max(direct_meters + 5_000.0);
    }
    if direct_meters < 100_000.0 {
        return direct_meters * 4.0;
    }
    if direct_meters < 300_000.0 {
        return direct_meters * 3.0;
    }
    direct_meters * 2.5
}

fn is_railway_layer_geometry_source(source: &EdgeGeometrySource) -> bool {
    matches!(
        source,
        EdgeGeometrySource::InfrastructureGraphFallback
            | EdgeGeometrySource::OsmGraphFallbackPlanned
    )
}

fn counter_value(counters: &BTreeMap<String, u64>, key: &str) -> u64 {
    counters.get(key).copied().unwrap_or(0)
}

fn quality_gate_equals(
    gate_id: &str,
    metric: &str,
    actual: u64,
    expected: u64,
) -> PipelineQualityGateResult {
    PipelineQualityGateResult {
        gate_id: gate_id.to_string(),
        metric: metric.to_string(),
        actual,
        target: format!("== {}", expected),
        status: if actual == expected {
            "pass".to_string()
        } else {
            "fail".to_string()
        },
    }
}

fn quality_gate_less_than(
    gate_id: &str,
    metric: &str,
    actual: u64,
    threshold: u64,
) -> PipelineQualityGateResult {
    PipelineQualityGateResult {
        gate_id: gate_id.to_string(),
        metric: metric.to_string(),
        actual,
        target: format!("< {}", threshold),
        status: if actual < threshold {
            "pass".to_string()
        } else {
            "fail".to_string()
        },
    }
}

fn quality_gate_less_than_or_equal(
    gate_id: &str,
    metric: &str,
    actual: u64,
    threshold: u64,
) -> PipelineQualityGateResult {
    PipelineQualityGateResult {
        gate_id: gate_id.to_string(),
        metric: metric.to_string(),
        actual,
        target: format!("<= {}", threshold),
        status: if actual <= threshold {
            "pass".to_string()
        } else {
            "fail".to_string()
        },
    }
}

fn city_quality_record(city: &aetrain_domain::City) -> PipelineCityQualityRecord {
    PipelineCityQualityRecord {
        city_id: city.city_id.clone(),
        display_name: city.display_name.clone(),
        country_code: city.country_code.clone(),
        station_count: city.station_ids.len(),
        wikidata_qid: city.wikidata_qid.clone(),
        population: city.population,
    }
}

fn abbreviation_candidate_record(
    city: &aetrain_domain::City,
) -> Option<PipelineAbbreviationCandidateRecord> {
    if is_legitimate_short_city_name(city) {
        return None;
    }
    let normalized_name = normalize_name(&city.display_name);
    let token_count = normalized_name.split_whitespace().count();
    let compact = normalized_name.replace(' ', "");
    let reason = if is_station_qualified_city_name(&city.display_name) {
        None
    } else if city.display_name.chars().any(|ch| ch.is_ascii_digit()) {
        Some("digit_or_route_like_name")
    } else if token_count > 1
        && normalized_name
            .split_whitespace()
            .all(|token| token.len() <= 2)
    {
        Some("multi_token_short_code")
    } else if compact.len() <= 2 {
        Some("single_token_too_short")
    } else if compact.chars().all(|ch| ch.is_ascii_alphabetic())
        && compact.len() <= 4
        && compact.chars().all(|ch| !"aeiouy".contains(ch))
    {
        Some("single_token_consonant_only_code")
    } else if city.display_name == city.display_name.to_ascii_uppercase() && compact.len() <= 5 {
        Some("uppercase_code")
    } else {
        None
    };
    let reason = reason?;
    Some(PipelineAbbreviationCandidateRecord {
        city_id: city.city_id.clone(),
        display_name: city.display_name.clone(),
        country_code: city.country_code.clone(),
        normalized_name,
        reason: reason.to_string(),
    })
}

fn is_legitimate_short_city_name(city: &aetrain_domain::City) -> bool {
    matches!(
        (
            city.country_code.as_str(),
            normalize_name(&city.display_name).as_str()
        ),
        ("FR", "eu")
            | ("FR", "ay")
            | ("CH", "au sg")
            | ("CH", "au zh")
            | ("CH", "ay f")
            | ("CH", "re")
    )
}

fn route_like_candidate_record(
    city: &aetrain_domain::City,
) -> Option<PipelineAbbreviationCandidateRecord> {
    let record = abbreviation_candidate_record(city)?;
    (record.reason == "digit_or_route_like_name").then_some(record)
}

fn build_route_like_residual_records(
    route_like_candidates: &[PipelineAbbreviationCandidateRecord],
    station_mappings: Option<&StationMappingReport>,
) -> Vec<PipelineRouteLikeResidualRecord> {
    let mapping_strategies = station_mappings
        .map(|report| {
            report
                .records
                .iter()
                .map(|record| {
                    (
                        record.city_id.as_str().to_string(),
                        station_mapping_strategy_label(&record.mapping_strategy).to_string(),
                    )
                })
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();

    route_like_candidates
        .iter()
        .map(|candidate| {
            let mapping_strategy = mapping_strategies.get(candidate.city_id.as_str()).cloned();
            let (classification, suggested_action) =
                classify_route_like_residual(candidate, mapping_strategy.as_deref());
            let derived_parent_key = if classification == "station_only_feed_stop_label" {
                None
            } else {
                route_like_primary_parent_key(&candidate.display_name)
            };
            PipelineRouteLikeResidualRecord {
                city_id: candidate.city_id.clone(),
                display_name: candidate.display_name.clone(),
                country_code: candidate.country_code.clone(),
                normalized_name: candidate.normalized_name.clone(),
                mapping_strategy,
                classification: classification.to_string(),
                suggested_action: suggested_action.to_string(),
                derived_parent_key,
            }
        })
        .collect()
}

fn classify_route_like_residual(
    candidate: &PipelineAbbreviationCandidateRecord,
    mapping_strategy: Option<&str>,
) -> (&'static str, &'static str) {
    let normalized = candidate.normalized_name.as_str();
    if normalized.starts_with("bus")
        || normalized == "g23"
        || normalized.chars().all(|ch| ch.is_ascii_alphanumeric())
            && normalized.chars().any(|ch| ch.is_ascii_digit())
            && normalized.split_whitespace().count() <= 2
    {
        return (
            "station_only_feed_stop_label",
            "keep as station only and require stronger parent-city authority before demotion",
        );
    }

    match mapping_strategy {
        Some("fallback_reference_gap") => (
            "reference_gap_parent_city_missing",
            "expand registry or reference-city coverage for the derived parent locality",
        ),
        Some("gtfs_stem_cluster") => (
            "feed_cluster_leak_without_parent_match",
            "tighten feed clustering or add authority-backed parent-city matching",
        ),
        _ => (
            "unresolved_route_like_local_stop",
            "keep unresolved until stronger authority or matching evidence exists",
        ),
    }
}

fn station_mapping_strategy_label(strategy: &crate::sncf::StationMappingStrategy) -> &'static str {
    match strategy {
        crate::sncf::StationMappingStrategy::ManualOverride => "manual_override",
        crate::sncf::StationMappingStrategy::ReferenceUic => "reference_uic",
        crate::sncf::StationMappingStrategy::ReferenceName => "reference_name",
        crate::sncf::StationMappingStrategy::FallbackReferenceGap => "fallback_reference_gap",
        crate::sncf::StationMappingStrategy::GtfsStemCluster => "gtfs_stem_cluster",
    }
}

fn city_id_has_registry_qid(city: &aetrain_domain::City) -> bool {
    let Some(qid) = city.wikidata_qid.as_deref() else {
        return false;
    };
    city.city_id.as_str().ends_with(&qid.to_ascii_lowercase())
}

fn export_web_debug_bundle(
    output_dir: &Path,
    meta: &DatasetMeta,
    canonical: &DatasetBundle,
    edge_geometries: &Option<EdgeGeometryArtifact>,
    attribution: &PipelineAttributionFile,
) -> Result<()> {
    let edge_geometries = resolved_edge_geometries(canonical, edge_geometries)?;
    write_json(&output_dir.join("meta.json"), meta)?;
    write_json(&output_dir.join("cities.json"), &canonical.cities)?;
    write_json(&output_dir.join("edges.json"), &canonical.edges)?;
    export_chunked_web_debug_edge_geometries(output_dir, &edge_geometries)?;
    write_json(&output_dir.join("attribution.json"), attribution)?;
    Ok(())
}

fn export_web_runtime_bundle(
    output_dir: &Path,
    canonical: &DatasetBundle,
    edge_geometries: &Option<EdgeGeometryArtifact>,
    attribution: &PipelineAttributionFile,
) -> Result<()> {
    let edge_geometries = resolved_edge_geometries(canonical, edge_geometries)?;
    let (runtime_bundle, station_artifact, runtime_edge_geometries) =
        build_web_runtime_bundle(canonical, &edge_geometries)?;
    write_json(&output_dir.join("meta.json"), &runtime_bundle.meta)?;
    write_json(
        &output_dir.join("countries.json"),
        &runtime_bundle.countries,
    )?;
    write_json(&output_dir.join("cities.json"), &runtime_bundle.cities)?;
    write_json(&output_dir.join("graph.json"), &runtime_bundle.graph)?;
    write_json(&output_dir.join("aliases.json"), &runtime_bundle.aliases)?;
    write_json(&output_dir.join("stations.json"), &station_artifact)?;
    write_json(
        &output_dir.join("route-geometries.json"),
        &runtime_edge_geometries,
    )?;
    write_json(&output_dir.join("attribution.json"), attribution)?;
    Ok(())
}

fn build_web_runtime_bundle(
    canonical: &DatasetBundle,
    edge_geometries: &EdgeGeometryArtifact,
) -> Result<(
    RuntimeDatasetBundle,
    RuntimeStationArtifact,
    RuntimeEdgeGeometryArtifact,
)> {
    let mut country_index_by_code = BTreeMap::<String, u16>::new();
    let mut countries = Vec::<RuntimeCountryRecord>::new();
    for city in &canonical.cities {
        if country_index_by_code.contains_key(&city.country_code) {
            continue;
        }
        let index = countries.len() as u16;
        country_index_by_code.insert(city.country_code.clone(), index);
        countries.push(RuntimeCountryRecord {
            code: city.country_code.clone(),
            display_name: country_display_name(&city.country_code),
        });
    }

    let city_index_by_id = canonical
        .cities
        .iter()
        .enumerate()
        .map(|(index, city)| (city.city_id.clone(), index as u32))
        .collect::<HashMap<_, _>>();

    let cities = canonical
        .cities
        .iter()
        .map(|city| {
            let country_index = *country_index_by_code
                .get(&city.country_code)
                .expect("country should exist");
            Ok(aetrain_dataset::RuntimeCityRecord {
                city_id: city.city_id.clone(),
                slug: city.slug.clone(),
                display_name: city.display_name.clone(),
                country_index,
                lat_e5: scale_coord_e5(city.location.lat)?,
                lon_e5: scale_coord_e5(city.location.lon)?,
                population: city
                    .population
                    .map(|value| value.min(u32::MAX as u64) as u32),
                interest_score: city.interest_score,
                map_rank: Some(compute_map_rank(city)),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let graph = build_runtime_graph(canonical, &city_index_by_id)?;
    let aliases = build_runtime_alias_index(canonical, &city_index_by_id)?;
    let station_artifact = build_runtime_station_artifact(canonical, &city_index_by_id)?;
    let edge_geometry_artifact =
        build_runtime_edge_geometry_artifact(edge_geometries, &city_index_by_id)?;
    let city_count = cities.len();
    let meta = RuntimeDatasetMeta::from_canonical(
        &canonical.meta,
        countries.len() as u16,
        city_count as u32,
        graph.edge_count() as u32,
        aliases.records.len() as u32,
    );
    let runtime_bundle = RuntimeDatasetBundle {
        meta,
        countries,
        cities,
        graph,
        aliases,
    };
    runtime_bundle
        .validate()
        .map_err(|error| anyhow::anyhow!("runtime web bundle validation failed: {error:?}"))?;
    edge_geometry_artifact
        .validate(city_count)
        .map_err(|error| anyhow::anyhow!("runtime route geometry validation failed: {error:?}"))?;

    Ok((runtime_bundle, station_artifact, edge_geometry_artifact))
}

fn build_runtime_graph(
    canonical: &DatasetBundle,
    city_index_by_id: &HashMap<aetrain_domain::CityId, u32>,
) -> Result<RuntimeGraph> {
    let city_count = canonical.cities.len();
    let mut outgoing = vec![Vec::<(u32, u16, u8)>::new(); city_count];
    for edge in &canonical.edges {
        let from_index = *city_index_by_id
            .get(&edge.from_city_id)
            .with_context(|| format!("missing from_city_id {}", edge.from_city_id))?
            as usize;
        let to_index = *city_index_by_id
            .get(&edge.to_city_id)
            .with_context(|| format!("missing to_city_id {}", edge.to_city_id))?;
        let duration_min = edge.duration_min.min(u16::MAX as u32) as u16;
        outgoing[from_index].push((to_index, duration_min, encode_mode_flags(edge)));
    }

    let mut edge_offsets = Vec::with_capacity(city_count + 1);
    let mut edge_targets = Vec::new();
    let mut edge_durations_min = Vec::new();
    let mut edge_mode_flags = Vec::new();
    edge_offsets.push(0);
    for edges in &mut outgoing {
        edges.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        for (target, duration, mode_flags) in edges {
            edge_targets.push(*target);
            edge_durations_min.push(*duration);
            edge_mode_flags.push(*mode_flags);
        }
        edge_offsets.push(edge_targets.len() as u32);
    }

    Ok(RuntimeGraph {
        edge_offsets,
        edge_targets,
        edge_durations_min,
        edge_mode_flags,
    })
}

fn build_runtime_alias_index(
    canonical: &DatasetBundle,
    city_index_by_id: &HashMap<aetrain_domain::CityId, u32>,
) -> Result<RuntimeAliasIndex> {
    let mut records = canonical
        .aliases
        .iter()
        .map(|alias| {
            let city_index = *city_index_by_id
                .get(&alias.city_id)
                .with_context(|| format!("missing alias city_id {}", alias.city_id))?;
            Ok(RuntimeAliasRecord {
                normalized_alias: alias.alias.clone(),
                city_index,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.normalized_alias
            .cmp(&right.normalized_alias)
            .then_with(|| left.city_index.cmp(&right.city_index))
    });
    Ok(RuntimeAliasIndex { records })
}

fn build_runtime_station_artifact(
    canonical: &DatasetBundle,
    city_index_by_id: &HashMap<aetrain_domain::CityId, u32>,
) -> Result<RuntimeStationArtifact> {
    let stations = canonical
        .stations
        .iter()
        .map(|station| {
            let city_index = *city_index_by_id
                .get(&station.city_id)
                .with_context(|| format!("missing station city_id {}", station.city_id))?;
            Ok(RuntimeStationRecord {
                station_id: station.station_id.as_str().to_string(),
                city_index,
                display_name: station.display_name.clone(),
                lat_e5: scale_coord_e5(station.location.lat)?,
                lon_e5: scale_coord_e5(station.location.lon)?,
                uic_code: station.uic_code.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(RuntimeStationArtifact { stations })
}

fn build_runtime_edge_geometry_artifact(
    edge_geometries: &EdgeGeometryArtifact,
    city_index_by_id: &HashMap<aetrain_domain::CityId, u32>,
) -> Result<RuntimeEdgeGeometryArtifact> {
    let geometries = edge_geometries
        .geometries
        .iter()
        .map(|geometry| {
            let from_city_index =
                *city_index_by_id
                    .get(&geometry.from_city_id)
                    .with_context(|| {
                        format!(
                            "missing route geometry from_city_id {}",
                            geometry.from_city_id
                        )
                    })?;
            let to_city_index = *city_index_by_id
                .get(&geometry.to_city_id)
                .with_context(|| {
                    format!("missing route geometry to_city_id {}", geometry.to_city_id)
                })?;
            Ok(RuntimeEdgeGeometryRecord {
                from_city_index,
                to_city_index,
                points: geometry.points.clone(),
                source: geometry.source.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(RuntimeEdgeGeometryArtifact { geometries })
}

fn resolved_edge_geometries(
    canonical: &DatasetBundle,
    edge_geometries: &Option<EdgeGeometryArtifact>,
) -> Result<EdgeGeometryArtifact> {
    if let Some(edge_geometries) = edge_geometries {
        return Ok(edge_geometries.clone());
    }

    let city_by_id = canonical
        .cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<HashMap<_, _>>();
    let geometries = canonical
        .edges
        .iter()
        .map(|edge| {
            let from_city = city_by_id
                .get(&edge.from_city_id)
                .with_context(|| format!("missing from city {}", edge.from_city_id))?;
            let to_city = city_by_id
                .get(&edge.to_city_id)
                .with_context(|| format!("missing to city {}", edge.to_city_id))?;
            Ok(EdgeGeometryRecord {
                from_city_id: edge.from_city_id.clone(),
                to_city_id: edge.to_city_id.clone(),
                points: vec![
                    PolylinePointE5 {
                        lat_e5: scale_coord_e5(from_city.location.lat)?,
                        lon_e5: scale_coord_e5(from_city.location.lon)?,
                    },
                    PolylinePointE5 {
                        lat_e5: scale_coord_e5(to_city.location.lat)?,
                        lon_e5: scale_coord_e5(to_city.location.lon)?,
                    },
                ],
                source: EdgeGeometrySource::StraightLineFallback,
                provenance: edge.provenance.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(EdgeGeometryArtifact { geometries })
}

fn scale_coord_e5(value: f64) -> Result<i32> {
    let scaled = (value * 100_000.0).round();
    if scaled < i32::MIN as f64 || scaled > i32::MAX as f64 {
        bail!("coordinate {value} is out of i32 e5 range");
    }
    Ok(scaled as i32)
}

fn compute_map_rank(city: &aetrain_domain::City) -> u16 {
    let population_rank = city
        .population
        .map(|value| (value / 100_000).min(u16::MAX as u64) as u16)
        .unwrap_or(0);
    let interest_rank = city.interest_score.unwrap_or(0) as u16 * 10;
    population_rank
        .max(interest_rank)
        .max(city.station_ids.len() as u16)
}

fn encode_mode_flags(edge: &aetrain_domain::TravelEdge) -> u8 {
    let mut flags = 0u8;
    match edge.service_kind {
        ServiceKind::Rail => flags |= 0b0000_0001,
        ServiceKind::Ferry => flags |= 0b0000_0010,
    }
    match edge.service_class {
        ServiceClass::Intercity => flags |= 0b0000_0100,
        ServiceClass::Regional => flags |= 0b0000_1000,
        ServiceClass::Ferry => flags |= 0b0001_0000,
    }
    flags
}

fn country_display_name(country_code: &str) -> String {
    match country_code {
        "FR" => "France".to_string(),
        "ZZ" => "Imported".to_string(),
        other => other.to_string(),
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("failed to serialize JSON output")?;
    fs::write(path, bytes).with_context(|| format!("failed to write {}", path.display()))
}

fn write_json_compact(path: &Path, value: &(impl Serialize + ?Sized)) -> Result<()> {
    let bytes = serde_json::to_vec(value).context("failed to serialize compact JSON output")?;
    fs::write(path, bytes).with_context(|| format!("failed to write {}", path.display()))
}

fn export_chunked_web_debug_edge_geometries(
    output_dir: &Path,
    edge_geometries: &EdgeGeometryArtifact,
) -> Result<()> {
    let chunk_ranges = chunk_edge_geometry_ranges(
        &edge_geometries.geometries,
        WEB_DEBUG_EDGE_GEOMETRY_CHUNK_TARGET_BYTES,
    )?;
    let chunk_dir = output_dir.join("edge-geometries");
    recreate_dir(&chunk_dir)?;

    let mut manifest = ChunkedEdgeGeometryManifest {
        version: 1,
        total_geometry_count: edge_geometries.geometries.len(),
        chunk_target_bytes: WEB_DEBUG_EDGE_GEOMETRY_CHUNK_TARGET_BYTES,
        chunks: Vec::with_capacity(chunk_ranges.len()),
    };

    for (chunk_index, range) in chunk_ranges.iter().enumerate() {
        let file_name = format!("chunk-{chunk_index:04}.json");
        let relative_file = format!("edge-geometries/{file_name}");
        let chunk_path = chunk_dir.join(&file_name);
        write_json_compact(&chunk_path, &edge_geometries.geometries[range.clone()])?;
        manifest.chunks.push(ChunkedEdgeGeometryManifestChunk {
            file: relative_file,
            geometry_count: range.len(),
        });
    }

    write_json(&output_dir.join("edge-geometries.manifest.json"), &manifest)?;
    Ok(())
}

fn chunk_edge_geometry_ranges(
    geometries: &[EdgeGeometryRecord],
    max_bytes: usize,
) -> Result<Vec<std::ops::Range<usize>>> {
    if geometries.is_empty() {
        return Ok(Vec::new());
    }

    let mut ranges = Vec::new();
    let mut chunk_start = 0usize;
    let mut chunk_bytes = 2usize;

    for (index, geometry) in geometries.iter().enumerate() {
        let geometry_bytes = serde_json::to_vec(geometry)
            .context("failed to size edge geometry record for chunking")?
            .len();
        let separator_bytes = usize::from(index > chunk_start);
        if index > chunk_start && chunk_bytes + separator_bytes + geometry_bytes > max_bytes {
            ranges.push(chunk_start..index);
            chunk_start = index;
            chunk_bytes = 2 + geometry_bytes;
            continue;
        }
        chunk_bytes += separator_bytes + geometry_bytes;
    }

    ranges.push(chunk_start..geometries.len());
    Ok(ranges)
}

fn recreate_dir(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_dir_all(path).with_context(|| format!("failed to remove {}", path.display()))?;
    }
    fs::create_dir_all(path).with_context(|| format!("failed to create {}", path.display()))
}

fn copy_dir_contents(source_dir: &Path, destination: &Path) -> Result<()> {
    for entry in fs::read_dir(source_dir)
        .with_context(|| format!("failed to read {}", source_dir.display()))?
    {
        let entry =
            entry.with_context(|| format!("failed to read entry in {}", source_dir.display()))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry
            .file_type()
            .with_context(|| format!("failed to inspect {}", source_path.display()))?
            .is_dir()
        {
            fs::create_dir_all(&destination_path)
                .with_context(|| format!("failed to create {}", destination_path.display()))?;
            copy_dir_contents(&source_path, &destination_path)?;
            continue;
        }
        fs::copy(&source_path, &destination_path).with_context(|| {
            format!(
                "failed to copy {} into {}",
                source_path.display(),
                destination_path.display()
            )
        })?;
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct AggregateTargetInput {
    target_id: String,
    manifest: PipelineArtifactManifest,
    canonical: DatasetBundle,
    edge_geometries: EdgeGeometryArtifact,
    station_mappings: Option<StationMappingReport>,
    rejected_city_candidates: Option<crate::RejectedCityCandidateReport>,
    issues: Vec<NormalizationIssue>,
}

fn load_aggregate_target_input(
    output_root: &Path,
    target_id: &str,
) -> Result<AggregateTargetInput> {
    let artifact_manifest_path = output_root.join(target_id).join("artifact-manifest.json");
    let manifest: PipelineArtifactManifest = read_json(&artifact_manifest_path)
        .with_context(|| format!("failed to load manifest for dependency target {target_id}"))?;
    let canonical_dir = manifest.outputs.canonical_dir.as_ref().with_context(|| {
        format!(
            "target {} does not export canonical artifacts required for aggregation",
            target_id
        )
    })?;
    let canonical_dir = PathBuf::from(canonical_dir);

    let canonical = read_json::<DatasetBundle>(&canonical_dir.join("bundle.json"))?;
    let edge_geometries =
        read_json::<EdgeGeometryArtifact>(&canonical_dir.join("edge-geometries.json"))?;
    let station_mappings_path = canonical_dir.join("station-mappings.json");
    let station_mappings = if station_mappings_path.exists() {
        Some(read_json::<StationMappingReport>(&station_mappings_path)?)
    } else {
        None
    };
    let rejected_city_candidates_path = canonical_dir.join("rejected-city-candidates.json");
    let rejected_city_candidates = if rejected_city_candidates_path.exists() {
        Some(read_json::<crate::RejectedCityCandidateReport>(
            &rejected_city_candidates_path,
        )?)
    } else {
        None
    };
    let _duplicates =
        read_json::<DuplicateCityReport>(&canonical_dir.join("duplicate-candidates.json"))?;
    let issues = read_json::<Vec<NormalizationIssue>>(&canonical_dir.join("issues.json"))?;

    Ok(AggregateTargetInput {
        target_id: target_id.to_string(),
        manifest,
        canonical,
        edge_geometries,
        station_mappings,
        rejected_city_candidates,
        issues,
    })
}

fn build_aggregate_bundle(request: AdapterBuildRequest<'_>) -> Result<AdapterBuildArtifacts> {
    if request.target.input_target_ids.is_empty() {
        bail!(
            "aggregate target {} must declare input_target_ids",
            request.target.id
        );
    }
    if !request.target.source_ids.is_empty() {
        bail!(
            "aggregate target {} must not declare source_ids",
            request.target.id
        );
    }

    let dependency_inputs = request
        .target
        .input_target_ids
        .iter()
        .map(|target_id| load_aggregate_target_input(request.output_root, target_id))
        .collect::<Result<Vec<_>>>()?;
    let authority_registry =
        load_geometry_authority_registry(request.manifest_dir, request.target)?;

    let source_snapshots = merge_source_snapshots(&dependency_inputs);
    let source_artifacts = merge_source_artifacts(&dependency_inputs);
    let rejected_city_candidates = merge_rejected_city_candidates(&dependency_inputs);
    let notes = vec![format!(
        "Aggregated canonical outputs from {} validated targets.",
        dependency_inputs.len()
    )];
    let mut counters = BTreeMap::from([
        (
            "dependency_target_count".to_string(),
            dependency_inputs.len() as u64,
        ),
        (
            "dependency_source_count".to_string(),
            source_snapshots.len() as u64,
        ),
        (
            "source_rejected_city_candidate_count".to_string(),
            dependency_inputs
                .iter()
                .map(|input| {
                    input
                        .manifest
                        .summary
                        .counters
                        .get("source_rejected_city_candidate_count")
                        .copied()
                        .unwrap_or(0)
                })
                .sum(),
        ),
        (
            "source_demoted_city_candidate_count".to_string(),
            dependency_inputs
                .iter()
                .map(|input| {
                    input
                        .manifest
                        .summary
                        .counters
                        .get("source_demoted_city_candidate_count")
                        .copied()
                        .unwrap_or(0)
                })
                .sum(),
        ),
        (
            "source_unresolved_city_candidate_count".to_string(),
            dependency_inputs
                .iter()
                .map(|input| {
                    input
                        .manifest
                        .summary
                        .counters
                        .get("source_unresolved_city_candidate_count")
                        .copied()
                        .unwrap_or(0)
                })
                .sum(),
        ),
    ]);

    let mut merged_cities = merge_cities(&dependency_inputs, request.target.id.as_str());
    counters.insert(
        "route_like_city_demoted_count".to_string(),
        merged_cities.route_like_demotion_stats.demoted_count,
    );
    counters.insert(
        "route_like_city_unresolved_count".to_string(),
        merged_cities.route_like_demotion_stats.unresolved_count,
    );
    counters.insert(
        "route_like_city_ambiguous_count".to_string(),
        merged_cities.route_like_demotion_stats.ambiguous_count,
    );
    if let Some(registry_overlay_path) = request.target.registry_overlay_path.as_deref() {
        let overlay_path =
            resolve_manifest_relative_path(request.manifest_dir, registry_overlay_path);
        let overlay: RegistryCanonicalBundle = read_json(&overlay_path).with_context(|| {
            format!(
                "failed to load registry overlay bundle from {}",
                overlay_path.display()
            )
        })?;
        let overlay_stats = apply_registry_city_authority(
            &mut merged_cities.cities,
            &mut merged_cities.city_id_remap,
            &overlay,
            request.target.id.as_str(),
            &mut merged_cities.issues,
        );
        merged_cities.aliases = rebuild_alias_records(&merged_cities.cities);
        counters.insert(
            "registry_overlay_match_count".to_string(),
            overlay_stats.matched_count,
        );
        counters.insert(
            "registry_overlay_unmatched_count".to_string(),
            overlay_stats.unmatched_count,
        );
        counters.insert(
            "registry_overlay_ambiguous_count".to_string(),
            overlay_stats.ambiguous_count,
        );
        counters.insert(
            "registry_overlay_country_correction_count".to_string(),
            overlay_stats.country_corrected_count,
        );
        counters.insert(
            "registry_overlay_station_rescue_count".to_string(),
            overlay_stats.station_promoted_count,
        );
    }
    let pre_cleanup_station_mappings =
        merge_station_mappings(&dependency_inputs, &merged_cities.city_id_remap);
    cleanup_station_like_and_zz_residual_cities(
        &mut merged_cities.cities,
        &mut merged_cities.city_id_remap,
        &pre_cleanup_station_mappings,
        request.target.id.as_str(),
        &mut merged_cities.issues,
    );
    let post_cleanup_remap = build_aggregate_city_id_remap(
        merged_cities.cities.iter().collect(),
        request.target.id.as_str(),
        &mut merged_cities.issues,
    );
    if !post_cleanup_remap.is_empty() {
        for (from_city_id, to_city_id) in &post_cleanup_remap {
            rebind_city_id_remap(&mut merged_cities.city_id_remap, from_city_id, to_city_id);
        }
        merged_cities.cities =
            collapse_cities_by_remap(merged_cities.cities.drain(..), &post_cleanup_remap)
                .into_values()
                .collect();
    }
    counters.insert(
        "route_like_city_unresolved_count".to_string(),
        merged_cities
            .cities
            .iter()
            .filter(|city| route_like_candidate_record(city).is_some())
            .count() as u64,
    );
    merged_cities.aliases = rebuild_alias_records(&merged_cities.cities);
    let mut stations = merge_stations(
        &dependency_inputs,
        &merged_cities.city_id_remap,
        request.target.id.as_str(),
    )?;
    let mut edges = merge_edges(&dependency_inputs, &merged_cities.city_id_remap);
    let mut edge_geometries =
        merge_edge_geometries(&dependency_inputs, &merged_cities.city_id_remap);
    let foreign_domestic_feed_leakage_rejected_count = reject_foreign_domestic_feed_leakage(
        &mut edges,
        &mut edge_geometries,
        &merged_cities.cities,
        request.target.id.as_str(),
        &mut merged_cities.issues,
    );
    let foreign_cross_border_feed_leakage_rejected_count = reject_foreign_cross_border_feed_leakage(
        &mut edges,
        &mut edge_geometries,
        &merged_cities.cities,
        request.target.id.as_str(),
        &mut merged_cities.issues,
    );
    let impossible_edge_speed_rejected_count = reject_impossible_edge_speeds(
        &mut edges,
        &mut edge_geometries,
        &merged_cities.cities,
        request.target.id.as_str(),
        &mut merged_cities.issues,
    );
    let invalid_railway_route_geometry_rejected_count = reject_invalid_railway_layer_geometries(
        &mut edge_geometries,
        &merged_cities.cities,
        &edges,
        request.target.id.as_str(),
        &mut merged_cities.issues,
    );
    let invalid_gtfs_shape_geometry_rejected_count = reject_invalid_gtfs_shape_geometries(
        &mut edge_geometries,
        &merged_cities.cities,
        &edges,
        request.target.id.as_str(),
        &mut merged_cities.issues,
    );
    let aggregate_rail_geometry_repair_count = apply_aggregate_rail_geometry_authority(
        &mut edge_geometries,
        &merged_cities.cities,
        &edges,
        &dependency_inputs,
        request.manifest,
        authority_registry.as_ref(),
        request.target.id.as_str(),
        &mut merged_cities.issues,
    )?;
    counters.insert(
        "aggregate_rail_geometry_repair_count".to_string(),
        aggregate_rail_geometry_repair_count,
    );
    counters.insert(
        "foreign_domestic_feed_leakage_rejected_count".to_string(),
        foreign_domestic_feed_leakage_rejected_count,
    );
    counters.insert(
        "foreign_cross_border_feed_leakage_rejected_count".to_string(),
        foreign_cross_border_feed_leakage_rejected_count,
    );
    counters.insert(
        "impossible_edge_speed_rejected_count".to_string(),
        impossible_edge_speed_rejected_count,
    );
    counters.insert(
        "invalid_railway_route_geometry_rejected_count".to_string(),
        invalid_railway_route_geometry_rejected_count,
    );
    counters.insert(
        "invalid_gtfs_shape_geometry_rejected_count".to_string(),
        invalid_gtfs_shape_geometry_rejected_count,
    );
    insert_route_geometry_coverage_counters(&mut counters, &edge_geometries);
    let mut station_mappings =
        merge_station_mappings(&dependency_inputs, &merged_cities.city_id_remap);
    let quarantined_fallback_gap_cities = quarantine_unresolved_fallback_gap_pseudo_cities(
        &mut merged_cities.cities,
        &mut merged_cities.aliases,
        &mut stations,
        &mut edges,
        &mut edge_geometries,
        &mut station_mappings,
        request.target.id.as_str(),
        &mut merged_cities.issues,
    );
    let aggregate_promoted_authority_networks = load_aggregate_promoted_country_authority_networks(
        &dependency_inputs,
        request.manifest,
        authority_registry.as_ref(),
    )?;
    let quarantined_promoted_attachment_gap_cities =
        quarantine_placeholder_promoted_attachment_gap_cities(
            &mut merged_cities.cities,
            &mut merged_cities.aliases,
            &mut stations,
            &mut edges,
            &mut edge_geometries,
            &mut station_mappings,
            authority_registry.as_ref(),
            &aggregate_promoted_authority_networks,
            request.target.id.as_str(),
            &mut merged_cities.issues,
        );
    counters.insert(
        "quarantined_fallback_gap_city_count".to_string(),
        quarantined_fallback_gap_cities.len() as u64,
    );
    counters.insert(
        "quarantined_promoted_attachment_gap_city_count".to_string(),
        quarantined_promoted_attachment_gap_cities.len() as u64,
    );
    apply_computed_city_enrichment(&mut merged_cities.cities, &edges);
    counters.insert(
        "residual_station_like_city_count".to_string(),
        merged_cities
            .cities
            .iter()
            .filter(|city| is_station_qualified_city_name(&city.display_name))
            .count() as u64,
    );
    counters.insert(
        "residual_zz_city_count".to_string(),
        merged_cities
            .cities
            .iter()
            .filter(|city| city.country_code == "ZZ")
            .count() as u64,
    );
    let duplicates = recompute_duplicates(request.generated_at, &merged_cities.cities);

    let mut issues = dependency_inputs
        .iter()
        .flat_map(|input| input.issues.iter().cloned())
        .collect::<Vec<_>>();
    issues.extend(merged_cities.issues);

    let canonical = DatasetBundle {
        meta: DatasetMeta {
            schema_version: request.manifest.schema_version,
            dataset_version: request.dataset_version.to_string(),
            generated_at: request.generated_at.to_string(),
            source_snapshots,
            attribution_path: "attribution.json".to_string(),
        },
        cities: merged_cities.cities,
        stations,
        edges,
        aliases: merged_cities.aliases,
    };

    Ok(AdapterBuildArtifacts {
        canonical,
        edge_geometries: Some(edge_geometries),
        station_mappings: Some(station_mappings),
        rejected_city_candidates: Some(rejected_city_candidates),
        quarantined_fallback_gap_cities,
        quarantined_promoted_attachment_gap_cities,
        duplicates,
        issues,
        counters,
        notes,
        source_artifacts,
    })
}

fn merge_source_snapshots(inputs: &[AggregateTargetInput]) -> Vec<SourceSnapshot> {
    let mut seen = BTreeSet::new();
    let mut snapshots = Vec::new();
    for input in inputs {
        for snapshot in &input.manifest.source_snapshots {
            let key = (
                snapshot.source_id.clone(),
                snapshot.fetched_at.clone(),
                snapshot.version_hint.clone(),
            );
            if seen.insert(key) {
                snapshots.push(snapshot.clone());
            }
        }
    }
    snapshots.sort_by(|left, right| left.source_id.cmp(&right.source_id));
    snapshots
}

fn merge_source_artifacts(inputs: &[AggregateTargetInput]) -> Vec<PipelineSourceArtifact> {
    let mut deduped = BTreeMap::<String, PipelineSourceArtifact>::new();
    for input in inputs {
        for artifact in &input.manifest.source_artifacts {
            deduped
                .entry(artifact.source_id.clone())
                .and_modify(|existing| {
                    if artifact.fetched_at > existing.fetched_at {
                        *existing = artifact.clone();
                    }
                })
                .or_insert_with(|| artifact.clone());
        }
    }
    deduped.into_values().collect()
}

fn merge_rejected_city_candidates(
    inputs: &[AggregateTargetInput],
) -> crate::RejectedCityCandidateReport {
    let mut records = Vec::new();
    for input in inputs {
        if let Some(report) = &input.rejected_city_candidates {
            records.extend(report.records.clone());
        }
    }
    crate::RejectedCityCandidateReport { records }
}

fn merge_cities(inputs: &[AggregateTargetInput], aggregate_source_id: &str) -> MergedCityOutput {
    let mut merged_by_input_id = BTreeMap::<aetrain_domain::CityId, aetrain_domain::City>::new();
    let mut issues = Vec::new();

    for input in inputs {
        for city in &input.canonical.cities {
            merged_by_input_id
                .entry(city.city_id.clone())
                .and_modify(|existing| {
                    if existing.slug != city.slug || existing.country_code != city.country_code {
                        issues.push(NormalizationIssue {
                            severity: crate::IssueSeverity::Warning,
                            source_id: aggregate_source_id.to_string(),
                            entity_ref: city.city_id.to_string(),
                            message: format!(
                                "conflicting city identity while aggregating {} from {}",
                                city.city_id, input.target_id
                            ),
                        });
                        return;
                    }

                    if existing.display_name != city.display_name {
                        if !existing
                            .aliases
                            .iter()
                            .any(|alias| alias == &city.display_name)
                        {
                            existing.aliases.push(city.display_name.clone());
                        }
                        if city.population.unwrap_or(0) > existing.population.unwrap_or(0) {
                            existing.display_name = city.display_name.clone();
                        }
                    }

                    if existing.wikidata_qid.is_none() {
                        existing.wikidata_qid = city.wikidata_qid.clone();
                    }
                    existing.population = merge_optional_u64(existing.population, city.population);
                    existing.interest_score =
                        merge_optional_u8(existing.interest_score, city.interest_score);
                    existing.location = merge_geo_points(existing.location, city.location);
                    merge_station_ids(&mut existing.station_ids, &city.station_ids);
                    merge_string_vec(&mut existing.aliases, &city.aliases);
                })
                .or_insert_with(|| city.clone());
        }
    }

    let city_id_remap = build_aggregate_city_id_remap(
        merged_by_input_id.values().collect(),
        aggregate_source_id,
        &mut issues,
    );
    let mut merged = collapse_cities_by_remap(merged_by_input_id.into_values(), &city_id_remap);

    for city in merged.values_mut() {
        city.aliases.sort();
        city.aliases.dedup();
        city.station_ids
            .sort_by(|left, right| left.as_str().cmp(right.as_str()));
        city.station_ids
            .dedup_by(|left, right| left.as_str() == right.as_str());
        if city.country_code == "ZZ"
            && let Some(inferred_country_code) =
                infer_country_code_from_station_ids(&city.station_ids)
        {
            city.country_code = inferred_country_code;
        }
    }
    canonicalize_aggregate_city_names(merged.values_mut(), aggregate_source_id, &mut issues);
    let second_stage_remap =
        build_aggregate_city_id_remap(merged.values().collect(), aggregate_source_id, &mut issues);
    let mut city_id_remap = city_id_remap;
    if !second_stage_remap.is_empty() {
        for (from_city_id, to_city_id) in &second_stage_remap {
            rebind_city_id_remap(&mut city_id_remap, from_city_id, to_city_id);
        }
        merged = collapse_cities_by_remap(merged.into_values(), &second_stage_remap);
    }
    let mut merged_cities = merged.into_values().collect::<Vec<_>>();
    let route_like_demotion_stats = demote_route_like_pseudo_cities(
        &mut merged_cities,
        &mut city_id_remap,
        aggregate_source_id,
        &mut issues,
    );
    let aliases = rebuild_alias_records(&merged_cities);

    MergedCityOutput {
        cities: merged_cities,
        aliases,
        city_id_remap,
        issues,
        route_like_demotion_stats,
    }
}

fn collapse_cities_by_remap(
    cities: impl Iterator<Item = aetrain_domain::City>,
    city_id_remap: &BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
) -> BTreeMap<aetrain_domain::CityId, aetrain_domain::City> {
    let mut merged = BTreeMap::<aetrain_domain::CityId, aetrain_domain::City>::new();
    for city in cities {
        let canonical_city_id = city_id_remap
            .get(&city.city_id)
            .cloned()
            .unwrap_or_else(|| city.city_id.clone());
        merged
            .entry(canonical_city_id.clone())
            .and_modify(|existing| {
                if city.city_id == canonical_city_id {
                    existing.slug = city.slug.clone();
                    existing.display_name = city.display_name.clone();
                    existing.country_code = city.country_code.clone();
                    existing.location = city.location;
                    if city.wikidata_qid.is_some() {
                        existing.wikidata_qid = city.wikidata_qid.clone();
                    }
                    if city.population.is_some() {
                        existing.population = city.population;
                    }
                    if city.interest_score.is_some() {
                        existing.interest_score = city.interest_score;
                    }
                }

                if existing.display_name != city.display_name
                    && !existing
                        .aliases
                        .iter()
                        .any(|alias| alias == &city.display_name)
                {
                    existing.aliases.push(city.display_name.clone());
                }

                if existing.country_code == "ZZ" && city.country_code != "ZZ" {
                    existing.country_code = city.country_code.clone();
                }
                if existing.wikidata_qid.is_none() {
                    existing.wikidata_qid = city.wikidata_qid.clone();
                }
                existing.population = merge_optional_u64(existing.population, city.population);
                existing.interest_score =
                    merge_optional_u8(existing.interest_score, city.interest_score);
                existing.location = merge_geo_points(existing.location, city.location);
                merge_station_ids(&mut existing.station_ids, &city.station_ids);
                merge_string_vec(&mut existing.aliases, &city.aliases);
            })
            .or_insert_with(|| {
                let mut canonical_city = city.clone();
                canonical_city.city_id = canonical_city_id;
                canonical_city
            });
    }
    merged
}

fn demote_route_like_pseudo_cities(
    cities: &mut Vec<aetrain_domain::City>,
    city_id_remap: &mut BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> RouteLikeDemotionStats {
    let mut stats = RouteLikeDemotionStats::default();
    let mut demotion_remap = BTreeMap::<aetrain_domain::CityId, aetrain_domain::CityId>::new();

    for city in cities.iter() {
        if route_like_candidate_record(city).is_none() || city.wikidata_qid.is_some() {
            continue;
        }
        let candidates = cities
            .iter()
            .filter(|parent| parent.city_id != city.city_id)
            .filter_map(|parent| {
                route_like_parent_match_score(city, parent).map(|score| (parent, score))
            })
            .collect::<Vec<_>>();
        let Some(best_score) = candidates.iter().map(|(_, score)| *score).max() else {
            stats.unresolved_count += 1;
            issues.push(NormalizationIssue {
                severity: crate::IssueSeverity::Warning,
                source_id: aggregate_source_id.to_string(),
                entity_ref: city.city_id.to_string(),
                message: format!(
                    "route-like pseudo-city {} had no deterministic parent-city match",
                    city.display_name
                ),
            });
            continue;
        };
        let best_candidates = candidates
            .into_iter()
            .filter(|(_, score)| *score == best_score)
            .collect::<Vec<_>>();
        if best_candidates.len() > 1 {
            stats.ambiguous_count += 1;
            issues.push(NormalizationIssue {
                severity: crate::IssueSeverity::Warning,
                source_id: aggregate_source_id.to_string(),
                entity_ref: city.city_id.to_string(),
                message: format!(
                    "route-like pseudo-city {} matched multiple parent cities equally",
                    city.display_name
                ),
            });
            continue;
        }
        let parent = best_candidates[0].0;
        demotion_remap.insert(city.city_id.clone(), parent.city_id.clone());
        stats.demoted_count += 1;
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Info,
            source_id: aggregate_source_id.to_string(),
            entity_ref: city.city_id.to_string(),
            message: format!(
                "demoted route-like pseudo-city {} into parent city {}",
                city.display_name, parent.display_name
            ),
        });
    }

    if demotion_remap.is_empty() {
        return stats;
    }

    for (from_city_id, to_city_id) in &demotion_remap {
        rebind_city_id_remap(city_id_remap, from_city_id, to_city_id);
    }
    *cities = collapse_cities_by_remap(cities.drain(..), &demotion_remap)
        .into_values()
        .collect();
    stats
}

fn canonicalize_aggregate_city_names<'a>(
    cities: impl Iterator<Item = &'a mut aetrain_domain::City>,
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) {
    for city in cities {
        let normalized_name = normalize_name(&city.display_name);
        let base_identity_key = city_identity_key(&city.display_name);
        if normalized_name == base_identity_key {
            continue;
        }
        if city.wikidata_qid.is_some() {
            continue;
        }
        if !is_plausible_aggregate_city_name(&base_identity_key) {
            continue;
        }
        let is_route_like = route_like_candidate_record(city).is_some();
        if !(is_station_qualified_city_name(&city.display_name)
            || city.country_code == "ZZ"
            || is_route_like)
        {
            continue;
        }

        let original_display_name = city.display_name.clone();
        let cleaned_display_name = title_case_ascii_name(&base_identity_key);
        if cleaned_display_name == city.display_name {
            continue;
        }
        if !city
            .aliases
            .iter()
            .any(|alias| alias == &original_display_name)
        {
            city.aliases.push(original_display_name.clone());
        }
        city.display_name = cleaned_display_name;
        city.slug = base_identity_key.replace(' ', "-");
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Info,
            source_id: aggregate_source_id.to_string(),
            entity_ref: city.city_id.to_string(),
            message: format!(
                "canonicalized aggregate city display name from {} to {}",
                original_display_name, city.display_name
            ),
        });
    }
}

fn is_plausible_aggregate_city_name(normalized_name: &str) -> bool {
    let tokens = normalized_name.split_whitespace().collect::<Vec<_>>();
    !normalized_name.is_empty()
        && !is_station_qualified_city_name(normalized_name)
        && (tokens.len() != 1 || normalized_name.len() > 2)
}

fn title_case_ascii_name(normalized_name: &str) -> String {
    normalized_name
        .split_whitespace()
        .map(|token| {
            let mut chars = token.chars();
            match chars.next() {
                Some(first) => {
                    let mut title = String::new();
                    title.push(first.to_ascii_uppercase());
                    title.push_str(chars.as_str());
                    title
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn infer_country_code_from_station_ids(
    station_ids: &[aetrain_domain::StationId],
) -> Option<String> {
    let mut inferred = BTreeSet::new();
    for station_id in station_ids {
        let Some(uic_code) = extract_uic_code_from_station_id(station_id.as_str()) else {
            continue;
        };
        let Some(country_code) = infer_country_code_from_uic_code(uic_code) else {
            continue;
        };
        inferred.insert(country_code);
    }
    if inferred.len() == 1 {
        inferred.into_iter().next().map(str::to_string)
    } else {
        None
    }
}

fn extract_uic_code_from_station_id(station_id: &str) -> Option<&str> {
    station_id.strip_prefix("station-uic-")
}

fn infer_country_code_from_uic_code(uic_code: &str) -> Option<&'static str> {
    let prefix = uic_code.get(0..2)?;
    match prefix {
        "71" => Some("ES"),
        "72" => Some("RS"),
        "73" => Some("GR"),
        "74" => Some("SE"),
        "76" => Some("NO"),
        "79" => Some("SI"),
        "80" => Some("DE"),
        "81" => Some("AT"),
        "82" => Some("LU"),
        "83" => Some("IT"),
        "84" => Some("NL"),
        "85" => Some("CH"),
        "86" => Some("DK"),
        "87" => Some("FR"),
        "88" => Some("BE"),
        _ => None,
    }
}

fn rebuild_alias_records(cities: &[aetrain_domain::City]) -> Vec<aetrain_dataset::AliasRecord> {
    let mut alias_pairs = BTreeSet::<(String, aetrain_domain::CityId)>::new();
    for city in cities {
        for alias in &city.aliases {
            alias_pairs.insert((alias.clone(), city.city_id.clone()));
        }
        alias_pairs.insert((normalize_alias(&city.display_name), city.city_id.clone()));
    }
    alias_pairs
        .into_iter()
        .filter(|(alias, _)| !alias.trim().is_empty())
        .map(|(alias, city_id)| aetrain_dataset::AliasRecord { alias, city_id })
        .collect()
}

fn merge_stations(
    inputs: &[AggregateTargetInput],
    city_id_remap: &BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
    aggregate_source_id: &str,
) -> Result<Vec<aetrain_domain::Station>> {
    let mut merged = BTreeMap::<aetrain_domain::StationId, aetrain_domain::Station>::new();

    for input in inputs {
        for station in &input.canonical.stations {
            let mut station = station.clone();
            station.city_id = city_id_remap
                .get(&station.city_id)
                .cloned()
                .unwrap_or_else(|| station.city_id.clone());
            merged
                .entry(station.station_id.clone())
                .and_modify(|existing| {
                    if existing.city_id != station.city_id {
                        existing.source_refs.push(aetrain_domain::SourceRef {
                            source_id: aggregate_source_id.to_string(),
                            raw_id: format!(
                                "conflicting-city:{}:{}",
                                existing.city_id, station.city_id
                            ),
                        });
                        return;
                    }

                    if station.display_name.len() > existing.display_name.len() {
                        existing.display_name = station.display_name.clone();
                    }
                    if existing.uic_code.is_none() {
                        existing.uic_code = station.uic_code.clone();
                    }
                    existing.location = merge_geo_points(existing.location, station.location);
                    merge_source_refs(&mut existing.source_refs, &station.source_refs);
                })
                .or_insert_with(|| station.clone());
        }
    }

    let stations = merged.into_values().collect::<Vec<_>>();
    for station in &stations {
        if station.display_name.trim().is_empty() {
            bail!(
                "aggregate station {} has an empty display name",
                station.station_id
            );
        }
    }
    Ok(stations)
}

fn merge_edges(
    inputs: &[AggregateTargetInput],
    city_id_remap: &BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
) -> Vec<aetrain_domain::TravelEdge> {
    let mut merged = BTreeMap::<
        (aetrain_domain::CityId, aetrain_domain::CityId),
        aetrain_domain::TravelEdge,
    >::new();

    for input in inputs {
        for edge in &input.canonical.edges {
            let from_city_id = city_id_remap
                .get(&edge.from_city_id)
                .cloned()
                .unwrap_or_else(|| edge.from_city_id.clone());
            let to_city_id = city_id_remap
                .get(&edge.to_city_id)
                .cloned()
                .unwrap_or_else(|| edge.to_city_id.clone());
            if from_city_id == to_city_id {
                continue;
            }
            let mut edge = edge.clone();
            edge.from_city_id = from_city_id.clone();
            edge.to_city_id = to_city_id.clone();
            let key = (from_city_id, to_city_id);
            merged
                .entry(key)
                .and_modify(|existing| merge_edge_record(existing, &edge))
                .or_insert(edge);
        }
    }

    merged.into_values().collect()
}

fn merge_edge_geometries(
    inputs: &[AggregateTargetInput],
    city_id_remap: &BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
) -> EdgeGeometryArtifact {
    let mut merged =
        BTreeMap::<(aetrain_domain::CityId, aetrain_domain::CityId), EdgeGeometryRecord>::new();

    for input in inputs {
        for geometry in &input.edge_geometries.geometries {
            let from_city_id = city_id_remap
                .get(&geometry.from_city_id)
                .cloned()
                .unwrap_or_else(|| geometry.from_city_id.clone());
            let to_city_id = city_id_remap
                .get(&geometry.to_city_id)
                .cloned()
                .unwrap_or_else(|| geometry.to_city_id.clone());
            if from_city_id == to_city_id {
                continue;
            }
            let mut geometry = geometry.clone();
            geometry.from_city_id = from_city_id.clone();
            geometry.to_city_id = to_city_id.clone();
            let key = (from_city_id, to_city_id);
            merged
                .entry(key)
                .and_modify(|existing| merge_edge_geometry_record(existing, &geometry))
                .or_insert(geometry);
        }
    }

    EdgeGeometryArtifact {
        geometries: merged.into_values().collect(),
    }
}

fn reject_foreign_domestic_feed_leakage(
    edges: &mut Vec<aetrain_domain::TravelEdge>,
    edge_geometries: &mut EdgeGeometryArtifact,
    cities: &[City],
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> u64 {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let mut rejected_edge_ids = BTreeSet::<(aetrain_domain::CityId, aetrain_domain::CityId)>::new();

    edges.retain(|edge| {
        let Some(from_city) = cities_by_id.get(&edge.from_city_id) else {
            return true;
        };
        let Some(to_city) = cities_by_id.get(&edge.to_city_id) else {
            return true;
        };
        let Some(home_country_code) = infer_home_country_code_from_provenance(&edge.provenance)
        else {
            return true;
        };
        if !is_foreign_domestic_feed_leakage(
            home_country_code,
            &from_city.country_code,
            &to_city.country_code,
        ) {
            return true;
        }

        rejected_edge_ids.insert((edge.from_city_id.clone(), edge.to_city_id.clone()));
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Warning,
            source_id: aggregate_source_id.to_string(),
            entity_ref: format!("{}->{}", edge.from_city_id, edge.to_city_id),
            message: format!(
                "rejected foreign-domestic edge leakage {} -> {} from feed {} with countries {} -> {}",
                from_city.display_name,
                to_city.display_name,
                home_country_code,
                from_city.country_code,
                to_city.country_code
            ),
        });
        false
    });

    edge_geometries.geometries.retain(|geometry| {
        !rejected_edge_ids.contains(&(geometry.from_city_id.clone(), geometry.to_city_id.clone()))
    });

    rejected_edge_ids.len() as u64
}

fn reject_foreign_cross_border_feed_leakage(
    edges: &mut Vec<aetrain_domain::TravelEdge>,
    edge_geometries: &mut EdgeGeometryArtifact,
    cities: &[City],
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> u64 {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let mut rejected_edge_ids = BTreeSet::<(aetrain_domain::CityId, aetrain_domain::CityId)>::new();

    edges.retain(|edge| {
        let Some(from_city) = cities_by_id.get(&edge.from_city_id) else {
            return true;
        };
        let Some(to_city) = cities_by_id.get(&edge.to_city_id) else {
            return true;
        };
        let Some(home_country_code) = infer_home_country_code_from_provenance(&edge.provenance)
        else {
            return true;
        };
        if !is_foreign_cross_border_feed_leakage(
            home_country_code,
            &from_city.country_code,
            &to_city.country_code,
        ) {
            return true;
        }

        rejected_edge_ids.insert((edge.from_city_id.clone(), edge.to_city_id.clone()));
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Warning,
            source_id: aggregate_source_id.to_string(),
            entity_ref: format!("{}->{}", edge.from_city_id, edge.to_city_id),
            message: format!(
                "rejected foreign cross-border edge leakage {} -> {} from feed {} with countries {} -> {}",
                from_city.display_name,
                to_city.display_name,
                home_country_code,
                from_city.country_code,
                to_city.country_code
            ),
        });
        false
    });

    edge_geometries.geometries.retain(|geometry| {
        !rejected_edge_ids.contains(&(geometry.from_city_id.clone(), geometry.to_city_id.clone()))
    });

    rejected_edge_ids.len() as u64
}

fn reject_impossible_edge_speeds(
    edges: &mut Vec<aetrain_domain::TravelEdge>,
    edge_geometries: &mut EdgeGeometryArtifact,
    cities: &[City],
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> u64 {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let mut rejected_edge_ids = BTreeSet::<(aetrain_domain::CityId, aetrain_domain::CityId)>::new();

    edges.retain(|edge| {
        let Some(from_city) = cities_by_id.get(&edge.from_city_id) else {
            return true;
        };
        let Some(to_city) = cities_by_id.get(&edge.to_city_id) else {
            return true;
        };
        let metrics = route_geometry_metrics(
            &[
                scale_geo_point_e5_for_pipeline(from_city.location),
                scale_geo_point_e5_for_pipeline(to_city.location),
            ],
            from_city.location,
            to_city.location,
            Some(edge.duration_min),
        );
        if !route_geometry_speed_is_physically_impossible(&metrics) {
            return true;
        }

        rejected_edge_ids.insert((edge.from_city_id.clone(), edge.to_city_id.clone()));
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Warning,
            source_id: aggregate_source_id.to_string(),
            entity_ref: format!("{}->{}", edge.from_city_id, edge.to_city_id),
            message: format!(
                "rejected impossible aggregate edge speed {} -> {}: direct={}km duration={}min implied_speed={}km/h",
                from_city.display_name,
                to_city.display_name,
                meters_to_km_u32(metrics.direct_meters),
                edge.duration_min,
                metrics.implied_speed_kmh.unwrap_or_default()
            ),
        });
        false
    });

    edge_geometries.geometries.retain(|geometry| {
        !rejected_edge_ids.contains(&(geometry.from_city_id.clone(), geometry.to_city_id.clone()))
    });

    rejected_edge_ids.len() as u64
}

fn reject_invalid_railway_layer_geometries(
    edge_geometries: &mut EdgeGeometryArtifact,
    cities: &[City],
    edges: &[aetrain_domain::TravelEdge],
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> u64 {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let edge_by_id = edges
        .iter()
        .map(|edge| ((edge.from_city_id.clone(), edge.to_city_id.clone()), edge))
        .collect::<BTreeMap<_, _>>();
    let mut rejected_count = 0;

    for geometry in &mut edge_geometries.geometries {
        if !is_railway_layer_geometry_source(&geometry.source) {
            continue;
        }
        let Some(from_city) = cities_by_id.get(&geometry.from_city_id) else {
            continue;
        };
        let Some(to_city) = cities_by_id.get(&geometry.to_city_id) else {
            continue;
        };
        let edge = edge_by_id.get(&(geometry.from_city_id.clone(), geometry.to_city_id.clone()));
        let metrics = route_geometry_metrics(
            &geometry.points,
            from_city.location,
            to_city.location,
            edge.map(|edge| edge.duration_min),
        );
        let distance_is_plausible = route_geometry_distance_metrics_are_plausible(
            metrics.geometry_meters,
            metrics.direct_meters,
        );
        if distance_is_plausible && !route_geometry_speed_is_physically_impossible(&metrics) {
            continue;
        }

        geometry.points = vec![
            scale_geo_point_e5_for_pipeline(from_city.location),
            scale_geo_point_e5_for_pipeline(to_city.location),
        ];
        geometry.source = EdgeGeometrySource::StraightLineFallback;
        merge_string_vec(
            &mut geometry.provenance,
            &[
                INVALID_RAILWAY_GEOMETRY_REJECTED_PROVENANCE.to_string(),
                build_rejected_geometry_metrics_provenance(
                    REJECTED_RAIL_METRICS_PROVENANCE_PREFIX,
                    &metrics,
                ),
            ],
        );
        rejected_count += 1;
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Warning,
            source_id: aggregate_source_id.to_string(),
            entity_ref: format!("{}->{}", geometry.from_city_id, geometry.to_city_id),
            message: format!(
                "rejected implausible railway geometry from {} to {}: geometry={}km direct={}km detour_ratio_x100={:?}",
                from_city.display_name,
                to_city.display_name,
                meters_to_km_u32(metrics.geometry_meters),
                meters_to_km_u32(metrics.direct_meters),
                metrics.detour_ratio_x100
            ),
        });
    }

    rejected_count
}

fn reject_invalid_gtfs_shape_geometries(
    edge_geometries: &mut EdgeGeometryArtifact,
    cities: &[City],
    edges: &[aetrain_domain::TravelEdge],
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> u64 {
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let edge_by_id = edges
        .iter()
        .map(|edge| ((edge.from_city_id.clone(), edge.to_city_id.clone()), edge))
        .collect::<BTreeMap<_, _>>();
    let mut rejected_count = 0;

    for geometry in &mut edge_geometries.geometries {
        if geometry.source != EdgeGeometrySource::GtfsShapeSegment {
            continue;
        }
        let Some(from_city) = cities_by_id.get(&geometry.from_city_id) else {
            continue;
        };
        let Some(to_city) = cities_by_id.get(&geometry.to_city_id) else {
            continue;
        };
        let edge = edge_by_id.get(&(geometry.from_city_id.clone(), geometry.to_city_id.clone()));
        let metrics = route_geometry_metrics(
            &geometry.points,
            from_city.location,
            to_city.location,
            edge.map(|edge| edge.duration_min),
        );
        let distance_is_plausible = route_geometry_distance_metrics_are_plausible(
            metrics.geometry_meters,
            metrics.direct_meters,
        );
        if distance_is_plausible && !route_geometry_speed_is_physically_impossible(&metrics) {
            continue;
        }

        geometry.points = vec![
            scale_geo_point_e5_for_pipeline(from_city.location),
            scale_geo_point_e5_for_pipeline(to_city.location),
        ];
        geometry.source = EdgeGeometrySource::StraightLineFallback;
        merge_string_vec(
            &mut geometry.provenance,
            &[
                INVALID_GTFS_SHAPE_GEOMETRY_REJECTED_PROVENANCE.to_string(),
                build_rejected_geometry_metrics_provenance(
                    REJECTED_SHAPE_METRICS_PROVENANCE_PREFIX,
                    &metrics,
                ),
            ],
        );
        rejected_count += 1;
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Warning,
            source_id: aggregate_source_id.to_string(),
            entity_ref: format!("{}->{}", geometry.from_city_id, geometry.to_city_id),
            message: format!(
                "rejected implausible gtfs shape geometry from {} to {}: geometry={}km direct={}km detour_ratio_x100={:?} implied_speed_kmh={:?}",
                from_city.display_name,
                to_city.display_name,
                meters_to_km_u32(metrics.geometry_meters),
                meters_to_km_u32(metrics.direct_meters),
                metrics.detour_ratio_x100,
                metrics.implied_speed_kmh
            ),
        });
    }

    rejected_count
}

fn apply_aggregate_rail_geometry_authority(
    edge_geometries: &mut EdgeGeometryArtifact,
    cities: &[City],
    edges: &[aetrain_domain::TravelEdge],
    inputs: &[AggregateTargetInput],
    manifest: &SourceManifest,
    authority_registry: Option<&GeometryAuthorityRegistry>,
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> Result<u64> {
    let Some((rail_geometry_source_id, rail_geometry_network)) =
        load_aggregate_rail_geometry_network(inputs, manifest, authority_registry)?
    else {
        return Ok(0);
    };
    let cities_by_id = cities
        .iter()
        .map(|city| (city.city_id.clone(), city))
        .collect::<BTreeMap<_, _>>();
    let mut repaired_count = 0;
    let mut provenance = Vec::new();
    provenance.push(format!("geometry:{rail_geometry_source_id}"));
    let edge_by_id = edges
        .iter()
        .map(|edge| ((edge.from_city_id.clone(), edge.to_city_id.clone()), edge))
        .collect::<BTreeMap<_, _>>();

    for geometry in &mut edge_geometries.geometries {
        if geometry.source == EdgeGeometrySource::InfrastructureGraphFallback {
            continue;
        }
        if geometry
            .provenance
            .iter()
            .any(|entry| entry == INVALID_RAILWAY_GEOMETRY_REJECTED_PROVENANCE)
        {
            continue;
        }
        let Some(from_city) = cities_by_id.get(&geometry.from_city_id) else {
            continue;
        };
        let Some(to_city) = cities_by_id.get(&geometry.to_city_id) else {
            continue;
        };
        if !authority_registry_supports_route(
            authority_registry,
            &rail_geometry_source_id,
            &from_city.country_code,
            &to_city.country_code,
        ) {
            continue;
        }
        if !authority_registry_allows_route_repair(
            authority_registry,
            &rail_geometry_source_id,
            &geometry.from_city_id,
            &geometry.to_city_id,
            &rail_geometry_network,
            from_city.location,
            to_city.location,
        ) {
            continue;
        }
        let Some(points) =
            rail_geometry_network.route_polyline(from_city.location, to_city.location)
        else {
            continue;
        };
        if points.len() < 2 {
            continue;
        }
        let points_e5 = points
            .into_iter()
            .map(scale_geo_point_e5_for_pipeline)
            .collect::<Vec<_>>();
        let metrics = route_geometry_metrics(
            &points_e5,
            from_city.location,
            to_city.location,
            edge_by_id
                .get(&(geometry.from_city_id.clone(), geometry.to_city_id.clone()))
                .map(|edge| edge.duration_min),
        );
        if !route_geometry_distance_metrics_are_plausible(
            metrics.geometry_meters,
            metrics.direct_meters,
        ) || route_geometry_speed_is_physically_impossible(&metrics)
        {
            continue;
        }

        geometry.points = points_e5;
        geometry.source = EdgeGeometrySource::InfrastructureGraphFallback;
        merge_string_vec(&mut geometry.provenance, &provenance);
        repaired_count += 1;
    }

    if repaired_count > 0 {
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Info,
            source_id: aggregate_source_id.to_string(),
            entity_ref: "edge-geometries".to_string(),
            message: format!(
                "repaired {repaired_count} aggregate route geometries using {rail_geometry_source_id}"
            ),
        });
    }

    Ok(repaired_count)
}

fn load_aggregate_rail_geometry_network(
    inputs: &[AggregateTargetInput],
    manifest: &SourceManifest,
    authority_registry: Option<&GeometryAuthorityRegistry>,
) -> Result<Option<(String, RailGeometryNetwork)>> {
    let Some(authority_registry) = authority_registry else {
        return Ok(None);
    };
    let rail_geometry_sources = manifest
        .sources
        .iter()
        .filter(|source| source.role.as_deref() == Some("rail_geometry"))
        .map(|source| (source.id.as_str(), source))
        .collect::<BTreeMap<_, _>>();
    let allowed_source_ids = authority_registry
        .countries
        .iter()
        .filter_map(|entry| entry.source_id.as_ref().cloned())
        .chain(
            authority_registry
                .corridors
                .iter()
                .filter_map(|entry| entry.source_id.as_ref().cloned()),
        )
        .collect::<BTreeSet<_>>();

    for (input, artifact) in inputs.iter().flat_map(|input| {
        input
            .manifest
            .source_artifacts
            .iter()
            .map(move |artifact| (input, artifact))
    }) {
        if !allowed_source_ids.contains(&artifact.source_id) {
            continue;
        }
        let Some(source_definition) = rail_geometry_sources.get(artifact.source_id.as_str()) else {
            continue;
        };
        if source_definition.adapter != "sncf_fr" {
            continue;
        }
        let path =
            resolve_pipeline_source_artifact_path(artifact, &input.manifest.outputs.target_root);
        let network = RailGeometryNetwork::load_sncf_rfn_geojson(&path).with_context(|| {
            format!(
                "failed to load aggregate rail geometry authority {} from {}",
                artifact.source_id,
                path.display()
            )
        })?;
        return Ok(Some((artifact.source_id.clone(), network)));
    }

    Ok(None)
}

fn load_aggregate_promoted_country_authority_networks(
    inputs: &[AggregateTargetInput],
    manifest: &SourceManifest,
    authority_registry: Option<&GeometryAuthorityRegistry>,
) -> Result<BTreeMap<String, RailGeometryNetwork>> {
    let Some(authority_registry) = authority_registry else {
        return Ok(BTreeMap::new());
    };
    let rail_geometry_sources = manifest
        .sources
        .iter()
        .filter(|source| source.role.as_deref() == Some("rail_geometry"))
        .map(|source| (source.id.as_str(), source))
        .collect::<BTreeMap<_, _>>();
    let promoted_country_sources = authority_registry
        .countries
        .iter()
        .filter(|entry| entry.status.is_promoted())
        .filter_map(|entry| {
            Some((
                entry.source_id.as_ref()?.clone(),
                entry.loader.as_ref()?.clone(),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    let mut networks = BTreeMap::new();

    for (input, artifact) in inputs.iter().flat_map(|input| {
        input
            .manifest
            .source_artifacts
            .iter()
            .map(move |artifact| (input, artifact))
    }) {
        let Some(loader) = promoted_country_sources.get(&artifact.source_id) else {
            continue;
        };
        let Some(source_definition) = rail_geometry_sources.get(artifact.source_id.as_str()) else {
            continue;
        };
        let path =
            resolve_pipeline_source_artifact_path(artifact, &input.manifest.outputs.target_root);
        let network = match loader {
            GeometryAuthorityLoader::SncfRfnGeojson => {
                if source_definition.adapter != "sncf_fr" {
                    continue;
                }
                RailGeometryNetwork::load_sncf_rfn_geojson(&path)
            }
        }
        .with_context(|| {
            format!(
                "failed to load aggregate promoted authority {} from {}",
                artifact.source_id,
                path.display()
            )
        })?;
        networks
            .entry(artifact.source_id.clone())
            .or_insert(network);
    }

    Ok(networks)
}

fn authority_registry_supports_route(
    authority_registry: Option<&GeometryAuthorityRegistry>,
    source_id: &str,
    from_country_code: &str,
    to_country_code: &str,
) -> bool {
    let Some(authority_registry) = authority_registry else {
        return false;
    };

    if from_country_code == to_country_code {
        return authority_registry
            .country(from_country_code)
            .is_some_and(|entry| {
                entry.status.is_promoted() && entry.source_id.as_deref() == Some(source_id)
            });
    }

    authority_registry
        .corridor(from_country_code, to_country_code)
        .is_some_and(|entry| {
            entry.status.is_promoted() && entry.source_id.as_deref() == Some(source_id)
        })
}

fn authority_registry_allows_route_repair(
    authority_registry: Option<&GeometryAuthorityRegistry>,
    source_id: &str,
    from_city_id: &aetrain_domain::CityId,
    to_city_id: &aetrain_domain::CityId,
    rail_geometry_network: &RailGeometryNetwork,
    from_location: GeoPoint,
    to_location: GeoPoint,
) -> bool {
    let Some(authority_registry) = authority_registry else {
        return true;
    };
    let Some(policy) = authority_registry.route_policy(source_id, from_city_id, to_city_id) else {
        return true;
    };
    match policy.action {
        GeometryAuthorityRoutePolicyAction::SuppressAuthorityUntilTopologyFixed => false,
        GeometryAuthorityRoutePolicyAction::TightenAuthorityFootprint => {
            let max_snap_distance_m = policy.max_snap_distance_m.unwrap_or(500);
            rail_geometry_network
                .route_snap_candidates(from_location)
                .first()
                .is_some_and(|(_, distance)| *distance <= max_snap_distance_m)
                && rail_geometry_network
                    .route_snap_candidates(to_location)
                    .first()
                    .is_some_and(|(_, distance)| *distance <= max_snap_distance_m)
        }
    }
}

fn resolve_pipeline_source_artifact_path(
    artifact: &PipelineSourceArtifact,
    target_root: &str,
) -> PathBuf {
    let local_path = PathBuf::from(&artifact.local_path);
    if local_path.is_absolute() {
        return local_path;
    }

    let target_relative = PathBuf::from(target_root).join(&local_path);
    if target_relative.exists() {
        return target_relative;
    }

    if local_path.exists() {
        return local_path;
    }

    target_relative
}

fn scale_geo_point_e5_for_pipeline(point: GeoPoint) -> PolylinePointE5 {
    PolylinePointE5 {
        lat_e5: (point.lat * 100_000.0).round() as i32,
        lon_e5: (point.lon * 100_000.0).round() as i32,
    }
}

fn merge_station_mappings(
    inputs: &[AggregateTargetInput],
    city_id_remap: &BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
) -> StationMappingReport {
    let mut records = BTreeMap::<String, crate::StationMappingRecord>::new();
    for input in inputs {
        if let Some(report) = &input.station_mappings {
            for record in &report.records {
                let mut record = record.clone();
                record.city_id = city_id_remap
                    .get(&record.city_id)
                    .cloned()
                    .unwrap_or_else(|| record.city_id.clone());
                records
                    .entry(record.station_id.as_str().to_string())
                    .or_insert(record);
            }
        }
    }
    StationMappingReport {
        records: records.into_values().collect(),
    }
}

fn build_aggregate_city_id_remap(
    cities: Vec<&aetrain_domain::City>,
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId> {
    let mut grouped = BTreeMap::<String, Vec<&aetrain_domain::City>>::new();
    for city in cities {
        grouped
            .entry(city_identity_key(&city.display_name))
            .or_default()
            .push(city);
    }

    let mut remap = BTreeMap::<aetrain_domain::CityId, aetrain_domain::CityId>::new();
    for (normalized_name, group) in grouped {
        if group.len() < 2 {
            continue;
        }

        let components = connected_city_components(&group);
        for component in components {
            if component.len() < 2 {
                continue;
            }

            let canonical = choose_canonical_city(component.iter().map(|index| group[*index]));
            for index in component {
                let city = group[index];
                if city.city_id == canonical.city_id {
                    continue;
                }
                remap.insert(city.city_id.clone(), canonical.city_id.clone());
                issues.push(NormalizationIssue {
                    severity: crate::IssueSeverity::Info,
                    source_id: aggregate_source_id.to_string(),
                    entity_ref: city.city_id.to_string(),
                    message: format!(
                        "merged duplicate city {} into {} while aggregating normalized name {}",
                        city.city_id, canonical.city_id, normalized_name
                    ),
                });
            }
        }
    }

    remap
}

fn cleanup_station_like_and_zz_residual_cities(
    cities: &mut Vec<aetrain_domain::City>,
    city_id_remap: &mut BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
    station_mappings: &StationMappingReport,
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) {
    let mapping_by_city = station_mappings.records.iter().fold(
        BTreeMap::<aetrain_domain::CityId, Vec<&crate::StationMappingRecord>>::new(),
        |mut acc, record| {
            acc.entry(record.city_id.clone()).or_default().push(record);
            acc
        },
    );
    let snapshot = cities.clone();
    let effective_country_by_city = snapshot
        .iter()
        .map(|city| {
            (
                city.city_id.clone(),
                effective_city_country_code(city, station_mappings),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let parent_match_keys_by_city = snapshot
        .iter()
        .map(|city| (city.city_id.clone(), parent_city_match_keys(city)))
        .collect::<BTreeMap<_, _>>();
    let mut remap = BTreeMap::<aetrain_domain::CityId, aetrain_domain::CityId>::new();

    for city in cities.iter_mut() {
        if let Some(country_code) = infer_country_code_from_station_mappings(city, station_mappings)
        {
            if city.country_code == "ZZ" {
                city.country_code = country_code.clone();
                issues.push(NormalizationIssue {
                    severity: crate::IssueSeverity::Info,
                    source_id: aggregate_source_id.to_string(),
                    entity_ref: city.city_id.to_string(),
                    message: format!(
                        "corrected aggregate ZZ city {} to country {} from station evidence",
                        city.display_name, country_code
                    ),
                });
            } else if city.country_code != country_code && city.wikidata_qid.is_none() {
                let original_country_code = city.country_code.clone();
                city.country_code = country_code.clone();
                issues.push(NormalizationIssue {
                    severity: crate::IssueSeverity::Info,
                    source_id: aggregate_source_id.to_string(),
                    entity_ref: city.city_id.to_string(),
                    message: format!(
                        "corrected weak aggregate city country for {} from {} to {} using station evidence",
                        city.display_name, original_country_code, country_code
                    ),
                });
            }
        }

        if let Some(cleaned_display_name) =
            cleaned_residual_city_display_name(city, mapping_by_city.get(&city.city_id))
            && cleaned_display_name != city.display_name
        {
            let original_display_name = city.display_name.clone();
            if !city
                .aliases
                .iter()
                .any(|alias| alias == &original_display_name)
            {
                city.aliases.push(original_display_name.clone());
            }
            city.display_name = cleaned_display_name.clone();
            city.slug = city_identity_key(&cleaned_display_name).replace(' ', "-");
            issues.push(NormalizationIssue {
                severity: crate::IssueSeverity::Info,
                source_id: aggregate_source_id.to_string(),
                entity_ref: city.city_id.to_string(),
                message: format!(
                    "cleaned aggregate residual city display name from {} to {}",
                    original_display_name, cleaned_display_name
                ),
            });
        }

        if let Some(expanded_display_name) = explicit_abbreviation_expansion(city) {
            let original_display_name = city.display_name.clone();
            let expanded_key = comparable_place_key(&expanded_display_name);
            let effective_country =
                infer_country_code_from_station_mappings(city, station_mappings)
                    .unwrap_or_else(|| city.country_code.clone());
            let mut candidates = snapshot
                .iter()
                .filter(|parent| parent.city_id != city.city_id)
                .filter(|parent| {
                    effective_country == effective_city_country_code(parent, station_mappings)
                })
                .filter(|parent| {
                    comparable_place_key(&city_identity_key(&parent.display_name)) == expanded_key
                })
                .filter_map(|parent| {
                    let distance_meters = geo_distance_meters(city.location, parent.location);
                    (distance_meters <= AGGREGATE_CITY_MERGE_DISTANCE_METERS as f64)
                        .then_some((parent, distance_meters))
                })
                .collect::<Vec<_>>();
            candidates.sort_by(|left, right| {
                left.1
                    .partial_cmp(&right.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            if let Some((parent, _)) = candidates.first().copied() {
                remap.insert(city.city_id.clone(), parent.city_id.clone());
                issues.push(NormalizationIssue {
                    severity: crate::IssueSeverity::Info,
                    source_id: aggregate_source_id.to_string(),
                    entity_ref: city.city_id.to_string(),
                    message: format!(
                        "demoted aggregate abbreviated city {} into canonical parent city {}",
                        original_display_name, parent.display_name
                    ),
                });
            } else if expanded_display_name != city.display_name {
                if !city
                    .aliases
                    .iter()
                    .any(|alias| alias == &original_display_name)
                {
                    city.aliases.push(original_display_name.clone());
                }
                city.display_name = expanded_display_name.clone();
                city.slug = city_identity_key(&expanded_display_name).replace(' ', "-");
                issues.push(NormalizationIssue {
                    severity: crate::IssueSeverity::Info,
                    source_id: aggregate_source_id.to_string(),
                    entity_ref: city.city_id.to_string(),
                    message: format!(
                        "expanded aggregate abbreviated city display name from {} to {}",
                        original_display_name, expanded_display_name
                    ),
                });
                if city.display_name == "Berlin" {
                    if let Some(parent) = snapshot.iter().find(|parent| {
                        parent.city_id != city.city_id
                            && effective_city_country_code(parent, station_mappings) == "DE"
                            && comparable_place_key(&city_identity_key(&parent.display_name))
                                == "berlin"
                    }) {
                        remap.insert(city.city_id.clone(), parent.city_id.clone());
                    }
                }
            }
        }

        if normalize_name(&city.display_name) == "s"
            && city.wikidata_qid.is_none()
            && let Some(parent) =
                best_major_parent_for_generic_s_cluster(city, &snapshot, station_mappings)
        {
            remap.insert(city.city_id.clone(), parent.city_id.clone());
            issues.push(NormalizationIssue {
                severity: crate::IssueSeverity::Info,
                source_id: aggregate_source_id.to_string(),
                entity_ref: city.city_id.to_string(),
                message: format!(
                    "demoted aggregate generic S-prefix city {} into parent city {}",
                    city.display_name, parent.display_name
                ),
            });
            continue;
        }

        if is_fallback_reference_gap_singleton_city(
            city,
            mapping_by_city
                .get(&city.city_id)
                .map(|records| records.as_slice()),
        ) && let Some(parent) = best_parent_for_fallback_gap_alias_match(
            city,
            &snapshot,
            mapping_by_city
                .get(&city.city_id)
                .map(|records| records.as_slice()),
            &effective_country_by_city,
            &parent_match_keys_by_city,
        ) {
            remap.insert(city.city_id.clone(), parent.city_id.clone());
            issues.push(NormalizationIssue {
                severity: crate::IssueSeverity::Info,
                source_id: aggregate_source_id.to_string(),
                entity_ref: city.city_id.to_string(),
                message: format!(
                    "demoted aggregate fallback-gap singleton city {} into authoritative parent city {}",
                    city.display_name, parent.display_name
                ),
            });
            continue;
        }

        if !is_station_qualified_city_name(&city.display_name) || city.station_ids.len() != 1 {
            continue;
        }

        let effective_country = infer_country_code_from_station_mappings(city, station_mappings)
            .unwrap_or_else(|| city.country_code.clone());
        let child_keys = station_like_parent_keys(
            city,
            mapping_by_city
                .get(&city.city_id)
                .map(|records| records.as_slice()),
        );
        let allow_nearby_fallback = starts_with_urban_platform_label(&city.display_name);
        let mut candidates = snapshot
            .iter()
            .filter(|parent| parent.city_id != city.city_id)
            .filter_map(|parent| {
                station_like_parent_match_score(
                    city,
                    parent,
                    &effective_country,
                    &child_keys,
                    allow_nearby_fallback,
                )
                .map(|score| (parent, score))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| right.1.cmp(&left.1));
        if candidates.is_empty() {
            continue;
        }
        if candidates.len() >= 2 && candidates[0].1 == candidates[1].1 {
            continue;
        }
        let parent = candidates[0].0;
        remap.insert(city.city_id.clone(), parent.city_id.clone());
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Info,
            source_id: aggregate_source_id.to_string(),
            entity_ref: city.city_id.to_string(),
            message: format!(
                "demoted aggregate station-like singleton city {} into parent city {}",
                city.display_name, parent.display_name
            ),
        });
    }

    if remap.is_empty() {
        return;
    }
    for (from_city_id, to_city_id) in &remap {
        rebind_city_id_remap(city_id_remap, from_city_id, to_city_id);
    }
    *cities = collapse_cities_by_remap(cities.drain(..), &remap)
        .into_values()
        .collect();
}

fn effective_city_country_code(
    city: &aetrain_domain::City,
    station_mappings: &StationMappingReport,
) -> String {
    infer_country_code_from_station_mappings(city, station_mappings)
        .unwrap_or_else(|| city.country_code.clone())
}

fn is_fallback_reference_gap_singleton_city(
    city: &aetrain_domain::City,
    station_records: Option<&[&crate::StationMappingRecord]>,
) -> bool {
    city.wikidata_qid.is_none()
        && city.station_ids.len() == 1
        && station_records.is_some_and(|records| {
            !records.is_empty()
                && records.iter().all(|record| {
                    record.mapping_strategy == crate::StationMappingStrategy::FallbackReferenceGap
                })
        })
}

fn best_parent_for_fallback_gap_alias_match<'a>(
    city: &aetrain_domain::City,
    snapshot: &'a [aetrain_domain::City],
    station_records: Option<&[&crate::StationMappingRecord]>,
    effective_country_by_city: &BTreeMap<aetrain_domain::CityId, String>,
    parent_match_keys_by_city: &BTreeMap<aetrain_domain::CityId, BTreeSet<String>>,
) -> Option<&'a aetrain_domain::City> {
    let effective_country = effective_country_by_city
        .get(&city.city_id)
        .cloned()
        .unwrap_or_else(|| city.country_code.clone());
    let child_keys = station_like_parent_keys(city, station_records);
    if child_keys.is_empty() {
        return None;
    }

    let mut candidates = snapshot
        .iter()
        .filter(|parent| parent.city_id != city.city_id)
        .filter(|parent| {
            effective_country_by_city
                .get(&parent.city_id)
                .is_some_and(|country| *country == effective_country)
        })
        .filter(|parent| {
            parent_match_keys_by_city
                .get(&parent.city_id)
                .is_some_and(|keys| keys.iter().any(|key| child_keys.contains(key)))
        })
        .filter_map(|parent| {
            let distance_meters =
                geo_distance_meters(city.location, parent.location).round() as u32;
            (distance_meters <= 10_000).then_some((parent, distance_meters))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        fallback_gap_parent_match_score(left.0)
            .cmp(&fallback_gap_parent_match_score(right.0))
            .then_with(|| left.1.cmp(&right.1))
            .reverse()
    });
    if candidates.len() >= 2
        && fallback_gap_parent_match_score(candidates[0].0)
            == fallback_gap_parent_match_score(candidates[1].0)
        && candidates[0].1 == candidates[1].1
    {
        return None;
    }
    candidates.first().map(|(parent, _)| *parent)
}

fn fallback_gap_parent_match_score(city: &aetrain_domain::City) -> (u8, usize, usize) {
    (
        u8::from(city_id_has_registry_qid(city) || city.wikidata_qid.is_some()),
        city.station_ids.len(),
        city.aliases.len(),
    )
}

fn quarantine_unresolved_fallback_gap_pseudo_cities(
    cities: &mut Vec<aetrain_domain::City>,
    aliases: &mut Vec<aetrain_dataset::AliasRecord>,
    stations: &mut Vec<aetrain_domain::Station>,
    edges: &mut Vec<aetrain_domain::TravelEdge>,
    edge_geometries: &mut EdgeGeometryArtifact,
    station_mappings: &mut StationMappingReport,
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> Vec<PipelineQuarantinedFallbackGapCityRecord> {
    let mapping_by_city = station_mappings.records.iter().fold(
        BTreeMap::<aetrain_domain::CityId, Vec<&crate::StationMappingRecord>>::new(),
        |mut acc, record| {
            acc.entry(record.city_id.clone()).or_default().push(record);
            acc
        },
    );

    let quarantined = cities
        .iter()
        .filter_map(|city| {
            let records = mapping_by_city.get(&city.city_id)?;
            classify_quarantined_fallback_gap_pseudo_city(city, records).map(
                |(classification, suggested_action)| PipelineQuarantinedFallbackGapCityRecord {
                    city_id: city.city_id.clone(),
                    display_name: city.display_name.clone(),
                    country_code: city.country_code.clone(),
                    station_display_names: records
                        .iter()
                        .map(|record| record.station_display_name.clone())
                        .collect(),
                    classification: classification.to_string(),
                    suggested_action: suggested_action.to_string(),
                },
            )
        })
        .collect::<Vec<_>>();

    if quarantined.is_empty() {
        return quarantined;
    }

    let quarantined_city_ids = quarantined
        .iter()
        .map(|record| record.city_id.clone())
        .collect::<BTreeSet<_>>();
    for record in &quarantined {
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Warning,
            source_id: aggregate_source_id.to_string(),
            entity_ref: record.city_id.to_string(),
            message: format!(
                "quarantined unresolved fallback-gap pseudo-city {} ({})",
                record.display_name, record.classification
            ),
        });
    }

    cities.retain(|city| !quarantined_city_ids.contains(&city.city_id));
    aliases.retain(|alias| !quarantined_city_ids.contains(&alias.city_id));
    stations.retain(|station| !quarantined_city_ids.contains(&station.city_id));
    edges.retain(|edge| {
        !quarantined_city_ids.contains(&edge.from_city_id)
            && !quarantined_city_ids.contains(&edge.to_city_id)
    });
    edge_geometries.geometries.retain(|geometry| {
        !quarantined_city_ids.contains(&geometry.from_city_id)
            && !quarantined_city_ids.contains(&geometry.to_city_id)
    });
    station_mappings
        .records
        .retain(|record| !quarantined_city_ids.contains(&record.city_id));

    *aliases = rebuild_alias_records(cities);
    quarantined
}

fn quarantine_placeholder_promoted_attachment_gap_cities(
    cities: &mut Vec<aetrain_domain::City>,
    aliases: &mut Vec<aetrain_dataset::AliasRecord>,
    stations: &mut Vec<aetrain_domain::Station>,
    edges: &mut Vec<aetrain_domain::TravelEdge>,
    edge_geometries: &mut EdgeGeometryArtifact,
    station_mappings: &mut StationMappingReport,
    authority_registry: Option<&GeometryAuthorityRegistry>,
    authority_networks: &BTreeMap<String, RailGeometryNetwork>,
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> Vec<PipelineQuarantinedPromotedAttachmentGapCityRecord> {
    let Some(authority_registry) = authority_registry else {
        return Vec::new();
    };
    let mapping_by_city = station_mappings.records.iter().fold(
        BTreeMap::<aetrain_domain::CityId, Vec<&crate::StationMappingRecord>>::new(),
        |mut acc, record| {
            acc.entry(record.city_id.clone()).or_default().push(record);
            acc
        },
    );

    let quarantined = cities
        .iter()
        .filter_map(|city| {
            classify_quarantined_promoted_attachment_gap_city(
                city,
                mapping_by_city.get(&city.city_id)?.as_slice(),
                authority_registry,
                authority_networks,
            )
        })
        .collect::<Vec<_>>();

    if quarantined.is_empty() {
        return quarantined;
    }

    let quarantined_city_ids = quarantined
        .iter()
        .map(|record| record.city_id.clone())
        .collect::<BTreeSet<_>>();
    for record in &quarantined {
        issues.push(NormalizationIssue {
            severity: crate::IssueSeverity::Warning,
            source_id: aggregate_source_id.to_string(),
            entity_ref: record.city_id.to_string(),
            message: format!(
                "quarantined promoted attachment-gap placeholder city {} ({})",
                record.display_name, record.classification
            ),
        });
    }

    cities.retain(|city| !quarantined_city_ids.contains(&city.city_id));
    aliases.retain(|alias| !quarantined_city_ids.contains(&alias.city_id));
    stations.retain(|station| !quarantined_city_ids.contains(&station.city_id));
    edges.retain(|edge| {
        !quarantined_city_ids.contains(&edge.from_city_id)
            && !quarantined_city_ids.contains(&edge.to_city_id)
    });
    edge_geometries.geometries.retain(|geometry| {
        !quarantined_city_ids.contains(&geometry.from_city_id)
            && !quarantined_city_ids.contains(&geometry.to_city_id)
    });
    station_mappings
        .records
        .retain(|record| !quarantined_city_ids.contains(&record.city_id));

    *aliases = rebuild_alias_records(cities);
    quarantined
}

fn classify_quarantined_promoted_attachment_gap_city(
    city: &aetrain_domain::City,
    station_records: &[&crate::StationMappingRecord],
    authority_registry: &GeometryAuthorityRegistry,
    authority_networks: &BTreeMap<String, RailGeometryNetwork>,
) -> Option<PipelineQuarantinedPromotedAttachmentGapCityRecord> {
    let (classification, suggested_action) =
        classify_quarantined_fallback_gap_pseudo_city(city, station_records)?;
    if !is_fallback_reference_gap_singleton_city(city, Some(station_records))
        || city.wikidata_qid.is_some()
        || city.population.is_some()
    {
        return None;
    }
    let authority = authority_registry.country(&city.country_code)?;
    if !authority.status.is_promoted() {
        return None;
    }
    let source_id = authority.source_id.as_ref()?;
    let network = authority_networks.get(source_id)?;
    let local_candidate_distances_m = network
        .route_snap_candidates(city.location)
        .into_iter()
        .map(|(_, distance)| distance)
        .collect::<Vec<_>>();
    let expanded_candidate_distances_m = network
        .expanded_route_snap_candidates(city.location)
        .into_iter()
        .map(|(_, distance)| distance)
        .collect::<Vec<_>>();
    if !expanded_candidate_distances_m.is_empty() {
        return None;
    }

    Some(PipelineQuarantinedPromotedAttachmentGapCityRecord {
        city_id: city.city_id.clone(),
        display_name: city.display_name.clone(),
        country_code: city.country_code.clone(),
        station_display_names: station_records
            .iter()
            .map(|record| record.station_display_name.clone())
            .collect(),
        source_id: source_id.clone(),
        local_candidate_distances_m,
        expanded_candidate_distances_m,
        classification: format!("promoted_attachment_gap_{classification}"),
        suggested_action: suggested_action.to_string(),
    })
}

fn classify_quarantined_fallback_gap_pseudo_city(
    city: &aetrain_domain::City,
    station_records: &[&crate::StationMappingRecord],
) -> Option<(&'static str, &'static str)> {
    if !is_fallback_reference_gap_singleton_city(city, Some(station_records)) {
        return None;
    }

    let station_names = station_records
        .iter()
        .map(|record| record.station_display_name.as_str())
        .collect::<Vec<_>>();
    if station_names
        .iter()
        .any(|name| fallback_gap_station_name_has_separator(name))
    {
        return Some((
            "fallback_gap_multi_locality_stop_label",
            "keep as station only until registry coverage provides an authoritative parent municipality",
        ));
    }
    if station_names
        .iter()
        .any(|name| fallback_gap_station_name_has_local_stop_qualifier(name))
        || fallback_gap_station_name_has_local_stop_qualifier(&city.display_name)
    {
        return Some((
            "fallback_gap_local_stop_label",
            "keep as station only until registry coverage provides an authoritative parent municipality",
        ));
    }

    None
}

fn fallback_gap_station_name_has_separator(value: &str) -> bool {
    value.contains(" - ")
}

fn fallback_gap_station_name_has_local_stop_qualifier(value: &str) -> bool {
    let normalized = normalize_name(value);
    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    tokens.iter().any(|token| {
        matches!(
            *token,
            "abri"
                | "bondy"
                | "centre"
                | "cimetiere"
                | "croisement"
                | "eglise"
                | "feuillee"
                | "gare"
                | "lac"
                | "lotissement"
                | "mairie"
                | "maison"
                | "parking"
                | "place"
                | "pont"
                | "quai"
                | "rond"
                | "route"
                | "routiere"
                | "salle"
                | "stade"
                | "usine"
                | "vieux"
                | "village"
        )
    }) || normalized.contains("saint anne")
        || normalized.contains("champ de foire")
}

fn cleaned_residual_city_display_name(
    city: &aetrain_domain::City,
    station_records: Option<&Vec<&crate::StationMappingRecord>>,
) -> Option<String> {
    if !is_station_qualified_city_name(&city.display_name)
        && route_like_candidate_record(city).is_none()
        && !matches!(normalize_name(&city.display_name).as_str(), "ay f")
    {
        return None;
    }

    if normalize_name(&city.display_name) == "ay f" {
        return Some("Ay".to_string());
    }

    let mut names = vec![city.display_name.clone()];
    names.extend(city.aliases.clone());
    if let Some(records) = station_records {
        names.extend(
            records
                .iter()
                .map(|record| record.station_display_name.clone()),
        );
    }

    let mut candidates = BTreeSet::new();
    for name in names {
        let cleaned_key = city_identity_key(&name);
        if !cleaned_key.is_empty()
            && is_plausible_aggregate_city_name(&cleaned_key)
            && cleaned_key.split_whitespace().all(|token| {
                !token.chars().any(|ch| ch.is_ascii_digit())
                    && !is_route_designator_token(token)
                    && !is_street_suffix_token(token)
            })
        {
            candidates.insert(title_case_ascii_name(&cleaned_key));
        }
        if let Some(route_key) = route_like_primary_parent_key(&name)
            && is_plausible_aggregate_city_name(&route_key)
        {
            candidates.insert(title_case_ascii_name(&route_key));
        }
    }

    candidates.into_iter().max_by(|left, right| {
        canonical_cleaned_name_rank(left).cmp(&canonical_cleaned_name_rank(right))
    })
}

fn canonical_cleaned_name_rank(value: &str) -> (usize, usize, std::cmp::Reverse<String>) {
    let normalized = normalize_name(value);
    (
        normalized.split_whitespace().count(),
        normalized.len(),
        std::cmp::Reverse(normalized),
    )
}

fn explicit_abbreviation_expansion(city: &aetrain_domain::City) -> Option<String> {
    match (
        city.country_code.as_str(),
        normalize_name(&city.display_name).as_str(),
    ) {
        ("DE", "d") => Some("Dusseldorf".to_string()),
        ("DE", "fds") => Some("Freudenstadt".to_string()),
        ("DE", "gd") => Some("Schwabisch Gmund".to_string()),
        ("DE", "ma") => Some("Mannheim".to_string()),
        ("DE", "me") => Some("Mettmann".to_string()),
        ("DE", "mg") => Some("Monchengladbach".to_string()),
        ("DE", "s") => Some("Berlin".to_string()),
        _ => None,
    }
}

fn best_major_parent_for_generic_s_cluster<'a>(
    city: &aetrain_domain::City,
    snapshot: &'a [aetrain_domain::City],
    station_mappings: &StationMappingReport,
) -> Option<&'a aetrain_domain::City> {
    if normalize_name(&city.display_name) != "s" {
        return None;
    }
    let effective_country = effective_city_country_code(city, station_mappings);
    snapshot
        .iter()
        .filter(|parent| parent.city_id != city.city_id)
        .filter(|parent| effective_city_country_code(parent, station_mappings) == effective_country)
        .filter(|parent| normalize_name(&parent.display_name) != "s")
        .filter_map(|parent| {
            let distance_meters = geo_distance_meters(city.location, parent.location);
            (distance_meters <= AGGREGATE_CITY_MERGE_DISTANCE_METERS as f64).then_some((
                parent,
                (
                    parent.interest_score.unwrap_or(0),
                    parent.station_ids.len(),
                    std::cmp::Reverse(distance_meters.round() as u32),
                ),
            ))
        })
        .max_by(|left, right| left.1.cmp(&right.1))
        .map(|(parent, _)| parent)
}

fn connected_city_components(group: &[&aetrain_domain::City]) -> Vec<Vec<usize>> {
    let mut visited = vec![false; group.len()];
    let mut components = Vec::new();

    for start in 0..group.len() {
        if visited[start] {
            continue;
        }

        let mut stack = vec![start];
        let mut component = Vec::new();
        visited[start] = true;

        while let Some(index) = stack.pop() {
            component.push(index);
            for candidate in 0..group.len() {
                if visited[candidate] {
                    continue;
                }
                if should_merge_city_records(group[index], group[candidate]) {
                    visited[candidate] = true;
                    stack.push(candidate);
                }
            }
        }

        components.push(component);
    }

    components
}

fn should_merge_city_records(left: &aetrain_domain::City, right: &aetrain_domain::City) -> bool {
    geo_distance_meters(left.location, right.location)
        <= AGGREGATE_CITY_MERGE_DISTANCE_METERS as f64
}

fn choose_canonical_city<'a>(
    cities: impl Iterator<Item = &'a aetrain_domain::City>,
) -> &'a aetrain_domain::City {
    cities
        .max_by(|left, right| canonical_city_rank(left).cmp(&canonical_city_rank(right)))
        .expect("city merge component should not be empty")
}

fn canonical_city_rank(
    city: &aetrain_domain::City,
) -> (u8, u8, u8, usize, u64, u8, usize, std::cmp::Reverse<String>) {
    (
        city_identity_quality(city),
        u8::from(!is_station_qualified_city_name(&city.display_name)),
        u8::from(city.country_code != "ZZ"),
        city.station_ids.len(),
        city.population.unwrap_or(0),
        city.interest_score.unwrap_or(0),
        city.aliases.len(),
        std::cmp::Reverse(city.city_id.as_str().to_string()),
    )
}

fn city_identity_quality(city: &aetrain_domain::City) -> u8 {
    let city_id = city.city_id.as_str();
    let mut parts = city_id.rsplitn(3, '-');
    let Some(last) = parts.next() else {
        return 0;
    };
    let Some(country) = parts.next() else {
        return 0;
    };

    if country == "fr" && last.len() == 5 && last.chars().all(|ch| ch.is_ascii_digit()) {
        return 2;
    }

    0
}

fn apply_computed_city_enrichment(
    cities: &mut [aetrain_domain::City],
    edges: &[aetrain_domain::TravelEdge],
) {
    let mut neighbors_by_city = HashMap::<String, BTreeSet<String>>::new();
    for edge in edges {
        neighbors_by_city
            .entry(edge.from_city_id.as_str().to_string())
            .or_default()
            .insert(edge.to_city_id.as_str().to_string());
        neighbors_by_city
            .entry(edge.to_city_id.as_str().to_string())
            .or_default()
            .insert(edge.from_city_id.as_str().to_string());
    }

    for city in cities {
        if city.interest_score.is_some() {
            continue;
        }
        let degree = neighbors_by_city
            .get(city.city_id.as_str())
            .map(|neighbors| neighbors.len())
            .unwrap_or(0);
        city.interest_score = Some(compute_city_interest_score(city, degree));
    }
}

fn apply_registry_city_authority(
    cities: &mut [aetrain_domain::City],
    city_id_remap: &mut BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
    overlay: &RegistryCanonicalBundle,
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> RegistryOverlayStats {
    let mut claimed_indexes = BTreeSet::new();
    let mut stats = RegistryOverlayStats::default();
    for registry_city in &overlay.cities {
        let candidates = cities
            .iter()
            .enumerate()
            .filter(|(index, _)| !claimed_indexes.contains(index))
            .filter_map(|(index, city)| {
                registry_overlay_match_score(city, registry_city).map(|score| (index, score))
            })
            .collect::<Vec<_>>();
        let Some(best_score) = candidates.iter().map(|(_, score)| *score).max() else {
            stats.unmatched_count += 1;
            issues.push(NormalizationIssue {
                severity: crate::IssueSeverity::Warning,
                source_id: aggregate_source_id.to_string(),
                entity_ref: registry_city.city_id.to_string(),
                message: format!(
                    "registry overlay city {} had no aggregate city match",
                    registry_city.city_id
                ),
            });
            continue;
        };
        let best_candidates = candidates
            .into_iter()
            .filter(|(_, score)| *score == best_score)
            .collect::<Vec<_>>();
        if best_candidates.len() > 1 {
            stats.ambiguous_count += 1;
            issues.push(NormalizationIssue {
                severity: crate::IssueSeverity::Warning,
                source_id: aggregate_source_id.to_string(),
                entity_ref: registry_city.city_id.to_string(),
                message: format!(
                    "registry overlay city {} matched multiple aggregate cities with equal score",
                    registry_city.city_id
                ),
            });
            continue;
        }
        let index = best_candidates[0].0;
        claimed_indexes.insert(index);
        let city = &mut cities[index];
        stats.matched_count += 1;
        let mut changed = false;
        let original_city_id = city.city_id.clone();
        let original_display_name = city.display_name.clone();
        let original_country_code = city.country_code.clone();
        if city.city_id != registry_city.city_id {
            rebind_city_id_remap(city_id_remap, &city.city_id, &registry_city.city_id);
            city.city_id = registry_city.city_id.clone();
            changed = true;
        }
        if city.slug != registry_city.slug {
            city.slug = registry_city.slug.clone();
            changed = true;
        }
        if city.display_name != registry_city.display_name {
            city.display_name = registry_city.display_name.clone();
            changed = true;
        }
        if original_display_name != registry_city.display_name
            && !city
                .aliases
                .iter()
                .any(|alias| alias == &original_display_name)
        {
            city.aliases.push(original_display_name.clone());
            changed = true;
        }
        if city.country_code != registry_city.country_code {
            city.country_code = registry_city.country_code.clone();
            changed = true;
        }
        if city.wikidata_qid != registry_city.wikidata_qid {
            city.wikidata_qid = registry_city.wikidata_qid.clone();
            changed = true;
        }
        if city.population != registry_city.population {
            city.population = registry_city.population;
            changed = true;
        }
        if original_country_code != registry_city.country_code {
            stats.country_corrected_count += 1;
        }
        if normalize_name(&original_display_name) != normalize_name(&registry_city.display_name) {
            stats.station_promoted_count += 1;
        }

        if changed {
            issues.push(NormalizationIssue {
                severity: crate::IssueSeverity::Info,
                source_id: aggregate_source_id.to_string(),
                entity_ref: original_city_id.to_string(),
                message: format!(
                    "applied authoritative registry city {} to aggregate city {}",
                    registry_city.city_id, original_city_id
                ),
            });
        }
    }
    stats
}

fn rebind_city_id_remap(
    city_id_remap: &mut BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
    from_city_id: &aetrain_domain::CityId,
    to_city_id: &aetrain_domain::CityId,
) {
    city_id_remap.insert(from_city_id.clone(), to_city_id.clone());
    for remapped_city_id in city_id_remap.values_mut() {
        if remapped_city_id == from_city_id {
            *remapped_city_id = to_city_id.clone();
        }
    }
}

fn registry_overlay_match_score(
    city: &aetrain_domain::City,
    registry_city: &aetrain_registry::RegistryCity,
) -> Option<(u8, u8, u8, usize)> {
    let current_name = normalize_name(&city.display_name);
    let registry_name = normalize_name(&registry_city.display_name);
    let exact_name_match = current_name == registry_name;
    let strong_prefix_match = current_name.starts_with(&(registry_name.clone() + " "));
    if !exact_name_match && !strong_prefix_match {
        return None;
    }

    let name_rank = if exact_name_match { 3 } else { 2 };
    let country_rank = if city
        .country_code
        .eq_ignore_ascii_case(&registry_city.country_code)
    {
        2
    } else if city.country_code == "ZZ" {
        1
    } else {
        0
    };
    let station_rank = u8::from(!is_station_qualified_city_name(&city.display_name));
    Some((
        name_rank,
        country_rank,
        station_rank,
        city.station_ids.len(),
    ))
}

fn compute_city_interest_score(city: &aetrain_domain::City, degree: usize) -> u8 {
    if is_station_qualified_city_name(&city.display_name) {
        let mut score = if city.country_code == "ZZ" { 0u8 } else { 1u8 };
        if degree >= 32 {
            score += 1;
        }
        return score.min(10);
    }

    let mut score = if city.country_code == "ZZ" { 2u8 } else { 4u8 };
    score += match city.station_ids.len() {
        0..=1 => 0,
        2..=3 => 1,
        4..=7 => 2,
        _ => 3,
    };
    score += match degree {
        0..=1 => 0,
        2..=7 => 1,
        8..=23 => 2,
        24..=63 => 3,
        _ => 4,
    };
    if city.aliases.len() >= 4 {
        score += 1;
    }
    if let Some(population) = city.population {
        score += match population {
            0..=99_999 => 0,
            100_000..=499_999 => 1,
            500_000..=1_499_999 => 2,
            _ => 3,
        };
    }

    score.min(10)
}

fn route_like_parent_match_score(
    route_like_city: &aetrain_domain::City,
    parent_city: &aetrain_domain::City,
) -> Option<(u8, u8, std::cmp::Reverse<u32>, usize)> {
    if route_like_city.country_code != parent_city.country_code
        || route_like_candidate_record(parent_city).is_some()
        || is_station_qualified_city_name(&parent_city.display_name)
    {
        return None;
    }

    let distance_meters =
        geo_distance_meters(route_like_city.location, parent_city.location).round() as u32;
    if distance_meters > ROUTE_LIKE_PARENT_MAX_DISTANCE_METERS {
        return None;
    }

    let route_keys = route_like_parent_keys(&route_like_city.display_name);
    if route_keys.is_empty() {
        return None;
    }
    let mut parent_keys = parent_city_match_keys(parent_city);
    parent_keys.retain(|key| !key.is_empty());
    if !route_keys.iter().any(|key| parent_keys.contains(key)) {
        return None;
    }

    let authority_rank = if city_id_has_registry_qid(parent_city) {
        3
    } else if parent_city.wikidata_qid.is_some() {
        2
    } else {
        city_identity_quality(parent_city)
    };
    Some((
        authority_rank,
        parent_city.station_ids.len() as u8,
        std::cmp::Reverse(distance_meters),
        parent_city.aliases.len(),
    ))
}

fn station_like_parent_match_score(
    child_city: &aetrain_domain::City,
    parent_city: &aetrain_domain::City,
    effective_country: &str,
    child_keys: &BTreeSet<String>,
    allow_nearby_fallback: bool,
) -> Option<(u8, u8, std::cmp::Reverse<u32>, usize)> {
    if parent_city.country_code != effective_country
        || is_station_qualified_city_name(&parent_city.display_name)
        || route_like_candidate_record(parent_city).is_some()
    {
        return None;
    }

    let distance_meters =
        geo_distance_meters(child_city.location, parent_city.location).round() as u32;
    if distance_meters > 10_000 {
        return None;
    }

    let parent_keys = parent_city_match_keys(parent_city);
    let key_match =
        !child_keys.is_empty() && child_keys.iter().any(|key| parent_keys.contains(key));
    let fallback_match = allow_nearby_fallback && distance_meters <= 7_500;
    if !key_match && !fallback_match {
        return None;
    }

    let authority_rank = if city_id_has_registry_qid(parent_city) {
        4
    } else if parent_city.wikidata_qid.is_some() {
        3
    } else {
        city_identity_quality(parent_city)
    };
    Some((
        authority_rank,
        parent_city.station_ids.len() as u8,
        std::cmp::Reverse(distance_meters),
        parent_city.aliases.len(),
    ))
}

fn route_like_parent_keys(display_name: &str) -> BTreeSet<String> {
    let Some(base_name) = route_like_primary_parent_key(display_name) else {
        return BTreeSet::new();
    };
    let mut keys = BTreeSet::new();
    keys.insert(base_name.clone());
    let expanded = base_name
        .split_whitespace()
        .map(expand_abbreviated_place_token)
        .collect::<Vec<_>>()
        .join(" ");
    keys.insert(comparable_place_key(&expanded));
    keys.retain(|key| !key.is_empty());
    keys
}

fn station_like_parent_keys(
    city: &aetrain_domain::City,
    station_records: Option<&[&crate::StationMappingRecord]>,
) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut names = vec![city.display_name.clone()];
    if let Some(records) = station_records {
        names.extend(
            records
                .iter()
                .map(|record| record.station_display_name.clone()),
        );
    }
    for name in names {
        let identity = city_identity_key(&name);
        if !identity.is_empty() {
            keys.insert(comparable_place_key(&identity));
            let expanded = identity
                .split_whitespace()
                .map(expand_abbreviated_place_token)
                .collect::<Vec<_>>()
                .join(" ");
            keys.insert(comparable_place_key(&expanded));
        }
    }
    keys.retain(|key| !key.is_empty());
    keys
}

fn starts_with_urban_platform_label(display_name: &str) -> bool {
    let normalized = normalize_name(display_name);
    normalized.starts_with("s bahn ") || normalized.starts_with("u bahn ")
}

fn route_like_primary_parent_key(display_name: &str) -> Option<String> {
    let normalized = normalize_name(display_name);
    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return None;
    }

    let marker_index = tokens
        .iter()
        .position(|token| {
            token.chars().any(|ch| ch.is_ascii_digit())
                || is_route_designator_token(token)
                || is_street_suffix_token(token)
        })
        .unwrap_or(tokens.len());
    let mut prefix = tokens[..marker_index].to_vec();
    while prefix
        .last()
        .is_some_and(|token| is_route_locality_token(token))
    {
        prefix.pop();
    }
    if prefix.is_empty() {
        return None;
    }
    Some(comparable_place_key(&prefix.join(" ")))
}

fn infer_country_code_from_station_mappings(
    city: &aetrain_domain::City,
    station_mappings: &StationMappingReport,
) -> Option<String> {
    let direct = infer_country_code_from_station_ids(&city.station_ids);
    if direct.is_some() {
        return direct;
    }

    let filtered_station_ids = station_mappings
        .records
        .iter()
        .filter(|record| record.city_id == city.city_id)
        .filter(|record| !is_bus_like_station_display_name(&record.station_display_name))
        .map(|record| record.station_id.clone())
        .collect::<Vec<_>>();
    if let Some(country_code) = infer_country_code_from_station_ids(&filtered_station_ids) {
        return Some(country_code);
    }

    let mut raw_prefixes = station_mappings
        .records
        .iter()
        .filter(|record| record.city_id == city.city_id)
        .filter_map(|record| infer_country_code_from_station_key(&record.station_key))
        .collect::<BTreeSet<_>>();
    if raw_prefixes.len() == 1 {
        return raw_prefixes.pop_first();
    }

    None
}

fn is_bus_like_station_display_name(value: &str) -> bool {
    let normalized = normalize_name(value);
    normalized.contains("gare routiere")
        || normalized.contains("busbahnhof")
        || normalized.contains("busstation")
        || normalized.starts_with("bus ")
}

fn infer_country_code_from_station_key(station_key: &str) -> Option<String> {
    let prefix = station_key.split(':').next()?;
    let normalized = prefix
        .strip_prefix('P')
        .unwrap_or(prefix)
        .to_ascii_lowercase();
    match normalized.as_str() {
        "de" => Some("DE".to_string()),
        "fr" => Some("FR".to_string()),
        "ch" => Some("CH".to_string()),
        "at" => Some("AT".to_string()),
        "be" => Some("BE".to_string()),
        "lu" => Some("LU".to_string()),
        "es" => Some("ES".to_string()),
        "it" => Some("IT".to_string()),
        _ => None,
    }
}

fn parent_city_match_keys(city: &aetrain_domain::City) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut names = city.aliases.clone();
    names.push(city.display_name.clone());
    for name in names {
        keys.insert(comparable_place_key(&city_identity_key(&name)));
        keys.insert(comparable_place_key(&normalize_name(&name)));
    }
    keys.retain(|key| !key.is_empty());
    keys
}

fn comparable_place_key(value: &str) -> String {
    normalize_name(value)
        .split_whitespace()
        .map(expand_abbreviated_place_token)
        .filter(|token| !is_place_connector_token(token))
        .collect::<Vec<_>>()
        .join(" ")
}

fn expand_abbreviated_place_token(token: &str) -> String {
    match token {
        "ka" => "karlsruhe".to_string(),
        "st" => "saint".to_string(),
        "ste" => "sainte".to_string(),
        _ => token.to_string(),
    }
}

fn is_place_connector_token(token: &str) -> bool {
    matches!(
        token,
        "d" | "de" | "des" | "du" | "en" | "l" | "la" | "le" | "les" | "pres" | "sur" | "sous"
    )
}

fn is_route_locality_token(token: &str) -> bool {
    matches!(
        token,
        "abri" | "bourg" | "carrefour" | "centre" | "cte" | "inter"
    )
}

fn recompute_duplicates(
    generated_at: &str,
    cities: &[aetrain_domain::City],
) -> DuplicateCityReport {
    let mut grouped = BTreeMap::<String, Vec<&aetrain_domain::City>>::new();
    for city in cities {
        grouped
            .entry(city_identity_key(&city.display_name))
            .or_default()
            .push(city);
    }

    let mut candidates = Vec::new();
    for (normalized_name, group) in grouped {
        for left_index in 0..group.len() {
            for right_index in (left_index + 1)..group.len() {
                let left = group[left_index];
                let right = group[right_index];
                let distance_meters =
                    geo_distance_meters(left.location, right.location).round() as u32;
                if distance_meters <= crate::DEFAULT_DUPLICATE_DISTANCE_METERS {
                    candidates.push(crate::DuplicateCityCandidate {
                        left_city_id: left.city_id.clone(),
                        left_display_name: left.display_name.clone(),
                        right_city_id: right.city_id.clone(),
                        right_display_name: right.display_name.clone(),
                        normalized_name: normalized_name.clone(),
                        distance_meters,
                    });
                }
            }
        }
    }

    DuplicateCityReport {
        generated_at: generated_at.to_string(),
        threshold_meters: crate::DEFAULT_DUPLICATE_DISTANCE_METERS,
        candidates,
    }
}

fn merge_edge_record(
    existing: &mut aetrain_domain::TravelEdge,
    incoming: &aetrain_domain::TravelEdge,
) {
    let incoming_is_better = incoming.duration_min < existing.duration_min
        || (incoming.duration_min == existing.duration_min
            && incoming.source_confidence > existing.source_confidence);

    if incoming_is_better {
        existing.duration_min = incoming.duration_min;
        existing.service_kind = incoming.service_kind.clone();
        existing.service_class = incoming.service_class.clone();
    }

    existing.change_count_estimate = merge_optional_u8_min(
        existing.change_count_estimate,
        incoming.change_count_estimate,
    );
    existing.source_confidence = existing.source_confidence.max(incoming.source_confidence);
    merge_string_vec(&mut existing.provenance, &incoming.provenance);
}

fn merge_edge_geometry_record(existing: &mut EdgeGeometryRecord, incoming: &EdgeGeometryRecord) {
    let existing_rank = edge_geometry_source_rank(&existing.source);
    let incoming_rank = edge_geometry_source_rank(&incoming.source);
    let incoming_is_better = incoming_rank < existing_rank
        || (incoming_rank == existing_rank && incoming.points.len() > existing.points.len());

    if incoming_is_better {
        existing.points = incoming.points.clone();
        existing.source = incoming.source.clone();
    }

    merge_string_vec(&mut existing.provenance, &incoming.provenance);
}

fn edge_geometry_source_rank(source: &EdgeGeometrySource) -> u8 {
    match source {
        EdgeGeometrySource::InfrastructureGraphFallback => 0,
        EdgeGeometrySource::OsmGraphFallbackPlanned => 1,
        EdgeGeometrySource::GtfsShapeSegment => 2,
        EdgeGeometrySource::StraightLineFallback => 3,
    }
}

fn merge_geo_points(
    left: aetrain_domain::GeoPoint,
    right: aetrain_domain::GeoPoint,
) -> aetrain_domain::GeoPoint {
    aetrain_domain::GeoPoint {
        lat: (left.lat + right.lat) / 2.0,
        lon: (left.lon + right.lon) / 2.0,
    }
}

fn merge_optional_u64(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn merge_optional_u8(left: Option<u8>, right: Option<u8>) -> Option<u8> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn merge_optional_u8_min(left: Option<u8>, right: Option<u8>) -> Option<u8> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn resolve_manifest_relative_path(manifest_dir: &Path, configured_path: &str) -> PathBuf {
    let path = PathBuf::from(configured_path);
    if path.is_absolute() {
        path
    } else {
        manifest_dir.join(path)
    }
}

fn merge_string_vec(target: &mut Vec<String>, values: &[String]) {
    let mut seen = target.iter().cloned().collect::<BTreeSet<_>>();
    for value in values {
        if seen.insert(value.clone()) {
            target.push(value.clone());
        }
    }
    target.sort();
}

fn merge_station_ids(
    target: &mut Vec<aetrain_domain::StationId>,
    values: &[aetrain_domain::StationId],
) {
    let mut seen = target
        .iter()
        .map(|station_id| station_id.as_str().to_string())
        .collect::<BTreeSet<_>>();
    for value in values {
        if seen.insert(value.as_str().to_string()) {
            target.push(value.clone());
        }
    }
}

fn merge_source_refs(
    target: &mut Vec<aetrain_domain::SourceRef>,
    values: &[aetrain_domain::SourceRef],
) {
    let mut seen = target
        .iter()
        .map(|source_ref| (source_ref.source_id.clone(), source_ref.raw_id.clone()))
        .collect::<BTreeSet<_>>();
    for value in values {
        let key = (value.source_id.clone(), value.raw_id.clone());
        if seen.insert(key) {
            target.push(value.clone());
        }
    }
    target.sort_by(|left, right| {
        left.source_id
            .cmp(&right.source_id)
            .then_with(|| left.raw_id.cmp(&right.raw_id))
    });
}

fn normalize_name(value: &str) -> String {
    deunicode(value)
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_alias(value: &str) -> String {
    normalize_name(value)
}

fn city_identity_key(value: &str) -> String {
    let normalized = normalize_name(value);
    let mut tokens = normalized
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();

    if let Some(index) = station_qualifier_start_index(&tokens) {
        if index > 0 {
            tokens.truncate(index);
        }
    } else {
        loop {
            let trimmed = if tokens.ends_with(&["gare".to_string(), "centrale".to_string()])
                || tokens.ends_with(&["gare".to_string(), "central".to_string()])
                || tokens.ends_with(&["central".to_string(), "station".to_string()])
            {
                Some(tokens.len() - 2)
            } else if tokens.last().is_some_and(|token| is_station_token(token)) {
                Some(tokens.len() - 1)
            } else {
                None
            };

            let Some(new_len) = trimmed else {
                break;
            };
            if new_len == 0 {
                break;
            }
            tokens.truncate(new_len);
        }
    }

    loop {
        let trimmed = if tokens.ends_with(&["arret".to_string(), "tcl".to_string()])
            || tokens.ends_with(&["rond".to_string(), "point".to_string()])
            || tokens.ends_with(&["la".to_string(), "poste".to_string()])
            || tokens.ends_with(&["route".to_string(), "nationale".to_string()])
            || tokens.ends_with(&["route".to_string(), "principale".to_string()])
        {
            Some(tokens.len() - 2)
        } else if tokens
            .last()
            .is_some_and(|token| is_locality_suffix_token(token))
        {
            Some(tokens.len() - 1)
        } else {
            None
        };

        let Some(new_len) = trimmed else {
            break;
        };
        if new_len == 0 {
            break;
        }
        tokens.truncate(new_len);
    }

    loop {
        let trimmed = if tokens.len() >= 2
            && tokens
                .last()
                .is_some_and(|token| is_street_suffix_token(token))
        {
            Some(tokens.len() - 2)
        } else if tokens.last().is_some_and(|token| {
            token.chars().any(|ch| ch.is_ascii_digit()) || is_route_designator_token(token)
        }) {
            Some(tokens.len() - 1)
        } else {
            None
        };

        let Some(new_len) = trimmed else {
            break;
        };
        if new_len == 0 {
            break;
        }
        tokens.truncate(new_len);
    }

    if tokens.is_empty() {
        normalized
    } else {
        tokens.join(" ")
    }
}

fn is_station_qualified_city_name(value: &str) -> bool {
    let tokens = normalize_name(value)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    tokens.len() > 1 && station_qualifier_start_index(&tokens).is_some()
}

fn station_qualifier_start_index(tokens: &[String]) -> Option<usize> {
    tokens
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, token)| {
            if !is_station_token(token) {
                return None;
            }
            if index > 0 && is_station_prefix_token(&tokens[index - 1]) {
                return Some(index - 1);
            }
            Some(index)
        })
}

fn is_station_token(token: &str) -> bool {
    matches!(
        token,
        "aeroport"
            | "airport"
            | "bahn"
            | "bahnhof"
            | "bahnhst"
            | "bf"
            | "bhf"
            | "busbahnhof"
            | "busstation"
            | "centrale"
            | "gare"
            | "gareroutiere"
            | "halt"
            | "haltepunkt"
            | "hbf"
            | "hauptbahnhof"
            | "hb"
            | "routiere"
            | "stazione"
            | "station"
            | "tgv"
            | "zob"
    )
}

fn is_station_prefix_token(token: &str) -> bool {
    matches!(token, "s" | "u")
}

fn is_locality_suffix_token(token: &str) -> bool {
    matches!(
        token,
        "centre"
            | "mairie"
            | "eglise"
            | "pharmacie"
            | "lycee"
            | "village"
            | "cimetiere"
            | "stade"
            | "archives"
            | "charite"
            | "monument"
            | "poste"
            | "republique"
            | "hopital"
    )
}

fn is_route_designator_token(token: &str) -> bool {
    matches!(token, "a" | "b" | "d" | "k" | "l" | "rd" | "rn")
}

fn is_street_suffix_token(token: &str) -> bool {
    matches!(
        token,
        "allee" | "avenue" | "chaussee" | "road" | "route" | "rue" | "strasse"
    )
}

fn geo_distance_meters(left: aetrain_domain::GeoPoint, right: aetrain_domain::GeoPoint) -> f64 {
    let earth_radius_m = 6_371_000.0_f64;
    let lat1 = left.lat.to_radians();
    let lat2 = right.lat.to_radians();
    let delta_lat = (right.lat - left.lat).to_radians();
    let delta_lon = (right.lon - left.lon).to_radians();

    let haversine =
        (delta_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);
    let angular_distance = 2.0 * haversine.sqrt().asin();
    earth_radius_m * angular_distance
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse JSON from {}", path.display()))
}

fn adapter_for(adapter_id: &str) -> Option<&'static dyn PipelineAdapter> {
    static SNCF_ADAPTER: SncfAdapter = SncfAdapter;
    static GTFS_BASIC_ADAPTER: GtfsBasicAdapter = GtfsBasicAdapter;
    static AGGREGATE_BUNDLE_ADAPTER: AggregateBundleAdapter = AggregateBundleAdapter;

    match adapter_id {
        "sncf_fr" => Some(&SNCF_ADAPTER),
        "gtfs_basic" => Some(&GTFS_BASIC_ADAPTER),
        "aggregate_bundle" => Some(&AGGREGATE_BUNDLE_ADAPTER),
        _ => None,
    }
}

impl PipelineAdapter for SncfAdapter {
    fn adapter_id(&self) -> &'static str {
        "sncf_fr"
    }

    fn build(&self, request: AdapterBuildRequest<'_>) -> Result<AdapterBuildArtifacts> {
        let gtfs = request.source_by_role_or_kind("schedule", SourceKind::Gtfs)?;
        let stations =
            request.source_by_role_or_kind("stations_reference", SourceKind::Supplementary)?;
        let rail_geometry = request.optional_source_by_role("rail_geometry");

        let output = build_sncf_dataset(
            &gtfs.local_path,
            &stations.local_path,
            rail_geometry.map(|source| source.local_path.as_path()),
            &gtfs.definition.id,
            &stations.definition.id,
            rail_geometry.map(|source| source.definition.id.as_str()),
            request.dataset_version,
            request.generated_at,
            request.source_snapshots,
            request.overrides,
        )?;

        let counters = BTreeMap::from([
            (
                "station_reference_count".to_string(),
                output.summary.station_reference_count as u64,
            ),
            (
                "gtfs_station_count".to_string(),
                output.summary.gtfs_station_count as u64,
            ),
            (
                "matched_station_count".to_string(),
                output.summary.matched_station_count as u64,
            ),
            (
                "unmatched_station_count".to_string(),
                output.summary.unmatched_station_count as u64,
            ),
            (
                "source_rejected_city_candidate_count".to_string(),
                output.rejected_city_candidates.records.len() as u64,
            ),
            (
                "source_demoted_city_candidate_count".to_string(),
                output
                    .rejected_city_candidates
                    .records
                    .iter()
                    .filter(|record| {
                        record.resolution
                            == crate::RejectedCityCandidateResolution::DemotedToParentCity
                    })
                    .count() as u64,
            ),
            (
                "source_unresolved_city_candidate_count".to_string(),
                output
                    .rejected_city_candidates
                    .records
                    .iter()
                    .filter(|record| {
                        record.resolution
                            != crate::RejectedCityCandidateResolution::DemotedToParentCity
                    })
                    .count() as u64,
            ),
        ]);

        Ok(AdapterBuildArtifacts {
            canonical: bundle_from_output(&output),
            edge_geometries: Some(output.edge_geometries),
            station_mappings: Some(output.station_mappings),
            rejected_city_candidates: Some(output.rejected_city_candidates),
            quarantined_fallback_gap_cities: Vec::new(),
            quarantined_promoted_attachment_gap_cities: Vec::new(),
            duplicates: output.duplicates,
            issues: output.issues,
            counters,
            notes: vec![
                format!("adapter={}", self.adapter_id()),
                format!("target={}", request.target.id),
            ],
            source_artifacts: Vec::new(),
        })
    }
}

impl PipelineAdapter for GtfsBasicAdapter {
    fn adapter_id(&self) -> &'static str {
        "gtfs_basic"
    }

    fn build(&self, request: AdapterBuildRequest<'_>) -> Result<AdapterBuildArtifacts> {
        let gtfs = request.source_by_role_or_kind("schedule", SourceKind::Gtfs)?;
        let country_code = gtfs.definition.country_code.clone();
        let output = build_gtfs_basic_dataset(
            &gtfs.local_path,
            &gtfs.definition.id,
            &country_code,
            request.dataset_version,
            request.generated_at,
            request.source_snapshots,
            request.overrides,
        )?;

        let counters = BTreeMap::from([
            (
                "gtfs_station_count".to_string(),
                output.summary.gtfs_station_count as u64,
            ),
            (
                "source_rejected_city_candidate_count".to_string(),
                output.rejected_city_candidates.records.len() as u64,
            ),
            (
                "source_demoted_city_candidate_count".to_string(),
                output
                    .rejected_city_candidates
                    .records
                    .iter()
                    .filter(|record| {
                        record.resolution
                            == crate::RejectedCityCandidateResolution::DemotedToParentCity
                    })
                    .count() as u64,
            ),
            (
                "source_unresolved_city_candidate_count".to_string(),
                output
                    .rejected_city_candidates
                    .records
                    .iter()
                    .filter(|record| {
                        record.resolution
                            != crate::RejectedCityCandidateResolution::DemotedToParentCity
                    })
                    .count() as u64,
            ),
        ]);

        Ok(AdapterBuildArtifacts {
            canonical: bundle_from_basic_output(&output),
            edge_geometries: Some(output.edge_geometries),
            station_mappings: Some(output.station_mappings),
            rejected_city_candidates: Some(output.rejected_city_candidates),
            quarantined_fallback_gap_cities: Vec::new(),
            quarantined_promoted_attachment_gap_cities: Vec::new(),
            duplicates: output.duplicates,
            issues: output.issues,
            counters,
            notes: vec![
                format!("adapter={}", self.adapter_id()),
                format!("target={}", request.target.id),
                format!("country_code={country_code}"),
            ],
            source_artifacts: Vec::new(),
        })
    }
}

impl PipelineAdapter for AggregateBundleAdapter {
    fn adapter_id(&self) -> &'static str {
        "aggregate_bundle"
    }

    fn build(&self, request: AdapterBuildRequest<'_>) -> Result<AdapterBuildArtifacts> {
        build_aggregate_bundle(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{StationMappingRecord, StationMappingStrategy};
    use aetrain_dataset::{
        AliasRecord, DatasetMeta, EdgeGeometryArtifact, EdgeGeometryRecord, EdgeGeometrySource,
        PolylinePointE5,
    };
    use aetrain_domain::{City, CityId, GeoPoint, Station, StationId, TravelEdge};
    use aetrain_registry::{RegistryCanonicalBundle, RegistryCity, RegistryMeta, RegistryStatus};

    #[test]
    fn compact_web_runtime_bundle_validates() {
        let canonical = DatasetBundle {
            meta: DatasetMeta::new("2026-05-08", "2026-05-08T18:00:00Z"),
            cities: vec![
                City {
                    city_id: CityId::new("paris-fr").expect("valid city id"),
                    slug: "paris".to_string(),
                    display_name: "Paris".to_string(),
                    country_code: "FR".to_string(),
                    location: GeoPoint {
                        lat: 48.8566,
                        lon: 2.3522,
                    },
                    wikidata_qid: None,
                    population: Some(2_100_000),
                    interest_score: Some(10),
                    station_ids: vec![StationId::new("sncf-fr-8727100").expect("valid station id")],
                    aliases: vec!["Paris Nord".to_string()],
                },
                City {
                    city_id: CityId::new("lyon-fr").expect("valid city id"),
                    slug: "lyon".to_string(),
                    display_name: "Lyon".to_string(),
                    country_code: "FR".to_string(),
                    location: GeoPoint {
                        lat: 45.764,
                        lon: 4.8357,
                    },
                    wikidata_qid: None,
                    population: Some(500_000),
                    interest_score: Some(7),
                    station_ids: vec![StationId::new("sncf-fr-8772319").expect("valid station id")],
                    aliases: Vec::new(),
                },
            ],
            stations: vec![
                Station {
                    station_id: StationId::new("sncf-fr-8727100").expect("valid station id"),
                    city_id: CityId::new("paris-fr").expect("valid city id"),
                    display_name: "Paris Nord".to_string(),
                    location: GeoPoint {
                        lat: 48.8809,
                        lon: 2.3553,
                    },
                    uic_code: Some("8727100".to_string()),
                    source_refs: Vec::new(),
                },
                Station {
                    station_id: StationId::new("sncf-fr-8772319").expect("valid station id"),
                    city_id: CityId::new("lyon-fr").expect("valid city id"),
                    display_name: "Lyon Part Dieu".to_string(),
                    location: GeoPoint {
                        lat: 45.7604,
                        lon: 4.8599,
                    },
                    uic_code: Some("8772319".to_string()),
                    source_refs: Vec::new(),
                },
            ],
            edges: vec![TravelEdge {
                from_city_id: CityId::new("paris-fr").expect("valid city id"),
                to_city_id: CityId::new("lyon-fr").expect("valid city id"),
                duration_min: 120,
                service_kind: ServiceKind::Rail,
                service_class: ServiceClass::Intercity,
                change_count_estimate: Some(0),
                source_confidence: 100,
                provenance: vec!["test:R1".to_string()],
            }],
            aliases: vec![
                AliasRecord {
                    alias: "paris".to_string(),
                    city_id: CityId::new("paris-fr").expect("valid city id"),
                },
                AliasRecord {
                    alias: "lyon".to_string(),
                    city_id: CityId::new("lyon-fr").expect("valid city id"),
                },
            ],
        };

        let edge_geometries = EdgeGeometryArtifact {
            geometries: vec![EdgeGeometryRecord {
                from_city_id: CityId::new("paris-fr").expect("valid city id"),
                to_city_id: CityId::new("lyon-fr").expect("valid city id"),
                points: vec![
                    PolylinePointE5 {
                        lat_e5: 4_885_660,
                        lon_e5: 235_220,
                    },
                    PolylinePointE5 {
                        lat_e5: 4_576_400,
                        lon_e5: 483_570,
                    },
                ],
                source: EdgeGeometrySource::StraightLineFallback,
                provenance: vec!["test:R1".to_string()],
            }],
        };

        let (runtime_bundle, station_artifact, runtime_edge_geometries) =
            build_web_runtime_bundle(&canonical, &edge_geometries)
                .expect("runtime bundle should build");

        assert_eq!(runtime_bundle.countries.len(), 1);
        assert_eq!(runtime_bundle.cities.len(), 2);
        assert_eq!(runtime_bundle.graph.edge_count(), 1);
        assert_eq!(runtime_bundle.aliases.records.len(), 2);
        assert_eq!(station_artifact.stations.len(), 2);
        assert_eq!(runtime_edge_geometries.geometries.len(), 1);
        runtime_bundle
            .validate()
            .expect("runtime bundle should validate");
    }

    #[test]
    fn edge_geometry_chunking_splits_large_artifacts() {
        let geometries = (0..6)
            .map(|index| EdgeGeometryRecord {
                from_city_id: CityId::new(format!("city-{index}-fr")).expect("valid city id"),
                to_city_id: CityId::new(format!("city-{}-fr", index + 1)).expect("valid city id"),
                points: vec![
                    PolylinePointE5 {
                        lat_e5: 4_800_000 + index,
                        lon_e5: 200_000 + index,
                    },
                    PolylinePointE5 {
                        lat_e5: 4_810_000 + index,
                        lon_e5: 210_000 + index,
                    },
                ],
                source: EdgeGeometrySource::StraightLineFallback,
                provenance: vec!["test:R1".to_string()],
            })
            .collect::<Vec<_>>();

        let chunk_ranges =
            chunk_edge_geometry_ranges(&geometries, 250).expect("chunking should succeed");
        assert!(chunk_ranges.len() > 1);
        assert_eq!(
            chunk_ranges.iter().map(|range| range.len()).sum::<usize>(),
            geometries.len()
        );
    }

    #[test]
    fn edge_geometry_merge_prefers_rail_graph_over_gtfs_shape() {
        let from_city_id = CityId::new("paris-fr").expect("valid city id");
        let to_city_id = CityId::new("strasbourg-fr").expect("valid city id");
        let mut existing = EdgeGeometryRecord {
            from_city_id: from_city_id.clone(),
            to_city_id: to_city_id.clone(),
            points: vec![
                PolylinePointE5 {
                    lat_e5: 4_887_698,
                    lon_e5: 235_912,
                },
                PolylinePointE5 {
                    lat_e5: 4_858_534,
                    lon_e5: 773_407,
                },
            ],
            source: EdgeGeometrySource::GtfsShapeSegment,
            provenance: vec!["test:gtfs".to_string()],
        };
        let incoming = EdgeGeometryRecord {
            from_city_id,
            to_city_id,
            points: vec![
                PolylinePointE5 {
                    lat_e5: 4_887_698,
                    lon_e5: 235_912,
                },
                PolylinePointE5 {
                    lat_e5: 4_870_000,
                    lon_e5: 400_000,
                },
                PolylinePointE5 {
                    lat_e5: 4_858_534,
                    lon_e5: 773_407,
                },
            ],
            source: EdgeGeometrySource::InfrastructureGraphFallback,
            provenance: vec!["geometry:sncf-fr-rfn-lines".to_string()],
        };

        merge_edge_geometry_record(&mut existing, &incoming);

        assert_eq!(
            existing.source,
            EdgeGeometrySource::InfrastructureGraphFallback
        );
        assert_eq!(existing.points.len(), 3);
        assert!(existing.provenance.iter().any(|entry| entry == "test:gtfs"));
        assert!(
            existing
                .provenance
                .iter()
                .any(|entry| entry == "geometry:sncf-fr-rfn-lines")
        );
    }

    #[test]
    fn relative_path_between_artifact_and_target_root_is_stable() {
        let path =
            PathBuf::from("/repo/data/cache/raw/sncf-fr-rfn-lines/sncf-fr-rfn-lines.geojson");
        let target_root = PathBuf::from("/repo/data/build/stage1/sncf-fr");

        assert_eq!(
            relative_path_between(&path, &target_root),
            Some(PathBuf::from(
                "../../../cache/raw/sncf-fr-rfn-lines/sncf-fr-rfn-lines.geojson"
            ))
        );
    }

    #[test]
    fn aggregate_city_merge_canonicalizes_duplicate_foreign_feed_cities() {
        let paris_fr = City {
            city_id: CityId::new("paris-fr-75056").expect("valid city id"),
            slug: "paris".to_string(),
            display_name: "Paris".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 48.8552,
                lon: 2.3501,
            },
            wikidata_qid: None,
            population: Some(2_100_000),
            interest_score: Some(10),
            station_ids: vec![
                StationId::new("sncf-fr-8727100").expect("valid station id"),
                StationId::new("sncf-fr-8739100").expect("valid station id"),
            ],
            aliases: vec!["Paris Nord".to_string()],
        };
        let paris_ch = City {
            city_id: CityId::new("paris-ch-a8788511").expect("valid city id"),
            slug: "paris".to_string(),
            display_name: "Paris".to_string(),
            country_code: "CH".to_string(),
            location: GeoPoint {
                lat: 48.8484,
                lon: 2.3604,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("sncf-fr-8711300").expect("valid station id")],
            aliases: vec!["Paris Gare de Lyon".to_string()],
        };
        let lyon = City {
            city_id: CityId::new("lyon-fr-69123").expect("valid city id"),
            slug: "lyon".to_string(),
            display_name: "Lyon".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 45.764,
                lon: 4.8357,
            },
            wikidata_qid: None,
            population: Some(500_000),
            interest_score: Some(7),
            station_ids: vec![StationId::new("sncf-fr-8772319").expect("valid station id")],
            aliases: Vec::new(),
        };

        let input = vec![paris_fr.clone(), paris_ch.clone(), lyon];
        let mut issues = Vec::new();
        let remap =
            build_aggregate_city_id_remap(input.iter().collect(), "europe-aggregate", &mut issues);

        assert_eq!(
            remap.get(&paris_ch.city_id),
            Some(&paris_fr.city_id),
            "foreign-feed Paris should collapse into canonical Paris"
        );
        assert!(
            !issues.is_empty(),
            "merge should emit an informational issue"
        );

        let aggregate_input = AggregateTargetInput {
            target_id: "test-target".to_string(),
            manifest: PipelineArtifactManifest {
                dataset_id: "test".to_string(),
                target_id: "test-target".to_string(),
                adapter: "aggregate_bundle".to_string(),
                dataset_version: "test".to_string(),
                generated_at: "2026-05-09T00:00:00Z".to_string(),
                source_snapshots: Vec::new(),
                source_artifacts: Vec::new(),
                outputs: PipelineOutputPaths {
                    target_root: String::new(),
                    canonical_dir: None,
                    web_dir: None,
                    web_debug_dir: None,
                },
                summary: PipelineBuildSummary {
                    city_count: 3,
                    station_count: 0,
                    edge_count: 0,
                    alias_count: 0,
                    duplicate_count: 0,
                    issue_count: 0,
                    counters: BTreeMap::new(),
                },
                notes: Vec::new(),
            },
            canonical: DatasetBundle {
                meta: DatasetMeta::new("2026-05-09", "2026-05-09T00:00:00Z"),
                cities: input,
                stations: Vec::new(),
                edges: Vec::new(),
                aliases: Vec::new(),
            },
            edge_geometries: EdgeGeometryArtifact {
                geometries: Vec::new(),
            },
            station_mappings: None,
            rejected_city_candidates: None,
            issues: Vec::new(),
        };
        let merged = merge_cities(&[aggregate_input], "europe-aggregate");
        let paris = merged
            .cities
            .iter()
            .find(|city| city.city_id == paris_fr.city_id)
            .expect("merged Paris should exist");
        assert_eq!(paris.country_code, "FR");
    }

    #[test]
    fn merge_edges_applies_city_id_remap() {
        let paris_fr = CityId::new("paris-fr-75056").expect("valid city id");
        let paris_ch = CityId::new("paris-ch-a8788511").expect("valid city id");
        let lyon = CityId::new("lyon-fr-69123").expect("valid city id");
        let edge = TravelEdge {
            from_city_id: paris_ch.clone(),
            to_city_id: lyon.clone(),
            duration_min: 120,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Intercity,
            change_count_estimate: Some(0),
            source_confidence: 70,
            provenance: vec!["test:ch-feed".to_string()],
        };
        let canonical = DatasetBundle {
            meta: DatasetMeta::new("2026-05-09", "2026-05-09T00:00:00Z"),
            cities: Vec::new(),
            stations: Vec::new(),
            edges: vec![edge],
            aliases: Vec::new(),
        };
        let input = AggregateTargetInput {
            target_id: "ch-target".to_string(),
            manifest: PipelineArtifactManifest {
                dataset_id: "test".to_string(),
                target_id: "ch-target".to_string(),
                adapter: "gtfs_basic".to_string(),
                dataset_version: "test".to_string(),
                generated_at: "2026-05-09T00:00:00Z".to_string(),
                source_snapshots: Vec::new(),
                source_artifacts: Vec::new(),
                outputs: PipelineOutputPaths {
                    target_root: String::new(),
                    canonical_dir: None,
                    web_dir: None,
                    web_debug_dir: None,
                },
                summary: PipelineBuildSummary {
                    city_count: 0,
                    station_count: 0,
                    edge_count: 1,
                    alias_count: 0,
                    duplicate_count: 0,
                    issue_count: 0,
                    counters: BTreeMap::new(),
                },
                notes: Vec::new(),
            },
            canonical,
            edge_geometries: EdgeGeometryArtifact {
                geometries: Vec::new(),
            },
            station_mappings: None,
            rejected_city_candidates: None,
            issues: Vec::new(),
        };
        let remap = BTreeMap::from([(paris_ch, paris_fr.clone())]);
        let edges = merge_edges(&[input], &remap);

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].from_city_id, paris_fr);
        assert_eq!(edges[0].to_city_id, lyon);
    }

    #[test]
    fn aggregate_city_merge_uses_station_qualified_identity_keys() {
        let lux_city = City {
            city_id: CityId::new("luxembourg-lu-bb74daf2").expect("valid city id"),
            slug: "luxembourg".to_string(),
            display_name: "Luxembourg".to_string(),
            country_code: "LU".to_string(),
            location: GeoPoint {
                lat: 49.5997,
                lon: 6.1346,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-uic-82001000").expect("valid station id")],
            aliases: vec!["Luxembourg Gare Centrale".to_string()],
        };
        let lux_station_city = City {
            city_id: CityId::new("luxembourg-gare-centrale-lu-bb74daf3").expect("valid city id"),
            slug: "luxembourg-gare-centrale".to_string(),
            display_name: "Luxembourg Gare Centrale".to_string(),
            country_code: "LU".to_string(),
            location: GeoPoint {
                lat: 49.6000,
                lon: 6.1339,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-europe-1").expect("valid station id")],
            aliases: Vec::new(),
        };

        let mut issues = Vec::new();
        let remap = build_aggregate_city_id_remap(
            vec![&lux_city, &lux_station_city],
            "europe-aggregate",
            &mut issues,
        );

        assert_eq!(
            remap.get(&lux_station_city.city_id),
            Some(&lux_city.city_id),
            "station-qualified city variant should merge into canonical city identity"
        );
    }

    #[test]
    fn aggregate_city_merge_strips_interior_station_tokens() {
        let berlin = City {
            city_id: CityId::new("berlin-de-5b922f02").expect("valid city id"),
            slug: "berlin".to_string(),
            display_name: "Berlin".to_string(),
            country_code: "DE".to_string(),
            location: GeoPoint {
                lat: 52.5200,
                lon: 13.4050,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-uic-8011160").expect("valid station id")],
            aliases: Vec::new(),
        };
        let berlin_hbf = City {
            city_id: CityId::new("berlin-hbf-lehrter-bahnhof-nord-zz-1fb4c6e1")
                .expect("valid city id"),
            slug: "berlin-hbf-lehrter-bahnhof-nord".to_string(),
            display_name: "Berlin Hbf Lehrter Bahnhof Nord".to_string(),
            country_code: "ZZ".to_string(),
            location: GeoPoint {
                lat: 52.5251,
                lon: 13.3694,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![
                StationId::new("station-europe-berlin-hbf").expect("valid station id"),
            ],
            aliases: Vec::new(),
        };

        let mut issues = Vec::new();
        let remap = build_aggregate_city_id_remap(
            vec![&berlin, &berlin_hbf],
            "europe-aggregate",
            &mut issues,
        );

        assert_eq!(
            remap.get(&berlin_hbf.city_id),
            Some(&berlin.city_id),
            "interior station tokens should collapse station-shaped Berlin variants"
        );
    }

    #[test]
    fn aggregate_city_merge_strips_s_bahn_and_bf_qualifiers() {
        let bad_vigaun = City {
            city_id: CityId::new("bad-vigaun-at-base").expect("valid city id"),
            slug: "bad-vigaun".to_string(),
            display_name: "Bad Vigaun".to_string(),
            country_code: "AT".to_string(),
            location: GeoPoint {
                lat: 47.665,
                lon: 13.138,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-bad-vigaun").expect("valid station id")],
            aliases: Vec::new(),
        };
        let bad_vigaun_s_bahn = City {
            city_id: CityId::new("bad-vigaun-s-bahn-at-2a0f189b").expect("valid city id"),
            slug: "bad-vigaun-s-bahn".to_string(),
            display_name: "Bad Vigaun S Bahn".to_string(),
            country_code: "AT".to_string(),
            location: GeoPoint {
                lat: 47.6652,
                lon: 13.1381,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-bad-vigaun-s").expect("valid station id")],
            aliases: Vec::new(),
        };
        let bad_oeynhausen = City {
            city_id: CityId::new("bad-oeynhausen-de-base").expect("valid city id"),
            slug: "bad-oeynhausen".to_string(),
            display_name: "Bad Oeynhausen".to_string(),
            country_code: "DE".to_string(),
            location: GeoPoint {
                lat: 52.206,
                lon: 8.803,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-bad-oeynhausen").expect("valid station id")],
            aliases: Vec::new(),
        };
        let bad_oeynhausen_bf = City {
            city_id: CityId::new("bad-oeynhausen-bf-zob-de-6b4b910f").expect("valid city id"),
            slug: "bad-oeynhausen-bf-zob".to_string(),
            display_name: "Bad Oeynhausen Bf Zob".to_string(),
            country_code: "DE".to_string(),
            location: GeoPoint {
                lat: 52.2059,
                lon: 8.8029,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![
                StationId::new("station-bad-oeynhausen-bf").expect("valid station id"),
            ],
            aliases: Vec::new(),
        };

        let mut issues = Vec::new();
        let remap = build_aggregate_city_id_remap(
            vec![
                &bad_vigaun,
                &bad_vigaun_s_bahn,
                &bad_oeynhausen,
                &bad_oeynhausen_bf,
            ],
            "europe-aggregate",
            &mut issues,
        );

        assert_eq!(
            remap.get(&bad_vigaun_s_bahn.city_id),
            Some(&bad_vigaun.city_id)
        );
        assert_eq!(
            remap.get(&bad_oeynhausen_bf.city_id),
            Some(&bad_oeynhausen.city_id)
        );
    }

    #[test]
    fn aggregate_city_merge_strips_locality_suffixes_for_zz_rows() {
        let adamswiller = City {
            city_id: CityId::new("adamswiller-fr-base").expect("valid city id"),
            slug: "adamswiller".to_string(),
            display_name: "Adamswiller".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 48.883,
                lon: 7.227,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-adamswiller").expect("valid station id")],
            aliases: Vec::new(),
        };
        let adamswiller_mairie = City {
            city_id: CityId::new("adamswiller-mairie-zz-0985a88a").expect("valid city id"),
            slug: "adamswiller-mairie".to_string(),
            display_name: "Adamswiller Mairie".to_string(),
            country_code: "ZZ".to_string(),
            location: GeoPoint {
                lat: 48.8831,
                lon: 7.2271,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![
                StationId::new("station-adamswiller-mairie").expect("valid station id"),
            ],
            aliases: Vec::new(),
        };

        let mut issues = Vec::new();
        let remap = build_aggregate_city_id_remap(
            vec![&adamswiller, &adamswiller_mairie],
            "europe-aggregate",
            &mut issues,
        );

        assert_eq!(
            remap.get(&adamswiller_mairie.city_id),
            Some(&adamswiller.city_id)
        );
    }

    #[test]
    fn canonicalize_aggregate_city_names_trims_station_and_locality_singletons() {
        let mut cities = [
            City {
                city_id: CityId::new("bad-oeynhausen-bf-zob-de-6b4b910f").expect("valid city id"),
                slug: "bad-oeynhausen-bf-zob".to_string(),
                display_name: "Bad Oeynhausen Bf Zob".to_string(),
                country_code: "DE".to_string(),
                location: GeoPoint {
                    lat: 52.206,
                    lon: 8.803,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![
                    StationId::new("station-bad-oeynhausen-bf").expect("valid station id"),
                ],
                aliases: Vec::new(),
            },
            City {
                city_id: CityId::new("adamswiller-mairie-zz-0985a88a").expect("valid city id"),
                slug: "adamswiller-mairie".to_string(),
                display_name: "Adamswiller Mairie".to_string(),
                country_code: "ZZ".to_string(),
                location: GeoPoint {
                    lat: 48.883,
                    lon: 7.227,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![
                    StationId::new("station-adamswiller-mairie").expect("valid station id"),
                ],
                aliases: Vec::new(),
            },
            City {
                city_id: CityId::new("kilstett-13-route-nationale-fr-3f58b216")
                    .expect("valid city id"),
                slug: "kilstett-13-route-nationale".to_string(),
                display_name: "Kilstett 13 Route Nationale".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 48.676,
                    lon: 7.857,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![
                    StationId::new("station-kilstett-13-route-nationale")
                        .expect("valid station id"),
                ],
                aliases: Vec::new(),
            },
        ];
        let mut issues = Vec::new();

        canonicalize_aggregate_city_names(cities.iter_mut(), "europe-aggregate", &mut issues);

        assert_eq!(cities[0].display_name, "Bad Oeynhausen");
        assert_eq!(cities[0].slug, "bad-oeynhausen");
        assert!(
            cities[0]
                .aliases
                .iter()
                .any(|alias| alias == "Bad Oeynhausen Bf Zob")
        );
        assert_eq!(cities[1].display_name, "Adamswiller");
        assert_eq!(cities[1].slug, "adamswiller");
        assert!(
            cities[1]
                .aliases
                .iter()
                .any(|alias| alias == "Adamswiller Mairie")
        );
        assert_eq!(cities[2].display_name, "Kilstett");
        assert_eq!(cities[2].slug, "kilstett");
        assert!(
            cities[2]
                .aliases
                .iter()
                .any(|alias| alias == "Kilstett 13 Route Nationale")
        );
        assert_eq!(issues.len(), 3);
    }

    #[test]
    fn infer_country_code_from_uic_station_ids_works_for_foreign_sncf_rows() {
        let berlin = vec![StationId::new("station-uic-80077990").expect("valid station id")];
        let bruxelles = vec![StationId::new("station-uic-88140010").expect("valid station id")];
        let barcelone = vec![StationId::new("station-uic-71718010").expect("valid station id")];
        let mixed = vec![
            StationId::new("station-uic-80077990").expect("valid station id"),
            StationId::new("station-uic-88140010").expect("valid station id"),
        ];

        assert_eq!(
            infer_country_code_from_station_ids(&berlin).as_deref(),
            Some("DE")
        );
        assert_eq!(
            infer_country_code_from_station_ids(&bruxelles).as_deref(),
            Some("BE")
        );
        assert_eq!(
            infer_country_code_from_station_ids(&barcelone).as_deref(),
            Some("ES")
        );
        assert_eq!(infer_country_code_from_station_ids(&mixed), None);
    }

    #[test]
    fn infer_country_code_from_station_mappings_prefers_non_bus_station_evidence() {
        let city = City {
            city_id: CityId::new("perl-zz-66383162").expect("valid city id"),
            slug: "perl".to_string(),
            display_name: "Perl".to_string(),
            country_code: "ZZ".to_string(),
            location: GeoPoint {
                lat: 49.4731,
                lon: 6.3693,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![
                StationId::new("station-uic-80251967").expect("valid station id"),
                StationId::new("station-uic-87697839").expect("valid station id"),
            ],
            aliases: Vec::new(),
        };
        let station_mappings = StationMappingReport {
            records: vec![
                StationMappingRecord {
                    station_key: "StopArea:OCE80251967".to_string(),
                    station_id: StationId::new("station-uic-80251967").expect("valid station id"),
                    city_id: city.city_id.clone(),
                    city_cluster_key: "fallback-perl-80251967".to_string(),
                    station_display_name: "Perl".to_string(),
                    mapping_strategy: StationMappingStrategy::FallbackReferenceGap,
                    confidence: 50,
                    matched_reference_id: None,
                    matched_reference_name: None,
                    override_id: None,
                    source_refs: Vec::new(),
                },
                StationMappingRecord {
                    station_key: "StopArea:OCE87697839".to_string(),
                    station_id: StationId::new("station-uic-87697839").expect("valid station id"),
                    city_id: city.city_id.clone(),
                    city_cluster_key: "fallback-perl-gare-routiere-87697839".to_string(),
                    station_display_name: "Perl Gare Routière".to_string(),
                    mapping_strategy: StationMappingStrategy::FallbackReferenceGap,
                    confidence: 50,
                    matched_reference_id: None,
                    matched_reference_name: None,
                    override_id: None,
                    source_refs: Vec::new(),
                },
            ],
        };

        assert_eq!(
            infer_country_code_from_station_mappings(&city, &station_mappings).as_deref(),
            Some("DE")
        );
    }

    #[test]
    fn infer_country_code_from_station_mappings_can_use_station_key_prefix() {
        let city = City {
            city_id: CityId::new("s-bahn-unten-at-3bca6a1e").expect("valid city id"),
            slug: "s-bahn-unten".to_string(),
            display_name: "S Bahn Unten".to_string(),
            country_code: "AT".to_string(),
            location: GeoPoint {
                lat: 52.47606989,
                lon: 13.36514378,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-uic-900058101").expect("valid station id")],
            aliases: Vec::new(),
        };
        let station_mappings = StationMappingReport {
            records: vec![StationMappingRecord {
                station_key: "Pde:11000:900058101".to_string(),
                station_id: StationId::new("station-uic-900058101").expect("valid station id"),
                city_id: city.city_id.clone(),
                city_cluster_key: "gtfs-basic-at-s-bahn-unten-0".to_string(),
                station_display_name: "S-Bahn unten".to_string(),
                mapping_strategy: StationMappingStrategy::GtfsStemCluster,
                confidence: 60,
                matched_reference_id: None,
                matched_reference_name: None,
                override_id: None,
                source_refs: Vec::new(),
            }],
        };

        assert_eq!(
            infer_country_code_from_station_mappings(&city, &station_mappings).as_deref(),
            Some("DE")
        );
    }

    #[test]
    fn cleanup_station_like_and_zz_residual_cities_demotes_and_corrects() {
        let karlsruhe_id = CityId::new("karlsruhe-de-36d8b6bc").expect("valid city id");
        let residual_id =
            CityId::new("ka-hauptbahnhof-vorplatz-de-98d98592").expect("valid city id");
        let perl_id = CityId::new("perl-zz-66383162").expect("valid city id");
        let mut cities = vec![
            City {
                city_id: karlsruhe_id.clone(),
                slug: "karlsruhe".to_string(),
                display_name: "Karlsruhe".to_string(),
                country_code: "DE".to_string(),
                location: GeoPoint {
                    lat: 48.9885,
                    lon: 8.3908,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: (0..12)
                    .map(|index| {
                        StationId::new(format!("station-karlsruhe-{index}"))
                            .expect("valid station id")
                    })
                    .collect(),
                aliases: Vec::new(),
            },
            City {
                city_id: residual_id.clone(),
                slug: "ka-hauptbahnhof-vorplatz".to_string(),
                display_name: "Ka Hauptbahnhof Vorplatz".to_string(),
                country_code: "DE".to_string(),
                location: GeoPoint {
                    lat: 48.994346,
                    lon: 8.399587,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![
                    StationId::new("station-de-delfi-gtfs-d27d9101").expect("valid station id"),
                ],
                aliases: Vec::new(),
            },
            City {
                city_id: perl_id.clone(),
                slug: "perl".to_string(),
                display_name: "Perl".to_string(),
                country_code: "ZZ".to_string(),
                location: GeoPoint {
                    lat: 49.4731,
                    lon: 6.3693,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![
                    StationId::new("station-uic-80251967").expect("valid station id"),
                    StationId::new("station-uic-87697839").expect("valid station id"),
                ],
                aliases: Vec::new(),
            },
        ];
        let station_mappings = StationMappingReport {
            records: vec![
                StationMappingRecord {
                    station_key: "de:08212:89".to_string(),
                    station_id: StationId::new("station-de-delfi-gtfs-d27d9101")
                        .expect("valid station id"),
                    city_id: residual_id.clone(),
                    city_cluster_key: "gtfs-basic-de-ka-0".to_string(),
                    station_display_name: "KA Hauptbahnhof (Vorplatz)".to_string(),
                    mapping_strategy: StationMappingStrategy::GtfsStemCluster,
                    confidence: 60,
                    matched_reference_id: None,
                    matched_reference_name: None,
                    override_id: None,
                    source_refs: Vec::new(),
                },
                StationMappingRecord {
                    station_key: "StopArea:OCE80251967".to_string(),
                    station_id: StationId::new("station-uic-80251967").expect("valid station id"),
                    city_id: perl_id.clone(),
                    city_cluster_key: "fallback-perl-80251967".to_string(),
                    station_display_name: "Perl".to_string(),
                    mapping_strategy: StationMappingStrategy::FallbackReferenceGap,
                    confidence: 50,
                    matched_reference_id: None,
                    matched_reference_name: None,
                    override_id: None,
                    source_refs: Vec::new(),
                },
                StationMappingRecord {
                    station_key: "StopArea:OCE87697839".to_string(),
                    station_id: StationId::new("station-uic-87697839").expect("valid station id"),
                    city_id: perl_id.clone(),
                    city_cluster_key: "fallback-perl-gare-routiere-87697839".to_string(),
                    station_display_name: "Perl Gare Routière".to_string(),
                    mapping_strategy: StationMappingStrategy::FallbackReferenceGap,
                    confidence: 50,
                    matched_reference_id: None,
                    matched_reference_name: None,
                    override_id: None,
                    source_refs: Vec::new(),
                },
            ],
        };
        let mut remap = BTreeMap::new();
        let mut issues = Vec::new();

        cleanup_station_like_and_zz_residual_cities(
            &mut cities,
            &mut remap,
            &station_mappings,
            "europe-aggregate",
            &mut issues,
        );

        assert!(!cities.iter().any(|city| city.city_id == residual_id));
        assert_eq!(remap.get(&residual_id).cloned(), Some(karlsruhe_id.clone()));
        let perl = cities
            .iter()
            .find(|city| city.city_id == perl_id)
            .expect("perl city should remain");
        assert_eq!(perl.country_code, "DE");
    }

    #[test]
    fn cleanup_station_like_and_zz_residual_cities_demotes_fallback_gap_alias_match() {
        let lyon_id = CityId::new("lyon-fr-q456").expect("valid city id");
        let residual_id =
            CityId::new("lyon-vaise-gare-routiere-zz-6e92fbd5").expect("valid city id");
        let mut cities = vec![
            City {
                city_id: lyon_id.clone(),
                slug: "lyon".to_string(),
                display_name: "Lyon".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 45.761011,
                    lon: 4.827087,
                },
                wikidata_qid: Some("Q456".to_string()),
                population: Some(522_969),
                interest_score: Some(10),
                station_ids: vec![
                    StationId::new("station-uic-87723197").expect("valid station id"),
                    StationId::new("station-uic-87722025").expect("valid station id"),
                ],
                aliases: vec!["Lyon Vaise".to_string()],
            },
            City {
                city_id: residual_id.clone(),
                slug: "lyon-vaise".to_string(),
                display_name: "Lyon Vaise".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 45.779611,
                    lon: 4.803685,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![
                    StationId::new("station-uic-87697045").expect("valid station id"),
                ],
                aliases: vec!["Lyon Vaise Gare Routiere".to_string()],
            },
        ];
        let station_mappings = StationMappingReport {
            records: vec![StationMappingRecord {
                station_key: "StopArea:OCE87697045".to_string(),
                station_id: StationId::new("station-uic-87697045").expect("valid station id"),
                city_id: residual_id.clone(),
                city_cluster_key: "fallback-lyon-vaise-gare-routiere-87697045".to_string(),
                station_display_name: "Lyon-Vaise-Gare-Routière".to_string(),
                mapping_strategy: StationMappingStrategy::FallbackReferenceGap,
                confidence: 50,
                matched_reference_id: None,
                matched_reference_name: None,
                override_id: None,
                source_refs: Vec::new(),
            }],
        };
        let mut remap = BTreeMap::new();
        let mut issues = Vec::new();

        cleanup_station_like_and_zz_residual_cities(
            &mut cities,
            &mut remap,
            &station_mappings,
            "europe-aggregate",
            &mut issues,
        );

        assert!(!cities.iter().any(|city| city.city_id == residual_id));
        assert_eq!(remap.get(&residual_id).cloned(), Some(lyon_id));
    }

    #[test]
    fn cleaned_residual_city_display_name_strips_route_like_noise() {
        let city = City {
            city_id: CityId::new("wimmenau-d-919-rue-de-la-zz-af0f2d0d").expect("valid city id"),
            slug: "wimmenau-d-919-rue-de-la".to_string(),
            display_name: "Wimmenau D 919 Rue De La".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 48.910025,
                lon: 7.420315,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-uic-87642348").expect("valid station id")],
            aliases: vec!["Wimmenau D.919 - Rue de la Gare".to_string()],
        };

        assert_eq!(
            cleaned_residual_city_display_name(&city, None).as_deref(),
            Some("Wimmenau")
        );
    }

    #[test]
    fn fallback_gap_local_stop_qualifier_recognizes_champ_de_foire() {
        assert!(fallback_gap_station_name_has_local_stop_qualifier(
            "Gouzon Champ De Foire"
        ));
        assert!(!fallback_gap_station_name_has_local_stop_qualifier("Quillan"));
    }

    #[test]
    fn abbreviation_candidate_record_exempts_legitimate_short_names() {
        let eu = City {
            city_id: CityId::new("eu-fr-76255").expect("valid city id"),
            slug: "eu".to_string(),
            display_name: "Eu".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 50.054139,
                lon: 1.417087,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-uic-87317537").expect("valid station id")],
            aliases: Vec::new(),
        };
        let au_sg = City {
            city_id: CityId::new("au-sg-ch-e9228a80").expect("valid city id"),
            slug: "au-sg".to_string(),
            display_name: "Au Sg".to_string(),
            country_code: "CH".to_string(),
            location: GeoPoint {
                lat: 47.43561098,
                lon: 9.64140235,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-uic-8506316").expect("valid station id")],
            aliases: Vec::new(),
        };

        assert!(abbreviation_candidate_record(&eu).is_none());
        assert!(abbreviation_candidate_record(&au_sg).is_none());
    }

    #[test]
    fn explicit_abbreviation_expansion_maps_known_german_codes() {
        let d = City {
            city_id: CityId::new("d-de-d6d09cb7").expect("valid city id"),
            slug: "d".to_string(),
            display_name: "D".to_string(),
            country_code: "DE".to_string(),
            location: GeoPoint {
                lat: 51.2133554,
                lon: 6.7755882,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![
                StationId::new("station-de-delfi-gtfs-405ced36").expect("valid station id"),
            ],
            aliases: vec!["D-Bilk S".to_string()],
        };

        assert_eq!(
            explicit_abbreviation_expansion(&d).as_deref(),
            Some("Dusseldorf")
        );
    }

    #[test]
    fn aggregate_enrichment_assigns_low_interest_to_station_shaped_rows() {
        let berlin = City {
            city_id: CityId::new("berlin-de-5b922f02").expect("valid city id"),
            slug: "berlin".to_string(),
            display_name: "Berlin".to_string(),
            country_code: "DE".to_string(),
            location: GeoPoint {
                lat: 52.5200,
                lon: 13.4050,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![
                StationId::new("station-berlin-1").expect("valid station id"),
                StationId::new("station-berlin-2").expect("valid station id"),
                StationId::new("station-berlin-3").expect("valid station id"),
            ],
            aliases: vec!["Berlin Hauptbahnhof".to_string()],
        };
        let berlin_spandau = City {
            city_id: CityId::new("s-spandau-bhf-berlin-de-9dc6342d").expect("valid city id"),
            slug: "s-spandau-bhf-berlin".to_string(),
            display_name: "S Spandau Bhf Berlin".to_string(),
            country_code: "DE".to_string(),
            location: GeoPoint {
                lat: 52.5344,
                lon: 13.1982,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-berlin-spandau").expect("valid station id")],
            aliases: Vec::new(),
        };
        let lyon = City {
            city_id: CityId::new("lyon-fr-69123").expect("valid city id"),
            slug: "lyon".to_string(),
            display_name: "Lyon".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 45.7640,
                lon: 4.8357,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: (0..11)
                .map(|index| {
                    StationId::new(format!("station-lyon-{index}")).expect("valid station id")
                })
                .collect(),
            aliases: vec!["Lyon Part Dieu".to_string(), "Lyon Perrache".to_string()],
        };
        let lyon_routiere = City {
            city_id: CityId::new("lyon-part-dieu-gare-routiere-zz-1f21be10")
                .expect("valid city id"),
            slug: "lyon-part-dieu-gare-routiere".to_string(),
            display_name: "Lyon Part Dieu Gare Routiere".to_string(),
            country_code: "ZZ".to_string(),
            location: GeoPoint {
                lat: 45.7607,
                lon: 4.8619,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: vec![StationId::new("station-lyon-routiere").expect("valid station id")],
            aliases: Vec::new(),
        };
        let edges = vec![
            TravelEdge {
                from_city_id: berlin.city_id.clone(),
                to_city_id: lyon.city_id.clone(),
                duration_min: 60,
                service_kind: ServiceKind::Rail,
                service_class: ServiceClass::Intercity,
                change_count_estimate: Some(0),
                source_confidence: 100,
                provenance: vec!["test:1".to_string()],
            },
            TravelEdge {
                from_city_id: berlin.city_id.clone(),
                to_city_id: berlin_spandau.city_id.clone(),
                duration_min: 10,
                service_kind: ServiceKind::Rail,
                service_class: ServiceClass::Regional,
                change_count_estimate: Some(0),
                source_confidence: 100,
                provenance: vec!["test:2".to_string()],
            },
            TravelEdge {
                from_city_id: lyon.city_id.clone(),
                to_city_id: lyon_routiere.city_id.clone(),
                duration_min: 5,
                service_kind: ServiceKind::Rail,
                service_class: ServiceClass::Regional,
                change_count_estimate: Some(0),
                source_confidence: 100,
                provenance: vec!["test:3".to_string()],
            },
        ];
        let mut cities = vec![berlin, berlin_spandau, lyon, lyon_routiere];

        apply_computed_city_enrichment(&mut cities, &edges);

        let berlin_interest = cities
            .iter()
            .find(|city| city.display_name == "Berlin")
            .and_then(|city| city.interest_score)
            .expect("Berlin should get computed interest");
        let berlin_spandau_interest = cities
            .iter()
            .find(|city| city.display_name == "S Spandau Bhf Berlin")
            .and_then(|city| city.interest_score)
            .expect("station-shaped Berlin should get computed interest");
        let lyon_interest = cities
            .iter()
            .find(|city| city.display_name == "Lyon")
            .and_then(|city| city.interest_score)
            .expect("Lyon should get computed interest");
        let lyon_routiere_interest = cities
            .iter()
            .find(|city| city.display_name == "Lyon Part Dieu Gare Routiere")
            .and_then(|city| city.interest_score)
            .expect("station-shaped Lyon should get computed interest");

        assert!(berlin_interest >= 5);
        assert!(lyon_interest >= 7);
        assert!(berlin_spandau_interest <= 2);
        assert!(lyon_routiere_interest <= 1);
    }

    #[test]
    fn registry_overlay_backfills_wikidata_and_population() {
        let mut cities = vec![
            City {
                city_id: CityId::new("paris-fr-75056").expect("valid city id"),
                slug: "paris".to_string(),
                display_name: "Paris".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 48.8552,
                    lon: 2.3501,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![StationId::new("station-paris").expect("valid station id")],
                aliases: Vec::new(),
            },
            City {
                city_id: CityId::new("avignon-fr-84007").expect("valid city id"),
                slug: "avignon".to_string(),
                display_name: "Avignon".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 43.949,
                    lon: 4.805,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![StationId::new("station-avignon").expect("valid station id")],
                aliases: Vec::new(),
            },
            City {
                city_id: CityId::new("nantes-ch-8fefd121").expect("valid city id"),
                slug: "nantes".to_string(),
                display_name: "Nantes".to_string(),
                country_code: "CH".to_string(),
                location: GeoPoint {
                    lat: 47.218,
                    lon: -1.554,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![StationId::new("station-nantes").expect("valid station id")],
                aliases: Vec::new(),
            },
            City {
                city_id: CityId::new("toulouse-matabiau-ch-099c66c9").expect("valid city id"),
                slug: "toulouse-matabiau".to_string(),
                display_name: "Toulouse Matabiau".to_string(),
                country_code: "CH".to_string(),
                location: GeoPoint {
                    lat: 43.611,
                    lon: 1.453,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![StationId::new("station-toulouse").expect("valid station id")],
                aliases: Vec::new(),
            },
        ];
        let overlay = RegistryCanonicalBundle {
            meta: RegistryMeta {
                schema_version: 1,
                dataset_id: "test-overlay".to_string(),
                scope: "fr-test".to_string(),
                generated_at: "2026-05-10T00:00:00Z".to_string(),
            },
            cities: vec![
                RegistryCity {
                    city_id: CityId::new("paris-fr-q90").expect("valid city id"),
                    slug: "paris".to_string(),
                    display_name: "Paris".to_string(),
                    country_code: "FR".to_string(),
                    identity_point: GeoPoint {
                        lat: 48.8566,
                        lon: 2.3522,
                    },
                    map_anchor_point: GeoPoint {
                        lat: 48.8566,
                        lon: 2.3522,
                    },
                    bbox: None,
                    wikidata_qid: Some("Q90".to_string()),
                    population: Some(2_243_739),
                    status: RegistryStatus::Resolved,
                    external_refs: Vec::new(),
                },
                RegistryCity {
                    city_id: CityId::new("avignon-fr-q6397").expect("valid city id"),
                    slug: "avignon".to_string(),
                    display_name: "Avignon".to_string(),
                    country_code: "FR".to_string(),
                    identity_point: GeoPoint {
                        lat: 43.9486,
                        lon: 4.8083,
                    },
                    map_anchor_point: GeoPoint {
                        lat: 43.9486,
                        lon: 4.8083,
                    },
                    bbox: None,
                    wikidata_qid: Some("Q6397".to_string()),
                    population: Some(94_200),
                    status: RegistryStatus::Resolved,
                    external_refs: Vec::new(),
                },
                RegistryCity {
                    city_id: CityId::new("nantes-fr-q12191").expect("valid city id"),
                    slug: "nantes".to_string(),
                    display_name: "Nantes".to_string(),
                    country_code: "FR".to_string(),
                    identity_point: GeoPoint {
                        lat: 47.2172,
                        lon: -1.5539,
                    },
                    map_anchor_point: GeoPoint {
                        lat: 47.2172,
                        lon: -1.5539,
                    },
                    bbox: None,
                    wikidata_qid: Some("Q12191".to_string()),
                    population: Some(327_734),
                    status: RegistryStatus::Resolved,
                    external_refs: Vec::new(),
                },
                RegistryCity {
                    city_id: CityId::new("toulouse-fr-q7880").expect("valid city id"),
                    slug: "toulouse".to_string(),
                    display_name: "Toulouse".to_string(),
                    country_code: "FR".to_string(),
                    identity_point: GeoPoint {
                        lat: 43.6044,
                        lon: 1.4433,
                    },
                    map_anchor_point: GeoPoint {
                        lat: 43.6044,
                        lon: 1.4433,
                    },
                    bbox: None,
                    wikidata_qid: Some("Q7880".to_string()),
                    population: Some(514_819),
                    status: RegistryStatus::Resolved,
                    external_refs: Vec::new(),
                },
            ],
            stations: Vec::new(),
            memberships: Vec::new(),
            name_variants: Vec::new(),
            city_facts: Vec::new(),
            city_signals: Vec::new(),
        };
        let mut issues = Vec::new();
        let mut remap = cities
            .iter()
            .map(|city| (city.city_id.clone(), city.city_id.clone()))
            .collect::<BTreeMap<_, _>>();

        let stats = apply_registry_city_authority(
            &mut cities,
            &mut remap,
            &overlay,
            "europe-aggregate",
            &mut issues,
        );

        assert_eq!(cities[0].city_id.as_str(), "paris-fr-q90");
        assert_eq!(cities[0].wikidata_qid.as_deref(), Some("Q90"));
        assert_eq!(cities[0].population, Some(2_243_739));
        assert_eq!(cities[1].city_id.as_str(), "avignon-fr-q6397");
        assert_eq!(cities[1].wikidata_qid.as_deref(), Some("Q6397"));
        assert_eq!(cities[1].population, Some(94_200));
        assert_eq!(cities[2].city_id.as_str(), "nantes-fr-q12191");
        assert_eq!(cities[2].display_name, "Nantes");
        assert_eq!(cities[2].country_code, "FR");
        assert_eq!(cities[2].wikidata_qid.as_deref(), Some("Q12191"));
        assert_eq!(cities[3].city_id.as_str(), "toulouse-fr-q7880");
        assert_eq!(cities[3].display_name, "Toulouse");
        assert_eq!(cities[3].country_code, "FR");
        assert_eq!(cities[3].wikidata_qid.as_deref(), Some("Q7880"));
        assert_eq!(
            remap
                .get(&CityId::new("nantes-ch-8fefd121").expect("valid city id"))
                .expect("remapped nantes")
                .as_str(),
            "nantes-fr-q12191"
        );
        assert_eq!(
            remap
                .get(&CityId::new("toulouse-matabiau-ch-099c66c9").expect("valid city id"))
                .expect("remapped toulouse")
                .as_str(),
            "toulouse-fr-q7880"
        );
        assert_eq!(issues.len(), 4);
        assert_eq!(stats.matched_count, 4);
        assert_eq!(stats.unmatched_count, 0);
        assert_eq!(stats.ambiguous_count, 0);
        assert_eq!(stats.country_corrected_count, 2);
        assert_eq!(stats.station_promoted_count, 1);
    }

    #[test]
    fn registry_overlay_skips_ambiguous_equal_score_matches() {
        let mut cities = vec![
            aetrain_domain::City {
                city_id: CityId::new("saint-etienne-fr-a").expect("valid city id"),
                slug: "saint-etienne".to_string(),
                display_name: "Saint Etienne".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 45.4397,
                    lon: 4.3872,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: Vec::new(),
                aliases: Vec::new(),
            },
            aetrain_domain::City {
                city_id: CityId::new("saint-etienne-fr-b").expect("valid city id"),
                slug: "saint-etienne".to_string(),
                display_name: "Saint Etienne".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 45.4397,
                    lon: 4.3872,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: Vec::new(),
                aliases: Vec::new(),
            },
        ];
        let overlay = RegistryCanonicalBundle {
            meta: RegistryMeta {
                schema_version: 1,
                dataset_id: "registry-test".to_string(),
                scope: "fr-test".to_string(),
                generated_at: "2026-05-10T00:00:00Z".to_string(),
            },
            cities: vec![RegistryCity {
                city_id: CityId::new("saint-etienne-fr-q42716").expect("valid city id"),
                slug: "saint-etienne".to_string(),
                display_name: "Saint Etienne".to_string(),
                country_code: "FR".to_string(),
                identity_point: GeoPoint {
                    lat: 45.4397,
                    lon: 4.3872,
                },
                map_anchor_point: GeoPoint {
                    lat: 45.4397,
                    lon: 4.3872,
                },
                bbox: None,
                wikidata_qid: Some("Q42716".to_string()),
                population: Some(199_000),
                status: RegistryStatus::Resolved,
                external_refs: Vec::new(),
            }],
            stations: Vec::new(),
            memberships: Vec::new(),
            name_variants: Vec::new(),
            city_facts: Vec::new(),
            city_signals: Vec::new(),
        };
        let mut issues = Vec::new();
        let mut remap = cities
            .iter()
            .map(|city| (city.city_id.clone(), city.city_id.clone()))
            .collect::<BTreeMap<_, _>>();

        let stats = apply_registry_city_authority(
            &mut cities,
            &mut remap,
            &overlay,
            "europe-aggregate",
            &mut issues,
        );

        assert_eq!(stats.matched_count, 0);
        assert_eq!(stats.unmatched_count, 0);
        assert_eq!(stats.ambiguous_count, 1);
        assert!(cities.iter().all(|city| city.wikidata_qid.is_none()));
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn quality_report_flags_station_like_and_zz_gate_failures() {
        let cities = vec![
            City {
                city_id: CityId::new("alpha-zz-1").expect("valid city id"),
                slug: "alpha".to_string(),
                display_name: "Alpha".to_string(),
                country_code: "ZZ".to_string(),
                location: GeoPoint { lat: 0.0, lon: 0.0 },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: Vec::new(),
                aliases: Vec::new(),
            },
            City {
                city_id: CityId::new("beta-fr-2").expect("valid city id"),
                slug: "beta".to_string(),
                display_name: "Beta Gare".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint { lat: 1.0, lon: 1.0 },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: vec![StationId::new("station-beta").expect("valid station id")],
                aliases: Vec::new(),
            },
        ];
        let counters = BTreeMap::from([
            ("registry_overlay_ambiguous_count".to_string(), 0),
            ("residual_station_like_city_count".to_string(), 121),
            ("residual_zz_city_count".to_string(), 360),
        ]);

        let report = build_quality_report(
            &cities,
            &[],
            &EdgeGeometryArtifact { geometries: vec![] },
            None,
            &[],
            &[],
            &counters,
            0,
            None,
            &[],
            Path::new("."),
        );

        assert_eq!(report.registry_match_report.authoritative_city_count, 0);
        assert_eq!(report.station_like_cities.len(), 1);
        assert_eq!(report.zz_cities.len(), 1);
        assert_eq!(report.route_like_candidates.len(), 0);
        assert!(report.gate_results.len() >= 14);
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "registry_overlay_ambiguous_count")
                .expect("ambiguous gate")
                .status,
            "pass"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "residual_station_like_city_count")
                .expect("station gate")
                .status,
            "fail"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "residual_zz_city_count")
                .expect("zz gate")
                .status,
            "fail"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "route_like_city_unresolved_count")
                .expect("route-like gate")
                .status,
            "pass"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "foreign_domestic_feed_leakage_count")
                .expect("leakage gate")
                .status,
            "pass"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "domestic_straight_line_fallback_count")
                .expect("straight-line gate")
                .status,
            "pass"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "foreign_cross_border_feed_leakage_count")
                .expect("foreign cross-border leakage gate")
                .status,
            "pass"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "rejected_rail_authority_count")
                .expect("rejected rail authority gate")
                .status,
            "pass"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "rejected_shape_plausibility_count")
                .expect("rejected shape plausibility gate")
                .status,
            "pass"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "impossible_edge_speed_count")
                .expect("impossible edge speed gate")
                .status,
            "pass"
        );
    }

    #[test]
    fn quality_report_lists_route_geometries_not_using_railway_layer() {
        let paris = City {
            city_id: CityId::new("paris-fr").expect("valid city id"),
            slug: "paris".to_string(),
            display_name: "Paris".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 48.8566,
                lon: 2.3522,
            },
            wikidata_qid: Some("Q90".to_string()),
            population: Some(2_100_000),
            interest_score: Some(10),
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let lyon = City {
            city_id: CityId::new("lyon-fr").expect("valid city id"),
            slug: "lyon".to_string(),
            display_name: "Lyon".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 45.764,
                lon: 4.8357,
            },
            wikidata_qid: Some("Q456".to_string()),
            population: Some(500_000),
            interest_score: Some(7),
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let edges = vec![TravelEdge {
            from_city_id: paris.city_id.clone(),
            to_city_id: lyon.city_id.clone(),
            duration_min: 120,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Intercity,
            change_count_estimate: Some(0),
            source_confidence: 90,
            provenance: vec!["sncf-fr-gtfs:FR:Line::test-route".to_string()],
        }];
        let edge_geometries = EdgeGeometryArtifact {
            geometries: vec![
                EdgeGeometryRecord {
                    from_city_id: paris.city_id.clone(),
                    to_city_id: lyon.city_id.clone(),
                    points: vec![
                        PolylinePointE5 {
                            lat_e5: 4_885_660,
                            lon_e5: 235_220,
                        },
                        PolylinePointE5 {
                            lat_e5: 4_576_400,
                            lon_e5: 483_570,
                        },
                    ],
                    source: EdgeGeometrySource::StraightLineFallback,
                    provenance: vec!["sncf-fr-gtfs:FR:Line::test-route".to_string()],
                },
                EdgeGeometryRecord {
                    from_city_id: lyon.city_id.clone(),
                    to_city_id: paris.city_id.clone(),
                    points: vec![
                        PolylinePointE5 {
                            lat_e5: 4_576_400,
                            lon_e5: 483_570,
                        },
                        PolylinePointE5 {
                            lat_e5: 4_700_000,
                            lon_e5: 360_000,
                        },
                        PolylinePointE5 {
                            lat_e5: 4_885_660,
                            lon_e5: 235_220,
                        },
                    ],
                    source: EdgeGeometrySource::InfrastructureGraphFallback,
                    provenance: vec!["geometry:test-rail".to_string()],
                },
            ],
        };
        let mut counters = BTreeMap::new();
        insert_route_geometry_coverage_counters(&mut counters, &edge_geometries);

        let report = build_quality_report(
            &[paris, lyon],
            &edges,
            &edge_geometries,
            None,
            &[],
            &[],
            &counters,
            0,
            None,
            &[],
            Path::new("."),
        );

        assert_eq!(report.non_railway_route_geometries.len(), 1);
        assert_eq!(
            report.non_railway_route_geometries[0].geometry_source,
            EdgeGeometrySource::StraightLineFallback
        );
        assert_eq!(
            report.non_railway_route_geometries[0].geometry_resolution_status,
            "missing_domestic_authority"
        );
        assert_eq!(
            report.non_railway_route_geometries[0].duration_min,
            Some(120)
        );
        assert_eq!(
            counters.get("non_railway_layer_route_geometry_count"),
            Some(&1)
        );
        assert_eq!(counters.get("railway_layer_route_geometry_count"), Some(&1));
        assert_eq!(report.route_geometry_anomalies.len(), 1);
        assert_eq!(
            report.route_geometry_anomalies[0].anomaly_type,
            "straight_line_fallback"
        );
        assert_eq!(report.domestic_geometry_backlog_by_country.len(), 1);
        assert_eq!(
            report.domestic_geometry_backlog_by_country[0].country_code,
            "FR"
        );
    }

    #[test]
    fn quality_report_applies_promoted_authority_gates() {
        let paris = City {
            city_id: CityId::new("paris-fr").expect("valid city id"),
            slug: "paris".to_string(),
            display_name: "Paris".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 48.8566,
                lon: 2.3522,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let lyon = City {
            city_id: CityId::new("lyon-fr").expect("valid city id"),
            slug: "lyon".to_string(),
            display_name: "Lyon".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 45.7640,
                lon: 4.8357,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let edges = vec![TravelEdge {
            from_city_id: paris.city_id.clone(),
            to_city_id: lyon.city_id.clone(),
            duration_min: 120,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Intercity,
            change_count_estimate: Some(0),
            source_confidence: 100,
            provenance: vec!["sncf-fr-gtfs:FR:test".to_string()],
        }];
        let edge_geometries = EdgeGeometryArtifact {
            geometries: vec![EdgeGeometryRecord {
                from_city_id: paris.city_id.clone(),
                to_city_id: lyon.city_id.clone(),
                points: vec![
                    scale_geo_point_e5_for_pipeline(paris.location),
                    scale_geo_point_e5_for_pipeline(lyon.location),
                ],
                source: EdgeGeometrySource::StraightLineFallback,
                provenance: vec!["sncf-fr-gtfs:FR:test".to_string()],
            }],
        };
        let registry = GeometryAuthorityRegistry {
            dataset_id: "test-authorities".to_string(),
            schema_version: 1,
            description: "test".to_string(),
            countries: vec![crate::CountryGeometryAuthorityDefinition {
                country_code: "FR".to_string(),
                source_id: Some("sncf-fr-rfn-lines".to_string()),
                loader: Some(GeometryAuthorityLoader::SncfRfnGeojson),
                status: GeometryAuthorityStatus::ProductionReady,
                max_promoted_station_attachment_gap_count: Some(0),
                max_promoted_topology_no_route_gap_count: Some(0),
                max_promoted_rejected_implausible_authority_detour_count: Some(0),
                notes: None,
            }],
            corridors: Vec::new(),
            route_policies: Vec::new(),
        };

        let report = build_quality_report(
            &[paris, lyon],
            &edges,
            &edge_geometries,
            None,
            &[],
            &[],
            &BTreeMap::new(),
            0,
            Some(&registry),
            &[],
            Path::new("."),
        );

        assert_eq!(report.country_geometry_authorities.len(), 1);
        assert_eq!(
            report.country_geometry_authorities[0].missing_domestic_authority_count,
            1
        );
        assert_eq!(
            report.country_geometry_authorities[0].max_promoted_station_attachment_gap_count,
            Some(0)
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "promoted_domestic_authority_gap_count")
                .expect("promoted domestic gate")
                .status,
            "fail"
        );
        assert_eq!(
            report.promoted_domestic_authority_gap_details[0].authority_gap_reason,
            "authority_station_attachment_gap"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "promoted_station_attachment_gap_count")
                .expect("promoted station attachment gate")
                .status,
            "fail"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "promoted_topology_no_route_gap_count")
                .expect("promoted topology no-route gate")
                .status,
            "pass"
        );
        assert_eq!(
            report
                .gate_results
                .iter()
                .find(|gate| gate.metric == "country_fr_promoted_station_attachment_gap_count")
                .expect("country policy gate")
                .status,
            "fail"
        );
    }

    #[test]
    fn quality_report_flags_implausible_route_geometry_anomalies() {
        let orleans = City {
            city_id: CityId::new("orleans-fr").expect("valid city id"),
            slug: "orleans".to_string(),
            display_name: "Orleans".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 47.907891,
                lon: 1.904242,
            },
            wikidata_qid: None,
            population: None,
            interest_score: Some(7),
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let saint_cyr = City {
            city_id: CityId::new("saint-cyr-en-val-fr").expect("valid city id"),
            slug: "saint-cyr-en-val".to_string(),
            display_name: "Saint Cyr En Val".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 47.819215,
                lon: 1.947581,
            },
            wikidata_qid: None,
            population: None,
            interest_score: Some(5),
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let edges = vec![TravelEdge {
            from_city_id: orleans.city_id.clone(),
            to_city_id: saint_cyr.city_id.clone(),
            duration_min: 8,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Regional,
            change_count_estimate: Some(0),
            source_confidence: 100,
            provenance: vec!["test:route".to_string()],
        }];
        let edge_geometries = EdgeGeometryArtifact {
            geometries: vec![EdgeGeometryRecord {
                from_city_id: orleans.city_id.clone(),
                to_city_id: saint_cyr.city_id.clone(),
                points: vec![
                    PolylinePointE5 {
                        lat_e5: 4_790_789,
                        lon_e5: 190_424,
                    },
                    PolylinePointE5 {
                        lat_e5: 4_730_000,
                        lon_e5: 10_000,
                    },
                    PolylinePointE5 {
                        lat_e5: 4_781_922,
                        lon_e5: 194_758,
                    },
                ],
                source: EdgeGeometrySource::InfrastructureGraphFallback,
                provenance: vec!["geometry:test-rail".to_string()],
            }],
        };

        let report = build_quality_report(
            &[orleans, saint_cyr],
            &edges,
            &edge_geometries,
            None,
            &[],
            &[],
            &BTreeMap::new(),
            0,
            None,
            &[],
            Path::new("."),
        );

        assert_eq!(report.route_geometry_anomalies.len(), 1);
        assert_eq!(
            report.route_geometry_anomalies[0].anomaly_type,
            "railway_geometry_detour"
        );
        assert_eq!(
            report.route_geometry_anomalies[0].geometry_resolution_status,
            "railway_geometry_detour"
        );
        assert!(
            report.route_geometry_anomalies[0]
                .detour_ratio_x100
                .expect("detour ratio should be present")
                > 600
        );
        assert_eq!(report.rejected_rail_authority_routes.len(), 0);
    }

    #[test]
    fn geometry_resolution_status_classifies_straight_line_cases() {
        assert_eq!(
            classify_geometry_resolution_status(
                "CH",
                "CH",
                &EdgeGeometrySource::StraightLineFallback,
                &["ch-gtfs:91-1-D-j26-1".to_string()],
                Some("straight_line_fallback"),
            ),
            "missing_domestic_authority"
        );
        assert_eq!(
            classify_geometry_resolution_status(
                "DE",
                "DE",
                &EdgeGeometrySource::StraightLineFallback,
                &["ch-gtfs:91-50-C-j26-1".to_string()],
                Some("straight_line_fallback"),
            ),
            "foreign_domestic_leakage"
        );
        assert_eq!(
            classify_geometry_resolution_status(
                "CH",
                "DE",
                &EdgeGeometrySource::StraightLineFallback,
                &["ch-gtfs:91-72-G-j26-1".to_string()],
                Some("straight_line_fallback"),
            ),
            "cross_border_unresolved"
        );
        assert_eq!(
            classify_geometry_resolution_status(
                "NL",
                "DE",
                &EdgeGeometrySource::StraightLineFallback,
                &["ch-gtfs:91-66-Y-j26-1".to_string()],
                Some("straight_line_fallback"),
            ),
            "foreign_cross_border_leakage"
        );
    }

    #[test]
    fn geometry_resolution_status_classifies_rejected_gtfs_shape() {
        assert_eq!(
            classify_geometry_resolution_status(
                "ES",
                "ES",
                &EdgeGeometrySource::StraightLineFallback,
                &[
                    "es-renfe-mainline-gtfs:test".to_string(),
                    INVALID_GTFS_SHAPE_GEOMETRY_REJECTED_PROVENANCE.to_string(),
                ],
                Some("rejected_invalid_gtfs_shape_geometry"),
            ),
            "rejected_shape_plausibility"
        );
    }

    #[test]
    fn promoted_domestic_authority_gap_reason_prefers_station_attachment_before_topology() {
        assert_eq!(
            classify_promoted_domestic_authority_gap_reason(None, Some(42), false),
            "authority_station_attachment_gap"
        );
        assert_eq!(
            classify_promoted_domestic_authority_gap_reason(Some(42), Some(84), false),
            "authority_topology_no_route"
        );
        assert_eq!(
            classify_promoted_domestic_authority_gap_reason(Some(42), Some(84), true),
            "implausible_authority_detour"
        );
        assert_eq!(
            classify_authority_path_failure_reason(Some(42), Some(84), false),
            "authority_topology_no_route"
        );
    }

    #[test]
    fn authority_detour_corridor_policy_prefers_footprint_before_suppression() {
        assert_eq!(
            classify_authority_detour_corridor_policy(2, 1500, 500, 900).0,
            "tighten_authority_footprint"
        );
        assert_eq!(
            classify_authority_detour_corridor_policy(2, 120, 250, 800).0,
            "suppress_authority_until_topology_fixed"
        );
        assert_eq!(
            classify_authority_detour_corridor_policy(1, 120, 120, 160).0,
            "review_authority_corridor"
        );
    }

    #[test]
    fn reject_foreign_cross_border_feed_leakage_removes_edge_and_geometry() {
        let amsterdam = City {
            city_id: CityId::new("amsterdam-nl").expect("valid city id"),
            slug: "amsterdam".to_string(),
            display_name: "Amsterdam".to_string(),
            country_code: "NL".to_string(),
            location: GeoPoint {
                lat: 52.3676,
                lon: 4.9041,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let offenburg = City {
            city_id: CityId::new("offenburg-de").expect("valid city id"),
            slug: "offenburg".to_string(),
            display_name: "Offenburg".to_string(),
            country_code: "DE".to_string(),
            location: GeoPoint {
                lat: 48.4734,
                lon: 7.9498,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let mut edges = vec![TravelEdge {
            from_city_id: amsterdam.city_id.clone(),
            to_city_id: offenburg.city_id.clone(),
            duration_min: 360,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Intercity,
            change_count_estimate: Some(0),
            source_confidence: 100,
            provenance: vec!["ch-gtfs:test".to_string()],
        }];
        let mut edge_geometries = EdgeGeometryArtifact {
            geometries: vec![EdgeGeometryRecord {
                from_city_id: amsterdam.city_id.clone(),
                to_city_id: offenburg.city_id.clone(),
                points: vec![
                    scale_geo_point_e5_for_pipeline(amsterdam.location),
                    scale_geo_point_e5_for_pipeline(offenburg.location),
                ],
                source: EdgeGeometrySource::StraightLineFallback,
                provenance: vec!["ch-gtfs:test".to_string()],
            }],
        };
        let mut issues = Vec::new();

        let rejected = reject_foreign_cross_border_feed_leakage(
            &mut edges,
            &mut edge_geometries,
            &[amsterdam, offenburg],
            "europe-validated",
            &mut issues,
        );

        assert_eq!(rejected, 1);
        assert!(edges.is_empty());
        assert!(edge_geometries.geometries.is_empty());
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn reject_impossible_edge_speeds_removes_edge_and_geometry() {
        let madrid = City {
            city_id: CityId::new("madrid-es").expect("valid city id"),
            slug: "madrid".to_string(),
            display_name: "Madrid".to_string(),
            country_code: "ES".to_string(),
            location: GeoPoint {
                lat: 40.4168,
                lon: -3.7038,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let leon = City {
            city_id: CityId::new("leon-es").expect("valid city id"),
            slug: "leon".to_string(),
            display_name: "Leon".to_string(),
            country_code: "ES".to_string(),
            location: GeoPoint {
                lat: 42.5987,
                lon: -5.5671,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let mut edges = vec![TravelEdge {
            from_city_id: madrid.city_id.clone(),
            to_city_id: leon.city_id.clone(),
            duration_min: 20,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Intercity,
            change_count_estimate: Some(0),
            source_confidence: 100,
            provenance: vec!["es-renfe-mainline-gtfs:test".to_string()],
        }];
        let mut edge_geometries = EdgeGeometryArtifact {
            geometries: vec![EdgeGeometryRecord {
                from_city_id: madrid.city_id.clone(),
                to_city_id: leon.city_id.clone(),
                points: vec![
                    scale_geo_point_e5_for_pipeline(madrid.location),
                    scale_geo_point_e5_for_pipeline(leon.location),
                ],
                source: EdgeGeometrySource::StraightLineFallback,
                provenance: vec!["es-renfe-mainline-gtfs:test".to_string()],
            }],
        };
        let mut issues = Vec::new();

        let rejected = reject_impossible_edge_speeds(
            &mut edges,
            &mut edge_geometries,
            &[madrid, leon],
            "europe-validated",
            &mut issues,
        );

        assert_eq!(rejected, 1);
        assert!(edges.is_empty());
        assert!(edge_geometries.geometries.is_empty());
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn reject_invalid_gtfs_shape_geometries_downgrades_to_straight_line() {
        let gibaja = City {
            city_id: CityId::new("gibaja-es").expect("valid city id"),
            slug: "gibaja".to_string(),
            display_name: "Gibaja".to_string(),
            country_code: "ES".to_string(),
            location: GeoPoint {
                lat: 43.3161,
                lon: -3.4387,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let udalla = City {
            city_id: CityId::new("udalla-es").expect("valid city id"),
            slug: "udalla".to_string(),
            display_name: "Udalla".to_string(),
            country_code: "ES".to_string(),
            location: GeoPoint {
                lat: 43.2662,
                lon: -3.4295,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let edges = vec![TravelEdge {
            from_city_id: gibaja.city_id.clone(),
            to_city_id: udalla.city_id.clone(),
            duration_min: 3,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Regional,
            change_count_estimate: Some(0),
            source_confidence: 100,
            provenance: vec!["es-renfe-mainline-gtfs:test".to_string()],
        }];
        let mut edge_geometries = EdgeGeometryArtifact {
            geometries: vec![EdgeGeometryRecord {
                from_city_id: gibaja.city_id.clone(),
                to_city_id: udalla.city_id.clone(),
                points: vec![
                    scale_geo_point_e5_for_pipeline(gibaja.location),
                    PolylinePointE5 {
                        lat_e5: 4_350_000,
                        lon_e5: -320_000,
                    },
                    scale_geo_point_e5_for_pipeline(udalla.location),
                ],
                source: EdgeGeometrySource::GtfsShapeSegment,
                provenance: vec!["es-renfe-mainline-gtfs:test".to_string()],
            }],
        };
        let mut issues = Vec::new();

        let rejected = reject_invalid_gtfs_shape_geometries(
            &mut edge_geometries,
            &[gibaja.clone(), udalla.clone()],
            &edges,
            "europe-validated",
            &mut issues,
        );

        assert_eq!(rejected, 1);
        assert_eq!(
            edge_geometries.geometries[0].source,
            EdgeGeometrySource::StraightLineFallback
        );
        assert!(
            edge_geometries.geometries[0]
                .provenance
                .iter()
                .any(|entry| entry == INVALID_GTFS_SHAPE_GEOMETRY_REJECTED_PROVENANCE)
        );
        assert_eq!(
            edge_geometries.geometries[0].points,
            vec![
                scale_geo_point_e5_for_pipeline(gibaja.location),
                scale_geo_point_e5_for_pipeline(udalla.location),
            ]
        );
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn abbreviation_candidates_skip_legitimate_short_place_names() {
        let agde = City {
            city_id: CityId::new("agde-fr-34003").expect("valid city id"),
            slug: "agde".to_string(),
            display_name: "Agde".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint {
                lat: 43.31,
                lon: 3.47,
            },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let gd = City {
            city_id: CityId::new("gd-de-c0b2ec09").expect("valid city id"),
            slug: "gd".to_string(),
            display_name: "Gd".to_string(),
            country_code: "DE".to_string(),
            location: GeoPoint { lat: 0.0, lon: 0.0 },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let au_sg = City {
            city_id: CityId::new("au-sg-ch-e9228a80").expect("valid city id"),
            slug: "au-sg".to_string(),
            display_name: "Au Sg".to_string(),
            country_code: "CH".to_string(),
            location: GeoPoint { lat: 0.0, lon: 0.0 },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let rn = City {
            city_id: CityId::new("rn-fr-x").expect("valid city id"),
            slug: "rn".to_string(),
            display_name: "Kilstett 13 Route Nationale".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint { lat: 0.0, lon: 0.0 },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };

        assert!(abbreviation_candidate_record(&agde).is_none());
        assert_eq!(
            abbreviation_candidate_record(&gd)
                .expect("gd candidate")
                .reason,
            "single_token_too_short"
        );
        assert_eq!(abbreviation_candidate_record(&au_sg), None);
        assert_eq!(
            abbreviation_candidate_record(&rn)
                .expect("route candidate")
                .reason,
            "digit_or_route_like_name"
        );
    }

    #[test]
    fn quality_report_splits_abbreviation_and_route_like_candidates() {
        let route_like = City {
            city_id: CityId::new("rn-fr-x").expect("valid city id"),
            slug: "rn".to_string(),
            display_name: "Kilstett 13 Route Nationale".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint { lat: 0.0, lon: 0.0 },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let abbrev = City {
            city_id: CityId::new("gd-de-c0b2ec09").expect("valid city id"),
            slug: "gd".to_string(),
            display_name: "Gd".to_string(),
            country_code: "DE".to_string(),
            location: GeoPoint { lat: 0.0, lon: 0.0 },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        };
        let counters = BTreeMap::new();

        let report = build_quality_report(
            &[route_like, abbrev],
            &[],
            &EdgeGeometryArtifact { geometries: vec![] },
            None,
            &[],
            &[],
            &counters,
            0,
            None,
            &[],
            Path::new("."),
        );

        assert_eq!(report.route_like_candidates.len(), 1);
        assert_eq!(
            report.route_like_candidates[0].reason,
            "digit_or_route_like_name"
        );
        assert_eq!(report.abbreviation_candidates.len(), 1);
        assert_eq!(
            report.abbreviation_candidates[0].reason,
            "single_token_too_short"
        );
    }

    #[test]
    fn demote_route_like_pseudo_cities_collapses_deterministic_parent_match() {
        let mut cities = vec![
            City {
                city_id: CityId::new("munster-fr-68226").expect("valid city id"),
                slug: "munster".to_string(),
                display_name: "Munster".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 48.0400,
                    lon: 7.1380,
                },
                wikidata_qid: None,
                population: None,
                interest_score: Some(4),
                station_ids: vec![StationId::new("station-munster").expect("valid station id")],
                aliases: Vec::new(),
            },
            City {
                city_id: CityId::new("munster-inter-d417-badischhof-zz-c6570f7f")
                    .expect("valid city id"),
                slug: "munster-inter-d417-badischhof".to_string(),
                display_name: "Munster Inter D417 Badischhof".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 48.0410,
                    lon: 7.1400,
                },
                wikidata_qid: None,
                population: None,
                interest_score: Some(1),
                station_ids: vec![
                    StationId::new("station-munster-inter-d417-badischhof")
                        .expect("valid station id"),
                ],
                aliases: Vec::new(),
            },
        ];
        let mut city_id_remap = BTreeMap::new();
        let mut issues = Vec::new();

        let stats = demote_route_like_pseudo_cities(
            &mut cities,
            &mut city_id_remap,
            "europe-aggregate",
            &mut issues,
        );

        assert_eq!(
            stats,
            RouteLikeDemotionStats {
                demoted_count: 1,
                unresolved_count: 0,
                ambiguous_count: 0,
            }
        );
        assert_eq!(cities.len(), 1);
        assert_eq!(cities[0].display_name, "Munster");
        assert!(
            cities[0]
                .aliases
                .iter()
                .any(|alias| alias == "Munster Inter D417 Badischhof")
        );
        assert_eq!(
            city_id_remap.get(
                &CityId::new("munster-inter-d417-badischhof-zz-c6570f7f").expect("valid city id")
            ),
            Some(&CityId::new("munster-fr-68226").expect("valid city id"))
        );
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn route_like_residuals_capture_mapping_strategy_and_classification() {
        let candidates = vec![
            PipelineAbbreviationCandidateRecord {
                city_id: CityId::new("bus-x30-ostfriedh-at-05066955").expect("valid city id"),
                display_name: "Bus X30 Ostfriedh".to_string(),
                country_code: "AT".to_string(),
                normalized_name: "bus x30 ostfriedh".to_string(),
                reason: "digit_or_route_like_name".to_string(),
            },
            PipelineAbbreviationCandidateRecord {
                city_id: CityId::new("wimmenau-d-919-rue-de-la-zz-af0f2d0d")
                    .expect("valid city id"),
                display_name: "Wimmenau D 919 Rue De La".to_string(),
                country_code: "FR".to_string(),
                normalized_name: "wimmenau d 919 rue de la".to_string(),
                reason: "digit_or_route_like_name".to_string(),
            },
        ];
        let station_mappings = StationMappingReport {
            records: vec![
                crate::StationMappingRecord {
                    station_key: "at:bus-x30".to_string(),
                    station_id: StationId::new("station-at-bus-x30").expect("valid station id"),
                    city_id: CityId::new("bus-x30-ostfriedh-at-05066955").expect("valid city id"),
                    city_cluster_key: "cluster-a".to_string(),
                    station_display_name: "Bus X30 Ostfriedh".to_string(),
                    mapping_strategy: crate::sncf::StationMappingStrategy::GtfsStemCluster,
                    confidence: 60,
                    matched_reference_id: None,
                    matched_reference_name: None,
                    override_id: None,
                    source_refs: Vec::new(),
                },
                crate::StationMappingRecord {
                    station_key: "fr:wimmenau".to_string(),
                    station_id: StationId::new("station-uic-87642348").expect("valid station id"),
                    city_id: CityId::new("wimmenau-d-919-rue-de-la-zz-af0f2d0d")
                        .expect("valid city id"),
                    city_cluster_key: "cluster-b".to_string(),
                    station_display_name: "Wimmenau D.919 - Rue de la Gare".to_string(),
                    mapping_strategy: crate::sncf::StationMappingStrategy::FallbackReferenceGap,
                    confidence: 50,
                    matched_reference_id: None,
                    matched_reference_name: None,
                    override_id: None,
                    source_refs: Vec::new(),
                },
            ],
        };

        let residuals = build_route_like_residual_records(&candidates, Some(&station_mappings));

        assert_eq!(residuals.len(), 2);
        assert_eq!(residuals[0].classification, "station_only_feed_stop_label");
        assert_eq!(
            residuals[0].mapping_strategy.as_deref(),
            Some("gtfs_stem_cluster")
        );
        assert_eq!(
            residuals[1].classification,
            "reference_gap_parent_city_missing"
        );
        assert_eq!(
            residuals[1].mapping_strategy.as_deref(),
            Some("fallback_reference_gap")
        );
        assert_eq!(residuals[1].derived_parent_key.as_deref(), Some("wimmenau"));
    }
}
