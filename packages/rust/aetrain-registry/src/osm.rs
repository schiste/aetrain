use aetrain_domain::GeoPoint;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OsmRelationRef {
    pub relation_id: String,
    pub role: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OsmStationObservation {
    pub object_id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub city_hint: Option<String>,
    pub country_code: Option<String>,
    pub location: GeoPoint,
    #[serde(default)]
    pub tags: Vec<(String, String)>,
    #[serde(default)]
    pub relations: Vec<OsmRelationRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OsmPlaceObservation {
    pub object_id: String,
    pub name: String,
    pub place_kind: String,
    pub country_code: Option<String>,
    pub location: GeoPoint,
}
