use aetrain_domain::GeoPoint;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SncfStationReferenceObservation {
    pub raw_id: String,
    pub display_name: String,
    pub code_insee: Option<String>,
    pub location: GeoPoint,
    #[serde(default)]
    pub uic_codes: Vec<String>,
}
