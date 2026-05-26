use aetrain_domain::GeoPoint;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WikidataCityObservation {
    pub qid: String,
    pub label: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub country_code: Option<String>,
    pub location: Option<GeoPoint>,
    pub population: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WikidataStationObservation {
    pub qid: String,
    pub label: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub city_qid: Option<String>,
    pub country_code: Option<String>,
    pub location: Option<GeoPoint>,
    #[serde(default)]
    pub instance_of: Vec<String>,
    #[serde(default)]
    pub part_of: Vec<String>,
    #[serde(default)]
    pub has_parts: Vec<String>,
    #[serde(default)]
    pub uic_station_codes: Vec<String>,
    #[serde(default)]
    pub ibnr_ids: Vec<String>,
    #[serde(default)]
    pub osm_relation_ids: Vec<String>,
    #[serde(default)]
    pub station_codes: Vec<String>,
    #[serde(default)]
    pub operators: Vec<String>,
    #[serde(default)]
    pub networks: Vec<String>,
    #[serde(default)]
    pub connecting_lines: Vec<String>,
    #[serde(default)]
    pub connecting_services: Vec<String>,
    pub platform_track_count: Option<u16>,
    pub patronage: Option<u64>,
    pub official_website: Option<String>,
    pub image_url: Option<String>,
}
