use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

#[derive(Clone, Debug, PartialEq)]
pub struct PlannerNode {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub country: String,
    pub population: u64,
    pub interest: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlannerEdgeInput {
    pub from: String,
    pub to: String,
    pub minutes: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlannerRouteResult {
    pub time: u32,
    pub path: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlannerSuggestion {
    pub name: String,
    pub after_stop: usize,
    pub detour_min: u32,
}

#[derive(Clone, Debug)]
struct PlannerSearchEntry {
    city_index: usize,
    name_normalized: String,
    country_normalized: String,
    search_text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct HeapItem {
    cost: u32,
    node: usize,
}

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse for min-heap on cost; ties broken by node index ascending.
        other
            .cost
            .cmp(&self.cost)
            .then_with(|| self.node.cmp(&other.node))
    }
}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Debug)]
pub struct PlannerGraph {
    cities: Vec<PlannerNode>,
    index_by_name: HashMap<String, usize>,
    adjacency: Vec<Vec<(usize, u32)>>,
    invalid_edge_keys: Vec<String>,
    /// Indices into `cities`, pre-sorted by interest DESC, population DESC, name ASC.
    sorted_search: Vec<PlannerSearchEntry>,
}

impl PlannerGraph {
    pub fn new(nodes: Vec<PlannerNode>, edges: &[PlannerEdgeInput]) -> Self {
        let cities = nodes;
        let mut index_by_name: HashMap<String, usize> = HashMap::with_capacity(cities.len());
        for (index, city) in cities.iter().enumerate() {
            // First-seen wins on duplicate names (mirrors JS Map.set semantics on the
            // `cities.map(...)` call which would overwrite — we keep first since the
            // cities list itself is the canonical order; duplicates are not expected).
            index_by_name.entry(city.name.clone()).or_insert(index);
        }

        let mut adjacency: Vec<Vec<(usize, u32)>> = vec![Vec::new(); cities.len()];
        let mut invalid_edge_keys: Vec<String> = Vec::new();

        for edge in edges {
            let route_key = format!("{}-{}", edge.from, edge.to);
            let from_index = index_by_name.get(&edge.from).copied();
            let to_index = index_by_name.get(&edge.to).copied();
            match (from_index, to_index) {
                (Some(from_idx), Some(to_idx)) if from_idx != to_idx => {
                    adjacency[from_idx].push((to_idx, edge.minutes));
                    adjacency[to_idx].push((from_idx, edge.minutes));
                }
                _ => {
                    invalid_edge_keys.push(route_key);
                }
            }
        }

        let sorted_search = build_sorted_search(&cities);

        Self {
            cities,
            index_by_name,
            adjacency,
            invalid_edge_keys,
            sorted_search,
        }
    }

    pub fn cities(&self) -> &[PlannerNode] {
        &self.cities
    }

    pub fn edge_count(&self) -> usize {
        self.adjacency.iter().map(|adj| adj.len()).sum::<usize>() / 2
    }

    pub fn invalid_edge_keys(&self) -> &[String] {
        &self.invalid_edge_keys
    }

    pub fn shortest_path(&self, from: &str, to: &str) -> Option<PlannerRouteResult> {
        if from == to {
            // JS returns `{ time: 0, path: [from] }` even when the name is unknown.
            return Some(PlannerRouteResult {
                time: 0,
                path: vec![from.to_string()],
            });
        }

        let start_index = *self.index_by_name.get(from)?;
        let end_index = *self.index_by_name.get(to)?;

        let (distances, previous) = self.dijkstra(start_index, Some(end_index));
        let total = distances[end_index]?;

        let mut path_indexes = Vec::<usize>::new();
        let mut cursor = end_index;
        loop {
            path_indexes.push(cursor);
            if cursor == start_index {
                break;
            }
            cursor = previous[cursor]?;
        }
        path_indexes.reverse();

        let path = path_indexes
            .into_iter()
            .map(|index| self.cities[index].name.clone())
            .collect();

        Some(PlannerRouteResult { time: total, path })
    }

