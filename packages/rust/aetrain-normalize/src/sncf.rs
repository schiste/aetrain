use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    hash::{Hash, Hasher},
    path::Path,
};

use aetrain_dataset::{AliasRecord, DatasetBundle, DatasetMeta, SourceSnapshot};
use aetrain_domain::{
    City, CityId, GeoPoint, ServiceClass, ServiceKind, SourceRef, Station, StationId, TravelEdge,
};
use anyhow::{Context, Result};
use csv::ReaderBuilder;
use deunicode::deunicode;
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::{IssueSeverity, NormalizationIssue};

pub const DEFAULT_DUPLICATE_DISTANCE_METERS: u32 = 25_000;
const NAME_MATCH_DISTANCE_METERS: f64 = 2_000.0;

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
    pub edges: Vec<TravelEdge>,
    pub aliases: Vec<AliasRecord>,
    pub duplicates: DuplicateCityReport,
    pub issues: Vec<NormalizationIssue>,
    pub summary: SncfBuildSummary,
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
    cluster_key: String,
    display_name: String,
    location: GeoPoint,
    uic_code: Option<String>,
    source_refs: Vec<SourceRef>,
    confidence: u8,
}

#[derive(Clone, Debug)]
struct CityCluster {
    code_insee: Option<String>,
    country_code: String,
    station_keys: Vec<String>,
    station_ids: Vec<StationId>,
    display_names: Vec<String>,
    aliases: HashSet<String>,
    lat_sum: f64,
    lon_sum: f64,
    count: usize,
}

#[derive(Clone, Debug)]
struct StopVisit {
    station_key: String,
    city_id: CityId,
    departure_seconds: u32,
    stop_sequence: u32,
}

#[derive(Clone, Debug)]
struct EdgeAccumulator {
    duration_min: u32,
    source_confidence: u8,
    provenance: String,
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
}

#[derive(Deserialize)]
struct GtfsStopTimeRow {
    trip_id: String,
    arrival_time: String,
    departure_time: String,
    stop_id: String,
    stop_sequence: u32,
}

