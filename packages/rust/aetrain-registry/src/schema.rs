use aetrain_domain::{CityId, GeoPoint, StationId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryStatus {
    Resolved,
    Provisional,
    NeedsReview,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryMeta {
    pub schema_version: u16,
    pub dataset_id: String,
    pub scope: String,
    pub generated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalRecordRef {
    pub source_id: String,
    pub external_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryObservationSource {
    pub provider: String,
    pub source_id: String,
    pub snapshot_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryCity {
    pub city_id: CityId,
    pub display_name: String,
    pub country_code: String,
    pub location: GeoPoint,
    pub wikidata_qid: Option<String>,
    pub population: Option<u64>,
    pub status: RegistryStatus,
    #[serde(default)]
    pub external_refs: Vec<ExternalRecordRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryStation {
    pub station_id: StationId,
    pub display_name: String,
    pub country_code: String,
    pub location: GeoPoint,
    pub uic_code: Option<String>,
    pub status: RegistryStatus,
    #[serde(default)]
    pub external_refs: Vec<ExternalRecordRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryCityStationMembership {
    pub city_id: CityId,
    pub station_id: StationId,
    pub is_primary: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryNameVariantKind {
    CanonicalAlias,
    StationVariant,
    FeedAbbreviation,
    ForeignLanguage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryNameVariant {
    pub city_id: CityId,
    pub value: String,
    pub kind: RegistryNameVariantKind,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryCanonicalBundle {
    pub meta: RegistryMeta,
    pub cities: Vec<RegistryCity>,
    pub stations: Vec<RegistryStation>,
    pub memberships: Vec<RegistryCityStationMembership>,
    pub name_variants: Vec<RegistryNameVariant>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryCityCollection {
    pub meta: RegistryMeta,
    pub cities: Vec<RegistryCity>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryStationCollection {
    pub meta: RegistryMeta,
    pub stations: Vec<RegistryStation>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryNameVariantCollection {
    pub meta: RegistryMeta,
    pub variants: Vec<RegistryNameVariant>,
}
