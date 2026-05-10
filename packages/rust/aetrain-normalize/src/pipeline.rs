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
use aetrain_domain::{ServiceClass, ServiceKind};
use aetrain_registry::RegistryCanonicalBundle;
use anyhow::{Context, Result, bail};
use deunicode::deunicode;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    DuplicateCityReport, FetchedSource, ManualOverrideRegistry, NormalizationIssue, SourceKind,
    SourceManifest, StationMappingReport, TargetDefinition, build_gtfs_basic_dataset,
    build_sncf_dataset, bundle_from_basic_output, bundle_from_output,
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

struct MergedCityOutput {
    cities: Vec<aetrain_domain::City>,
    aliases: Vec<aetrain_dataset::AliasRecord>,
    city_id_remap: BTreeMap<aetrain_domain::CityId, aetrain_domain::CityId>,
    issues: Vec<NormalizationIssue>,
}

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
    export_pipeline_target(
        manifest,
        target,
        &artifacts,
        &sources,
        output_root,
        dataset_version,
        generated_at,
        artifacts.canonical.meta.source_snapshots.clone(),
    )
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

fn export_pipeline_target(
    manifest: &SourceManifest,
    target: &TargetDefinition,
    artifacts: &AdapterBuildArtifacts,
    sources: &[&FetchedSource],
    output_root: &Path,
    dataset_version: &str,
    generated_at: &str,
    source_snapshots: Vec<SourceSnapshot>,
) -> Result<PipelineArtifactManifest> {
    let target_root = output_root.join(&target.id);
    fs::create_dir_all(&target_root)
        .with_context(|| format!("failed to create {}", target_root.display()))?;

    let source_artifacts = if artifacts.source_artifacts.is_empty() {
        sources
            .iter()
            .map(|source| PipelineSourceArtifact {
                source_id: source.definition.id.clone(),
                local_path: source.local_path.display().to_string(),
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

    let summary = PipelineBuildSummary {
        city_count: artifacts.canonical.cities.len(),
        station_count: artifacts.canonical.stations.len(),
        edge_count: artifacts.canonical.edges.len(),
        alias_count: artifacts.canonical.aliases.len(),
        duplicate_count: artifacts.duplicates.candidates.len(),
        issue_count: artifacts.issues.len(),
        counters: artifacts.counters.clone(),
    };

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
        notes: artifacts.notes.clone(),
    };

    write_json(
        &target_root.join("artifact-manifest.json"),
        &artifact_manifest,
    )?;
    write_json(
        &target_root.join("summary.json"),
        &artifact_manifest.summary,
    )?;
    Ok(artifact_manifest)
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
    write_json(&output_dir.join("issues.json"), &artifacts.issues)?;
    write_json(&output_dir.join("attribution.json"), attribution)?;
    Ok(())
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
    let _duplicates =
        read_json::<DuplicateCityReport>(&canonical_dir.join("duplicate-candidates.json"))?;
    let issues = read_json::<Vec<NormalizationIssue>>(&canonical_dir.join("issues.json"))?;

    Ok(AggregateTargetInput {
        target_id: target_id.to_string(),
        manifest,
        canonical,
        edge_geometries,
        station_mappings,
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

    let source_snapshots = merge_source_snapshots(&dependency_inputs);
    let source_artifacts = merge_source_artifacts(&dependency_inputs);
    let notes = vec![format!(
        "Aggregated canonical outputs from {} validated targets.",
        dependency_inputs.len()
    )];
    let counters = BTreeMap::from([
        (
            "dependency_target_count".to_string(),
            dependency_inputs.len() as u64,
        ),
        (
            "dependency_source_count".to_string(),
            source_snapshots.len() as u64,
        ),
    ]);

    let mut merged_cities = merge_cities(&dependency_inputs, request.target.id.as_str());
    if let Some(registry_overlay_path) = request.target.registry_overlay_path.as_deref() {
        let overlay_path =
            resolve_manifest_relative_path(request.manifest_dir, registry_overlay_path);
        let overlay: RegistryCanonicalBundle = read_json(&overlay_path).with_context(|| {
            format!(
                "failed to load registry overlay bundle from {}",
                overlay_path.display()
            )
        })?;
        apply_registry_city_overlay(
            &mut merged_cities.cities,
            &overlay,
            request.target.id.as_str(),
            &mut merged_cities.issues,
        );
    }
    let stations = merge_stations(
        &dependency_inputs,
        &merged_cities.city_id_remap,
        request.target.id.as_str(),
    )?;
    let edges = merge_edges(&dependency_inputs, &merged_cities.city_id_remap);
    let edge_geometries = merge_edge_geometries(&dependency_inputs, &merged_cities.city_id_remap);
    let station_mappings = merge_station_mappings(&dependency_inputs, &merged_cities.city_id_remap);
    apply_computed_city_enrichment(&mut merged_cities.cities, &edges);
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
    let mut merged = BTreeMap::<aetrain_domain::CityId, aetrain_domain::City>::new();
    let mut alias_pairs = BTreeSet::<(String, aetrain_domain::CityId)>::new();

    for city in merged_by_input_id.into_values() {
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

    for city in merged.values_mut() {
        city.aliases.sort();
        city.aliases.dedup();
        city.station_ids
            .sort_by(|left, right| left.as_str().cmp(right.as_str()));
        city.station_ids
            .dedup_by(|left, right| left.as_str() == right.as_str());
        for alias in &city.aliases {
            alias_pairs.insert((alias.clone(), city.city_id.clone()));
        }
        alias_pairs.insert((normalize_alias(&city.display_name), city.city_id.clone()));
    }

    let aliases = alias_pairs
        .into_iter()
        .filter(|(alias, _)| !alias.trim().is_empty())
        .map(|(alias, city_id)| aetrain_dataset::AliasRecord { alias, city_id })
        .collect::<Vec<_>>();

    MergedCityOutput {
        cities: merged.into_values().collect(),
        aliases,
        city_id_remap,
        issues,
    }
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

fn apply_registry_city_overlay(
    cities: &mut [aetrain_domain::City],
    overlay: &RegistryCanonicalBundle,
    aggregate_source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) {
    let mut claimed_indexes = BTreeSet::new();
    for registry_city in &overlay.cities {
        let Some((index, _score)) = cities
            .iter()
            .enumerate()
            .filter(|(index, _)| !claimed_indexes.contains(index))
            .filter_map(|(index, city)| {
                registry_overlay_match_score(city, registry_city).map(|score| (index, score))
            })
            .max_by(|left, right| left.1.cmp(&right.1))
        else {
            continue;
        };
        claimed_indexes.insert(index);
        let city = &mut cities[index];
        let mut changed = false;
        if city.slug != registry_city.slug {
            city.slug = registry_city.slug.clone();
            changed = true;
        }
        if city.display_name != registry_city.display_name {
            city.display_name = registry_city.display_name.clone();
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

        if changed {
            issues.push(NormalizationIssue {
                severity: crate::IssueSeverity::Info,
                source_id: aggregate_source_id.to_string(),
                entity_ref: city.city_id.to_string(),
                message: format!(
                    "applied registry overlay {} to canonical city {}",
                    registry_city.city_id, city.city_id
                ),
            });
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
        EdgeGeometrySource::GtfsShapeSegment => 0,
        EdgeGeometrySource::InfrastructureGraphFallback => 1,
        EdgeGeometrySource::OsmGraphFallbackPlanned => 2,
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

    if let Some(index) = first_station_qualifier_index(&tokens) {
        if index > 0 {
            tokens.truncate(index);
        }
    } else {
        loop {
            let trimmed = if tokens.ends_with(&["gare".to_string(), "centrale".to_string()]) {
                Some(tokens.len() - 2)
            } else if tokens.ends_with(&["gare".to_string(), "central".to_string()]) {
                Some(tokens.len() - 2)
            } else if tokens.ends_with(&["central".to_string(), "station".to_string()]) {
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
    tokens.len() > 1 && first_station_qualifier_index(&tokens).is_some()
}

fn first_station_qualifier_index(tokens: &[String]) -> Option<usize> {
    tokens
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, token)| is_station_token(token).then_some(index))
}

fn is_station_token(token: &str) -> bool {
    matches!(
        token,
        "aeroport"
            | "airport"
            | "bahn"
            | "bahnhof"
            | "bahnhst"
            | "bhf"
            | "busbahnhof"
            | "busstation"
            | "centrale"
            | "gare"
            | "gareroutiere"
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
        ]);

        Ok(AdapterBuildArtifacts {
            canonical: bundle_from_output(&output),
            edge_geometries: Some(output.edge_geometries),
            station_mappings: Some(output.station_mappings),
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

        let counters = BTreeMap::from([(
            "gtfs_station_count".to_string(),
            output.summary.gtfs_station_count as u64,
        )]);

        Ok(AdapterBuildArtifacts {
            canonical: bundle_from_basic_output(&output),
            edge_geometries: Some(output.edge_geometries),
            station_mappings: Some(output.station_mappings),
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

        let lyon = lyon;
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

        apply_registry_city_overlay(&mut cities, &overlay, "europe-aggregate", &mut issues);

        assert_eq!(cities[0].wikidata_qid.as_deref(), Some("Q90"));
        assert_eq!(cities[0].population, Some(2_243_739));
        assert_eq!(cities[1].wikidata_qid.as_deref(), Some("Q6397"));
        assert_eq!(cities[1].population, Some(94_200));
        assert_eq!(cities[2].display_name, "Nantes");
        assert_eq!(cities[2].country_code, "FR");
        assert_eq!(cities[2].wikidata_qid.as_deref(), Some("Q12191"));
        assert_eq!(cities[3].display_name, "Toulouse");
        assert_eq!(cities[3].country_code, "FR");
        assert_eq!(cities[3].wikidata_qid.as_deref(), Some("Q7880"));
        assert_eq!(issues.len(), 4);
    }
}
