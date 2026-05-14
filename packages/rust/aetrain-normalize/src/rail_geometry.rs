use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashMap},
    fs,
    path::Path,
};

use aetrain_domain::GeoPoint;
use anyhow::{Context, Result};
use serde_json::Value;

const DEFAULT_SNAP_DISTANCE_METERS: f64 = 25_000.0;
const ENDPOINT_SNAP_DISTANCE_METERS: f64 = 350.0;
const NODE_MERGE_TOLERANCE_METERS: f64 = 120.0;
const NODE_BUCKET_SCALE: f64 = 1_000.0;
const SNAP_CANDIDATE_LIMIT: usize = 8;

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

    pub fn route_polyline(&self, from: GeoPoint, to: GeoPoint) -> Option<Vec<GeoPoint>> {
        if self.nodes.is_empty() {
            return None;
        }

        self.best_route_polyline_between_points(from, to)
    }

    pub fn snap_point(&self, target: GeoPoint) -> Option<usize> {
        let (node_index, distance) = self.nearest_node(target)?;
        if distance > DEFAULT_SNAP_DISTANCE_METERS {
            return None;
        }
        Some(node_index)
    }

    pub fn nearest_node_with_distance(&self, target: GeoPoint) -> Option<(usize, u32)> {
        let (node_index, distance) = self.nearest_node(target)?;
        Some((node_index, distance.round() as u32))
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
        let start_candidates = self.nearest_nodes_with_distance(
            from,
            DEFAULT_SNAP_DISTANCE_METERS.round() as u32,
            SNAP_CANDIDATE_LIMIT,
        );
        let end_candidates = self.nearest_nodes_with_distance(
            to,
            DEFAULT_SNAP_DISTANCE_METERS.round() as u32,
            SNAP_CANDIDATE_LIMIT,
        );
        if start_candidates.is_empty() || end_candidates.is_empty() {
            return None;
        }

        let mut best_route = None::<(u32, Vec<GeoPoint>)>;
        let direct_distance = estimate_distance_meters(from, to);
        for (start_node, start_distance) in &start_candidates {
            for (end_node, end_distance) in &end_candidates {
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
        if start_distance > DEFAULT_SNAP_DISTANCE_METERS
            || end_distance > DEFAULT_SNAP_DISTANCE_METERS
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

    fn nearest_node(&self, target: GeoPoint) -> Option<(usize, f64)> {
        self.nodes
            .iter()
            .enumerate()
            .map(|(index, point)| (index, haversine_meters(*point, target)))
            .min_by(|left, right| left.1.total_cmp(&right.1))
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
            let from_index = get_or_insert_exact_node(
                window[0],
                &mut nodes,
                &mut adjacency,
                &mut node_index_by_key,
            );
            let to_index = get_or_insert_exact_node(
                window[1],
                &mut nodes,
                &mut adjacency,
                &mut node_index_by_key,
            );
            add_undirected_edge(&mut adjacency, from_index, to_index, window[0], window[1]);
        }
    }

    add_endpoint_stitch_edges(&nodes, &mut adjacency, &endpoint_node_indexes);

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
    let mut node_indexes_by_bucket = HashMap::<(i32, i32), Vec<usize>>::new();
    for (index, point) in nodes.iter().enumerate() {
        node_indexes_by_bucket
            .entry(quantize_bucket_key(*point))
            .or_default()
            .push(index);
    }

    let mut stitched_pairs = HashMap::<(usize, usize), ()>::new();
    for endpoint_index in endpoint_node_indexes {
        let endpoint_index = *endpoint_index;
        let endpoint = nodes[endpoint_index];
        let bucket = quantize_bucket_key(endpoint);
        for lat_bucket in (bucket.0 - 1)..=(bucket.0 + 1) {
            for lon_bucket in (bucket.1 - 1)..=(bucket.1 + 1) {
                let Some(candidate_indexes) = node_indexes_by_bucket.get(&(lat_bucket, lon_bucket))
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
}
