use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashMap, HashSet},
    fs::{self, File},
    io::Write,
    path::Path,
};

use aetrain_domain::GeoPoint;
use anyhow::{Context, Result};
use rusqlite::Connection;
use serde_json::Value;
use zip::ZipArchive;

const ROUTE_SNAP_DISTANCE_METERS: f64 = 5_000.0;
const ENDPOINT_SNAP_DISTANCE_METERS: f64 = 350.0;
const NODE_MERGE_TOLERANCE_METERS: f64 = 120.0;
const NODE_BUCKET_SCALE: f64 = 1_000.0;
const SNAP_CANDIDATE_LIMIT: usize = 8;
const SNAP_LOCALITY_SLACK_METERS: u32 = 300;
const EXPANDED_SNAP_CANDIDATE_LIMIT: usize = 24;
const EXPANDED_SNAP_LOCALITY_SLACK_METERS: u32 = 1_500;
const MAX_SEGMENT_LENGTH_WITHOUT_VERTEX_METERS: u32 = 500;
const COMPONENT_MICRO_STITCH_TOLERANCE_METERS: f64 = 60.0;
const COMPONENT_ENDPOINT_STITCH_TOLERANCE_METERS: f64 = 150.0;

#[derive(Clone, Debug)]
pub struct RailGeometryNetwork {
    nodes: Vec<GeoPoint>,
    adjacency: Vec<Vec<GraphEdge>>,
}

#[derive(Clone, Copy, Debug)]
struct GraphEdge {
    target: usize,
    weight_meters: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct QueueState {
    node: usize,
    distance_meters: u32,
    estimated_total_meters: u32,
}

impl Ord for QueueState {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .estimated_total_meters
            .cmp(&self.estimated_total_meters)
            .then_with(|| other.distance_meters.cmp(&self.distance_meters))
            .then_with(|| other.node.cmp(&self.node))
    }
}

impl PartialOrd for QueueState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl RailGeometryNetwork {
    pub fn merge(networks: &[&RailGeometryNetwork]) -> Self {
        let mut polylines = Vec::<Vec<GeoPoint>>::new();
        for network in networks {
            for (from_node, edges) in network.adjacency.iter().enumerate() {
                for edge in edges {
                    if from_node >= edge.target {
                        continue;
                    }
                    polylines.push(vec![network.nodes[from_node], network.nodes[edge.target]]);
                }
            }
        }
        build_network_from_polylines(&polylines)
    }