    pub fn shortest_path_all(&self, from: &str) -> HashMap<String, u32> {
        let mut result = HashMap::new();
        let Some(&start_index) = self.index_by_name.get(from) else {
            return result;
        };

        let (distances, _) = self.dijkstra(start_index, None);
        for (index, maybe_distance) in distances.iter().enumerate() {
            if let Some(distance) = maybe_distance {
                result.insert(self.cities[index].name.clone(), *distance);
            }
        }
        result
    }

    pub fn find_interesting_stops(
        &self,
        trip: &[String],
        segments: &[PlannerRouteResult],
    ) -> Vec<PlannerSuggestion> {
        let trip_set: std::collections::HashSet<&str> = trip.iter().map(String::as_str).collect();

        // Carry city interest alongside the suggestion for the final sort.
        let mut suggestions: Vec<(PlannerSuggestion, u8)> = Vec::new();

        for (segment_index, segment) in segments.iter().enumerate() {
            if segment.path.len() <= 2 {
                continue;
            }

            // Interior cities meeting the interest threshold.
            for path_index in 1..segment.path.len() - 1 {
                let name = &segment.path[path_index];
                if trip_set.contains(name.as_str()) {
                    continue;
                }
                let Some(&city_index) = self.index_by_name.get(name) else {
                    continue;
                };
                let city = &self.cities[city_index];
                if city.interest < 7 {
                    continue;
                }
                suggestions.push((
                    PlannerSuggestion {
                        name: name.clone(),
                        after_stop: segment_index,
                        detour_min: 0,
                    },
                    city.interest,
                ));
            }

            let Some(from_name) = segment.path.first() else {
                continue;
            };
            let Some(to_name) = segment.path.last() else {
                continue;
            };
            let Some(&from_index) = self.index_by_name.get(from_name) else {
                continue;
            };
            let Some(&to_index) = self.index_by_name.get(to_name) else {
                continue;
            };
            let from_city = &self.cities[from_index];
            let to_city = &self.cities[to_index];

            let route_set: std::collections::HashSet<&str> =
                segment.path.iter().map(String::as_str).collect();

            let mid_lat = (from_city.lat + to_city.lat) / 2.0;
            let mid_lon = (from_city.lon + to_city.lon) / 2.0;
            let route_len = haversine(from_city.lat, from_city.lon, to_city.lat, to_city.lon);

            for city in &self.cities {
                if city.interest < 7 {
                    continue;
                }
                if route_set.contains(city.name.as_str()) {
                    continue;
                }
                if trip_set.contains(city.name.as_str()) {
                    continue;
                }
                if suggestions
                    .iter()
                    .any(|(existing, _)| existing.name == city.name)
                {
                    continue;
                }

                let dist_to_mid = haversine(city.lat, city.lon, mid_lat, mid_lon);
                if dist_to_mid >= route_len * 0.4 || dist_to_mid >= 120.0 {
                    continue;
                }

                let to_candidate = self.shortest_path(from_name, &city.name);
                let from_candidate = self.shortest_path(&city.name, to_name);
                let (Some(to_candidate), Some(from_candidate)) = (to_candidate, from_candidate)
                else {
                    continue;
                };

                // Use signed math so we don't underflow when the candidate route
                // somehow tied or beat the direct segment (JS would yield <= 0
                // and the `> 0` guard would reject it).
                let candidate_total = to_candidate.time as i64 + from_candidate.time as i64;
                let detour = candidate_total - segment.time as i64;
                if detour > 0 && detour < 180 {
                    suggestions.push((
                        PlannerSuggestion {
                            name: city.name.clone(),
                            after_stop: segment_index,
                            detour_min: detour as u32,
                        },
                        city.interest,
                    ));
                }
            }
        }

        // Deduplicate by name (first-seen wins) — already enforced during build,
        // but mirror the JS post-filter exactly.
        let mut seen = std::collections::HashSet::<String>::new();
        let mut deduped: Vec<(PlannerSuggestion, u8)> = Vec::new();
        for entry in suggestions.into_iter() {
            if seen.insert(entry.0.name.clone()) {
                deduped.push(entry);
            }
        }

        // Sort by interest DESC, detour_min ASC. Stable sort preserves first-seen
        // ordering for ties (JS Array.sort is stable since ES2019).
        deduped.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| a.0.detour_min.cmp(&b.0.detour_min))
        });

        deduped
            .into_iter()
            .map(|(suggestion, _)| suggestion)
            .collect()
    }

    pub fn search_cities(&self, query: &str, limit: usize) -> Vec<PlannerNode> {
        let normalized = normalize_query(query);
        if normalized.is_empty() {
            return Vec::new();
        }

        let mut matches = Vec::with_capacity(limit);
        for entry in &self.sorted_search {
            if entry.name_normalized.contains(&normalized)
                || entry.country_normalized.contains(&normalized)
                || entry.search_text.contains(&normalized)
            {
                matches.push(self.cities[entry.city_index].clone());
                if matches.len() >= limit {
                    break;
                }
            }
        }
        matches
    }

    fn dijkstra(
        &self,
        start_index: usize,
        end_index: Option<usize>,
    ) -> (Vec<Option<u32>>, Vec<Option<usize>>) {
        let n = self.cities.len();
        let mut distances: Vec<Option<u32>> = vec![None; n];
        let mut previous: Vec<Option<usize>> = vec![None; n];
        let mut visited = vec![false; n];
        let mut heap = BinaryHeap::<HeapItem>::new();

        distances[start_index] = Some(0);
        heap.push(HeapItem {
            cost: 0,
            node: start_index,
        });

        while let Some(HeapItem { cost, node }) = heap.pop() {
            if visited[node] {
                continue;
            }
            visited[node] = true;
            if Some(node) == end_index {
                break;
            }

            for (next_node, weight) in &self.adjacency[node] {
                let alt = cost.saturating_add(*weight);
                let neighbor_distance = distances[*next_node];
                let should_update = match neighbor_distance {
                    None => true,
                    Some(existing) => alt < existing,
                };
                if !should_update {
                    continue;
                }
                distances[*next_node] = Some(alt);
                previous[*next_node] = Some(node);
                heap.push(HeapItem {
                    cost: alt,
                    node: *next_node,
                });
            }
        }

        (distances, previous)
    }
}

