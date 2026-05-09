// wasm-bindgen wrapper around aetrain-routing's PlannerGraph.
// JSON-shaped interop via serde-wasm-bindgen so the JS side can keep using
// its existing dataset shapes (planner-engine.ts on the web) without bespoke
// tuple encodings. Compiled to wasm32-unknown-unknown via wasm-pack.

use aetrain_routing::planner::{
    PlannerEdgeInput, PlannerGraph as InnerGraph, PlannerNode, PlannerRouteResult,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn install_panic_hook() {
    #[cfg(feature = "panic-hook")]
    console_error_panic_hook::set_once();
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PlannerNodeJs {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub country: String,
    pub population: u64,
    pub interest: u8,
}

#[derive(Debug, Deserialize)]
pub struct PlannerEdgeJs {
    pub from: String,
    pub to: String,
    pub minutes: u32,
}

#[derive(Debug, Serialize)]
pub struct PlannerRouteResultJs {
    pub time: u32,
    pub path: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PlannerSegmentInputJs {
    pub time: u32,
    pub path: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PlannerSuggestionJs {
    pub name: String,
    #[serde(rename = "afterStop")]
    pub after_stop: usize,
    #[serde(rename = "detourMin")]
    pub detour_min: u32,
}

#[wasm_bindgen]
pub struct PlannerGraph {
    inner: InnerGraph,
}

#[wasm_bindgen]
impl PlannerGraph {
    #[wasm_bindgen(constructor)]
    pub fn new(nodes_js: JsValue, edges_js: JsValue) -> Result<PlannerGraph, JsValue> {
        let nodes: Vec<PlannerNodeJs> =
            serde_wasm_bindgen::from_value(nodes_js).map_err(into_js_error)?;
        let edges: Vec<PlannerEdgeJs> =
            serde_wasm_bindgen::from_value(edges_js).map_err(into_js_error)?;

        let inner_nodes: Vec<PlannerNode> = nodes
            .into_iter()
            .map(|n| PlannerNode {
                name: n.name,
                lat: n.lat,
                lon: n.lon,
                country: n.country,
                population: n.population,
                interest: n.interest,
            })
            .collect();
        let inner_edges: Vec<PlannerEdgeInput> = edges
            .into_iter()
            .map(|e| PlannerEdgeInput {
                from: e.from,
                to: e.to,
                minutes: e.minutes,
            })
            .collect();

        Ok(PlannerGraph {
            inner: InnerGraph::new(inner_nodes, &inner_edges),
        })
    }

    #[wasm_bindgen(js_name = cityCount)]
    pub fn city_count(&self) -> usize {
        self.inner.cities().len()
    }

    #[wasm_bindgen(js_name = edgeCount)]
    pub fn edge_count(&self) -> usize {
        self.inner.edge_count()
    }

    #[wasm_bindgen(js_name = invalidEdgeKeys)]
    pub fn invalid_edge_keys(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(self.inner.invalid_edge_keys()).map_err(into_js_error)
    }

    #[wasm_bindgen(js_name = shortestPath)]
    pub fn shortest_path(&self, from: &str, to: &str) -> Result<JsValue, JsValue> {
        let result = self.inner.shortest_path(from, to);
        let mapped = result.map(|r| PlannerRouteResultJs {
            time: r.time,
            path: r.path,
        });
        serde_wasm_bindgen::to_value(&mapped).map_err(into_js_error)
    }

    #[wasm_bindgen(js_name = shortestPathAll)]
    pub fn shortest_path_all(&self, from: &str) -> Result<JsValue, JsValue> {
        let map = self.inner.shortest_path_all(from);
        // Serializer default emits a Map for HashMap; JS callers expect a
        // plain object keyed by city name. Use the object serializer.
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        map.serialize(&serializer).map_err(into_js_error)
    }

    #[wasm_bindgen(js_name = findInterestingStops)]
    pub fn find_interesting_stops(
        &self,
        trip_js: JsValue,
        segments_js: JsValue,
    ) -> Result<JsValue, JsValue> {
        let trip: Vec<String> = serde_wasm_bindgen::from_value(trip_js).map_err(into_js_error)?;
        let segments: Vec<PlannerSegmentInputJs> =
            serde_wasm_bindgen::from_value(segments_js).map_err(into_js_error)?;
        let inner_segments: Vec<PlannerRouteResult> = segments
            .into_iter()
            .map(|s| PlannerRouteResult {
                time: s.time,
                path: s.path,
            })
            .collect();
        let suggestions = self.inner.find_interesting_stops(&trip, &inner_segments);
        let js_suggestions: Vec<PlannerSuggestionJs> = suggestions
            .into_iter()
            .map(|s| PlannerSuggestionJs {
                name: s.name,
                after_stop: s.after_stop,
                detour_min: s.detour_min,
            })
            .collect();
        serde_wasm_bindgen::to_value(&js_suggestions).map_err(into_js_error)
    }

    #[wasm_bindgen(js_name = searchCities)]
    pub fn search_cities(&self, query: &str, limit: usize) -> Result<JsValue, JsValue> {
        let results = self.inner.search_cities(query, limit);
        let js_results: Vec<PlannerNodeJs> = results
            .into_iter()
            .map(|n| PlannerNodeJs {
                name: n.name,
                lat: n.lat,
                lon: n.lon,
                country: n.country,
                population: n.population,
                interest: n.interest,
            })
            .collect();
        serde_wasm_bindgen::to_value(&js_results).map_err(into_js_error)
    }
}

fn into_js_error(err: serde_wasm_bindgen::Error) -> JsValue {
    JsValue::from_str(&err.to_string())
}