    pub fn load_sncf_rfn_geojson(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let payload: Value = serde_json::from_str(&raw)
            .with_context(|| format!("failed to parse GeoJSON from {}", path.display()))?;
        let features = payload
            .get("features")
            .and_then(Value::as_array)
            .context("GeoJSON payload is missing features[]")?;

        let mut polylines = Vec::<Vec<GeoPoint>>::new();

        for feature in features {
            if !feature_is_active(feature.get("properties")) {
                continue;
            }
            let Some(geometry) = feature.get("geometry") else {
                continue;
            };
            let Some(geometry_type) = geometry.get("type").and_then(Value::as_str) else {
                continue;
            };
            let Some(coordinates) = geometry.get("coordinates") else {
                continue;
            };

            match geometry_type {
                "LineString" => {
                    if let Some(points) = parse_linestring_coordinates(coordinates) {
                        polylines.push(points);
                    }
                }
                "MultiLineString" => {
                    if let Some(lines) = coordinates.as_array() {
                        for line in lines {
                            if let Some(points) = parse_linestring_coordinates(line) {
                                polylines.push(points);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        Ok(build_network_from_polylines(&polylines))
    }

    pub fn load_geofabrik_railways_gpkg(path: &Path) -> Result<Self> {
        let (connection, extracted_path) = open_gpkg_connection(path)?;
        let railways_table = resolve_geofabrik_railways_table(&connection).with_context(|| {
            format!(
                "failed to resolve railways table from GeoPackage {}",
                path.display()
            )
        })?;
        let mut statement = connection
            .prepare(&format!("SELECT geom, fclass FROM {railways_table}"))
            .with_context(|| {
                format!(
                    "failed to prepare railways query against GeoPackage {}",
                    path.display()
                )
            })?;
        let mut rows = statement.query([]).with_context(|| {
            format!(
                "failed to query railways layer from GeoPackage {}",
                path.display()
            )
        })?;
        let mut polylines = Vec::<Vec<GeoPoint>>::new();

        while let Some(row) = rows.next()? {
            let fclass = row.get::<_, Option<String>>(1)?.unwrap_or_default();
            if !geofabrik_fclass_is_supported_railway(&fclass) {
                continue;
            }
            let geom = row.get::<_, Vec<u8>>(0)?;
            polylines.extend(parse_gpkg_lines(&geom)?);
        }

        drop(rows);
        drop(statement);
        drop(connection);
        if let Some(extracted_path) = extracted_path {
            let _ = fs::remove_file(extracted_path);
        }

        Ok(build_network_from_polylines(&polylines))
    }

    pub fn route_polyline(&self, from: GeoPoint, to: GeoPoint) -> Option<Vec<GeoPoint>> {
        if self.nodes.is_empty() {
            return None;
        }

        self.best_route_polyline_between_points(from, to)
    }

    pub fn nearest_nodes_with_distance(
        &self,
        target: GeoPoint,
        max_distance_meters: u32,
        limit: usize,
    ) -> Vec<(usize, u32)> {
        let mut candidates = self
            .nodes
            .iter()
            .enumerate()
            .map(|(index, point)| (index, haversine_meters(*point, target).round() as u32))
            .filter(|(_, distance)| *distance <= max_distance_meters)
            .collect::<Vec<_>>();
        candidates.sort_by_key(|(_, distance)| *distance);
        candidates.truncate(limit);
        candidates
    }

    pub fn best_route_polyline_between_points(
        &self,
        from: GeoPoint,
        to: GeoPoint,
    ) -> Option<Vec<GeoPoint>> {
        let start_candidates = self.route_snap_candidates(from);
        let end_candidates = self.route_snap_candidates(to);
        if start_candidates.is_empty() || end_candidates.is_empty() {
            return None;
        }

        self.best_route_polyline_for_candidates(from, to, &start_candidates, &end_candidates)
    }

    pub fn route_snap_candidates(&self, target: GeoPoint) -> Vec<(usize, u32)> {
        self.route_snap_candidates_with_params(
            target,
            SNAP_CANDIDATE_LIMIT,
            SNAP_LOCALITY_SLACK_METERS,
        )
    }

    pub fn expanded_route_snap_candidates(&self, target: GeoPoint) -> Vec<(usize, u32)> {
        self.route_snap_candidates_with_params(
            target,
            EXPANDED_SNAP_CANDIDATE_LIMIT,
            EXPANDED_SNAP_LOCALITY_SLACK_METERS,
        )
    }

    pub fn route_polyline_for_snap_candidates(
        &self,
        from: GeoPoint,
        to: GeoPoint,
        start_candidates: &[(usize, u32)],
        end_candidates: &[(usize, u32)],
    ) -> Option<Vec<GeoPoint>> {
        let start_candidates =
            filter_local_snap_candidates(start_candidates.to_vec(), SNAP_LOCALITY_SLACK_METERS);
        let end_candidates =
            filter_local_snap_candidates(end_candidates.to_vec(), SNAP_LOCALITY_SLACK_METERS);
        if start_candidates.is_empty() || end_candidates.is_empty() {
            return None;
        }

        self.best_route_polyline_for_candidates(from, to, &start_candidates, &end_candidates)
    }

    fn route_snap_candidates_with_params(
        &self,
        target: GeoPoint,
        limit: usize,
        slack_meters: u32,
    ) -> Vec<(usize, u32)> {
        filter_local_snap_candidates(
            self.nearest_nodes_with_distance(target, ROUTE_SNAP_DISTANCE_METERS.round() as u32, limit),
            slack_meters,
        )
    }

    fn best_route_polyline_for_candidates(
        &self,
        from: GeoPoint,
        to: GeoPoint,
        start_candidates: &[(usize, u32)],
        end_candidates: &[(usize, u32)],
    ) -> Option<Vec<GeoPoint>> {
        let mut best_route = None::<(u32, Vec<GeoPoint>)>;
        let direct_distance = estimate_distance_meters(from, to);
        for (start_node, start_distance) in start_candidates {
            for (end_node, end_distance) in end_candidates {
                if start_node == end_node && direct_distance > ENDPOINT_SNAP_DISTANCE_METERS as u32
                {
                    continue;
                }
                let Some(points) =
                    self.route_polyline_between_nodes(from, to, *start_node, *end_node)
                else {
                    continue;
                };
                let route_distance = polyline_distance_meters(&points);
                let score = route_distance
                    .saturating_add(*start_distance)
                    .saturating_add(*end_distance);
                match &best_route {
                    Some((best_score, _)) if score >= *best_score => {}
                    _ => best_route = Some((score, points)),
                }
            }
        }

        best_route.map(|(_, points)| points)
    }

    pub fn route_polyline_between_nodes(
        &self,
        from: GeoPoint,
        to: GeoPoint,
        start_node: usize,
        end_node: usize,
    ) -> Option<Vec<GeoPoint>> {
        let start_distance = haversine_meters(self.nodes[start_node], from);
        let end_distance = haversine_meters(self.nodes[end_node], to);
        if start_distance > ROUTE_SNAP_DISTANCE_METERS || end_distance > ROUTE_SNAP_DISTANCE_METERS
        {
            return None;
        }
        let node_path = self.shortest_path(start_node, end_node)?;
        let mut points = node_path
            .into_iter()
            .map(|node_index| self.nodes[node_index])
            .collect::<Vec<_>>();
        if points.len() < 2 {
            return None;
        }

        if haversine_meters(points[0], from) > ENDPOINT_SNAP_DISTANCE_METERS {
            points.insert(0, from);
        } else {
            points[0] = from;
        }

        let last_index = points.len() - 1;
        if haversine_meters(points[last_index], to) > ENDPOINT_SNAP_DISTANCE_METERS {
            points.push(to);
        } else {
            points[last_index] = to;
        }

        Some(points)
    }

    fn shortest_path(&self, start: usize, end: usize) -> Option<Vec<usize>> {
        if start == end {
            return Some(vec![start, end]);
        }

        let mut distance = vec![u32::MAX; self.nodes.len()];
        let mut previous = vec![usize::MAX; self.nodes.len()];
        let mut queue = BinaryHeap::<QueueState>::new();
        distance[start] = 0;
        queue.push(QueueState {
            node: start,
            distance_meters: 0,
            estimated_total_meters: estimate_distance_meters(self.nodes[start], self.nodes[end]),
        });

        while let Some(state) = queue.pop() {
            if state.node == end {
                return Some(reconstruct_path(&previous, start, end));
            }
            if state.distance_meters > distance[state.node] {
                continue;
            }

            for edge in &self.adjacency[state.node] {
                let candidate_distance = state.distance_meters.saturating_add(edge.weight_meters);
                if candidate_distance >= distance[edge.target] {
                    continue;
                }

                distance[edge.target] = candidate_distance;
                previous[edge.target] = state.node;
                queue.push(QueueState {
                    node: edge.target,
                    distance_meters: candidate_distance,
                    estimated_total_meters: candidate_distance.saturating_add(
                        estimate_distance_meters(self.nodes[edge.target], self.nodes[end]),
                    ),
                });
            }
        }

        None
    }
}

fn open_gpkg_connection(path: &Path) -> Result<(Connection, Option<std::path::PathBuf>)> {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        let extracted_path = extract_first_gpkg_from_zip(path)?;
        let connection = Connection::open(&extracted_path).with_context(|| {
            format!(
                "failed to open extracted GeoPackage {} from {}",
                extracted_path.display(),
                path.display()
            )
        })?;
        Ok((connection, Some(extracted_path)))
    } else {
        let connection = Connection::open(path)
            .with_context(|| format!("failed to open GeoPackage {}", path.display()))?;
        Ok((connection, None))
    }
}

fn resolve_geofabrik_railways_table(connection: &Connection) -> Result<String> {
    let mut statement = connection.prepare(
        "SELECT table_name FROM gpkg_contents WHERE table_name LIKE 'gis_osm_railways_free%' ORDER BY CASE WHEN table_name = 'gis_osm_railways_free' THEN 0 ELSE 1 END, table_name",
    )?;
    let mut rows = statement.query([])?;
    let table_name = rows
        .next()?
        .map(|row| row.get::<_, String>(0))
        .transpose()?
        .context("GeoPackage does not expose a gis_osm_railways_free* table")?;
    Ok(table_name)
}

fn extract_first_gpkg_from_zip(path: &Path) -> Result<std::path::PathBuf> {
    let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut archive =
        ZipArchive::new(file).with_context(|| format!("failed to parse {}", path.display()))?;
    let mut member_index = None;
    for index in 0..archive.len() {
        let is_gpkg = archive
            .by_index(index)
            .ok()
            .and_then(|entry| entry.enclosed_name().map(|name| name.to_path_buf()))
            .is_some_and(|name| {
                name.extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("gpkg"))
            });
        if is_gpkg {
            member_index = Some(index);
            break;
        }
    }
    let member_index = member_index.context("GeoPackage zip does not contain a .gpkg member")?;
    let mut member = archive.by_index(member_index).with_context(|| {
        format!(
            "failed to open GeoPackage member {} from {}",
            member_index,
            path.display()
        )
    })?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("current time should be after epoch")
        .as_nanos();
    let extracted_path =
        std::env::temp_dir().join(format!("{timestamp}-aetrain-rail-authority.gpkg"));
    let mut output = File::create(&extracted_path)
        .with_context(|| format!("failed to create {}", extracted_path.display()))?;
    std::io::copy(&mut member, &mut output).with_context(|| {
        format!(
            "failed to extract GeoPackage member from {} to {}",
            path.display(),
            extracted_path.display()
        )
    })?;
    output.flush()?;
    Ok(extracted_path)
}

fn geofabrik_fclass_is_supported_railway(fclass: &str) -> bool {
    matches!(
        fclass,
        "rail" | "narrow_gauge"
    )
}

fn parse_gpkg_lines(blob: &[u8]) -> Result<Vec<Vec<GeoPoint>>> {
    let wkb = gpkg_wkb_payload(blob)?;
    let mut cursor = 0usize;
    parse_wkb_lines(wkb, &mut cursor)
}

fn gpkg_wkb_payload(blob: &[u8]) -> Result<&[u8]> {
    if blob.len() < 8 || &blob[0..2] != b"GP" {
        anyhow::bail!("invalid GeoPackage geometry header");
    }
    let flags = blob[3];
    let envelope_code = (flags >> 1) & 0b111;
    let envelope_bytes = match envelope_code {
        0 => 0usize,
        1 => 32,
        2 | 3 => 48,
        4 => 64,
        _ => anyhow::bail!("unsupported GeoPackage envelope code {envelope_code}"),
    };
    let header_len = 8usize + envelope_bytes;
    if blob.len() < header_len {
        anyhow::bail!("truncated GeoPackage geometry header");
    }
    Ok(&blob[header_len..])
}

fn parse_wkb_lines(wkb: &[u8], cursor: &mut usize) -> Result<Vec<Vec<GeoPoint>>> {
    let byte_order = read_u8(wkb, cursor)?;
    let little_endian = match byte_order {
        0 => false,
        1 => true,
        _ => anyhow::bail!("unsupported WKB byte order {byte_order}"),
    };
    let geometry_type = read_u32(wkb, cursor, little_endian)?;
    match geometry_type {
        2 => Ok(vec![parse_wkb_linestring(wkb, cursor, little_endian)?]),
        5 => {
            let count = read_u32(wkb, cursor, little_endian)? as usize;
            let mut lines = Vec::with_capacity(count);
            for _ in 0..count {
                lines.extend(parse_wkb_lines(wkb, cursor)?);
            }
            Ok(lines)
        }
        _ => anyhow::bail!("unsupported WKB geometry type {geometry_type}"),
    }
}

fn parse_wkb_linestring(
    wkb: &[u8],
    cursor: &mut usize,
    little_endian: bool,
) -> Result<Vec<GeoPoint>> {
    let count = read_u32(wkb, cursor, little_endian)? as usize;
    let mut points = Vec::with_capacity(count);
    for _ in 0..count {
        let lon = read_f64(wkb, cursor, little_endian)?;
        let lat = read_f64(wkb, cursor, little_endian)?;
        points.push(GeoPoint { lat, lon });
    }
    Ok(points)
}

fn read_u8(bytes: &[u8], cursor: &mut usize) -> Result<u8> {
    if *cursor >= bytes.len() {
        anyhow::bail!("unexpected end of WKB payload");
    }
    let value = bytes[*cursor];
    *cursor += 1;
    Ok(value)
}

fn read_u32(bytes: &[u8], cursor: &mut usize, little_endian: bool) -> Result<u32> {
    if bytes.len().saturating_sub(*cursor) < 4 {
        anyhow::bail!("unexpected end of WKB payload");
    }
    let chunk: [u8; 4] = bytes[*cursor..*cursor + 4]
        .try_into()
        .expect("slice length checked");
    *cursor += 4;
    Ok(if little_endian {
        u32::from_le_bytes(chunk)
    } else {
        u32::from_be_bytes(chunk)
    })
}

fn read_f64(bytes: &[u8], cursor: &mut usize, little_endian: bool) -> Result<f64> {
    if bytes.len().saturating_sub(*cursor) < 8 {
        anyhow::bail!("unexpected end of WKB payload");
    }
    let chunk: [u8; 8] = bytes[*cursor..*cursor + 8]
        .try_into()
        .expect("slice length checked");
    *cursor += 8;
    Ok(if little_endian {
        f64::from_le_bytes(chunk)
    } else {
        f64::from_be_bytes(chunk)
    })
}

fn feature_is_active(properties: Option<&Value>) -> bool {
    let Some(properties) = properties.and_then(Value::as_object) else {
        return true;
    };

    for key in ["mnemo", "MNEMO"] {
        let Some(status) = properties.get(key).and_then(Value::as_str) else {
            continue;
        };
        return status.trim().eq_ignore_ascii_case("EXPLOITE");
    }

    true
}

fn parse_linestring_coordinates(value: &Value) -> Option<Vec<GeoPoint>> {
    let coordinates = value.as_array()?;
    let mut points = Vec::new();
    for coordinate in coordinates {
        let pair = coordinate.as_array()?;
        let lon = pair.first()?.as_f64()?;
        let lat = pair.get(1)?.as_f64()?;
        points.push(GeoPoint { lat, lon });
    }
    if points.len() < 2 {
        return None;
    }
    Some(points)
}

fn build_network_from_polylines(polylines: &[Vec<GeoPoint>]) -> RailGeometryNetwork {
    let mut nodes = Vec::<GeoPoint>::new();
    let mut adjacency = Vec::<Vec<GraphEdge>>::new();
    let mut node_index_by_key = HashMap::<(i32, i32), usize>::new();
    let mut endpoint_node_indexes = Vec::<usize>::new();

    for points in polylines {
        if points.len() < 2 {
            continue;
        }

        let first_index = get_or_insert_exact_node(
            points[0],
            &mut nodes,
            &mut adjacency,
            &mut node_index_by_key,
        );
        endpoint_node_indexes.push(first_index);
        let last_index = get_or_insert_exact_node(
            points[points.len() - 1],
            &mut nodes,
            &mut adjacency,
            &mut node_index_by_key,
        );
        endpoint_node_indexes.push(last_index);

        for window in points.windows(2) {
            let densified = densify_segment(window[0], window[1]);
            for segment in densified.windows(2) {
                let from_index = get_or_insert_exact_node(
                    segment[0],
                    &mut nodes,
                    &mut adjacency,
                    &mut node_index_by_key,
                );
                let to_index = get_or_insert_exact_node(
                    segment[1],
                    &mut nodes,
                    &mut adjacency,
                    &mut node_index_by_key,
                );
                add_undirected_edge(&mut adjacency, from_index, to_index, segment[0], segment[1]);
            }
        }
    }

    add_endpoint_stitch_edges(&nodes, &mut adjacency, &endpoint_node_indexes);
    add_component_stitch_edges(&nodes, &mut adjacency, &endpoint_node_indexes);

    RailGeometryNetwork { nodes, adjacency }
}

fn add_undirected_edge(
    adjacency: &mut [Vec<GraphEdge>],
    from_index: usize,
    to_index: usize,
    from_point: GeoPoint,
    to_point: GeoPoint,
) {
    if from_index == to_index {
        return;
    }

    let weight_meters = estimate_distance_meters(from_point, to_point).max(1);
    add_directed_edge(adjacency, from_index, to_index, weight_meters);
    add_directed_edge(adjacency, to_index, from_index, weight_meters);
}

fn add_directed_edge(
    adjacency: &mut [Vec<GraphEdge>],
    from_index: usize,
    to_index: usize,
    weight_meters: u32,
) {
    if let Some(existing) = adjacency[from_index]
        .iter_mut()
        .find(|edge| edge.target == to_index)
    {
        if weight_meters < existing.weight_meters {
            existing.weight_meters = weight_meters;
        }
        return;
    }

    adjacency[from_index].push(GraphEdge {
        target: to_index,
        weight_meters,
    });
}

fn add_endpoint_stitch_edges(
    nodes: &[GeoPoint],
    adjacency: &mut [Vec<GraphEdge>],
    endpoint_node_indexes: &[usize],
) {
    let mut endpoint_indexes_by_bucket = HashMap::<(i32, i32), Vec<usize>>::new();
    for endpoint_index in endpoint_node_indexes {
        let endpoint_index = *endpoint_index;
        endpoint_indexes_by_bucket
            .entry(quantize_bucket_key(nodes[endpoint_index]))
            .or_default()
            .push(endpoint_index);
    }

    let mut stitched_pairs = HashMap::<(usize, usize), ()>::new();
    for endpoint_index in endpoint_node_indexes {
        let endpoint_index = *endpoint_index;
        let endpoint = nodes[endpoint_index];
        let bucket = quantize_bucket_key(endpoint);
        for lat_bucket in (bucket.0 - 1)..=(bucket.0 + 1) {
            for lon_bucket in (bucket.1 - 1)..=(bucket.1 + 1) {
                let Some(candidate_indexes) =
                    endpoint_indexes_by_bucket.get(&(lat_bucket, lon_bucket))
                else {
                    continue;
                };
                for candidate_index in candidate_indexes {
                    if endpoint_index == *candidate_index {
                        continue;
                    }
                    let distance = haversine_meters(endpoint, nodes[*candidate_index]);
                    if distance > NODE_MERGE_TOLERANCE_METERS {
                        continue;
                    }
                    let pair = if endpoint_index < *candidate_index {
                        (endpoint_index, *candidate_index)
                    } else {
                        (*candidate_index, endpoint_index)
                    };
                    if stitched_pairs.insert(pair, ()).is_none() {
                        let weight_meters = distance.round().max(1.0) as u32;
                        add_directed_edge(adjacency, pair.0, pair.1, weight_meters);
                        add_directed_edge(adjacency, pair.1, pair.0, weight_meters);
                    }
                }
            }
        }
    }
}

fn add_component_stitch_edges(
    nodes: &[GeoPoint],
    adjacency: &mut [Vec<GraphEdge>],
    endpoint_node_indexes: &[usize],
) {
    let endpoint_node_indexes = endpoint_node_indexes
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let components = connected_components(adjacency);
    let mut node_indexes_by_bucket = HashMap::<(i32, i32), Vec<usize>>::new();
    for (index, point) in nodes.iter().enumerate() {
        node_indexes_by_bucket
            .entry(quantize_bucket_key(*point))
            .or_default()
            .push(index);
    }

    let mut stitched_pairs = HashSet::<(usize, usize)>::new();
    for (node_index, point) in nodes.iter().enumerate() {
        let bucket = quantize_bucket_key(*point);
        for lat_bucket in (bucket.0 - 1)..=(bucket.0 + 1) {
            for lon_bucket in (bucket.1 - 1)..=(bucket.1 + 1) {
                let Some(candidate_indexes) = node_indexes_by_bucket.get(&(lat_bucket, lon_bucket))
                else {
                    continue;
                };
                for candidate_index in candidate_indexes {
                    if node_index == *candidate_index {
                        continue;
                    }
                    if components[node_index] == components[*candidate_index] {
                        continue;
                    }
                    let distance = haversine_meters(*point, nodes[*candidate_index]);
                    let endpoint_involved = endpoint_node_indexes.contains(&node_index)
                        || endpoint_node_indexes.contains(candidate_index);
                    let tolerance = if endpoint_involved {
                        COMPONENT_ENDPOINT_STITCH_TOLERANCE_METERS
                    } else {
                        COMPONENT_MICRO_STITCH_TOLERANCE_METERS
                    };
                    if distance > tolerance {
                        continue;
                    }
                    let pair = if node_index < *candidate_index {
                        (node_index, *candidate_index)
                    } else {
                        (*candidate_index, node_index)
                    };
                    if stitched_pairs.insert(pair) {
                        let weight_meters = distance.round().max(1.0) as u32;
                        add_directed_edge(adjacency, pair.0, pair.1, weight_meters);
                        add_directed_edge(adjacency, pair.1, pair.0, weight_meters);
                    }
                }
            }
        }
    }
}

fn get_or_insert_exact_node(
    point: GeoPoint,
    nodes: &mut Vec<GeoPoint>,
    adjacency: &mut Vec<Vec<GraphEdge>>,
    node_index_by_key: &mut HashMap<(i32, i32), usize>,
) -> usize {
    let key = quantize_point_key(point);
    if let Some(index) = node_index_by_key.get(&key) {
        return *index;
    }

    let index = nodes.len();
    nodes.push(point);
    adjacency.push(Vec::new());
    node_index_by_key.insert(key, index);
    index
}

fn quantize_point_key(point: GeoPoint) -> (i32, i32) {
    (
        (point.lat * 100_000.0).round() as i32,
        (point.lon * 100_000.0).round() as i32,
    )
}

fn quantize_bucket_key(point: GeoPoint) -> (i32, i32) {
    (
        (point.lat * NODE_BUCKET_SCALE).floor() as i32,
        (point.lon * NODE_BUCKET_SCALE).floor() as i32,
    )
}

fn connected_components(adjacency: &[Vec<GraphEdge>]) -> Vec<usize> {
    let mut components = vec![usize::MAX; adjacency.len()];
    let mut next_component = 0usize;
    let mut stack = Vec::<usize>::new();

    for start in 0..adjacency.len() {
        if components[start] != usize::MAX {
            continue;
        }
        components[start] = next_component;
        stack.push(start);
        while let Some(node) = stack.pop() {
            for edge in &adjacency[node] {
                if components[edge.target] != usize::MAX {
                    continue;
                }
                components[edge.target] = next_component;
                stack.push(edge.target);
            }
        }
        next_component += 1;
    }

    components
}

fn reconstruct_path(previous: &[usize], start: usize, end: usize) -> Vec<usize> {
    let mut path = Vec::<usize>::new();
    let mut current = end;
    path.push(current);
    while current != start {
        current = previous[current];
        if current == usize::MAX {
            return vec![start, end];
        }
        path.push(current);
    }
    path.reverse();
    path
}

fn estimate_distance_meters(from: GeoPoint, to: GeoPoint) -> u32 {
    haversine_meters(from, to).round() as u32
}

fn polyline_distance_meters(points: &[GeoPoint]) -> u32 {
    points
        .windows(2)
        .map(|window| estimate_distance_meters(window[0], window[1]))
        .sum()
}

fn densify_segment(from: GeoPoint, to: GeoPoint) -> Vec<GeoPoint> {
    let distance = estimate_distance_meters(from, to);
    if distance <= MAX_SEGMENT_LENGTH_WITHOUT_VERTEX_METERS {
        return vec![from, to];
    }

    let steps = ((distance as f64 / MAX_SEGMENT_LENGTH_WITHOUT_VERTEX_METERS as f64).ceil()
        as usize)
        .max(1);
    let mut points = Vec::with_capacity(steps + 1);
    for step in 0..=steps {
        let t = step as f64 / steps as f64;
        points.push(GeoPoint {
            lat: from.lat + (to.lat - from.lat) * t,
            lon: from.lon + (to.lon - from.lon) * t,
        });
    }
    points
}

fn filter_local_snap_candidates(candidates: Vec<(usize, u32)>, slack_meters: u32) -> Vec<(usize, u32)> {
    let Some((_, nearest_distance)) = candidates.first() else {
        return candidates;
    };
    let distance_limit = nearest_distance.saturating_add(slack_meters);
    candidates
        .into_iter()
        .filter(|(_, distance)| *distance <= distance_limit)
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::{
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn route_polyline_uses_active_lines_only() {
        let path = write_test_geojson(
            r#"{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE"},
      "geometry": {
        "type": "LineString",
        "coordinates": [[2.0, 48.0], [3.0, 48.0], [4.0, 48.0]]
      }
    },
    {
      "type": "Feature",
      "properties": {"mnemo": "FERME"},
      "geometry": {
        "type": "LineString",
        "coordinates": [[2.0, 49.0], [4.0, 49.0]]
      }
    }
  ]
}"#,
        )
        .expect("geojson should be created");
        let network =
            RailGeometryNetwork::load_sncf_rfn_geojson(&path).expect("network should parse");

        let route = network
            .route_polyline(
                GeoPoint {
                    lat: 48.0,
                    lon: 2.0,
                },
                GeoPoint {
                    lat: 48.0,
                    lon: 4.0,
                },
            )
            .expect("route should exist");
        assert!(route.len() >= 3);
        assert!(route.iter().any(|point| (point.lon - 3.0).abs() < 0.0001));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn nearby_segment_endpoints_are_merged_into_one_graph_node() {
        let path = write_test_geojson(
            r#"{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE"},
      "geometry": {
        "type": "LineString",
        "coordinates": [[2.0, 48.0], [3.0, 48.0]]
      }
    },
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE"},
      "geometry": {
        "type": "LineString",
        "coordinates": [[3.0007, 48.0002], [4.0, 48.0]]
      }
    }
  ]
}"#,
        )
        .expect("geojson should be created");
        let network =
            RailGeometryNetwork::load_sncf_rfn_geojson(&path).expect("network should parse");

