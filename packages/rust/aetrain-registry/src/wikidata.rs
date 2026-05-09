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
    pub city_qid: Option<String>,
    pub country_code: Option<String>,
    pub location: Option<GeoPoint>,
}