pub fn build_sncf_dataset(
    gtfs_path: &Path,
    stations_csv_path: &Path,
    dataset_version: &str,
    generated_at: &str,
    source_snapshots: Vec<SourceSnapshot>,
) -> Result<SncfBuildOutput> {
    let station_references = load_station_references(stations_csv_path)?;
    let (gtfs_stations, stop_to_station_key) = load_gtfs_stations(gtfs_path)?;
    let trip_routes = load_trip_routes_from_gtfs(gtfs_path)?;
    let used_station_keys =
        collect_used_station_keys(gtfs_path, &trip_routes, &stop_to_station_key)?;
    let gtfs_stations = gtfs_stations
        .into_iter()
        .filter(|station| used_station_keys.contains(&station.station_key))
        .collect::<Vec<_>>();

    let mut issues = Vec::new();
    let (
        cities,
        stations,
        aliases,
        station_key_to_city,
        station_key_confidence,
        matched_station_count,
        unmatched_station_count,
    ) = normalize_stations(&gtfs_stations, &station_references, &mut issues)?;

    let edges = build_city_edges(
        gtfs_path,
        &trip_routes,
        &stop_to_station_key,
        &station_key_to_city,
        &station_key_confidence,
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
        edges,
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

fn load_station_references(path: &Path) -> Result<Vec<ReferenceStation>> {
    let mut reader = ReaderBuilder::new()
        .flexible(true)
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
    let stops = archive
        .by_name("stops.txt")
        .context("missing stops.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().from_reader(stops);

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

        let candidate = GtfsStationArea {
            station_key: station_key.clone(),
            display_name: row.stop_name.trim().to_string(),
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

fn normalize_stations(
    gtfs_stations: &[GtfsStationArea],
    references: &[ReferenceStation],
    issues: &mut Vec<NormalizationIssue>,
) -> Result<(
    Vec<City>,
    Vec<Station>,
    Vec<AliasRecord>,
    HashMap<String, CityId>,
    HashMap<String, u8>,
    usize,
    usize,
)> {
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
        let (cluster_key, country_code, confidence) = if let Some(reference) = matched_reference {
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
            )
        } else {
            issues.push(NormalizationIssue {
                severity: IssueSeverity::Warning,
                source_id: "sncf-fr-stations".to_string(),
                entity_ref: station.station_key.clone(),
                message: format!(
                    "no station-reference match for GTFS stop area {}",
                    station.display_name
                ),
            });
            (fallback_cluster_key(station), "ZZ".to_string(), 50)
        };

        let station_id = StationId::new(stable_station_id(station))
            .context("failed to build stable station id")?;
        let mut source_refs = vec![SourceRef {
            source_id: "sncf-fr-gtfs".to_string(),
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
                source_id: "sncf-fr-stations".to_string(),
                raw_id: reference.raw_id.clone(),
            });
        }

        station_key_confidence.insert(station.station_key.clone(), confidence);
        pending_stations.push(PendingStation {
            station_id: station_id.clone(),
            cluster_key: cluster_key.clone(),
            display_name: station.display_name.clone(),
            location: station.location,
            uic_code: station.uic_code.clone(),
            source_refs,
            confidence,
        });

        let cluster = clusters.entry(cluster_key).or_insert_with(|| CityCluster {
            code_insee: code_insee.clone(),
            country_code,
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
        cluster.station_keys.push(station.station_key.clone());
        cluster.station_ids.push(station_id);
        cluster.display_names.push(station.display_name.clone());
        cluster.aliases.insert(station.display_name.clone());
        cluster.lat_sum += station.location.lat;
        cluster.lon_sum += station.location.lon;
        cluster.count += 1;
    }

    let mut cities = Vec::new();
    let mut city_id_by_cluster = HashMap::new();
    let mut station_key_to_city = HashMap::new();
    let mut aliases = Vec::new();
    let mut alias_keys = HashSet::new();

    for (cluster_key, cluster) in &clusters {
        let display_name = derive_city_display_name(&cluster.display_names);
        let slug = slugify(&display_name);
        let city_id = CityId::new(stable_city_id(
            cluster_key,
            &slug,
            cluster.code_insee.as_deref(),
        ))
        .context("failed to build stable city id")?;
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

    let stations = pending_stations
        .into_iter()
        .map(|station| {
            let city_id = city_id_by_cluster
                .get(&station.cluster_key)
                .expect("cluster should resolve to a city")
                .clone();
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

    let unmatched_station_count = gtfs_stations.len().saturating_sub(matched_station_count);
    Ok((
        cities,
        stations,
        aliases,
        station_key_to_city,
        station_key_confidence,
        matched_station_count,
        unmatched_station_count,
    ))
}

fn build_city_edges(
    gtfs_path: &Path,
    trip_routes: &HashMap<String, String>,
    stop_to_station_key: &HashMap<String, String>,
    station_key_to_city: &HashMap<String, CityId>,
    station_key_confidence: &HashMap<String, u8>,
    issues: &mut Vec<NormalizationIssue>,
) -> Result<Vec<TravelEdge>> {
    let file =
        File::open(gtfs_path).with_context(|| format!("failed to open {}", gtfs_path.display()))?;
    let mut archive = ZipArchive::new(file).context("failed to open GTFS archive")?;

    let stop_times = archive
        .by_name("stop_times.txt")
        .context("missing stop_times.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().from_reader(stop_times);
    let mut edge_map = BTreeMap::<(CityId, CityId), EdgeAccumulator>::new();
    let mut previous_by_trip = HashMap::<String, StopVisit>::new();
    let mut missing_stop_mappings = 0usize;

    for row in reader.deserialize::<GtfsStopTimeRow>() {
        let row = row.context("failed to parse GTFS stop time")?;
        let Some(route_id) = trip_routes.get(&row.trip_id) else {
            continue;
        };
        let Some(station_key) = stop_to_station_key.get(&row.stop_id) else {
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

            let key = (previous.city_id.clone(), city_id.clone());
            let provenance = format!("sncf-fr-gtfs:{route_id}");
            edge_map
                .entry(key)
                .and_modify(|edge| {
                    if duration_min < edge.duration_min {
                        edge.duration_min = duration_min;
                        edge.provenance = provenance.clone();
                        edge.source_confidence = confidence;
                    }
                })
                .or_insert(EdgeAccumulator {
                    duration_min,
                    source_confidence: confidence,
                    provenance,
                });
        }
    }

    if missing_stop_mappings > 0 {
        issues.push(NormalizationIssue {
            severity: IssueSeverity::Warning,
            source_id: "sncf-fr-gtfs".to_string(),
            entity_ref: "stop_times.txt".to_string(),
            message: format!(
                "{missing_stop_mappings} stop_time rows could not be mapped to normalized cities"
            ),
        });
    }

    Ok(edge_map
        .into_iter()
        .map(|((from_city_id, to_city_id), edge)| TravelEdge {
            from_city_id,
            to_city_id,
            duration_min: edge.duration_min,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Regional,
            change_count_estimate: Some(0),
            source_confidence: edge.source_confidence,
            provenance: vec![edge.provenance],
        })
        .collect())
}

fn load_allowed_routes(archive: &mut ZipArchive<File>) -> Result<HashMap<String, i16>> {
    let routes = archive
        .by_name("routes.txt")
        .context("missing routes.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().from_reader(routes);
    let mut allowed = HashMap::new();
    for row in reader.deserialize::<GtfsRouteRow>() {
        let row = row.context("failed to parse GTFS route")?;
        if is_supported_rail_route_type(row.route_type) {
            allowed.insert(row.route_id, row.route_type);
        }
    }
    Ok(allowed)
}

fn load_trip_routes(
    archive: &mut ZipArchive<File>,
    allowed_routes: &HashMap<String, i16>,
) -> Result<HashMap<String, String>> {
    let trips = archive
        .by_name("trips.txt")
        .context("missing trips.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().from_reader(trips);
    let mut trip_routes = HashMap::new();
    for row in reader.deserialize::<GtfsTripRow>() {
        let row = row.context("failed to parse GTFS trip")?;
        if allowed_routes.contains_key(&row.route_id) {
            trip_routes.insert(row.trip_id, row.route_id);
        }
    }
    Ok(trip_routes)
}

fn load_trip_routes_from_gtfs(gtfs_path: &Path) -> Result<HashMap<String, String>> {
    let file =
        File::open(gtfs_path).with_context(|| format!("failed to open {}", gtfs_path.display()))?;
    let mut archive = ZipArchive::new(file).context("failed to open GTFS archive")?;
    let allowed_routes = load_allowed_routes(&mut archive)?;
    load_trip_routes(&mut archive, &allowed_routes)
}

fn collect_used_station_keys(
    gtfs_path: &Path,
    trip_routes: &HashMap<String, String>,
    stop_to_station_key: &HashMap<String, String>,
) -> Result<HashSet<String>> {
    let file =
        File::open(gtfs_path).with_context(|| format!("failed to open {}", gtfs_path.display()))?;
    let mut archive = ZipArchive::new(file).context("failed to open GTFS archive")?;
    let stop_times = archive
        .by_name("stop_times.txt")
        .context("missing stop_times.txt in GTFS archive")?;
    let mut reader = ReaderBuilder::new().from_reader(stop_times);
    let mut station_keys = HashSet::new();

    for row in reader.deserialize::<GtfsStopTimeRow>() {
        let row = row.context("failed to parse GTFS stop time")?;
        if !trip_routes.contains_key(&row.trip_id) {
            continue;
        }
        if let Some(station_key) = stop_to_station_key.get(&row.stop_id) {
            station_keys.insert(station_key.clone());
        }
    }

    Ok(station_keys)
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

    if !common.is_empty() {
        return title_case(&common.join(" "));
    }

    names
        .iter()
        .min_by_key(|name| normalize_name(name).len())
        .cloned()
        .unwrap_or_else(|| "Unknown".to_string())
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
    normalized
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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

fn stable_station_id(station: &GtfsStationArea) -> String {
    if let Some(uic) = &station.uic_code {
        format!("sncf-fr-{uic}")
    } else {
        format!("sncf-fr-stop-{}", stable_hash(&station.station_key))
    }
}

fn stable_city_id(cluster_key: &str, slug: &str, code_insee: Option<&str>) -> String {
    if let Some(code_insee) = code_insee.filter(|value| !value.is_empty() && *value != "unknown") {
        format!("{slug}-fr-{code_insee}")
    } else {
        format!("{slug}-zz-{}", stable_hash(cluster_key))
    }
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
}