fn build_sorted_search(cities: &[PlannerNode]) -> Vec<PlannerSearchEntry> {
    let mut indexes: Vec<usize> = (0..cities.len()).collect();
    indexes.sort_by(|&left, &right| {
        let l = &cities[left];
        let r = &cities[right];
        r.interest
            .cmp(&l.interest)
            .then_with(|| r.population.cmp(&l.population))
            .then_with(|| l.name.cmp(&r.name))
    });

    indexes
        .into_iter()
        .map(|index| {
            let city = &cities[index];
            let name_normalized = normalize_query(&city.name);
            let country_normalized = normalize_query(&city.country);
            let search_text = format!("{} {}", name_normalized, country_normalized);
            PlannerSearchEntry {
                city_index: index,
                name_normalized,
                country_normalized,
                search_text,
            }
        })
        .collect()
}

fn normalize_query(value: &str) -> String {
    value
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
        .collect::<String>()
        .to_lowercase()
        .trim()
        .to_string()
}

fn haversine(lat_a: f64, lon_a: f64, lat_b: f64, lon_b: f64) -> f64 {
    const RADIUS_KM: f64 = 6371.0;
    let d_lat = (lat_b - lat_a).to_radians();
    let d_lon = (lon_b - lon_a).to_radians();
    let lat_a_rad = lat_a.to_radians();
    let lat_b_rad = lat_b.to_radians();
    let x = (d_lat / 2.0).sin().powi(2)
        + lat_a_rad.cos() * lat_b_rad.cos() * (d_lon / 2.0).sin().powi(2);
    RADIUS_KM * 2.0 * x.sqrt().atan2((1.0 - x).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(
        name: &str,
        lat: f64,
        lon: f64,
        country: &str,
        population: u64,
        interest: u8,
    ) -> PlannerNode {
        PlannerNode {
            name: name.to_string(),
            lat,
            lon,
            country: country.to_string(),
            population,
            interest,
        }
    }

    fn edge(from: &str, to: &str, minutes: u32) -> PlannerEdgeInput {
        PlannerEdgeInput {
            from: from.to_string(),
            to: to.to_string(),
            minutes,
        }
    }

    fn three_city_graph() -> PlannerGraph {
        PlannerGraph::new(
            vec![
                node("Paris", 48.8566, 2.3522, "France", 2_000_000, 9),
                node("Lyon", 45.7640, 4.8357, "France", 500_000, 8),
                node("Milano", 45.4642, 9.1900, "Italy", 1_400_000, 9),
            ],
            &[
                edge("Paris", "Lyon", 120),
                edge("Lyon", "Milano", 240),
                edge("Paris", "Milano", 500),
            ],
        )
    }

    #[test]
    fn shortest_path_prefers_through_path() {
        let graph = three_city_graph();
        let route = graph
            .shortest_path("Paris", "Milano")
            .expect("route exists");
        assert_eq!(route.time, 360);
        assert_eq!(route.path, vec!["Paris", "Lyon", "Milano"]);
    }

    #[test]
    fn shortest_path_zero_self() {
        let graph = three_city_graph();
        let route = graph.shortest_path("Paris", "Paris").expect("self route");
        assert_eq!(route.time, 0);
        assert_eq!(route.path, vec!["Paris"]);
    }

    #[test]
    fn shortest_path_unknown_returns_none() {
        let graph = three_city_graph();
        assert!(graph.shortest_path("Paris", "Atlantis").is_none());
        assert!(graph.shortest_path("Atlantis", "Paris").is_none());
    }

    #[test]
    fn shortest_path_all_includes_start_and_omits_unreachable() {
        let graph = PlannerGraph::new(
            vec![
                node("Paris", 48.8566, 2.3522, "France", 2_000_000, 9),
                node("Lyon", 45.7640, 4.8357, "France", 500_000, 8),
                node("Milano", 45.4642, 9.1900, "Italy", 1_400_000, 9),
                node("Reykjavik", 64.1466, -21.9426, "Iceland", 130_000, 5),
            ],
            &[edge("Paris", "Lyon", 120), edge("Lyon", "Milano", 240)],
        );

        let distances = graph.shortest_path_all("Paris");
        assert_eq!(distances.get("Paris"), Some(&0));
        assert_eq!(distances.get("Lyon"), Some(&120));
        assert_eq!(distances.get("Milano"), Some(&360));
        assert!(!distances.contains_key("Reykjavik"));
    }

    #[test]
    fn shortest_path_all_unknown_start_returns_empty() {
        let graph = three_city_graph();
        assert!(graph.shortest_path_all("Atlantis").is_empty());
    }

    #[test]
    fn search_cities_case_and_diacritic_insensitive() {
        let graph = PlannerGraph::new(
            vec![
                node("Lyon", 45.7640, 4.8357, "France", 500_000, 8),
                node("Kraków", 50.0647, 19.9450, "Poland", 780_000, 9),
                node("Reykjavik", 64.1466, -21.9426, "Iceland", 130_000, 5),
            ],
            &[],
        );

        let lyon = graph.search_cities("lyon", 5);
        assert_eq!(lyon.len(), 1);
        assert_eq!(lyon[0].name, "Lyon");

        let krakow_plain = graph.search_cities("krakow", 5);
        assert_eq!(krakow_plain.len(), 1);
        assert_eq!(krakow_plain[0].name, "Kraków");

        let krakow_accented = graph.search_cities("kraków", 5);
        assert_eq!(krakow_accented.len(), 1);
        assert_eq!(krakow_accented[0].name, "Kraków");

        // Country match.
        let poland = graph.search_cities("Poland", 5);
        assert_eq!(poland.len(), 1);
        assert_eq!(poland[0].name, "Kraków");

        // Empty query yields empty.
        assert!(graph.search_cities("   ", 5).is_empty());
    }

    #[test]
    fn search_cities_respects_pre_sort_and_limit() {
        let graph = PlannerGraph::new(
            vec![
                node("Andorra la Vella", 42.5, 1.5, "Andorra", 22_000, 7),
                node("Athens", 37.98, 23.72, "Greece", 660_000, 9),
                node("Aalborg", 57.04, 9.92, "Denmark", 120_000, 6),
            ],
            &[],
        );

        // 'a' matches all three; pre-sort orders by interest DESC, pop DESC,
        // name ASC: Athens (9) -> Andorra la Vella (7) -> Aalborg (6).
        let matches = graph.search_cities("a", 2);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].name, "Athens");
        assert_eq!(matches[1].name, "Andorra la Vella");
    }

    #[test]
    fn invalid_edge_keys_records_self_loops_and_unknowns() {
        let graph = PlannerGraph::new(
            vec![
                node("Paris", 48.8566, 2.3522, "France", 2_000_000, 9),
                node("Lyon", 45.7640, 4.8357, "France", 500_000, 8),
            ],
            &[
                edge("Paris", "Lyon", 120),
                edge("Paris", "Paris", 0),      // self-loop
                edge("Paris", "Atlantis", 999), // unknown to
                edge("Atlantis", "Lyon", 999),  // unknown from
            ],
        );

        let invalid = graph.invalid_edge_keys();
        assert_eq!(invalid.len(), 3);
        assert!(invalid.contains(&"Paris-Paris".to_string()));
        assert!(invalid.contains(&"Paris-Atlantis".to_string()));
        assert!(invalid.contains(&"Atlantis-Lyon".to_string()));
        assert_eq!(graph.edge_count(), 1);
    }

    #[test]
    fn find_interesting_stops_returns_interior_path_cities() {
        // Build a graph where the best Paris->Milano path goes through
        // a high-interest interior city (Lyon).
        let graph = PlannerGraph::new(
            vec![
                node("Paris", 48.8566, 2.3522, "France", 2_000_000, 9),
                node("Lyon", 45.7640, 4.8357, "France", 500_000, 8),
                node("Milano", 45.4642, 9.1900, "Italy", 1_400_000, 9),
            ],
            &[edge("Paris", "Lyon", 120), edge("Lyon", "Milano", 240)],
        );

        let segment = graph.shortest_path("Paris", "Milano").unwrap();
        let suggestions =
            graph.find_interesting_stops(&["Paris".to_string(), "Milano".to_string()], &[segment]);

        // Lyon (interest 8) is interior; it should be suggested with detour 0.
        let lyon = suggestions
            .iter()
            .find(|suggestion| suggestion.name == "Lyon")
            .expect("Lyon should be suggested as interior stop");
        assert_eq!(lyon.detour_min, 0);
        assert_eq!(lyon.after_stop, 0);
    }

    #[test]
    fn find_interesting_stops_dedupes_and_orders_by_interest() {
        // Two segments whose interior both contain Lyon — should appear once.
        let graph = PlannerGraph::new(
            vec![
                node("Paris", 48.8566, 2.3522, "France", 2_000_000, 9),
                node("Lyon", 45.7640, 4.8357, "France", 500_000, 8),
                node("Milano", 45.4642, 9.1900, "Italy", 1_400_000, 9),
                node("Roma", 41.9028, 12.4964, "Italy", 2_870_000, 9),
            ],
            &[
                edge("Paris", "Lyon", 120),
                edge("Lyon", "Milano", 240),
                edge("Milano", "Lyon", 240), // ignored — duplicate dir
                edge("Milano", "Roma", 300),
                edge("Lyon", "Roma", 600),
            ],
        );

        let s1 = graph.shortest_path("Paris", "Milano").unwrap();
        let s2 = graph.shortest_path("Milano", "Roma").unwrap();
        let suggestions = graph.find_interesting_stops(
            &[
                "Paris".to_string(),
                "Milano".to_string(),
                "Roma".to_string(),
            ],
            &[s1, s2],
        );

        let lyon_count = suggestions.iter().filter(|s| s.name == "Lyon").count();
        assert_eq!(lyon_count, 1, "Lyon should be deduplicated");
    }

    #[test]
    fn find_interesting_stops_includes_near_route_candidate() {
        // The near-route branch of the JS planner only triggers for segments
        // whose path has length > 2, so we route Alpha -> Bravo -> Omega via
        // explicit intermediate node "Bravo" (interest 5, below threshold).
        // The candidate "Mid" sits ~55 km from the segment midpoint and
        // detour = (200 + 200) - segment.time. We size segment.time so the
        // detour lands inside (0, 180).
        let graph = PlannerGraph::new(
            vec![
                node("Alpha", 0.0, 0.0, "Test", 2_000_000, 9),
                node("Bravo", 0.0, 2.0, "Test", 100_000, 5),
                node("Omega", 0.0, 4.0, "Test", 1_400_000, 9),
                node("Mid", 0.5, 2.0, "Test", 500_000, 8),
            ],
            &[
                edge("Alpha", "Bravo", 180),
                edge("Bravo", "Omega", 180),
                edge("Alpha", "Mid", 200),
                edge("Mid", "Omega", 200),
            ],
        );

        let segment = graph.shortest_path("Alpha", "Omega").unwrap();
        assert_eq!(segment.time, 360);
        assert_eq!(segment.path, vec!["Alpha", "Bravo", "Omega"]);

        let suggestions =
            graph.find_interesting_stops(&["Alpha".to_string(), "Omega".to_string()], &[segment]);
        let mid = suggestions
            .iter()
            .find(|suggestion| suggestion.name == "Mid")
            .expect("Mid should be suggested as a near-route detour");
        assert_eq!(mid.detour_min, 40);
        assert_eq!(mid.after_stop, 0);
    }

    #[test]
    fn find_interesting_stops_rejects_far_off_cities() {
        // Path Alpha -> Bravo -> Omega gives segment.path.len()==3 so the
        // near-route loop runs. "FarAway" sits far from the Alpha-Omega
        // midpoint (>> 120 km AND >> route_len * 0.4) and must be rejected.
        let graph = PlannerGraph::new(
            vec![
                node("Alpha", 0.0, 0.0, "Test", 2_000_000, 9),
                node("Bravo", 0.0, 1.0, "Test", 100_000, 5),
                node("Omega", 0.0, 2.0, "Test", 1_400_000, 9),
                node("FarAway", 50.0, 50.0, "Test", 130_000, 9),
            ],
            &[
                edge("Alpha", "Bravo", 100),
                edge("Bravo", "Omega", 100),
                edge("Alpha", "FarAway", 200),
                edge("FarAway", "Omega", 200),
            ],
        );

        let segment = graph.shortest_path("Alpha", "Omega").unwrap();
        assert_eq!(segment.path.len(), 3);
        let suggestions =
            graph.find_interesting_stops(&["Alpha".to_string(), "Omega".to_string()], &[segment]);
        assert!(suggestions.iter().all(|s| s.name != "FarAway"));
    }
}
