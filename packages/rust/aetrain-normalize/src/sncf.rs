use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    hash::{Hash, Hasher},
    path::Path,
};

use aetrain_dataset::{
    AliasRecord, DatasetBundle, DatasetMeta, EdgeGeometryArtifact, EdgeGeometryRecord,
    EdgeGeometrySource, PolylinePointE5, SourceSnapshot,
};
use aetrain_domain::{
    City, CityId, GeoPoint, ServiceClass, ServiceKind, SourceRef, Station, StationId, TravelEdge,
};
use anyhow::{Context, Result};
use csv::{ReaderBuilder, Trim};
use deunicode::deunicode;
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::{
    IssueSeverity, ManualOverrideRegistry, NormalizationIssue, rail_geometry::RailGeometryNetwork,
};

pub const DEFAULT_DUPLICATE_DISTANCE_METERS: u32 = 25_000;
const NAME_MATCH_DISTANCE_METERS: f64 = 2_000.0;
const GTFS_BASIC_STEM_DISTANCE_METERS: f64 = 30_000.0;
const GTFS_BASIC_ROUTE_LIKE_PARENT_MAX_DISTANCE_METERS: f64 = 5_000.0;
const GTFS_BASIC_URBAN_PARENT_MAX_DISTANCE_METERS: f64 = 15_000.0;
const GTFS_BASIC_URBAN_NEARBY_FALLBACK_MAX_DISTANCE_METERS: f64 = 5_000.0;
const MAX_SHAPE_STOP_DISTANCE_METERS: f64 = 25_000.0;
const SHAPE_ENDPOINT_SNAP_DISTANCE_METERS: f64 = 350.0;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuplicateCityCandidate {
    pub left_city_id: CityId,
    pub left_display_name: String,
    pub right_city_id: CityId,
    pub right_display_name: String,
    pub normalized_name: String,
    pub distance_meters: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuplicateCityReport {
    pub generated_at: String,
    pub threshold_meters: u32,
    pub candidates: Vec<DuplicateCityCandidate>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SncfBuildSummary {
    pub station_reference_count: usize,
    pub gtfs_station_count: usize,
    pub matched_station_count: usize,
    pub unmatched_station_count: usize,
    pub city_count: usize,
    pub station_count: usize,
    pub edge_count: usize,
    pub duplicate_count: usize,
    pub issue_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SncfBuildOutput {
    pub meta: DatasetMeta,
    pub cities: Vec<City>,
    pub stations: Vec<Station>,
    pub station_mappings: StationMappingReport,
    pub edges: Vec<TravelEdge>,
    pub edge_geometries: EdgeGeometryArtifact,
    pub rejected_city_candidates: RejectedCityCandidateReport,
    pub aliases: Vec<AliasRecord>,
    pub duplicates: DuplicateCityReport,
    pub issues: Vec<NormalizationIssue>,
    pub summary: SncfBuildSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BasicGtfsBuildSummary {
    pub gtfs_station_count: usize,
    pub city_count: usize,
    pub station_count: usize,
    pub edge_count: usize,
    pub duplicate_count: usize,
    pub issue_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BasicGtfsBuildOutput {
    pub meta: DatasetMeta,
    pub cities: Vec<City>,
    pub stations: Vec<Station>,
    pub station_mappings: StationMappingReport,
    pub edges: Vec<TravelEdge>,
    pub edge_geometries: EdgeGeometryArtifact,
    pub rejected_city_candidates: RejectedCityCandidateReport,
    pub aliases: Vec<AliasRecord>,
    pub duplicates: DuplicateCityReport,
    pub issues: Vec<NormalizationIssue>,
    pub summary: BasicGtfsBuildSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationMappingStrategy {
    ManualOverride,
    ReferenceUic,
    ReferenceName,
    FallbackReferenceGap,
    GtfsStemCluster,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationMappingRecord {
    pub station_key: String,
    pub station_id: StationId,
    pub city_id: CityId,
    pub city_cluster_key: String,
    pub station_display_name: String,
    pub mapping_strategy: StationMappingStrategy,
    pub confidence: u8,
    pub matched_reference_id: Option<String>,
    pub matched_reference_name: Option<String>,
    pub override_id: Option<String>,
    pub source_refs: Vec<SourceRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct StationMappingReport {
    pub records: Vec<StationMappingRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectedCityCandidateResolution {
    DemotedToParentCity,
    UnresolvedStationOnly,
    UnresolvedReferenceGap,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedCityCandidateRecord {
    pub cluster_key: String,
    pub display_name: String,
    pub country_code: String,
    pub station_count: usize,
    pub eligibility: String,
    pub resolution: RejectedCityCandidateResolution,
    pub derived_parent_key: Option<String>,
    pub parent_cluster_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RejectedCityCandidateReport {
    pub records: Vec<RejectedCityCandidateRecord>,
}

#[derive(Clone, Debug)]
struct ReferenceStation {
    raw_id: String,
    display_name: String,
    code_insee: Option<String>,
    location: GeoPoint,
    uic_codes: Vec<String>,
}

#[derive(Clone, Debug)]
struct GtfsStationArea {
    station_key: String,
    display_name: String,
    location: GeoPoint,
    uic_code: Option<String>,
}

#[derive(Clone, Debug)]
struct PendingStation {
    station_id: StationId,
    station_key: String,
    cluster_key: String,
    display_name: String,
    location: GeoPoint,
    uic_code: Option<String>,
    source_refs: Vec<SourceRef>,
    confidence: u8,
    mapping_strategy: StationMappingStrategy,
    matched_reference_id: Option<String>,
    matched_reference_name: Option<String>,
    override_id: Option<String>,
}

#[derive(Clone, Debug)]
struct CityCluster {
    code_insee: Option<String>,
    country_code: String,
    manual_city_id: Option<CityId>,
    station_keys: Vec<String>,
    station_ids: Vec<StationId>,
    display_names: Vec<String>,
    aliases: HashSet<String>,
    lat_sum: f64,
    lon_sum: f64,
    count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum CityEligibility {
    Eligible,
    StationOnlyFeedStopLabel,
    UrbanInterchangeOrHub { parent_key: Option<String> },
    RouteLikeLocalStop { parent_key: Option<String> },
}

#[derive(Clone, Debug, Default)]
struct CityEligibilityResolution {
    remap: HashMap<String, String>,
    rename_display_name: HashMap<String, String>,
    report: RejectedCityCandidateReport,
}

#[derive(Clone, Debug)]
struct StopVisit {
    station_key: String,
    city_id: CityId,
    departure_seconds: u32,
    stop_sequence: u32,
    location: GeoPoint,
}

#[derive(Clone, Debug)]
struct EdgeAccumulator {
    duration_min: u32,
    source_confidence: u8,
    provenance: Vec<String>,
    geometry_points: Vec<GeoPoint>,
    geometry_source: EdgeGeometrySource,
}

#[derive(Clone, Debug)]
struct OverrideBinding {
    override_id: String,
    target_city_id: CityId,
}

#[derive(Deserialize)]
struct GtfsStopRow {
    stop_id: String,
    stop_name: String,
    stop_lat: f64,
    stop_lon: f64,
    #[serde(default)]
    location_type: Option<u8>,
    #[serde(default)]
    parent_station: Option<String>,
}

#[derive(Deserialize)]
struct GtfsRouteRow {
    route_id: String,
    route_type: i16,
}

#[derive(Deserialize)]
struct GtfsTripRow {
    route_id: String,
    trip_id: String,
    #[serde(default)]
    shape_id: Option<String>,
}

#[derive(Deserialize)]
struct GtfsStopTimeRow {
    trip_id: String,
    arrival_time: String,
    departure_time: String,
    stop_id: String,
    stop_sequence: u32,
}

#[derive(Deserialize)]
struct GtfsShapeRow {
    shape_id: String,
    shape_pt_lat: f64,
    shape_pt_lon: f64,
    shape_pt_sequence: u32,
}

#[derive(Clone, Debug)]
struct TripDescriptor {
    route_id: String,
    shape_id: Option<String>,
}

#[allow(clippy::too_many_arguments)] // Public API re-exported from aetrain-normalize.
pub fn build_sncf_dataset(
    gtfs_path: &Path,
    stations_csv_path: &Path,
    rail_geometry_path: Option<&Path>,
    gtfs_source_id: &str,
    station_reference_source_id: &str,
    rail_geometry_source_id: Option<&str>,
    dataset_version: &str,
    generated_at: &str,
    source_snapshots: Vec<SourceSnapshot>,
    overrides: &ManualOverrideRegistry,
) -> Result<SncfBuildOutput> {
    let station_references = load_station_references(stations_csv_path)?;
    let (gtfs_stations, stop_to_station_key) = load_gtfs_stations(gtfs_path)?;
    let trip_descriptors = load_trip_descriptors_from_gtfs(gtfs_path, gtfs_source_id)?;
    let shapes_by_id = load_gtfs_shapes_from_gtfs(gtfs_path)?;
    let rail_geometry_network = rail_geometry_path
        .map(RailGeometryNetwork::load_sncf_rfn_geojson)
        .transpose()?;
    let used_station_keys =
        collect_used_station_keys(gtfs_path, &trip_descriptors, &stop_to_station_key)?;
    let gtfs_stations = gtfs_stations
        .into_iter()
        .filter(|station| used_station_keys.contains(&station.station_key))
        .collect::<Vec<_>>();
    let station_locations = gtfs_stations
        .iter()
        .map(|station| (station.station_key.clone(), station.location))
        .collect::<HashMap<_, _>>();

    let mut issues = Vec::new();
    let (
        cities,
        stations,
        station_mappings,
        rejected_city_candidates,
        aliases,
        station_key_to_city,
        station_key_confidence,
        matched_station_count,
        unmatched_station_count,
    ) = normalize_stations(
        &gtfs_stations,
        &station_references,
        gtfs_source_id,
        station_reference_source_id,
        overrides,
        &mut issues,
    )?;

    let (edges, edge_geometries) = build_city_edges(
        BuildCityEdgesInputs {
            gtfs_path,
            gtfs_source_id,
            trip_descriptors: &trip_descriptors,
            shapes_by_id: &shapes_by_id,
            rail_geometry_network: rail_geometry_network.as_ref(),
            rail_geometry_source_id,
            stop_to_station_key: &stop_to_station_key,
            station_locations: &station_locations,
            station_key_to_city: &station_key_to_city,
            station_key_confidence: &station_key_confidence,
        },
        &mut issues,
    )?;
    let duplicates =
        detect_duplicate_cities(&cities, generated_at, DEFAULT_DUPLICATE_DISTANCE_METERS);

    let meta = DatasetMeta {
        schema_version: aetrain_domain::DATASET_SCHEMA_VERSION,
        dataset_version: dataset_version.to_string(),
        generated_at: generated_at.to_string(),
        source_snapshots,
        attribution_path: "attribution.json".to_string(),
    };

    let summary = SncfBuildSummary {
        station_reference_count: station_references.len(),
        gtfs_station_count: gtfs_stations.len(),
        matched_station_count,
        unmatched_station_count,
        city_count: cities.len(),
        station_count: stations.len(),
        edge_count: edges.len(),
        duplicate_count: duplicates.candidates.len(),
        issue_count: issues.len(),
    };

    Ok(SncfBuildOutput {
        meta,
        cities,
        stations,
        station_mappings,
        edges,
        edge_geometries,
        rejected_city_candidates,
        aliases,
        duplicates,
        issues,
        summary,
    })
}

pub fn bundle_from_output(output: &SncfBuildOutput) -> DatasetBundle {
    DatasetBundle {
        meta: output.meta.clone(),
        cities: output.cities.clone(),
        stations: output.stations.clone(),
        edges: output.edges.clone(),
        aliases: output.aliases.clone(),
    }
}

pub fn build_gtfs_basic_dataset(
    gtfs_path: &Path,
    gtfs_source_id: &str,
    country_code: &str,
    dataset_version: &str,
    generated_at: &str,
    source_snapshots: Vec<SourceSnapshot>,
    overrides: &ManualOverrideRegistry,
) -> Result<BasicGtfsBuildOutput> {
    let (gtfs_stations, stop_to_station_key) = load_gtfs_stations(gtfs_path)?;
    let trip_descriptors = load_trip_descriptors_from_gtfs(gtfs_path, gtfs_source_id)?;
    let shapes_by_id = load_gtfs_shapes_from_gtfs(gtfs_path)?;
    let used_station_keys =
        collect_used_station_keys(gtfs_path, &trip_descriptors, &stop_to_station_key)?;
    let gtfs_stations = gtfs_stations
        .into_iter()
        .filter(|station| used_station_keys.contains(&station.station_key))
        .collect::<Vec<_>>();
    let station_locations = gtfs_stations
        .iter()
        .map(|station| (station.station_key.clone(), station.location))
        .collect::<HashMap<_, _>>();

    let mut issues = Vec::new();
    let (
        cities,
        stations,
        station_mappings,
        rejected_city_candidates,
        aliases,
        station_key_to_city,
        station_key_confidence,
    ) = normalize_gtfs_only_stations(
        &gtfs_stations,
        gtfs_source_id,
        country_code,
        overrides,
        &mut issues,
    )?;
    let (edges, edge_geometries) = build_city_edges(
        BuildCityEdgesInputs {
            gtfs_path,
            gtfs_source_id,
            trip_descriptors: &trip_descriptors,
            shapes_by_id: &shapes_by_id,
            rail_geometry_network: None,
            rail_geometry_source_id: None,
            stop_to_station_key: &stop_to_station_key,
            station_locations: &station_locations,
            station_key_to_city: &station_key_to_city,
            station_key_confidence: &station_key_confidence,
        },
        &mut issues,
    )?;
    let duplicates =
        detect_duplicate_cities(&cities, generated_at, DEFAULT_DUPLICATE_DISTANCE_METERS);

    let meta = DatasetMeta {
        schema_version: aetrain_domain::DATASET_SCHEMA_VERSION,
        dataset_version: dataset_version.to_string(),
        generated_at: generated_at.to_string(),
        source_snapshots,
        attribution_path: "attribution.json".to_string(),
    };

    let summary = BasicGtfsBuildSummary {
        gtfs_station_count: gtfs_stations.len(),
        city_count: cities.len(),
        station_count: stations.len(),
        edge_count: edges.len(),
        duplicate_count: duplicates.candidates.len(),
        issue_count: issues.len(),
    };

    Ok(BasicGtfsBuildOutput {
        meta,
        cities,
        stations,
        station_mappings,
        edges,
        edge_geometries,
        rejected_city_candidates,
        aliases,
        duplicates,
        issues,
        summary,
    })
}

pub fn bundle_from_basic_output(output: &BasicGtfsBuildOutput) -> DatasetBundle {
    DatasetBundle {
        meta: output.meta.clone(),
        cities: output.cities.clone(),
        stations: output.stations.clone(),
        edges: output.edges.clone(),
        aliases: output.aliases.clone(),
    }
}

fn load_station_references(path: &Path) -> Result<Vec<ReferenceStation>> {
    let mut reader = ReaderBuilder::new()
        .flexible(true)
        .trim(Trim::All)
        .from_path(path)
        .with_context(|| format!("failed to open {}", path.display()))?;
    let headers = reader
        .headers()
        .context("failed to read station reference headers")?
        .iter()
        .map(normalize_header)
        .collect::<Vec<_>>();

    let index_of = |name: &str| {
        headers
            .iter()
            .position(|header| header == name)
            .with_context(|| format!("missing {name} column in {}", path.display()))
    };

    let name_idx = index_of("nom")?;
    let position_idx = index_of("position_geographique")?;
    let code_insee_idx = index_of("codeinsee")?;
    let codes_uic_idx = index_of("codes_uic")?;
    let id_idx = index_of("id")?;

    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.context("failed to read station reference record")?;
        let display_name = record.get(name_idx).unwrap_or("").trim();
        let position = record.get(position_idx).unwrap_or("").trim();
        if display_name.is_empty() || position.is_empty() {
            continue;
        }

        let Some(location) = parse_lat_lon_pair(position) else {
            continue;
        };
        rows.push(ReferenceStation {
            raw_id: record.get(id_idx).unwrap_or("").trim().to_string(),
            display_name: display_name.to_string(),
            code_insee: non_empty(record.get(code_insee_idx)),
            location,
            uic_codes: extract_digit_sequences(record.get(codes_uic_idx).unwrap_or("")),
        });
    }

    Ok(rows)
}

fn load_gtfs_stations(path: &Path) -> Result<(Vec<GtfsStationArea>, HashMap<String, String>)> {
    let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut archive = ZipArchive::new(file).context("failed to open GTFS archive")?;
    let stops_entry = resolve_gtfs_archive_member_name(&mut archive, "stops.txt")
        .context("missing stops.txt in GTFS archive")?;
    let stops = archive
        .by_name(&stops_entry)
        .context("missing stops.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(stops);

    let mut stop_to_station_key = HashMap::new();
    let mut areas = BTreeMap::<String, GtfsStationArea>::new();

    for row in reader.deserialize::<GtfsStopRow>() {
        let row = row.context("failed to parse GTFS stop")?;
        let location_type = row.location_type.unwrap_or(0);
        let stop_id = row.stop_id.trim().to_string();
        let station_key = if location_type == 1 {
            stop_id.clone()
        } else {
            row.parent_station
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(stop_id.as_str())
                .to_string()
        };
        stop_to_station_key.insert(stop_id.clone(), station_key.clone());

        let display_name = row.stop_name.trim().to_string();
        if is_placeholder_station_name(&display_name) {
            continue;
        }

        let candidate = GtfsStationArea {
            station_key: station_key.clone(),
            display_name,
            location: GeoPoint {
                lat: row.stop_lat,
                lon: row.stop_lon,
            },
            uic_code: extract_digit_sequences(&stop_id).into_iter().next(),
        };

        areas.entry(station_key).or_insert(candidate);
    }

    Ok((areas.into_values().collect(), stop_to_station_key))
}

type NormalizeStationsResult = (
    Vec<City>,
    Vec<Station>,
    StationMappingReport,
    RejectedCityCandidateReport,
    Vec<AliasRecord>,
    HashMap<String, CityId>,
    HashMap<String, u8>,
    usize,
    usize,
);

fn normalize_stations(
    gtfs_stations: &[GtfsStationArea],
    references: &[ReferenceStation],
    gtfs_source_id: &str,
    station_reference_source_id: &str,
    overrides: &ManualOverrideRegistry,
    issues: &mut Vec<NormalizationIssue>,
) -> Result<NormalizeStationsResult> {
    let override_lookup = build_override_lookup(overrides)?;
    let mut applied_override_ids = HashSet::<String>::new();
    let mut reference_by_uic = HashMap::<String, Vec<&ReferenceStation>>::new();
    let mut reference_by_name = HashMap::<String, Vec<&ReferenceStation>>::new();
    for reference in references {
        for uic in &reference.uic_codes {
            reference_by_uic
                .entry(uic.clone())
                .or_default()
                .push(reference);
        }
        reference_by_name
            .entry(normalize_name(&reference.display_name))
            .or_default()
            .push(reference);
    }

    let mut pending_stations = Vec::new();
    let mut station_key_confidence = HashMap::new();
    let mut clusters = BTreeMap::<String, CityCluster>::new();
    let mut matched_station_count = 0usize;

    for station in gtfs_stations {
        let normalized_name = normalize_name(&station.display_name);
        let reference_match_mode = if station
            .uic_code
            .as_ref()
            .and_then(|uic| reference_by_uic.get(uic))
            .is_some()
        {
            Some(StationMappingStrategy::ReferenceUic)
        } else {
            None
        };
        let direct_match = station
            .uic_code
            .as_ref()
            .and_then(|uic| reference_by_uic.get(uic))
            .and_then(|matches| choose_nearest_reference(matches, station.location));

        let name_match = if direct_match.is_none() {
            reference_by_name
                .get(&normalized_name)
                .and_then(|matches| choose_name_match(matches, station.location))
        } else {
            None
        };

        let matched_reference = direct_match.or(name_match);
        let mut source_refs = vec![SourceRef {
            source_id: gtfs_source_id.to_string(),
            raw_id: station.station_key.clone(),
        }];
        let code_insee = matched_reference.and_then(|reference| {
            reference
                .code_insee
                .as_deref()
                .map(normalize_french_code_insee)
        });
        if let Some(reference) = matched_reference {
            source_refs.push(SourceRef {
                source_id: station_reference_source_id.to_string(),
                raw_id: reference.raw_id.clone(),
            });
        }

        let override_binding =
            resolve_station_override(&source_refs, &override_lookup, &station.station_key)?;
        let override_id = override_binding
            .as_ref()
            .map(|binding| binding.override_id.clone());
        if let Some(binding) = &override_binding {
            applied_override_ids.insert(binding.override_id.clone());
        }

        let (cluster_key, country_code, confidence, manual_city_id, mapping_strategy) =
            if let Some(binding) = override_binding {
                (
                    format!("override-city-{}", binding.target_city_id),
                    "FR".to_string(),
                    100,
                    Some(binding.target_city_id),
                    StationMappingStrategy::ManualOverride,
                )
            } else if let Some(reference) = matched_reference {
                matched_station_count += 1;
                let normalized_code_insee = reference
                    .code_insee
                    .as_deref()
                    .map(normalize_french_code_insee);
                (
                    format!(
                        "fr-insee-{}",
                        normalized_code_insee.as_deref().unwrap_or("unknown")
                    ),
                    "FR".to_string(),
                    if direct_match.is_some() { 100 } else { 80 },
                    None,
                    reference_match_mode.unwrap_or(StationMappingStrategy::ReferenceName),
                )
            } else {
                issues.push(NormalizationIssue {
                    severity: IssueSeverity::Warning,
                    source_id: station_reference_source_id.to_string(),
                    entity_ref: station.station_key.clone(),
                    message: format!(
                        "no station-reference match for GTFS stop area {}",
                        station.display_name
                    ),
                });
                (
                    fallback_cluster_key(station),
                    "ZZ".to_string(),
                    50,
                    None,
                    StationMappingStrategy::FallbackReferenceGap,
                )
            };

        let station_id = StationId::new(stable_station_id(gtfs_source_id, station))
            .context("failed to build stable station id")?;

        station_key_confidence.insert(station.station_key.clone(), confidence);
        pending_stations.push(PendingStation {
            station_id: station_id.clone(),
            station_key: station.station_key.clone(),
            cluster_key: cluster_key.clone(),
            display_name: station.display_name.clone(),
            location: station.location,
            uic_code: station.uic_code.clone(),
            source_refs,
            confidence,
            mapping_strategy,
            matched_reference_id: matched_reference.map(|reference| reference.raw_id.clone()),
            matched_reference_name: matched_reference
                .map(|reference| reference.display_name.clone()),
            override_id,
        });

        let cluster = clusters.entry(cluster_key).or_insert_with(|| CityCluster {
            code_insee: code_insee.clone(),
            country_code,
            manual_city_id: manual_city_id.clone(),
            station_keys: Vec::new(),
            station_ids: Vec::new(),
            display_names: Vec::new(),
            aliases: HashSet::new(),
            lat_sum: 0.0,
            lon_sum: 0.0,
            count: 0,
        });
        if cluster.code_insee.is_none() {
            cluster.code_insee = code_insee;
        }
        if cluster.manual_city_id.is_none() {
            cluster.manual_city_id = manual_city_id;
        }
        cluster.station_keys.push(station.station_key.clone());
        cluster.station_ids.push(station_id);
        cluster.display_names.push(station.display_name.clone());
        cluster.aliases.insert(station.display_name.clone());
        cluster.lat_sum += station.location.lat;
        cluster.lon_sum += station.location.lon;
        cluster.count += 1;
    }

    let eligibility_resolution =
        resolve_gtfs_basic_ineligible_clusters(&clusters, gtfs_source_id, issues);
    if !eligibility_resolution.remap.is_empty() {
        for station in &mut pending_stations {
            if let Some(parent_cluster_key) = eligibility_resolution.remap.get(&station.cluster_key)
            {
                station.cluster_key = parent_cluster_key.clone();
            }
        }

        let mut merged_children = HashSet::new();
        for (child_cluster_key, parent_cluster_key) in &eligibility_resolution.remap {
            if child_cluster_key == parent_cluster_key {
                continue;
            }
            let Some(child_cluster) = clusters.get(child_cluster_key).cloned() else {
                continue;
            };
            let parent_cluster = clusters
                .get_mut(parent_cluster_key)
                .expect("demoted GTFS-basic parent cluster should exist");
            parent_cluster
                .station_keys
                .extend(child_cluster.station_keys);
            parent_cluster.station_ids.extend(child_cluster.station_ids);
            parent_cluster
                .display_names
                .extend(child_cluster.display_names);
            parent_cluster.aliases.extend(child_cluster.aliases);
            parent_cluster.lat_sum += child_cluster.lat_sum;
            parent_cluster.lon_sum += child_cluster.lon_sum;
            parent_cluster.count += child_cluster.count;
            merged_children.insert(child_cluster_key.clone());
        }
        for child_cluster_key in merged_children {
            clusters.remove(&child_cluster_key);
        }
    }

    for (cluster_key, display_name) in &eligibility_resolution.rename_display_name {
        let Some(cluster) = clusters.get_mut(cluster_key) else {
            continue;
        };
        for existing_name in &cluster.display_names {
            cluster.aliases.insert(existing_name.clone());
        }
        cluster.display_names = vec![display_name.clone()];
        cluster.aliases.insert(display_name.clone());
    }

    let mut cities = Vec::new();
    let mut city_id_by_cluster = HashMap::new();
    let mut station_key_to_city = HashMap::new();
    let mut aliases = Vec::new();
    let mut alias_keys = HashSet::new();

    for (cluster_key, cluster) in &clusters {
        let display_name = derive_city_display_name(&cluster.display_names);
        let slug = slugify(&display_name);
        let city_id = if let Some(manual_city_id) = &cluster.manual_city_id {
            manual_city_id.clone()
        } else {
            CityId::new(stable_city_id(
                cluster_key,
                &slug,
                cluster.code_insee.as_deref(),
            ))
            .context("failed to build stable city id")?
        };
        let location = GeoPoint {
            lat: cluster.lat_sum / cluster.count as f64,
            lon: cluster.lon_sum / cluster.count as f64,
        };

        let mut station_ids = cluster.station_ids.clone();
        station_ids.sort();
        station_ids.dedup();

        let mut city_aliases = cluster
            .aliases
            .iter()
            .filter(|alias| normalize_name(alias) != normalize_name(&display_name))
            .cloned()
            .collect::<Vec<_>>();
        city_aliases.sort();

        for alias in &city_aliases {
            let alias_key = normalize_name(alias);
            if alias_keys.insert((alias_key.clone(), city_id.clone())) {
                aliases.push(AliasRecord {
                    alias: alias_key,
                    city_id: city_id.clone(),
                });
            }
        }

        if alias_keys.insert((normalize_name(&display_name), city_id.clone())) {
            aliases.push(AliasRecord {
                alias: normalize_name(&display_name),
                city_id: city_id.clone(),
            });
        }

        for station_key in &cluster.station_keys {
            station_key_to_city.insert(station_key.clone(), city_id.clone());
        }
        city_id_by_cluster.insert(cluster_key.clone(), city_id.clone());
        cities.push(City {
            city_id,
            slug,
            display_name,
            country_code: cluster.country_code.clone(),
            location,
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids,
            aliases: city_aliases,
        });
    }

    cities.sort_by(|left, right| left.city_id.cmp(&right.city_id));
    aliases.sort_by(|left, right| {
        left.alias
            .cmp(&right.alias)
            .then_with(|| left.city_id.cmp(&right.city_id))
    });

    let mut station_mappings = Vec::<StationMappingRecord>::new();
    let mut stations = pending_stations
        .into_iter()
        .map(|station| {
            let city_id = city_id_by_cluster
                .get(&station.cluster_key)
                .expect("cluster should resolve to a city")
                .clone();
            station_mappings.push(StationMappingRecord {
                station_key: station.station_key.clone(),
                station_id: station.station_id.clone(),
                city_id: city_id.clone(),
                city_cluster_key: station.cluster_key.clone(),
                station_display_name: station.display_name.clone(),
                mapping_strategy: station.mapping_strategy.clone(),
                confidence: station.confidence,
                matched_reference_id: station.matched_reference_id.clone(),
                matched_reference_name: station.matched_reference_name.clone(),
                override_id: station.override_id.clone(),
                source_refs: station.source_refs.clone(),
            });
            Station {
                station_id: station.station_id,
                city_id,
                display_name: station.display_name,
                location: station.location,
                uic_code: station.uic_code,
                source_refs: station.source_refs,
            }
        })
        .collect::<Vec<_>>();
    stations.sort_by(|left, right| left.station_id.cmp(&right.station_id));
    station_mappings.sort_by(|left, right| left.station_id.cmp(&right.station_id));

    for override_entry in &overrides.city_overrides {
        if !applied_override_ids.contains(&override_entry.id) {
            issues.push(NormalizationIssue {
                severity: IssueSeverity::Warning,
                source_id: "manual-overrides".to_string(),
                entity_ref: override_entry.id.clone(),
                message: format!(
                    "manual override {} did not match any SNCF station source refs",
                    override_entry.id
                ),
            });
        }
    }

    let unmatched_station_count = gtfs_stations.len().saturating_sub(matched_station_count);
    Ok((
        cities,
        stations,
        StationMappingReport {
            records: station_mappings,
        },
        eligibility_resolution.report,
        aliases,
        station_key_to_city,
        station_key_confidence,
        matched_station_count,
        unmatched_station_count,
    ))
}

type NormalizeGtfsOnlyStationsResult = (
    Vec<City>,
    Vec<Station>,
    StationMappingReport,
    RejectedCityCandidateReport,
    Vec<AliasRecord>,
    HashMap<String, CityId>,
    HashMap<String, u8>,
);

fn normalize_gtfs_only_stations(
    gtfs_stations: &[GtfsStationArea],
    gtfs_source_id: &str,
    country_code: &str,
    overrides: &ManualOverrideRegistry,
    issues: &mut Vec<NormalizationIssue>,
) -> Result<NormalizeGtfsOnlyStationsResult> {
    let override_lookup = build_override_lookup(overrides)?;
    let mut applied_override_ids = HashSet::<String>::new();
    let stem_by_station_key = derive_gtfs_basic_city_stems(gtfs_stations);
    let cluster_keys =
        assign_gtfs_basic_cluster_keys(gtfs_stations, &stem_by_station_key, country_code);

    let mut pending_stations = Vec::new();
    let mut station_key_confidence = HashMap::new();
    let mut clusters = BTreeMap::<String, CityCluster>::new();

    for station in gtfs_stations {
        let source_refs = vec![SourceRef {
            source_id: gtfs_source_id.to_string(),
            raw_id: station.station_key.clone(),
        }];
        let override_binding =
            resolve_station_override(&source_refs, &override_lookup, &station.station_key)?;
        let override_id = override_binding
            .as_ref()
            .map(|binding| binding.override_id.clone());
        if let Some(binding) = &override_binding {
            applied_override_ids.insert(binding.override_id.clone());
        }

        let (cluster_key, confidence, manual_city_id) = if let Some(binding) = override_binding {
            (
                format!("override-city-{}", binding.target_city_id),
                100,
                Some(binding.target_city_id),
            )
        } else {
            let cluster_key = cluster_keys
                .get(&station.station_key)
                .cloned()
                .unwrap_or_else(|| fallback_cluster_key(station));
            (cluster_key, 60, None)
        };

        let station_id = StationId::new(stable_station_id(gtfs_source_id, station))
            .context("failed to build stable station id")?;
        station_key_confidence.insert(station.station_key.clone(), confidence);
        pending_stations.push(PendingStation {
            station_id: station_id.clone(),
            station_key: station.station_key.clone(),
            cluster_key: cluster_key.clone(),
            display_name: station.display_name.clone(),
            location: station.location,
            uic_code: station.uic_code.clone(),
            source_refs,
            confidence,
            mapping_strategy: if manual_city_id.is_some() {
                StationMappingStrategy::ManualOverride
            } else {
                StationMappingStrategy::GtfsStemCluster
            },
            matched_reference_id: None,
            matched_reference_name: None,
            override_id,
        });

        let cluster = clusters.entry(cluster_key).or_insert_with(|| CityCluster {
            code_insee: None,
            country_code: country_code.to_string(),
            manual_city_id: manual_city_id.clone(),
            station_keys: Vec::new(),
            station_ids: Vec::new(),
            display_names: Vec::new(),
            aliases: HashSet::new(),
            lat_sum: 0.0,
            lon_sum: 0.0,
            count: 0,
        });
        if cluster.manual_city_id.is_none() {
            cluster.manual_city_id = manual_city_id;
        }
        cluster.station_keys.push(station.station_key.clone());
        cluster.station_ids.push(station_id);
        cluster.display_names.push(station.display_name.clone());
        cluster.aliases.insert(station.display_name.clone());
        cluster.lat_sum += station.location.lat;
        cluster.lon_sum += station.location.lon;
        cluster.count += 1;
    }

    let eligibility_resolution =
        resolve_gtfs_basic_ineligible_clusters(&clusters, gtfs_source_id, issues);
    if !eligibility_resolution.remap.is_empty() {
        for station in &mut pending_stations {
            if let Some(parent_cluster_key) = eligibility_resolution.remap.get(&station.cluster_key)
            {
                station.cluster_key = parent_cluster_key.clone();
            }
        }

        let mut merged_children = HashSet::new();
        for (child_cluster_key, parent_cluster_key) in &eligibility_resolution.remap {
            if child_cluster_key == parent_cluster_key {
                continue;
            }
            let Some(child_cluster) = clusters.get(child_cluster_key).cloned() else {
                continue;
            };
            let parent_cluster = clusters
                .get_mut(parent_cluster_key)
                .expect("demoted GTFS-basic parent cluster should exist");
            parent_cluster
                .station_keys
                .extend(child_cluster.station_keys);
            parent_cluster.station_ids.extend(child_cluster.station_ids);
            parent_cluster
                .display_names
                .extend(child_cluster.display_names);
            parent_cluster.aliases.extend(child_cluster.aliases);
            parent_cluster.lat_sum += child_cluster.lat_sum;
            parent_cluster.lon_sum += child_cluster.lon_sum;
            parent_cluster.count += child_cluster.count;
            merged_children.insert(child_cluster_key.clone());
        }
        for child_cluster_key in merged_children {
            clusters.remove(&child_cluster_key);
        }
    }

    for (cluster_key, display_name) in &eligibility_resolution.rename_display_name {
        let Some(cluster) = clusters.get_mut(cluster_key) else {
            continue;
        };
        for existing_name in &cluster.display_names {
            cluster.aliases.insert(existing_name.clone());
        }
        cluster.display_names = vec![display_name.clone()];
        cluster.aliases.insert(display_name.clone());
    }

    let mut cities = Vec::new();
    let mut city_id_by_cluster = HashMap::new();
    let mut station_key_to_city = HashMap::new();
    let mut aliases = Vec::new();
    let mut alias_keys = HashSet::new();

    for (cluster_key, cluster) in &clusters {
        let display_name = derive_city_display_name(&cluster.display_names);
        let slug = slugify(&display_name);
        let city_id = if let Some(manual_city_id) = &cluster.manual_city_id {
            manual_city_id.clone()
        } else {
            CityId::new(stable_city_id_with_country(
                cluster_key,
                &slug,
                &cluster.country_code,
                cluster.code_insee.as_deref(),
            ))
            .context("failed to build stable city id")?
        };
        let location = GeoPoint {
            lat: cluster.lat_sum / cluster.count as f64,
            lon: cluster.lon_sum / cluster.count as f64,
        };

        let mut station_ids = cluster.station_ids.clone();
        station_ids.sort();
        station_ids.dedup();

        let mut city_aliases = cluster
            .aliases
            .iter()
            .filter(|alias| normalize_name(alias) != normalize_name(&display_name))
            .cloned()
            .collect::<Vec<_>>();
        city_aliases.sort();

        for alias in &city_aliases {
            let alias_key = normalize_name(alias);
            if alias_keys.insert((alias_key.clone(), city_id.clone())) {
                aliases.push(AliasRecord {
                    alias: alias_key,
                    city_id: city_id.clone(),
                });
            }
        }

        if alias_keys.insert((normalize_name(&display_name), city_id.clone())) {
            aliases.push(AliasRecord {
                alias: normalize_name(&display_name),
                city_id: city_id.clone(),
            });
        }

        for station_key in &cluster.station_keys {
            station_key_to_city.insert(station_key.clone(), city_id.clone());
        }
        city_id_by_cluster.insert(cluster_key.clone(), city_id.clone());
        cities.push(City {
            city_id,
            slug,
            display_name,
            country_code: cluster.country_code.clone(),
            location,
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids,
            aliases: city_aliases,
        });
    }

    cities.sort_by(|left, right| left.city_id.cmp(&right.city_id));
    aliases.sort_by(|left, right| {
        left.alias
            .cmp(&right.alias)
            .then_with(|| left.city_id.cmp(&right.city_id))
    });

    let mut station_mappings = Vec::<StationMappingRecord>::new();
    let mut stations = pending_stations
        .into_iter()
        .map(|station| {
            let city_id = city_id_by_cluster
                .get(&station.cluster_key)
                .expect("cluster should resolve to a city")
                .clone();
            station_mappings.push(StationMappingRecord {
                station_key: station.station_key.clone(),
                station_id: station.station_id.clone(),
                city_id: city_id.clone(),
                city_cluster_key: station.cluster_key.clone(),
                station_display_name: station.display_name.clone(),
                mapping_strategy: station.mapping_strategy.clone(),
                confidence: station.confidence,
                matched_reference_id: None,
                matched_reference_name: None,
                override_id: station.override_id.clone(),
                source_refs: station.source_refs.clone(),
            });
            Station {
                station_id: station.station_id,
                city_id,
                display_name: station.display_name,
                location: station.location,
                uic_code: station.uic_code,
                source_refs: station.source_refs,
            }
        })
        .collect::<Vec<_>>();
    stations.sort_by(|left, right| left.station_id.cmp(&right.station_id));
    station_mappings.sort_by(|left, right| left.station_id.cmp(&right.station_id));

    for override_entry in &overrides.city_overrides {
        if !applied_override_ids.contains(&override_entry.id) {
            issues.push(NormalizationIssue {
                severity: IssueSeverity::Warning,
                source_id: "manual-overrides".to_string(),
                entity_ref: override_entry.id.clone(),
                message: format!(
                    "manual override {} did not match any GTFS-basic station source refs",
                    override_entry.id
                ),
            });
        }
    }

    Ok((
        cities,
        stations,
        StationMappingReport {
            records: station_mappings,
        },
        eligibility_resolution.report,
        aliases,
        station_key_to_city,
        station_key_confidence,
    ))
}

struct BuildCityEdgesInputs<'a> {
    gtfs_path: &'a Path,
    gtfs_source_id: &'a str,
    trip_descriptors: &'a HashMap<String, TripDescriptor>,
    shapes_by_id: &'a HashMap<String, Vec<GeoPoint>>,
    rail_geometry_network: Option<&'a RailGeometryNetwork>,
    rail_geometry_source_id: Option<&'a str>,
    stop_to_station_key: &'a HashMap<String, String>,
    station_locations: &'a HashMap<String, GeoPoint>,
    station_key_to_city: &'a HashMap<String, CityId>,
    station_key_confidence: &'a HashMap<String, u8>,
}

fn build_city_edges(
    inputs: BuildCityEdgesInputs<'_>,
    issues: &mut Vec<NormalizationIssue>,
) -> Result<(Vec<TravelEdge>, EdgeGeometryArtifact)> {
    let BuildCityEdgesInputs {
        gtfs_path,
        gtfs_source_id,
        trip_descriptors,
        shapes_by_id,
        rail_geometry_network,
        rail_geometry_source_id,
        stop_to_station_key,
        station_locations,
        station_key_to_city,
        station_key_confidence,
    } = inputs;
    let file =
        File::open(gtfs_path).with_context(|| format!("failed to open {}", gtfs_path.display()))?;
    let mut archive = ZipArchive::new(file).context("failed to open GTFS archive")?;

    let stop_times_entry = resolve_gtfs_archive_member_name(&mut archive, "stop_times.txt")
        .context("missing stop_times.txt in GTFS archive")?;
    let stop_times = archive
        .by_name(&stop_times_entry)
        .context("missing stop_times.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(stop_times);
    let mut edge_map = BTreeMap::<(CityId, CityId), EdgeAccumulator>::new();
    let mut previous_by_trip = HashMap::<String, StopVisit>::new();
    let mut geometry_cache = HashMap::<(String, String), Option<Vec<GeoPoint>>>::new();
    let station_snap_nodes = rail_geometry_network.map(|network| {
        station_locations
            .iter()
            .map(|(station_key, location)| (station_key.clone(), network.snap_point(*location)))
            .collect::<HashMap<_, _>>()
    });
    let mut missing_stop_mappings = 0usize;

    for row in reader.deserialize::<GtfsStopTimeRow>() {
        let row = row.context("failed to parse GTFS stop time")?;
        let Some(trip_descriptor) = trip_descriptors.get(&row.trip_id) else {
            continue;
        };
        let Some(station_key) = stop_to_station_key.get(&row.stop_id) else {
            missing_stop_mappings += 1;
            continue;
        };
        let Some(location) = station_locations.get(station_key).copied() else {
            missing_stop_mappings += 1;
            continue;
        };
        let Some(city_id) = station_key_to_city.get(station_key) else {
            missing_stop_mappings += 1;
            continue;
        };

        let arrival_seconds = match parse_gtfs_time(&row.arrival_time) {
            Some(value) => value,
            None => continue,
        };
        let departure_seconds = match parse_gtfs_time(&row.departure_time) {
            Some(value) => value,
            None => continue,
        };

        if let Some(previous) = previous_by_trip.insert(
            row.trip_id.clone(),
            StopVisit {
                station_key: station_key.clone(),
                city_id: city_id.clone(),
                departure_seconds,
                stop_sequence: row.stop_sequence,
                location,
            },
        ) {
            if row.stop_sequence <= previous.stop_sequence || previous.city_id == *city_id {
                continue;
            }

            let duration_seconds = arrival_seconds.saturating_sub(previous.departure_seconds);
            if duration_seconds == 0 {
                continue;
            }
            let duration_min = duration_seconds.div_ceil(60);
            let confidence = previous
                .station_key
                .as_str()
                .pipe(|key| station_key_confidence.get(key).copied().unwrap_or(50))
                .min(
                    station_key_confidence
                        .get(station_key)
                        .copied()
                        .unwrap_or(50),
                );
            let mut ctx = EdgeGeometryContext {
                shape_points: trip_descriptor
                    .shape_id
                    .as_deref()
                    .and_then(|shape_id| shapes_by_id.get(shape_id)),
                rail_geometry_network,
                rail_geometry_source_id,
                geometry_cache: &mut geometry_cache,
                station_snap_nodes: station_snap_nodes.as_ref(),
            };
            let (geometry_points, geometry_source, geometry_provenance) = build_edge_geometry(
                previous.location,
                location,
                &previous.station_key,
                station_key,
                &mut ctx,
            );

            let key = (previous.city_id.clone(), city_id.clone());
            let mut provenance = vec![format!("{gtfs_source_id}:{}", trip_descriptor.route_id)];
            provenance.extend(geometry_provenance);
            edge_map
                .entry(key)
                .and_modify(|edge| {
                    if duration_min < edge.duration_min {
                        edge.duration_min = duration_min;
                        edge.provenance = provenance.clone();
                        edge.source_confidence = confidence;
                        edge.geometry_points = geometry_points.clone();
                        edge.geometry_source = geometry_source.clone();
                    }
                })
                .or_insert(EdgeAccumulator {
                    duration_min,
                    source_confidence: confidence,
                    provenance,
                    geometry_points,
                    geometry_source,
                });
        }
    }

    if missing_stop_mappings > 0 {
        issues.push(NormalizationIssue {
            severity: IssueSeverity::Warning,
            source_id: gtfs_source_id.to_string(),
            entity_ref: "stop_times.txt".to_string(),
            message: format!(
                "{missing_stop_mappings} stop_time rows could not be mapped to normalized cities"
            ),
        });
    }

    let mut edges = Vec::<TravelEdge>::new();
    let mut geometries = Vec::<EdgeGeometryRecord>::new();
    for ((from_city_id, to_city_id), edge) in edge_map {
        edges.push(TravelEdge {
            from_city_id: from_city_id.clone(),
            to_city_id: to_city_id.clone(),
            duration_min: edge.duration_min,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Regional,
            change_count_estimate: Some(0),
            source_confidence: edge.source_confidence,
            provenance: edge.provenance.clone(),
        });
        geometries.push(EdgeGeometryRecord {
            from_city_id,
            to_city_id,
            points: edge
                .geometry_points
                .into_iter()
                .map(scale_geo_point_e5)
                .collect::<Result<Vec<_>>>()?,
            source: edge.geometry_source,
            provenance: edge.provenance,
        });
    }

    Ok((edges, EdgeGeometryArtifact { geometries }))
}

struct EdgeGeometryContext<'a> {
    shape_points: Option<&'a Vec<GeoPoint>>,
    rail_geometry_network: Option<&'a RailGeometryNetwork>,
    rail_geometry_source_id: Option<&'a str>,
    geometry_cache: &'a mut HashMap<(String, String), Option<Vec<GeoPoint>>>,
    station_snap_nodes: Option<&'a HashMap<String, Option<usize>>>,
}

fn build_edge_geometry(
    from_location: GeoPoint,
    to_location: GeoPoint,
    from_station_key: &str,
    to_station_key: &str,
    ctx: &mut EdgeGeometryContext<'_>,
) -> (Vec<GeoPoint>, EdgeGeometrySource, Vec<String>) {
    if let Some(shape_points) = ctx.shape_points
        && let Some(points) = extract_shape_segment(shape_points, from_location, to_location)
    {
        return (points, EdgeGeometrySource::GtfsShapeSegment, Vec::new());
    }

    if let Some(rail_geometry_network) = ctx.rail_geometry_network {
        let cache_key = (from_station_key.to_string(), to_station_key.to_string());
        let start_node = ctx
            .station_snap_nodes
            .and_then(|snap_nodes| snap_nodes.get(from_station_key))
            .and_then(|node| *node);
        let end_node = ctx
            .station_snap_nodes
            .and_then(|snap_nodes| snap_nodes.get(to_station_key))
            .and_then(|node| *node);
        let cached = ctx
            .geometry_cache
            .entry(cache_key)
            .or_insert_with(|| match (start_node, end_node) {
                (Some(start_node), Some(end_node)) => rail_geometry_network
                    .route_polyline_between_nodes(from_location, to_location, start_node, end_node),
                _ => rail_geometry_network.route_polyline(from_location, to_location),
            })
            .clone();
        if let Some(points) = cached {
            let mut provenance = Vec::new();
            if let Some(source_id) = ctx.rail_geometry_source_id {
                provenance.push(format!("geometry:{source_id}"));
            }
            return (
                points,
                EdgeGeometrySource::InfrastructureGraphFallback,
                provenance,
            );
        }
    }

    (
        vec![from_location, to_location],
        EdgeGeometrySource::StraightLineFallback,
        Vec::new(),
    )
}

fn extract_shape_segment(
    shape_points: &[GeoPoint],
    from_location: GeoPoint,
    to_location: GeoPoint,
) -> Option<Vec<GeoPoint>> {
    if shape_points.len() < 2 {
        return None;
    }

    let (start_index, start_distance) = nearest_shape_point_index(shape_points, from_location, 0)?;
    let (end_index, end_distance) =
        nearest_shape_point_index(shape_points, to_location, start_index)?;
    if end_index <= start_index
        || start_distance > MAX_SHAPE_STOP_DISTANCE_METERS
        || end_distance > MAX_SHAPE_STOP_DISTANCE_METERS
    {
        return None;
    }

    let mut points = shape_points[start_index..=end_index].to_vec();
    if haversine_meters(points[0], from_location) > SHAPE_ENDPOINT_SNAP_DISTANCE_METERS {
        points.insert(0, from_location);
    } else {
        points[0] = from_location;
    }

    let last_index = points.len() - 1;
    if haversine_meters(points[last_index], to_location) > SHAPE_ENDPOINT_SNAP_DISTANCE_METERS {
        points.push(to_location);
    } else {
        points[last_index] = to_location;
    }

    Some(points)
}

fn nearest_shape_point_index(
    shape_points: &[GeoPoint],
    target: GeoPoint,
    start_index: usize,
) -> Option<(usize, f64)> {
    shape_points
        .iter()
        .enumerate()
        .skip(start_index)
        .map(|(index, point)| (index, haversine_meters(*point, target)))
        .min_by(|left, right| left.1.total_cmp(&right.1))
}

fn scale_geo_point_e5(point: GeoPoint) -> Result<PolylinePointE5> {
    Ok(PolylinePointE5 {
        lat_e5: (point.lat * 100_000.0).round() as i32,
        lon_e5: (point.lon * 100_000.0).round() as i32,
    })
}

fn load_allowed_routes_for_source(
    archive: &mut ZipArchive<File>,
    gtfs_source_id: &str,
) -> Result<HashMap<String, i16>> {
    let routes_entry = resolve_gtfs_archive_member_name(archive, "routes.txt")
        .context("missing routes.txt in GTFS archive")?;
    let routes = archive
        .by_name(&routes_entry)
        .context("missing routes.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(routes);
    let mut allowed = HashMap::new();
    for row in reader.deserialize::<GtfsRouteRow>() {
        let row = row.context("failed to parse GTFS route")?;
        if is_supported_rail_route(&row, gtfs_source_id) {
            allowed.insert(row.route_id, row.route_type);
        }
    }
    Ok(allowed)
}

fn load_trip_descriptors(
    archive: &mut ZipArchive<File>,
    allowed_routes: &HashMap<String, i16>,
) -> Result<HashMap<String, TripDescriptor>> {
    let trips_entry = resolve_gtfs_archive_member_name(archive, "trips.txt")
        .context("missing trips.txt in GTFS archive")?;
    let trips = archive
        .by_name(&trips_entry)
        .context("missing trips.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(trips);
    let mut trip_descriptors = HashMap::new();
    for row in reader.deserialize::<GtfsTripRow>() {
        let row = row.context("failed to parse GTFS trip")?;
        if allowed_routes.contains_key(&row.route_id) {
            trip_descriptors.insert(
                row.trip_id,
                TripDescriptor {
                    route_id: row.route_id,
                    shape_id: row.shape_id.and_then(|shape_id| {
                        let shape_id = shape_id.trim().to_string();
                        if shape_id.is_empty() {
                            None
                        } else {
                            Some(shape_id)
                        }
                    }),
                },
            );
        }
    }
    Ok(trip_descriptors)
}

fn load_trip_descriptors_from_gtfs(
    gtfs_path: &Path,
    gtfs_source_id: &str,
) -> Result<HashMap<String, TripDescriptor>> {
    let file =
        File::open(gtfs_path).with_context(|| format!("failed to open {}", gtfs_path.display()))?;
    let mut archive = ZipArchive::new(file).context("failed to open GTFS archive")?;
    let allowed_routes = load_allowed_routes_for_source(&mut archive, gtfs_source_id)?;
    load_trip_descriptors(&mut archive, &allowed_routes)
}

fn load_gtfs_shapes_from_gtfs(gtfs_path: &Path) -> Result<HashMap<String, Vec<GeoPoint>>> {
    let file =
        File::open(gtfs_path).with_context(|| format!("failed to open {}", gtfs_path.display()))?;
    let mut archive = ZipArchive::new(file).context("failed to open GTFS archive")?;
    let Some(shapes_entry) = resolve_gtfs_archive_member_name(&mut archive, "shapes.txt") else {
        return Ok(HashMap::new());
    };
    let Ok(shapes) = archive.by_name(&shapes_entry) else {
        return Ok(HashMap::new());
    };
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(shapes);
    let mut shapes_by_id = HashMap::<String, Vec<(u32, GeoPoint)>>::new();
    for row in reader.deserialize::<GtfsShapeRow>() {
        let row = row.context("failed to parse GTFS shape row")?;
        shapes_by_id.entry(row.shape_id).or_default().push((
            row.shape_pt_sequence,
            GeoPoint {
                lat: row.shape_pt_lat,
                lon: row.shape_pt_lon,
            },
        ));
    }

    Ok(shapes_by_id
        .into_iter()
        .map(|(shape_id, mut points)| {
            points.sort_by_key(|(sequence, _)| *sequence);
            (
                shape_id,
                points
                    .into_iter()
                    .map(|(_, point)| point)
                    .collect::<Vec<_>>(),
            )
        })
        .collect())
}

fn collect_used_station_keys(
    gtfs_path: &Path,
    trip_descriptors: &HashMap<String, TripDescriptor>,
    stop_to_station_key: &HashMap<String, String>,
) -> Result<HashSet<String>> {
    let file =
        File::open(gtfs_path).with_context(|| format!("failed to open {}", gtfs_path.display()))?;
    let mut archive = ZipArchive::new(file).context("failed to open GTFS archive")?;
    let stop_times_entry = resolve_gtfs_archive_member_name(&mut archive, "stop_times.txt")
        .context("missing stop_times.txt in GTFS archive")?;
    let stop_times = archive
        .by_name(&stop_times_entry)
        .context("missing stop_times.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().trim(Trim::All).from_reader(stop_times);
    let mut station_keys = HashSet::new();

    for row in reader.deserialize::<GtfsStopTimeRow>() {
        let row = row.context("failed to parse GTFS stop time")?;
        if !trip_descriptors.contains_key(&row.trip_id) {
            continue;
        }
        if let Some(station_key) = stop_to_station_key.get(&row.stop_id) {
            station_keys.insert(station_key.clone());
        }
    }

    Ok(station_keys)
}

fn build_override_lookup(
    overrides: &ManualOverrideRegistry,
) -> Result<HashMap<(String, String), OverrideBinding>> {
    let mut lookup = HashMap::<(String, String), OverrideBinding>::new();
    for override_entry in &overrides.city_overrides {
        for source_ref in &override_entry.source_refs {
            let key = (source_ref.source_id.clone(), source_ref.raw_id.clone());
            if let Some(existing) = lookup.get(&key) {
                if existing.target_city_id != override_entry.target_city_id {
                    anyhow::bail!(
                        "override conflict for {}:{} between {} and {}",
                        source_ref.source_id,
                        source_ref.raw_id,
                        existing.override_id,
                        override_entry.id
                    );
                }
                continue;
            }

            lookup.insert(
                key,
                OverrideBinding {
                    override_id: override_entry.id.clone(),
                    target_city_id: override_entry.target_city_id.clone(),
                },
            );
        }
    }
    Ok(lookup)
}

fn resolve_gtfs_archive_member_name(
    archive: &mut ZipArchive<File>,
    logical_name: &str,
) -> Option<String> {
    let suffix = format!("/{logical_name}");
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            continue;
        };
        let entry_name = entry.name().to_string();
        if entry_name == logical_name || entry_name.ends_with(&suffix) {
            return Some(entry_name);
        }
    }
    None
}

fn resolve_station_override(
    source_refs: &[SourceRef],
    override_lookup: &HashMap<(String, String), OverrideBinding>,
    station_key: &str,
) -> Result<Option<OverrideBinding>> {
    let mut resolved = None::<OverrideBinding>;
    for source_ref in source_refs {
        let key = (source_ref.source_id.clone(), source_ref.raw_id.clone());
        let Some(binding) = override_lookup.get(&key) else {
            continue;
        };

        if let Some(existing) = &resolved {
            if existing.target_city_id != binding.target_city_id {
                anyhow::bail!(
                    "station {} matched conflicting overrides {} and {}",
                    station_key,
                    existing.override_id,
                    binding.override_id
                );
            }
        } else {
            resolved = Some(binding.clone());
        }
    }

    Ok(resolved)
}

fn derive_gtfs_basic_city_stems(gtfs_stations: &[GtfsStationArea]) -> HashMap<String, String> {
    let mut prefix_groups = HashMap::<String, Vec<(String, GeoPoint)>>::new();
    for station in gtfs_stations {
        let tokens = normalize_name(&station.display_name)
            .split_whitespace()
            .map(str::to_string)
            .collect::<Vec<_>>();
        for prefix_len in 1..tokens.len() {
            let prefix = tokens[..prefix_len].join(" ");
            if !is_usable_city_name_prefix(&prefix) {
                continue;
            }
            prefix_groups
                .entry(prefix)
                .or_default()
                .push((station.station_key.clone(), station.location));
        }
    }

    let mut stems = HashMap::new();
    for station in gtfs_stations {
        let normalized = normalize_name(&station.display_name);
        let tokens = normalized
            .split_whitespace()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut chosen = normalized.clone();

        for prefix_len in (1..tokens.len()).rev() {
            let prefix = tokens[..prefix_len].join(" ");
            if !is_usable_city_name_prefix(&prefix) {
                continue;
            }
            let Some(matches) = prefix_groups.get(&prefix) else {
                continue;
            };
            if matches.iter().any(|(station_key, location)| {
                station_key != &station.station_key
                    && haversine_meters(*location, station.location)
                        <= GTFS_BASIC_STEM_DISTANCE_METERS
            }) {
                chosen = prefix;
                break;
            }
        }

        stems.insert(station.station_key.clone(), chosen);
    }

    stems
}

fn assign_gtfs_basic_cluster_keys(
    gtfs_stations: &[GtfsStationArea],
    stems: &HashMap<String, String>,
    country_code: &str,
) -> HashMap<String, String> {
    let mut grouped = BTreeMap::<String, Vec<&GtfsStationArea>>::new();
    for station in gtfs_stations {
        let stem = stems
            .get(&station.station_key)
            .cloned()
            .unwrap_or_else(|| normalize_name(&station.display_name));
        grouped.entry(stem).or_default().push(station);
    }

    let mut assignments = HashMap::new();
    for (stem, mut stations) in grouped {
        stations.sort_by(|left, right| {
            left.location
                .lat
                .partial_cmp(&right.location.lat)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    left.location
                        .lon
                        .partial_cmp(&right.location.lon)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| left.station_key.cmp(&right.station_key))
        });

        let mut cluster_centers = Vec::<GeoPoint>::new();
        for station in stations {
            let cluster_index = cluster_centers
                .iter()
                .position(|center| {
                    haversine_meters(*center, station.location) <= GTFS_BASIC_STEM_DISTANCE_METERS
                })
                .unwrap_or_else(|| {
                    cluster_centers.push(station.location);
                    cluster_centers.len() - 1
                });
            assignments.insert(
                station.station_key.clone(),
                format!(
                    "gtfs-basic-{}-{}-{}",
                    country_code.to_ascii_lowercase(),
                    slugify(&stem),
                    cluster_index
                ),
            );
        }
    }

    assignments
}

fn choose_nearest_reference<'a>(
    references: &[&'a ReferenceStation],
    station_location: GeoPoint,
) -> Option<&'a ReferenceStation> {
    references.iter().copied().min_by(|left, right| {
        haversine_meters(left.location, station_location)
            .partial_cmp(&haversine_meters(right.location, station_location))
            .unwrap_or(std::cmp::Ordering::Equal)
    })
}

fn choose_name_match<'a>(
    references: &[&'a ReferenceStation],
    station_location: GeoPoint,
) -> Option<&'a ReferenceStation> {
    let best = choose_nearest_reference(references, station_location)?;
    let distance = haversine_meters(best.location, station_location);
    (distance <= NAME_MATCH_DISTANCE_METERS).then_some(best)
}

fn derive_city_display_name(names: &[String]) -> String {
    if names.len() == 1 {
        return cleaned_city_name_candidate(&names[0]);
    }

    let tokenized = names
        .iter()
        .map(|name| {
            normalize_name(name)
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let min_len = tokenized.iter().map(Vec::len).min().unwrap_or(0);
    let mut common = Vec::<String>::new();

    for index in 0..min_len {
        let token = &tokenized[0][index];
        if tokenized.iter().all(|tokens| tokens[index] == *token) {
            common.push(token.clone());
        } else {
            break;
        }
    }

    if !common.is_empty() && is_usable_city_name_prefix(&common.join(" ")) {
        return cleaned_city_name_candidate(&title_case(&common.join(" ")));
    }

    let mut prefix_counts = HashMap::<String, usize>::new();
    for tokens in &tokenized {
        for prefix_len in 1..tokens.len() {
            let prefix = tokens[..prefix_len].join(" ");
            *prefix_counts.entry(prefix).or_default() += 1;
        }
    }

    if let Some((prefix, _)) = prefix_counts
        .into_iter()
        .filter(|(_, count)| *count >= 2)
        .filter(|(prefix, _)| is_usable_city_name_prefix(prefix))
        .max_by(|left, right| {
            left.1
                .cmp(&right.1)
                .then_with(|| {
                    left.0
                        .split_whitespace()
                        .count()
                        .cmp(&right.0.split_whitespace().count())
                })
                .then_with(|| right.0.len().cmp(&left.0.len()))
        })
    {
        return cleaned_city_name_candidate(&title_case(&prefix));
    }

    let mut candidate_counts = HashMap::<String, usize>::new();
    for name in names {
        let candidate = cleaned_city_name_candidate(name);
        *candidate_counts.entry(candidate).or_default() += 1;
    }

    if let Some((candidate, _)) = candidate_counts
        .into_iter()
        .filter(|(candidate, _)| !normalize_name(candidate).is_empty())
        .max_by(|left, right| {
            left.1
                .cmp(&right.1)
                .then_with(|| {
                    city_name_candidate_quality(&left.0).cmp(&city_name_candidate_quality(&right.0))
                })
                .then_with(|| right.0.len().cmp(&left.0.len()))
        })
    {
        return candidate;
    }

    "Unknown".to_string()
}

fn resolve_gtfs_basic_ineligible_clusters(
    clusters: &BTreeMap<String, CityCluster>,
    source_id: &str,
    issues: &mut Vec<NormalizationIssue>,
) -> CityEligibilityResolution {
    let cluster_details = clusters
        .iter()
        .map(|(cluster_key, cluster)| {
            let display_name = derive_city_display_name(&cluster.display_names);
            let location = GeoPoint {
                lat: cluster.lat_sum / cluster.count as f64,
                lon: cluster.lon_sum / cluster.count as f64,
            };
            let eligibility = if cluster.manual_city_id.is_some() {
                CityEligibility::Eligible
            } else {
                classify_gtfs_basic_city_eligibility(&display_name)
            };
            (
                cluster_key.clone(),
                display_name,
                location,
                eligibility,
                cluster.station_ids.len(),
            )
        })
        .collect::<Vec<_>>();

    let mut resolutions = CityEligibilityResolution::default();
    for (cluster_key, display_name, location, eligibility, _) in &cluster_details {
        match eligibility {
            CityEligibility::Eligible => {}
            CityEligibility::StationOnlyFeedStopLabel => {
                resolutions
                    .report
                    .records
                    .push(RejectedCityCandidateRecord {
                        cluster_key: cluster_key.clone(),
                        display_name: display_name.clone(),
                        country_code: clusters
                            .get(cluster_key)
                            .map(|cluster| cluster.country_code.clone())
                            .unwrap_or_else(|| "ZZ".to_string()),
                        station_count: clusters
                            .get(cluster_key)
                            .map(|cluster| cluster.station_ids.len())
                            .unwrap_or(0),
                        eligibility: "station_only_feed_stop_label".to_string(),
                        resolution: RejectedCityCandidateResolution::UnresolvedStationOnly,
                        derived_parent_key: None,
                        parent_cluster_key: None,
                    });
                issues.push(NormalizationIssue {
                    severity: IssueSeverity::Warning,
                    source_id: source_id.to_string(),
                    entity_ref: cluster_key.clone(),
                    message: format!(
                        "GTFS-basic cluster {} remains station-only because no authoritative parent-city match exists",
                        display_name
                    ),
                });
            }
            CityEligibility::UrbanInterchangeOrHub { parent_key } => {
                let Some(parent_cluster_key) = resolve_gtfs_basic_urban_parent_cluster_key(
                    cluster_key,
                    parent_key.as_deref(),
                    *location,
                    &cluster_details,
                ) else {
                    if let Some(derived_display_name) = parent_key
                        .as_deref()
                        .and_then(derived_parent_display_name_from_key)
                    {
                        resolutions
                            .rename_display_name
                            .insert(cluster_key.clone(), derived_display_name);
                    }
                    resolutions
                        .report
                        .records
                        .push(RejectedCityCandidateRecord {
                            cluster_key: cluster_key.clone(),
                            display_name: display_name.clone(),
                            country_code: clusters
                                .get(cluster_key)
                                .map(|cluster| cluster.country_code.clone())
                                .unwrap_or_else(|| "ZZ".to_string()),
                            station_count: clusters
                                .get(cluster_key)
                                .map(|cluster| cluster.station_ids.len())
                                .unwrap_or(0),
                            eligibility: "urban_interchange_or_hub".to_string(),
                            resolution: RejectedCityCandidateResolution::UnresolvedStationOnly,
                            derived_parent_key: parent_key.clone(),
                            parent_cluster_key: None,
                        });
                    issues.push(NormalizationIssue {
                        severity: IssueSeverity::Warning,
                        source_id: source_id.to_string(),
                        entity_ref: cluster_key.clone(),
                        message: format!(
                            "GTFS-basic urban interchange cluster {} has no deterministic parent-city match",
                            display_name
                        ),
                    });
                    continue;
                };
                resolutions
                    .remap
                    .insert(cluster_key.clone(), parent_cluster_key.clone());
                resolutions
                    .report
                    .records
                    .push(RejectedCityCandidateRecord {
                        cluster_key: cluster_key.clone(),
                        display_name: display_name.clone(),
                        country_code: clusters
                            .get(cluster_key)
                            .map(|cluster| cluster.country_code.clone())
                            .unwrap_or_else(|| "ZZ".to_string()),
                        station_count: clusters
                            .get(cluster_key)
                            .map(|cluster| cluster.station_ids.len())
                            .unwrap_or(0),
                        eligibility: "urban_interchange_or_hub".to_string(),
                        resolution: RejectedCityCandidateResolution::DemotedToParentCity,
                        derived_parent_key: parent_key.clone(),
                        parent_cluster_key: Some(parent_cluster_key.clone()),
                    });
                let parent_display_name = cluster_details
                    .iter()
                    .find(|(candidate_cluster_key, _, _, _, _)| {
                        candidate_cluster_key == &parent_cluster_key
                    })
                    .map(|(_, parent_display_name, _, _, _)| parent_display_name.clone())
                    .unwrap_or_else(|| parent_cluster_key.clone());
                issues.push(NormalizationIssue {
                    severity: IssueSeverity::Info,
                    source_id: source_id.to_string(),
                    entity_ref: cluster_key.clone(),
                    message: format!(
                        "demoted GTFS-basic urban interchange cluster {} into parent city {}",
                        display_name, parent_display_name
                    ),
                });
            }
            CityEligibility::RouteLikeLocalStop { parent_key } => {
                let Some(parent_cluster_key) = parent_key.as_deref().and_then(|parent_key| {
                    resolve_gtfs_basic_parent_cluster_key(
                        cluster_key,
                        parent_key,
                        *location,
                        &cluster_details,
                    )
                }) else {
                    resolutions
                        .report
                        .records
                        .push(RejectedCityCandidateRecord {
                            cluster_key: cluster_key.clone(),
                            display_name: display_name.clone(),
                            country_code: clusters
                                .get(cluster_key)
                                .map(|cluster| cluster.country_code.clone())
                                .unwrap_or_else(|| "ZZ".to_string()),
                            station_count: clusters
                                .get(cluster_key)
                                .map(|cluster| cluster.station_ids.len())
                                .unwrap_or(0),
                            eligibility: "route_like_local_stop".to_string(),
                            resolution: RejectedCityCandidateResolution::UnresolvedReferenceGap,
                            derived_parent_key: parent_key.clone(),
                            parent_cluster_key: None,
                        });
                    issues.push(NormalizationIssue {
                        severity: IssueSeverity::Warning,
                        source_id: source_id.to_string(),
                        entity_ref: cluster_key.clone(),
                        message: format!(
                            "GTFS-basic route-like cluster {} has no deterministic parent-city match",
                            display_name
                        ),
                    });
                    continue;
                };
                resolutions
                    .remap
                    .insert(cluster_key.clone(), parent_cluster_key.clone());
                resolutions
                    .report
                    .records
                    .push(RejectedCityCandidateRecord {
                        cluster_key: cluster_key.clone(),
                        display_name: display_name.clone(),
                        country_code: clusters
                            .get(cluster_key)
                            .map(|cluster| cluster.country_code.clone())
                            .unwrap_or_else(|| "ZZ".to_string()),
                        station_count: clusters
                            .get(cluster_key)
                            .map(|cluster| cluster.station_ids.len())
                            .unwrap_or(0),
                        eligibility: "route_like_local_stop".to_string(),
                        resolution: RejectedCityCandidateResolution::DemotedToParentCity,
                        derived_parent_key: parent_key.clone(),
                        parent_cluster_key: Some(parent_cluster_key.clone()),
                    });
                let parent_display_name = cluster_details
                    .iter()
                    .find(|(candidate_cluster_key, _, _, _, _)| {
                        candidate_cluster_key == &parent_cluster_key
                    })
                    .map(|(_, parent_display_name, _, _, _)| parent_display_name.clone())
                    .unwrap_or_else(|| parent_cluster_key.clone());
                issues.push(NormalizationIssue {
                    severity: IssueSeverity::Info,
                    source_id: source_id.to_string(),
                    entity_ref: cluster_key.clone(),
                    message: format!(
                        "demoted GTFS-basic route-like cluster {} into parent city {}",
                        display_name, parent_display_name
                    ),
                });
            }
        }
    }

    resolutions
}

fn classify_gtfs_basic_city_eligibility(display_name: &str) -> CityEligibility {
    let normalized = normalize_name(display_name);
    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    let first_token = tokens.first().copied().unwrap_or_default();
    let is_station_only_bus_label = normalized == "bus"
        || normalized == "busbahnhof"
        || normalized.starts_with("bus ")
        || normalized.starts_with("bussteige ")
        || first_token.strip_prefix("bus").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit())
        });
    if is_station_only_bus_label
        || (normalized.chars().all(|ch| ch.is_ascii_alphanumeric())
            && normalized.chars().any(|ch| ch.is_ascii_digit())
            && normalized.split_whitespace().count() <= 2)
    {
        return CityEligibility::StationOnlyFeedStopLabel;
    }
    if is_gtfs_basic_urban_interchange_name(&normalized) {
        return CityEligibility::UrbanInterchangeOrHub {
            parent_key: gtfs_basic_urban_parent_key(display_name),
        };
    }
    if normalized.chars().any(|ch| ch.is_ascii_digit()) {
        return CityEligibility::RouteLikeLocalStop {
            parent_key: gtfs_basic_route_like_parent_key(display_name),
        };
    }
    CityEligibility::Eligible
}

fn is_gtfs_basic_urban_interchange_name(normalized: &str) -> bool {
    normalized.ends_with(" u")
        || normalized == "s u"
        || normalized.starts_with("s u ")
        || normalized.contains(" s u")
        || normalized.ends_with(" zob")
        || normalized.contains(" busbahnhof")
        || normalized.ends_with(" u tram")
}

fn resolve_gtfs_basic_parent_cluster_key(
    child_cluster_key: &str,
    parent_key: &str,
    child_location: GeoPoint,
    cluster_details: &[(String, String, GeoPoint, CityEligibility, usize)],
) -> Option<String> {
    let mut candidates = cluster_details
        .iter()
        .filter(|(cluster_key, _, _, eligibility, _)| {
            cluster_key != child_cluster_key && *eligibility == CityEligibility::Eligible
        })
        .filter_map(|(cluster_key, display_name, location, _, station_count)| {
            let comparable = comparable_gtfs_basic_place_key(display_name);
            if comparable != parent_key {
                return None;
            }
            let distance = haversine_meters(*location, child_location);
            (distance <= GTFS_BASIC_ROUTE_LIKE_PARENT_MAX_DISTANCE_METERS).then_some((
                cluster_key,
                display_name,
                distance,
                *station_count,
            ))
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by(|left, right| {
        right
            .3
            .cmp(&left.3)
            .then_with(|| left.2.total_cmp(&right.2))
            .then_with(|| left.1.cmp(right.1))
            .then_with(|| left.0.cmp(right.0))
    });
    if candidates.len() >= 2
        && candidates[0].3 == candidates[1].3
        && (candidates[0].2 - candidates[1].2).abs() < 1.0
    {
        return None;
    }
    Some(candidates[0].0.clone())
}

fn resolve_gtfs_basic_urban_parent_cluster_key(
    child_cluster_key: &str,
    parent_key: Option<&str>,
    child_location: GeoPoint,
    cluster_details: &[(String, String, GeoPoint, CityEligibility, usize)],
) -> Option<String> {
    if let Some(parent_key) = parent_key {
        let mut exact_candidates = cluster_details
            .iter()
            .filter(|(cluster_key, _, _, eligibility, _)| {
                cluster_key != child_cluster_key && *eligibility == CityEligibility::Eligible
            })
            .filter_map(|(cluster_key, display_name, location, _, station_count)| {
                let comparable = comparable_gtfs_basic_place_key(display_name);
                if comparable != parent_key {
                    return None;
                }
                let distance = haversine_meters(*location, child_location);
                (distance <= GTFS_BASIC_URBAN_PARENT_MAX_DISTANCE_METERS).then_some((
                    cluster_key,
                    display_name,
                    distance,
                    *station_count,
                ))
            })
            .collect::<Vec<_>>();
        exact_candidates.sort_by(|left, right| {
            right
                .3
                .cmp(&left.3)
                .then_with(|| left.2.total_cmp(&right.2))
                .then_with(|| left.1.cmp(right.1))
                .then_with(|| left.0.cmp(right.0))
        });
        if exact_candidates.len() >= 2
            && exact_candidates[0].3 == exact_candidates[1].3
            && (exact_candidates[0].2 - exact_candidates[1].2).abs() < 1.0
        {
            return None;
        }
        if let Some(candidate) = exact_candidates.first() {
            return Some(candidate.0.clone());
        }
    }

    let mut nearby_candidates = cluster_details
        .iter()
        .filter(|(cluster_key, _, _, eligibility, _)| {
            cluster_key != child_cluster_key && *eligibility == CityEligibility::Eligible
        })
        .filter_map(|(cluster_key, display_name, location, _, station_count)| {
            let distance = haversine_meters(*location, child_location);
            let comparable = comparable_gtfs_basic_place_key(display_name);
            (*station_count >= 10
                && distance <= GTFS_BASIC_URBAN_NEARBY_FALLBACK_MAX_DISTANCE_METERS
                && is_usable_city_name_prefix(&comparable))
            .then_some((cluster_key, display_name, distance, *station_count))
        })
        .collect::<Vec<_>>();
    nearby_candidates.sort_by(|left, right| {
        right
            .3
            .cmp(&left.3)
            .then_with(|| left.2.total_cmp(&right.2))
            .then_with(|| left.1.cmp(right.1))
            .then_with(|| left.0.cmp(right.0))
    });
    if nearby_candidates.len() >= 2
        && nearby_candidates[0].3 == nearby_candidates[1].3
        && (nearby_candidates[0].2 - nearby_candidates[1].2).abs() < 250.0
    {
        return None;
    }
    nearby_candidates
        .first()
        .map(|candidate| candidate.0.clone())
}

fn derived_parent_display_name_from_key(parent_key: &str) -> Option<String> {
    let normalized = normalize_name(parent_key);
    if normalized.is_empty() || !is_usable_city_name_prefix(&normalized) {
        return None;
    }
    Some(title_case(&normalized))
}

fn is_usable_city_name_prefix(prefix: &str) -> bool {
    let tokens = prefix.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return false;
    }

    if tokens.len() == 1 {
        return !matches!(
            tokens[0],
            "a" | "o"
                | "l"
                | "la"
                | "le"
                | "les"
                | "el"
                | "los"
                | "las"
                | "de"
                | "des"
                | "du"
                | "saint"
                | "st"
                | "san"
                | "sant"
                | "santa"
                | "santo"
                | "bad"
                | "bus"
        );
    }

    true
}

fn cleaned_city_name_candidate(name: &str) -> String {
    let mut tokens = normalize_name(name)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();

    loop {
        let trimmed = if tokens.ends_with(&["gare".to_string(), "centrale".to_string()])
            || tokens.ends_with(&["gare".to_string(), "central".to_string()])
            || tokens.ends_with(&["central".to_string(), "station".to_string()])
        {
            Some(tokens.len() - 2)
        } else if tokens.last().is_some_and(|token| {
            matches!(
                token.as_str(),
                "bahnhof" | "bahnhst" | "bhf" | "hbf" | "hb" | "hauptbahnhof" | "station" | "gare"
            )
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

    let cleaned = tokens.join(" ");
    if cleaned.is_empty() {
        "Unknown".to_string()
    } else {
        title_case(&cleaned)
    }
}

fn city_name_candidate_quality(candidate: &str) -> (u8, usize, usize) {
    let normalized = normalize_name(candidate);
    let token_count = normalized.split_whitespace().count();
    (
        u8::from(is_usable_city_name_prefix(&normalized)),
        token_count,
        normalized.len(),
    )
}

fn gtfs_basic_route_like_parent_key(display_name: &str) -> Option<String> {
    let normalized = normalize_name(display_name);
    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return None;
    }
    let marker_index = tokens
        .iter()
        .position(|token| {
            token.chars().any(|ch| ch.is_ascii_digit())
                || matches!(
                    *token,
                    "allee" | "avenue" | "chaussee" | "road" | "route" | "rue" | "strasse"
                )
        })
        .unwrap_or(tokens.len());
    let mut prefix = tokens[..marker_index].to_vec();
    while prefix.last().is_some_and(|token| {
        matches!(
            *token,
            "a" | "b" | "d" | "k" | "l" | "rd" | "rn" | "bahnhof" | "bahnhst" | "bhf" | "hbf"
        )
    }) {
        prefix.pop();
    }
    while prefix.last().is_some_and(|token| {
        matches!(
            *token,
            "abri" | "bourg" | "carrefour" | "centre" | "cte" | "inter"
        )
    }) {
        prefix.pop();
    }
    if prefix.is_empty() {
        return None;
    }
    Some(comparable_gtfs_basic_place_key(&prefix.join(" ")))
}

fn gtfs_basic_urban_parent_key(display_name: &str) -> Option<String> {
    let normalized = normalize_name(display_name);
    let mut tokens = normalized.split_whitespace().collect::<Vec<_>>();
    if tokens.len() >= 2 && tokens[0] == "s" && tokens[1] == "u" {
        tokens.drain(..2);
    } else if tokens.first().copied() == Some("u") {
        tokens.drain(..1);
    }
    while tokens.last().is_some_and(|token| {
        matches!(
            *token,
            "u" | "tram" | "zob" | "bahn" | "bf" | "bhf" | "hbf" | "bahnhof"
        )
    }) {
        tokens.pop();
    }
    while tokens.last().is_some_and(|token| matches!(*token, "s")) {
        tokens.pop();
    }
    if tokens.is_empty() {
        return None;
    }
    let raw = tokens.join(" ");
    let comparable = comparable_gtfs_basic_place_key(&raw);
    if comparable.is_empty() {
        Some(raw)
    } else {
        Some(comparable)
    }
}

fn comparable_gtfs_basic_place_key(value: &str) -> String {
    let mut tokens = normalize_name(value)
        .split_whitespace()
        .map(|token| match token {
            "st" => "saint".to_string(),
            "ste" => "sainte".to_string(),
            _ => token.to_string(),
        })
        .collect::<Vec<_>>();
    while tokens.last().is_some_and(|token| {
        matches!(
            token.as_str(),
            "bahnhof" | "bahnhst" | "bhf" | "hbf" | "hauptbahnhof" | "station" | "gare"
        )
    }) {
        tokens.pop();
    }
    tokens
        .into_iter()
        .filter(|token| {
            !matches!(
                token.as_str(),
                "a" | "b"
                    | "d"
                    | "de"
                    | "des"
                    | "du"
                    | "en"
                    | "k"
                    | "l"
                    | "la"
                    | "le"
                    | "les"
                    | "pres"
                    | "sur"
                    | "sous"
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_placeholder_station_name(name: &str) -> bool {
    let normalized = normalize_name(name);
    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    match tokens.as_slice() {
        ["bus"] | ["bahn"] => true,
        [token] if token.starts_with("bus") && token[3..].chars().all(|ch| ch.is_ascii_digit()) => {
            true
        }
        [first, second] if (*first == "bus" || *first == "bahn") && !second.is_empty() => true,
        _ => false,
    }
}

fn detect_duplicate_cities(
    cities: &[City],
    generated_at: &str,
    threshold_meters: u32,
) -> DuplicateCityReport {
    let mut by_name = BTreeMap::<String, Vec<&City>>::new();
    for city in cities {
        by_name
            .entry(normalize_name(&city.display_name))
            .or_default()
            .push(city);
    }

    let mut candidates = Vec::new();
    for (normalized_name, group) in by_name {
        if group.len() < 2 {
            continue;
        }
        for left_index in 0..group.len() {
            for right_index in (left_index + 1)..group.len() {
                let left = group[left_index];
                let right = group[right_index];
                let distance_meters =
                    haversine_meters(left.location, right.location).round() as u32;
                if distance_meters <= threshold_meters {
                    candidates.push(DuplicateCityCandidate {
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
        threshold_meters,
        candidates,
    }
}

fn parse_gtfs_time(input: &str) -> Option<u32> {
    let mut parts = input.split(':');
    let hours = parts.next()?.parse::<u32>().ok()?;
    let minutes = parts.next()?.parse::<u32>().ok()?;
    let seconds = parts.next()?.parse::<u32>().ok()?;
    Some(hours * 3600 + minutes * 60 + seconds)
}

fn parse_lat_lon_pair(input: &str) -> Option<GeoPoint> {
    let mut parts = input.split(',');
    let lat = parts.next()?.trim().parse::<f64>().ok()?;
    let lon = parts.next()?.trim().parse::<f64>().ok()?;
    Some(GeoPoint { lat, lon })
}

fn normalize_header(header: &str) -> String {
    header
        .trim_start_matches('\u{feff}')
        .trim()
        .to_ascii_lowercase()
}

fn normalize_name(input: &str) -> String {
    let ascii = deunicode(input);
    let mut normalized = String::new();
    let mut last_was_space = false;
    for ch in ascii.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch);
            last_was_space = false;
        } else if !last_was_space {
            normalized.push(' ');
            last_was_space = true;
        }
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn slugify(input: &str) -> String {
    normalize_name(input).replace(' ', "-")
}

fn title_case(input: &str) -> String {
    input
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            let mut rebuilt = String::new();
            if let Some(first) = chars.next() {
                rebuilt.extend(first.to_uppercase());
            }
            rebuilt.push_str(chars.as_str());
            rebuilt
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_digit_sequences(input: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    for ch in input.chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
        } else if current.len() >= 7 {
            values.push(current.clone());
            current.clear();
        } else {
            current.clear();
        }
    }
    if current.len() >= 7 {
        values.push(current);
    }
    values.sort();
    values.dedup();
    values
}

fn fallback_cluster_key(station: &GtfsStationArea) -> String {
    let base = slugify(&station.display_name);
    if let Some(uic) = &station.uic_code {
        format!("fallback-{base}-{uic}")
    } else {
        format!(
            "fallback-{base}-{}-{}",
            (station.location.lat * 1_000.0).round() as i32,
            (station.location.lon * 1_000.0).round() as i32
        )
    }
}

fn stable_station_id(source_id: &str, station: &GtfsStationArea) -> String {
    let source_slug = slugify(source_id);
    if let Some(uic) = &station.uic_code {
        format!("station-uic-{uic}")
    } else {
        format!(
            "station-{source_slug}-{}",
            stable_hash(&station.station_key)
        )
    }
}

fn stable_city_id(cluster_key: &str, slug: &str, code_insee: Option<&str>) -> String {
    if let Some(code_insee) = code_insee.filter(|value| !value.is_empty() && *value != "unknown") {
        format!("{slug}-fr-{code_insee}")
    } else {
        format!("{slug}-zz-{}", stable_hash(cluster_key))
    }
}

fn stable_city_id_with_country(
    cluster_key: &str,
    slug: &str,
    country_code: &str,
    code_insee: Option<&str>,
) -> String {
    if country_code.eq_ignore_ascii_case("FR") {
        return stable_city_id(cluster_key, slug, code_insee);
    }

    let country_slug = country_code.to_ascii_lowercase();
    format!("{slug}-{country_slug}-{}", stable_hash(cluster_key))
}

fn stable_hash(input: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:08x}", (hasher.finish() & 0xffff_ffff) as u32)
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn haversine_meters(left: GeoPoint, right: GeoPoint) -> f64 {
    let earth_radius_m = 6_371_000.0_f64;
    let lat1 = left.lat.to_radians();
    let lat2 = right.lat.to_radians();
    let delta_lat = (right.lat - left.lat).to_radians();
    let delta_lon = (right.lon - left.lon).to_radians();

    let a =
        (delta_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());
    earth_radius_m * c
}

fn is_supported_rail_route_type(route_type: i16) -> bool {
    route_type == 2 || (100..=117).contains(&route_type)
}

fn is_supported_rail_route(route: &GtfsRouteRow, gtfs_source_id: &str) -> bool {
    let route_id = route.route_id.as_str();
    if gtfs_source_id == "de-delfi-gtfs" {
        if route_id.contains("|Bus|")
            || route_id.contains("|Tram")
            || route_id.contains("|U-Ba")
            || route_id.contains("|Faeh")
        {
            return false;
        }
        return matches!(
            route.route_type,
            2 | 101 | 102 | 103 | 105 | 107 | 109 | 116 | 117
        );
    }
    is_supported_rail_route_type(route.route_type)
}

fn normalize_french_code_insee(input: &str) -> String {
    match input {
        "75101" | "75102" | "75103" | "75104" | "75105" | "75106" | "75107" | "75108" | "75109"
        | "75110" | "75111" | "75112" | "75113" | "75114" | "75115" | "75116" | "75117"
        | "75118" | "75119" | "75120" => "75056".to_string(),
        "69381" | "69382" | "69383" | "69384" | "69385" | "69386" | "69387" | "69388" | "69389" => {
            "69123".to_string()
        }
        "13201" | "13202" | "13203" | "13204" | "13205" | "13206" | "13207" | "13208" | "13209"
        | "13210" | "13211" | "13212" | "13213" | "13214" | "13215" | "13216" => {
            "13055".to_string()
        }
        other => other.to_string(),
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}

impl<T> Pipe for T {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ManualCityOverride, ManualOverrideRegistry};
    use std::{
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    #[test]
    fn digit_extraction_finds_uic_codes() {
        assert_eq!(
            extract_digit_sequences("StopArea:OCE71043075"),
            vec!["71043075".to_string()]
        );
    }

    #[test]
    fn name_normalization_strips_accents_and_punctuation() {
        assert_eq!(
            normalize_name("Saint-Étienne Châteaucreux"),
            "saint etienne chateaucreux"
        );
    }

    #[test]
    fn common_prefix_city_name_is_preferred() {
        let names = vec![
            "Paris Est".to_string(),
            "Paris Gare de Lyon".to_string(),
            "Paris Montparnasse".to_string(),
        ];

        assert_eq!(derive_city_display_name(&names), "Paris");
    }

    #[test]
    fn majority_prefix_city_name_is_preferred_when_common_prefix_is_empty() {
        let names = vec![
            "Avignon TGV".to_string(),
            "Avignon Centre".to_string(),
            "Montfavet".to_string(),
        ];

        assert_eq!(derive_city_display_name(&names), "Avignon");
    }

    #[test]
    fn duplicate_detection_flags_same_name_when_close() {
        let cities = vec![
            City {
                city_id: CityId::new("saint-denis-fr-93066").expect("valid id"),
                slug: "saint-denis".to_string(),
                display_name: "Saint-Denis".to_string(),
                country_code: "FR".to_string(),
                location: GeoPoint {
                    lat: 48.9362,
                    lon: 2.3574,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: Vec::new(),
                aliases: Vec::new(),
            },
            City {
                city_id: CityId::new("saint-denis-zz-feed").expect("valid id"),
                slug: "saint-denis".to_string(),
                display_name: "Saint-Denis".to_string(),
                country_code: "ZZ".to_string(),
                location: GeoPoint {
                    lat: 48.9450,
                    lon: 2.3580,
                },
                wikidata_qid: None,
                population: None,
                interest_score: None,
                station_ids: Vec::new(),
                aliases: Vec::new(),
            },
        ];

        let report = detect_duplicate_cities(&cities, "2026-05-07T19:00:00Z", 25_000);
        assert_eq!(report.candidates.len(), 1);
    }

    #[test]
    fn municipal_arrondissements_collapse_to_commune_codes() {
        assert_eq!(normalize_french_code_insee("75110"), "75056");
        assert_eq!(normalize_french_code_insee("69383"), "69123");
        assert_eq!(normalize_french_code_insee("13206"), "13055");
    }

    #[test]
    fn manual_override_forces_target_city_id() {
        let gtfs_stations = vec![GtfsStationArea {
            station_key: "StopArea:OCE8727100".to_string(),
            display_name: "Paris Nord".to_string(),
            location: GeoPoint {
                lat: 48.8809,
                lon: 2.3553,
            },
            uic_code: Some("8727100".to_string()),
        }];
        let references = vec![ReferenceStation {
            raw_id: "ref-paris-nord".to_string(),
            display_name: "Paris Nord".to_string(),
            code_insee: Some("75056".to_string()),
            location: GeoPoint {
                lat: 48.8809,
                lon: 2.3553,
            },
            uic_codes: vec!["8727100".to_string()],
        }];
        let overrides = ManualOverrideRegistry {
            city_overrides: vec![ManualCityOverride {
                id: "paris-cluster".to_string(),
                target_city_id: CityId::new("paris-fr").expect("valid city id"),
                source_refs: vec![SourceRef {
                    source_id: "sncf-fr-gtfs".to_string(),
                    raw_id: "StopArea:OCE8727100".to_string(),
                }],
                reason: "force shared city id".to_string(),
                added_by: "test".to_string(),
                added_at: "2026-05-08".to_string(),
                tracking_ref: "test".to_string(),
            }],
        };
        let mut issues = Vec::new();

        let (cities, stations, station_mappings, _, _, _, _, _, _) = normalize_stations(
            &gtfs_stations,
            &references,
            "sncf-fr-gtfs",
            "sncf-fr-stations",
            &overrides,
            &mut issues,
        )
        .expect("normalization should succeed");

        assert_eq!(cities.len(), 1);
        assert_eq!(
            cities[0].city_id,
            CityId::new("paris-fr").expect("valid city id")
        );
        assert_eq!(stations.len(), 1);
        assert_eq!(stations[0].city_id, cities[0].city_id);
        assert_eq!(station_mappings.records.len(), 1);
        assert_eq!(
            station_mappings.records[0].mapping_strategy,
            StationMappingStrategy::ManualOverride
        );
        assert_eq!(
            station_mappings.records[0].override_id.as_deref(),
            Some("paris-cluster")
        );
    }

    #[test]
    fn conflicting_override_bindings_are_rejected() {
        let overrides = ManualOverrideRegistry {
            city_overrides: vec![
                ManualCityOverride {
                    id: "first".to_string(),
                    target_city_id: CityId::new("paris-fr").expect("valid city id"),
                    source_refs: vec![SourceRef {
                        source_id: "sncf-fr-gtfs".to_string(),
                        raw_id: "StopArea:OCE8727100".to_string(),
                    }],
                    reason: "test".to_string(),
                    added_by: "test".to_string(),
                    added_at: "2026-05-08".to_string(),
                    tracking_ref: "test".to_string(),
                },
                ManualCityOverride {
                    id: "second".to_string(),
                    target_city_id: CityId::new("lyon-fr").expect("valid city id"),
                    source_refs: vec![SourceRef {
                        source_id: "sncf-fr-gtfs".to_string(),
                        raw_id: "StopArea:OCE8727100".to_string(),
                    }],
                    reason: "test".to_string(),
                    added_by: "test".to_string(),
                    added_at: "2026-05-08".to_string(),
                    tracking_ref: "test".to_string(),
                },
            ],
        };

        let error = build_override_lookup(&overrides).expect_err("expected conflict");
        assert!(
            error
                .to_string()
                .contains("override conflict for sncf-fr-gtfs:StopArea:OCE8727100")
        );
    }

    #[test]
    fn gtfs_basic_dataset_groups_shared_prefix_city_stations() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-gtfs-basic-test.zip",
            &[
                (
                    "stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
StopArea:PARISNORD,Paris Nord,48.8809,2.3553,1,\n\
StopArea:PARISEST,Paris Est,48.8769,2.3591,1,\n\
StopArea:LYONPD,Lyon Part Dieu,45.7600,4.8600,1,\n",
                ),
                ("routes.txt", "route_id,route_type\nR1,2\n"),
                ("trips.txt", "route_id,trip_id\nR1,T1\n"),
                (
                    "stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
T1,08:00:00,08:05:00,StopArea:PARISNORD,1\n\
T1,08:10:00,08:15:00,StopArea:PARISEST,2\n\
T1,10:00:00,10:05:00,StopArea:LYONPD,3\n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");

        let output = build_gtfs_basic_dataset(
            &zip_path,
            "sncf-fr-gtfs",
            "FR",
            "test-version",
            "2026-05-08T18:00:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("gtfs basic dataset should build");

        assert_eq!(output.summary.city_count, 2);
        assert_eq!(output.summary.station_count, 3);
        assert_eq!(output.summary.edge_count, 1);
        assert_eq!(output.station_mappings.records.len(), 3);
        assert_eq!(output.edge_geometries.geometries.len(), 1);
        assert_eq!(
            output.edge_geometries.geometries[0].source,
            EdgeGeometrySource::StraightLineFallback
        );
        assert!(
            output
                .cities
                .iter()
                .any(|city| city.display_name == "Paris")
        );
        assert!(
            output
                .cities
                .iter()
                .any(|city| city.display_name == "Lyon Part Dieu")
        );

        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn gtfs_basic_dataset_demotes_route_like_local_stop_into_parent_city() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-gtfs-basic-route-like-parent-test.zip",
            &[
                (
                    "stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
StopArea:MUNSTER,Munster,48.0400,7.1380,1,\n\
StopArea:MUNSTERBAD,Munster Inter D417 Badischhof,48.0410,7.1400,1,\n",
                ),
                ("routes.txt", "route_id,route_type\nR1,2\n"),
                ("trips.txt", "route_id,trip_id\nR1,T1\n"),
                (
                    "stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
T1,08:00:00,08:05:00,StopArea:MUNSTERBAD,1\n\
T1,08:10:00,08:15:00,StopArea:MUNSTER,2\n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");

        let output = build_gtfs_basic_dataset(
            &zip_path,
            "fr-test-gtfs",
            "FR",
            "test-version",
            "2026-05-11T10:00:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("gtfs basic dataset should build");

        assert_eq!(output.summary.city_count, 1);
        assert_eq!(output.summary.station_count, 2);
        assert_eq!(output.cities[0].display_name, "Munster");
        assert!(
            output.cities[0]
                .aliases
                .iter()
                .any(|alias| alias == "Munster Inter D417 Badischhof")
        );
        assert_eq!(output.stations[0].city_id, output.stations[1].city_id);
        assert!(output.issues.iter().any(|issue| {
            issue
                .message
                .contains("demoted GTFS-basic route-like cluster")
        }));

        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn gtfs_basic_dataset_does_not_collapse_generic_single_token_prefixes() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-gtfs-basic-bad-prefix-test.zip",
            &[
                (
                    "stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
StopArea:BADG,Bad Gastein Bahnhof,47.1158,13.1343,1,\n\
StopArea:BADH,Bad Hofgastein Bahnhof,47.1720,13.1000,1,\n",
                ),
                ("routes.txt", "route_id,route_type\nR1,2\n"),
                ("trips.txt", "route_id,trip_id\nR1,T1\n"),
                (
                    "stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
T1,08:00:00,08:05:00,StopArea:BADG,1\n\
T1,08:20:00,08:25:00,StopArea:BADH,2\n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");

        let output = build_gtfs_basic_dataset(
            &zip_path,
            "at-oebb-gtfs",
            "AT",
            "test-version",
            "2026-05-09T18:00:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("gtfs basic dataset should build");

        assert_eq!(output.summary.city_count, 2);
        assert!(
            output.cities.iter().all(|city| city.display_name != "Bad"),
            "generic one-word stem should not become a canonical city"
        );

        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn gtfs_basic_dataset_uses_clean_city_names_and_source_scoped_station_ids() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-gtfs-basic-station-id-test.zip",
            &[
                (
                    "stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
StopArea:LUX,Luxembourg Gare Centrale,49.5997,6.1346,1,\n\
StopArea:TRIER,Trier Hauptbahnhof,49.7567,6.6441,1,\n",
                ),
                ("routes.txt", "route_id,route_type\nR1,2\n"),
                ("trips.txt", "route_id,trip_id\nR1,T1\n"),
                (
                    "stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
T1,08:00:00,08:05:00,StopArea:LUX,1\n\
T1,08:40:00,08:45:00,StopArea:TRIER,2\n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");

        let output = build_gtfs_basic_dataset(
            &zip_path,
            "lu-atp-gtfs",
            "LU",
            "test-version",
            "2026-05-09T18:00:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("gtfs basic dataset should build");

        assert!(
            output
                .cities
                .iter()
                .any(|city| city.display_name == "Luxembourg"),
            "station suffix should be stripped from canonical city names"
        );
        assert!(
            output
                .stations
                .iter()
                .all(|station| !station.station_id.as_str().starts_with("sncf-fr-")),
            "non-French GTFS feeds should not emit SNCF-prefixed station ids"
        );

        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn gtfs_basic_dataset_drops_placeholder_bus_station_areas() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-gtfs-basic-bus-filter-test.zip",
            &[
                (
                    "stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
StopArea:BUSONLY,Bus,47.7000,16.5000,1,\n\
StopArea:WIENHBF,Wien Hbf,48.1850,16.3740,1,\n\
StopArea:LINZHBF,Linz Hbf,48.2900,14.2920,1,\n",
                ),
                ("routes.txt", "route_id,route_type\nR1,2\n"),
                ("trips.txt", "route_id,trip_id\nR1,T1\n"),
                (
                    "stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
T1,08:00:00,08:05:00,StopArea:WIENHBF,1\n\
T1,09:20:00,09:25:00,StopArea:LINZHBF,2\n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");

        let output = build_gtfs_basic_dataset(
            &zip_path,
            "at-oebb-gtfs",
            "AT",
            "test-version",
            "2026-05-09T18:00:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("gtfs basic dataset should build");

        assert!(
            output.cities.iter().all(|city| city.display_name != "Bus"),
            "placeholder Bus stop areas should not become canonical cities"
        );
        assert!(
            output
                .stations
                .iter()
                .all(|station| station.display_name != "Bus"),
            "placeholder Bus stop areas should be filtered out before normalization"
        );

        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn placeholder_station_name_filter_catches_bus_and_bahn_variants() {
        assert!(is_placeholder_station_name("Bus"));
        assert!(is_placeholder_station_name("bus"));
        assert!(is_placeholder_station_name("Bus A"));
        assert!(is_placeholder_station_name("Bus1"));
        assert!(is_placeholder_station_name("Bahn"));
        assert!(!is_placeholder_station_name("Baden Bahnhof"));
        assert!(!is_placeholder_station_name("Bad Gastein Bahnhof"));
        assert!(!is_placeholder_station_name("Buchs Bahnhof"));
    }

    #[test]
    fn classify_gtfs_basic_city_eligibility_detects_station_only_and_route_like_rows() {
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Bus X30 Ostfriedh"),
            CityEligibility::StationOnlyFeedStopLabel
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Busigny"),
            CityEligibility::Eligible
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Busenberg"),
            CityEligibility::Eligible
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Buschow"),
            CityEligibility::Eligible
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Buseck Grossen Buseck"),
            CityEligibility::Eligible
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Bussigny"),
            CityEligibility::Eligible
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("G23"),
            CityEligibility::StationOnlyFeedStopLabel
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Ka Europaplatz U"),
            CityEligibility::UrbanInterchangeOrHub {
                parent_key: Some("ka europaplatz".to_string()),
            }
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Hauptbahnhof U Tram"),
            CityEligibility::UrbanInterchangeOrHub {
                parent_key: Some("hauptbahnhof".to_string()),
            }
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("S U Berlin"),
            CityEligibility::UrbanInterchangeOrHub {
                parent_key: Some("berlin".to_string()),
            }
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Wimmenau D.919 - Rue de la Gare"),
            CityEligibility::RouteLikeLocalStop {
                parent_key: Some("wimmenau".to_string()),
            }
        );
        assert_eq!(
            classify_gtfs_basic_city_eligibility("Munster"),
            CityEligibility::Eligible
        );
    }

    #[test]
    fn gtfs_basic_parent_key_strips_station_suffixes_and_platform_tokens() {
        assert_eq!(
            gtfs_basic_route_like_parent_key("Bruck Mur Bahnhof 1"),
            Some("bruck mur".to_string())
        );
        assert_eq!(
            gtfs_basic_route_like_parent_key("Hart B Graz Bahnhof 1"),
            Some("hart graz".to_string())
        );
        assert_eq!(
            comparable_gtfs_basic_place_key("Bruck Mur Bahnhof"),
            "bruck mur".to_string()
        );
        assert_eq!(
            gtfs_basic_urban_parent_key("Ka Europaplatz U"),
            Some("ka europaplatz".to_string())
        );
        assert_eq!(
            gtfs_basic_urban_parent_key("Hauptbahnhof U Tram"),
            Some("hauptbahnhof".to_string())
        );
        assert_eq!(
            gtfs_basic_urban_parent_key("S U Berlin"),
            Some("berlin".to_string())
        );
    }

    #[test]
    fn unresolved_urban_interchange_cluster_uses_clean_parent_display_name() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-gtfs-basic-urban-parent-name-test.zip",
            &[
                (
                    "stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
StopArea:BUNDE,Bunde Bahnhof Zob,52.2000,8.5830,1,\n",
                ),
                ("routes.txt", "route_id,route_type\nR1,2\n"),
                ("trips.txt", "route_id,trip_id\nR1,T1\n"),
                (
                    "stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
T1,08:00:00,08:05:00,StopArea:BUNDE,1\n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");

        let output = build_gtfs_basic_dataset(
            &zip_path,
            "de-delfi-gtfs",
            "DE",
            "test-version",
            "2026-05-12T09:30:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("gtfs basic dataset should build");

        assert_eq!(output.summary.city_count, 1);
        assert_eq!(output.cities[0].display_name, "Bunde");
        assert!(
            output.cities[0]
                .aliases
                .iter()
                .any(|alias| alias == "Bunde Bahnhof Zob")
        );
        assert!(
            output
                .rejected_city_candidates
                .records
                .iter()
                .any(|record| {
                    record.display_name == "Bunde Bahnhof Zob"
                        && record.resolution
                            == RejectedCityCandidateResolution::UnresolvedStationOnly
                })
        );

        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn urban_parent_resolution_avoids_distant_generic_city_fallbacks() {
        let child_location = GeoPoint {
            lat: 52.1500,
            lon: 8.6300,
        };
        let cluster_details = vec![
            (
                "child".to_string(),
                "Herford Bahnhof Zob".to_string(),
                child_location,
                CityEligibility::UrbanInterchangeOrHub {
                    parent_key: Some("herford".to_string()),
                },
                2,
            ),
            (
                "generic-d".to_string(),
                "D".to_string(),
                GeoPoint {
                    lat: 52.1505,
                    lon: 8.6310,
                },
                CityEligibility::Eligible,
                25,
            ),
            (
                "bielefeld".to_string(),
                "Bielefeld".to_string(),
                GeoPoint {
                    lat: 52.0302,
                    lon: 8.5325,
                },
                CityEligibility::Eligible,
                40,
            ),
        ];

        assert_eq!(
            resolve_gtfs_basic_urban_parent_cluster_key(
                "child",
                Some("herford"),
                child_location,
                &cluster_details,
            ),
            None
        );
    }

    #[test]
    fn german_route_policy_rejects_bus_and_urban_transit_route_ids() {
        let bus_route = GtfsRouteRow {
            route_id: "de:VBB:12063036|Bus|686:_".to_string(),
            route_type: 106,
        };
        let urban_route = GtfsRouteRow {
            route_id: "de:VBB:11000000|U-Ba".to_string(),
            route_type: 400,
        };
        let rail_route = GtfsRouteRow {
            route_id: "7138187_109".to_string(),
            route_type: 109,
        };
        assert!(!is_supported_rail_route(&bus_route, "de-delfi-gtfs"));
        assert!(!is_supported_rail_route(&urban_route, "de-delfi-gtfs"));
        assert!(is_supported_rail_route(&rail_route, "de-delfi-gtfs"));
    }

    #[test]
    fn gtfs_basic_stem_rejects_low_signal_single_token_prefixes() {
        let stations = vec![
            GtfsStationArea {
                station_key: "s1".to_string(),
                display_name: "Bad Gastein Bahnhof".to_string(),
                location: GeoPoint {
                    lat: 47.116,
                    lon: 13.134,
                },
                uic_code: None,
            },
            GtfsStationArea {
                station_key: "s2".to_string(),
                display_name: "Bad Hofgastein Bahnhof".to_string(),
                location: GeoPoint {
                    lat: 47.172,
                    lon: 13.100,
                },
                uic_code: None,
            },
        ];

        let stems = derive_gtfs_basic_city_stems(&stations);
        assert_eq!(
            stems.get("s1").map(String::as_str),
            Some("bad gastein bahnhof")
        );
        assert_eq!(
            stems.get("s2").map(String::as_str),
            Some("bad hofgastein bahnhof")
        );
    }

    #[test]
    fn derive_city_display_name_strips_station_suffixes() {
        assert_eq!(
            derive_city_display_name(&["Luxembourg Gare Centrale".to_string()]),
            "Luxembourg"
        );
        assert_eq!(
            derive_city_display_name(&["Aalen Hauptbahnhof".to_string()]),
            "Aalen"
        );
    }

    #[test]
    fn gtfs_basic_dataset_reads_archives_with_a_common_root_folder() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-gtfs-basic-rooted-test.zip",
            &[
                (
                    "GTFS_Fahrplan_2026/stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
AT:WIE,WIEN HBF,48.1850,16.3740,1,\n\
AT:SZG,SALZBURG HBF,47.8133,13.0458,1,\n",
                ),
                (
                    "GTFS_Fahrplan_2026/routes.txt",
                    "route_id,route_type\nR1,2\n",
                ),
                ("GTFS_Fahrplan_2026/trips.txt", "route_id,trip_id\nR1,T1\n"),
                (
                    "GTFS_Fahrplan_2026/stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
T1,08:00:00,08:05:00,AT:WIE,1\n\
T1,10:30:00,10:35:00,AT:SZG,2\n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");

        let output = build_gtfs_basic_dataset(
            &zip_path,
            "at-oebb-gtfs",
            "AT",
            "test-version",
            "2026-05-09T10:00:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("rooted GTFS archive should build");

        assert_eq!(output.summary.city_count, 2);
        assert_eq!(output.summary.station_count, 2);
        assert_eq!(output.summary.edge_count, 1);
        assert_eq!(output.edge_geometries.geometries.len(), 1);

        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn gtfs_basic_dataset_trims_padded_headers_and_values() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-gtfs-basic-padded-test.zip",
            &[
                (
                    "stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
12006,Zaragoza Delicias,41.6586576,-0.9112693,1,\n\
12005,Calatayud,41.353249,-1.643768,1,\n",
                ),
                (
                    "routes.txt",
                    "route_id,route_type,route_short_name\n10T0001C1  ,2,C1  \n",
                ),
                (
                    "trips.txt",
                    "route_id,trip_id\n10T0001C1  ,1026S27616C8b\n",
                ),
                (
                    "stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence                                                                                             \n\
1026S27616C8b,11:28:00,11:31:00,12006,010                                                                                                             \n\
1026S27616C8b,11:35:00,11:35:00,12005,011                                                                                                             \n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");

        let output = build_gtfs_basic_dataset(
            &zip_path,
            "es-renfe-cercanias-gtfs",
            "ES",
            "test-version",
            "2026-05-09T10:30:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("padded GTFS archive should build");

        assert_eq!(output.summary.city_count, 2);
        assert_eq!(output.summary.edge_count, 1);

        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn sncf_dataset_exports_shape_segment_geometry() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-shapes-test.zip",
            &[
                (
                    "stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
StopArea:OCE8727100,Paris Nord,48.8809,2.3553,1,\n\
StopArea:OCE8772319,Lyon Part Dieu,45.7604,4.8599,1,\n",
                ),
                ("routes.txt", "route_id,route_type\nR1,2\n"),
                ("trips.txt", "route_id,trip_id,shape_id\nR1,T1,S1\n"),
                (
                    "stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
T1,08:00:00,08:05:00,StopArea:OCE8727100,1\n\
T1,10:00:00,10:05:00,StopArea:OCE8772319,2\n",
                ),
                (
                    "shapes.txt",
                    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n\
S1,48.8809,2.3553,1\n\
S1,48.3000,2.9000,2\n\
S1,47.3000,3.7000,3\n\
S1,46.4000,4.3000,4\n\
S1,45.7604,4.8599,5\n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");
        let stations_csv_path = write_text_file(
            "aetrain-stations-test.csv",
            "id,nom,position_geographique,codeinsee,codes_uic\n\
ref-paris-nord,Paris Nord,\"48.8809,2.3553\",75056,8727100\n\
ref-lyon-part-dieu,Lyon Part Dieu,\"45.7604,4.8599\",69123,8772319\n",
        )
        .expect("station reference CSV should be created");

        let output = build_sncf_dataset(
            &zip_path,
            &stations_csv_path,
            None,
            "sncf-fr-gtfs",
            "sncf-fr-stations",
            None,
            "test-version",
            "2026-05-08T18:00:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("sncf dataset should build");

        assert_eq!(output.summary.edge_count, 1);
        assert_eq!(output.edge_geometries.geometries.len(), 1);
        assert_eq!(
            output.edge_geometries.geometries[0].source,
            EdgeGeometrySource::GtfsShapeSegment
        );
        assert!(output.edge_geometries.geometries[0].points.len() >= 3);

        let _ = fs::remove_file(zip_path);
        let _ = fs::remove_file(stations_csv_path);
    }

    #[test]
    fn sncf_dataset_uses_rfn_geometry_when_shapes_are_missing() {
        let zip_path = write_test_gtfs_zip(
            "aetrain-rfn-fallback-test.zip",
            &[
                (
                    "stops.txt",
                    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
StopArea:OCE8727100,Paris Nord,48.8809,2.3553,1,\n\
StopArea:OCE8772319,Lyon Part Dieu,45.7604,4.8599,1,\n",
                ),
                ("routes.txt", "route_id,route_type\nR1,2\n"),
                ("trips.txt", "route_id,trip_id\nR1,T1\n"),
                (
                    "stop_times.txt",
                    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
T1,08:00:00,08:05:00,StopArea:OCE8727100,1\n\
T1,10:00:00,10:05:00,StopArea:OCE8772319,2\n",
                ),
            ],
        )
        .expect("test GTFS zip should be created");
        let stations_csv_path = write_text_file(
            "aetrain-rfn-stations-test.csv",
            "id,nom,position_geographique,codeinsee,codes_uic\n\
ref-paris-nord,Paris Nord,\"48.8809,2.3553\",75056,8727100\n\
ref-lyon-part-dieu,Lyon Part Dieu,\"45.7604,4.8599\",69123,8772319\n",
        )
        .expect("station reference CSV should be created");
        let rail_geojson_path = write_text_file(
            "aetrain-rfn-lines-test.geojson",
            r#"{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE"},
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [2.3553, 48.8809],
          [2.9000, 48.3000],
          [3.7000, 47.3000],
          [4.3000, 46.4000],
          [4.8599, 45.7604]
        ]
      }
    }
  ]
}"#,
        )
        .expect("rail geojson should be created");

        let output = build_sncf_dataset(
            &zip_path,
            &stations_csv_path,
            Some(&rail_geojson_path),
            "sncf-fr-gtfs",
            "sncf-fr-stations",
            Some("sncf-fr-rfn-lines"),
            "test-version",
            "2026-05-08T18:00:00Z",
            Vec::new(),
            &ManualOverrideRegistry::default(),
        )
        .expect("sncf dataset should build");

        assert_eq!(output.summary.edge_count, 1);
        assert_eq!(
            output.edge_geometries.geometries[0].source,
            EdgeGeometrySource::InfrastructureGraphFallback
        );
        assert!(
            output.edge_geometries.geometries[0]
                .provenance
                .iter()
                .any(|entry| entry == "geometry:sncf-fr-rfn-lines")
        );
        assert!(output.edge_geometries.geometries[0].points.len() >= 3);

        let _ = fs::remove_file(zip_path);
        let _ = fs::remove_file(stations_csv_path);
        let _ = fs::remove_file(rail_geojson_path);
    }

    fn write_test_gtfs_zip(
        file_name: &str,
        entries: &[(&str, &str)],
    ) -> Result<std::path::PathBuf> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time should be after epoch")
            .as_nanos();
        let path = env::temp_dir().join(format!("{timestamp}-{file_name}"));
        let file = fs::File::create(&path)
            .with_context(|| format!("failed to create {}", path.display()))?;
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

        for (name, contents) in entries {
            writer
                .start_file(name, options)
                .with_context(|| format!("failed to start zip entry {name}"))?;
            use std::io::Write;
            writer
                .write_all(contents.as_bytes())
                .with_context(|| format!("failed to write zip entry {name}"))?;
        }
        writer.finish().context("failed to finalize GTFS zip")?;
        Ok(path)
    }

    fn write_text_file(file_name: &str, contents: &str) -> Result<std::path::PathBuf> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time should be after epoch")
            .as_nanos();
        let path = env::temp_dir().join(format!("{timestamp}-{file_name}"));
        fs::write(&path, contents)
            .with_context(|| format!("failed to write {}", path.display()))?;
        Ok(path)
    }
}
