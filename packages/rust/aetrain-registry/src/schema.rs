use aetrain_domain::{CityId, GeoPoint, StationId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryAuthorityRole {
    MunicipalityIdentity,
    CityIdentity,
    StationIdentity,
    StationCityMembership,
    Enrichment,
    InterestSignal,
    FeedEvidence,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryTrustTier {
    Official,
    LinkedOpenData,
    Community,
    Derived,
    ManualOverride,
}

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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GeoBounds {
    pub min_lat: f64,
    pub min_lon: f64,
    pub max_lat: f64,
    pub max_lon: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalRecordRef {
    pub source_id: String,
    pub external_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_role: Option<RegistryAuthorityRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_tier: Option<RegistryTrustTier>,
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
    pub slug: String,
    pub display_name: String,
    pub country_code: String,
    pub identity_point: GeoPoint,
    pub map_anchor_point: GeoPoint,
    pub bbox: Option<GeoBounds>,
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
pub enum RegistryEvidenceKind {
    OfficialCode,
    PolygonContainment,
    CoordinateContainment,
    NameAliasMatch,
    WikidataSitelink,
    OsmTag,
    ManualOverride,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryCityAuthorityEvidence {
    pub city_id: CityId,
    pub source_ref: ExternalRecordRef,
    pub evidence_kind: RegistryEvidenceKind,
    pub confidence: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryStationCityMembershipEvidence {
    pub city_id: CityId,
    pub station_id: StationId,
    pub source_ref: ExternalRecordRef,
    pub evidence_kind: RegistryEvidenceKind,
    pub confidence: u8,
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
pub struct RegistryCityFacts {
    pub city_id: CityId,
    pub station_count: Option<u32>,
    pub museum_count: Option<u32>,
    pub unesco_site_count: Option<u32>,
    pub protected_area_distance_km: Option<f32>,
    pub coastline_distance_km: Option<f32>,
    #[serde(default)]
    pub source_refs: Vec<ExternalRecordRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryCitySignals {
    pub city_id: CityId,
    pub nature_interest_score: Option<u8>,
    pub historical_interest_score: Option<u8>,
    pub museum_interest_score: Option<u8>,
    pub scenic_score: Option<u8>,
    pub score_version: Option<String>,
    pub computed_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryCanonicalBundle {
    pub meta: RegistryMeta,
    pub cities: Vec<RegistryCity>,
    pub stations: Vec<RegistryStation>,
    pub memberships: Vec<RegistryCityStationMembership>,
    pub name_variants: Vec<RegistryNameVariant>,
    pub city_facts: Vec<RegistryCityFacts>,
    pub city_signals: Vec<RegistryCitySignals>,
    #[serde(default)]
    pub city_authority_evidence: Vec<RegistryCityAuthorityEvidence>,
    #[serde(default)]
    pub membership_evidence: Vec<RegistryStationCityMembershipEvidence>,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryCityFactsCollection {
    pub meta: RegistryMeta,
    pub facts: Vec<RegistryCityFacts>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryCitySignalsCollection {
    pub meta: RegistryMeta,
    pub signals: Vec<RegistryCitySignals>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryCityAuthorityEvidenceCollection {
    pub meta: RegistryMeta,
    pub evidence: Vec<RegistryCityAuthorityEvidence>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryStationCityMembershipEvidenceCollection {
    pub meta: RegistryMeta,
    pub evidence: Vec<RegistryStationCityMembershipEvidence>,
}
