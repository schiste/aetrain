use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use aetrain_domain::{CityId, TravelEdge};

const UNREACHABLE: u32 = u32::MAX;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteResult {
    pub total_minutes: u32,
    pub path: Vec<CityId>,
}

#[derive(Clone, Debug)]
pub struct CityGraph {
    city_ids: Vec<CityId>,
    index_by_city: HashMap<CityId, usize>,
    adjacency: Vec<Vec<(usize, u32)>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Visit {
    cost: u32,
    node: usize,
}

impl Ord for Visit {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .cost
            .cmp(&self.cost)
            .then_with(|| self.node.cmp(&other.node))
    }
}

impl PartialOrd for Visit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl CityGraph {
    pub fn from_edges(edges: &[TravelEdge]) -> Self {
        let mut city_ids = Vec::<CityId>::new();
        let mut index_by_city = HashMap::<CityId, usize>::new();

        for edge in edges {
            for city_id in [&edge.from_city_id, &edge.to_city_id] {
                if !index_by_city.contains_key(city_id) {
                    let next_index = city_ids.len();
                    city_ids.push(city_id.clone());
                    index_by_city.insert(city_id.clone(), next_index);
                }
            }
        }

        let mut adjacency = vec![Vec::<(usize, u32)>::new(); city_ids.len()];
        for edge in edges {
            let from_index = *index_by_city
                .get(&edge.from_city_id)
                .expect("from city must be indexed");
            let to_index = *index_by_city
                .get(&edge.to_city_id)
                .expect("to city must be indexed");
            adjacency[from_index].push((to_index, edge.duration_min));
        }

        Self {
            city_ids,
            index_by_city,
            adjacency,
        }
    }

    pub fn shortest_path(&self, start: &CityId, end: &CityId) -> Option<RouteResult> {
        let start_index = *self.index_by_city.get(start)?;
        let end_index = *self.index_by_city.get(end)?;
        let (distances, previous) = self.dijkstra(start_index);
        let total_minutes = *distances.get(end_index)?;
        if total_minutes == UNREACHABLE {
            return None;
        }

        let mut path = Vec::<CityId>::new();
        let mut cursor = end_index;
        loop {
            path.push(self.city_ids[cursor].clone());
            if cursor == start_index {
                break;
            }
            cursor = previous[cursor]?;
        }
        path.reverse();

        Some(RouteResult {
            total_minutes,
            path,
        })
    }

    pub fn reachable_within(&self, start: &CityId, max_minutes: u32) -> Vec<(CityId, u32)> {
        let Some(&start_index) = self.index_by_city.get(start) else {
            return Vec::new();
        };
        let (distances, _) = self.dijkstra(start_index);
        let mut reachable = Vec::<(CityId, u32)>::new();

        for (index, minutes) in distances.into_iter().enumerate() {
            if minutes != UNREACHABLE && minutes <= max_minutes {
                reachable.push((self.city_ids[index].clone(), minutes));
            }
        }

        reachable.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
        reachable
    }

    fn dijkstra(&self, start_index: usize) -> (Vec<u32>, Vec<Option<usize>>) {
        let mut distances = vec![UNREACHABLE; self.city_ids.len()];
        let mut previous = vec![None; self.city_ids.len()];
        let mut heap = BinaryHeap::<Visit>::new();

        distances[start_index] = 0;
        heap.push(Visit {
            cost: 0,
            node: start_index,
        });

        while let Some(Visit { cost, node }) = heap.pop() {
            if cost > distances[node] {
                continue;
            }

            for (next_node, weight) in &self.adjacency[node] {
                let next_cost = cost.saturating_add(*weight);
                if next_cost < distances[*next_node] {
                    distances[*next_node] = next_cost;
                    previous[*next_node] = Some(node);
                    heap.push(Visit {
                        cost: next_cost,
                        node: *next_node,
                    });
                }
            }
        }

        (distances, previous)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aetrain_domain::{ServiceClass, ServiceKind, TravelEdge};

    fn city_id(value: &str) -> CityId {
        CityId::new(value).expect("valid city id")
    }

    fn edge(from: &str, to: &str, minutes: u32) -> TravelEdge {
        TravelEdge {
            from_city_id: city_id(from),
            to_city_id: city_id(to),
            duration_min: minutes,
            service_kind: ServiceKind::Rail,
            service_class: ServiceClass::Intercity,
            change_count_estimate: None,
            source_confidence: 100,
            provenance: vec!["test".to_string()],
        }
    }

    #[test]
    fn chooses_shortest_path_by_total_minutes() {
        let graph = CityGraph::from_edges(&[
            edge("paris-fr", "lyon-fr", 120),
            edge("lyon-fr", "milano-it", 240),
            edge("paris-fr", "milano-it", 500),
        ]);

        let route = graph
            .shortest_path(&city_id("paris-fr"), &city_id("milano-it"))
            .expect("route should exist");

        assert_eq!(route.total_minutes, 360);
        assert_eq!(
            route.path,
            vec![
                city_id("paris-fr"),
                city_id("lyon-fr"),
                city_id("milano-it")
            ]
        );
    }

    #[test]
    fn returns_reachable_cities_within_limit() {
        let graph = CityGraph::from_edges(&[
            edge("paris-fr", "lyon-fr", 120),
            edge("lyon-fr", "milano-it", 240),
            edge("paris-fr", "dijon-fr", 90),
        ]);

        let reachable = graph.reachable_within(&city_id("paris-fr"), 150);

        assert_eq!(
            reachable,
            vec![
                (city_id("paris-fr"), 0),
                (city_id("dijon-fr"), 90),
                (city_id("lyon-fr"), 120),
            ]
        );
    }
}
