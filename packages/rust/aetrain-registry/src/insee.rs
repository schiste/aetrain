use aetrain_domain::GeoPoint;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InseeCommuneObservation {
    pub code_insee: String,
    pub display_name: String,
    pub country_code: String,
    pub location: GeoPoint,
}