        let route = network
            .route_polyline(
                GeoPoint {
                    lat: 48.0,
                    lon: 2.0,
                },
                GeoPoint {
                    lat: 48.0,
                    lon: 4.0,
                },
            )
            .expect("route should exist through merged node");
        assert!(route.len() >= 3);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn route_polyline_tries_multiple_snap_candidates() {
        let path = write_test_geojson(
            r#"{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE"},
      "geometry": {
        "type": "LineString",
        "coordinates": [[2.0000, 48.0000], [2.0100, 48.0000], [2.0200, 48.0000], [2.0300, 48.0000]]
      }
    },
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE"},
      "geometry": {
        "type": "LineString",
        "coordinates": [[2.02974, 48.0000], [2.02976, 48.0000]]
      }
    }
  ]
}"#,
        )
        .expect("geojson should be created");
        let network =
            RailGeometryNetwork::load_sncf_rfn_geojson(&path).expect("network should parse");

        let route = network
            .route_polyline(
                GeoPoint {
                    lat: 48.0000,
                    lon: 2.0001,
                },
                GeoPoint {
                    lat: 48.0000,
                    lon: 2.02975,
                },
            )
            .expect("route should use reachable snap candidates");

        assert!(route.len() >= 3);
        assert!(route.iter().any(|point| (point.lon - 2.02).abs() < 0.0002));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn endpoint_stitching_connects_orleans_style_rfn_gap() {
        let path = write_test_geojson(
            r#"{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE", "code_ligne": "569301"},
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [1.904759701091869, 47.90815419278686],
          [1.905069390420707, 47.9105538218331],
          [1.905275976552944, 47.91287325882416],
          [1.911575763677136, 47.914670237997065]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE", "code_ligne": "590000"},
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [1.911902813190106, 47.9144978354483],
          [1.947676804944898, 47.8200280941227]
        ]
      }
    }
  ]
}"#,
        )
        .expect("geojson should be created");
        let network =
            RailGeometryNetwork::load_sncf_rfn_geojson(&path).expect("network should parse");

        let route = network
            .route_polyline(
                GeoPoint {
                    lat: 47.907891,
                    lon: 1.904242,
                },
                GeoPoint {
                    lat: 47.819215,
                    lon: 1.947581,
                },
            )
            .expect("route should cross stitched RFN endpoint gap");

        assert!(route.len() >= 4);
        assert!(route.iter().any(|point| {
            (point.lat - 47.914670237997065).abs() < 0.0001
                && (point.lon - 1.911575763677136).abs() < 0.0001
        }));
        assert!(route.iter().any(|point| {
            (point.lat - 47.9144978354483).abs() < 0.0001
                && (point.lon - 1.911902813190106).abs() < 0.0001
        }));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn component_stitching_connects_small_interior_gap() {
        let path = write_test_geojson(
            r#"{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE", "code_ligne": "500000"},
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [0.00000, 48.00000],
          [0.00100, 48.00000],
          [0.00200, 48.00000]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE", "code_ligne": "530000"},
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [0.00155, 48.00002],
          [0.00255, 48.00002],
          [0.00355, 48.00002]
        ]
      }
    }
  ]
}"#,
        )
        .expect("geojson should be created");
        let network =
            RailGeometryNetwork::load_sncf_rfn_geojson(&path).expect("network should parse");

        let route = network
            .route_polyline(
                GeoPoint {
                    lat: 48.0,
                    lon: 0.0,
                },
                GeoPoint {
                    lat: 48.00002,
                    lon: 0.00355,
                },
            )
            .expect("route should cross small interior topology gap");

        assert!(route.len() >= 4);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn component_stitching_connects_endpoint_to_nearby_line() {
        let path = write_test_geojson(
            r#"{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE", "code_ligne": "430000"},
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [0.00000, 48.00000],
          [0.00100, 48.00000]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": {"mnemo": "EXPLOITE", "code_ligne": "395000"},
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [0.00190, 48.00015],
          [0.00290, 48.00015]
        ]
      }
    }
  ]
}"#,
        )
        .expect("geojson should be created");
        let network =
            RailGeometryNetwork::load_sncf_rfn_geojson(&path).expect("network should parse");

        let route = network
            .route_polyline(
                GeoPoint {
                    lat: 48.0,
                    lon: 0.0,
                },
                GeoPoint {
                    lat: 48.00015,
                    lon: 0.00290,
                },
            )
            .expect("route should cross endpoint-to-line topology gap");

        assert!(route.len() >= 3);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn geofabrik_gpkg_loader_keeps_rail_and_drops_tram() {
        let path = write_test_gpkg().expect("gpkg should be created");
        let network =
            RailGeometryNetwork::load_geofabrik_railways_gpkg(&path).expect("network should parse");

        let route = network
            .route_polyline(
                GeoPoint {
                    lat: 48.0,
                    lon: 2.0,
                },
                GeoPoint {
                    lat: 48.0,
                    lon: 4.0,
                },
            )
            .expect("rail route should be present");

        assert!(route.len() >= 2);
        assert!(network
            .route_polyline(
                GeoPoint {
                    lat: 49.0,
                    lon: 2.0,
                },
                GeoPoint {
                    lat: 49.0,
                    lon: 3.0,
                },
            )
            .is_none());

        let _ = fs::remove_file(path);
    }

    fn write_test_geojson(contents: &str) -> Result<std::path::PathBuf> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time should be after epoch")
            .as_nanos();
        let path = env::temp_dir().join(format!("{timestamp}-aetrain-rfn-test.geojson"));
        fs::write(&path, contents)
            .with_context(|| format!("failed to write {}", path.display()))?;
        Ok(path)
    }

    fn write_test_gpkg() -> Result<std::path::PathBuf> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time should be after epoch")
            .as_nanos();
        let path = env::temp_dir().join(format!("{timestamp}-aetrain-rail-test.gpkg"));
        let connection = Connection::open(&path)
            .with_context(|| format!("failed to create {}", path.display()))?;
        connection.execute_batch(
            "CREATE TABLE gpkg_contents (
                table_name TEXT NOT NULL PRIMARY KEY,
                data_type TEXT NOT NULL,
                identifier TEXT UNIQUE,
                description TEXT DEFAULT '',
                last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                min_x DOUBLE,
                min_y DOUBLE,
                max_x DOUBLE,
                max_y DOUBLE,
                srs_id INTEGER
            );
            CREATE TABLE gis_osm_railways_free (
                osm_id INTEGER,
                code INTEGER,
                fclass TEXT,
                name TEXT,
                ref TEXT,
                type TEXT,
                service TEXT,
                bridge TEXT,
                tunnel TEXT,
                geom BLOB
            );",
        )?;
        connection.execute(
            "INSERT INTO gpkg_contents (table_name, data_type, identifier, srs_id) VALUES (?1, 'features', ?1, 4326)",
            ("gis_osm_railways_free",),
        )?;
        connection.execute(
            "INSERT INTO gis_osm_railways_free (osm_id, code, fclass, geom) VALUES (?1, ?2, ?3, ?4)",
            (
                1i64,
                6101i64,
                "rail",
                encode_gpkg_linestring(&[(2.0, 48.0), (3.0, 48.0), (4.0, 48.0)]),
            ),
        )?;
        connection.execute(
            "INSERT INTO gis_osm_railways_free (osm_id, code, fclass, geom) VALUES (?1, ?2, ?3, ?4)",
            (
                2i64,
                6102i64,
                "tram",
                encode_gpkg_linestring(&[(2.0, 49.0), (3.0, 49.0)]),
            ),
        )?;
        Ok(path)
    }

    fn encode_gpkg_linestring(points: &[(f64, f64)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"GP");
        bytes.push(0);
        bytes.push(1);
        bytes.extend_from_slice(&4326i32.to_le_bytes());
        bytes.push(1);
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(points.len() as u32).to_le_bytes());
        for (lon, lat) in points {
            bytes.extend_from_slice(&lon.to_le_bytes());
            bytes.extend_from_slice(&lat.to_le_bytes());
        }
        bytes
    }
}
