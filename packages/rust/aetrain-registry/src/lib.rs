mod artifacts;
mod audit;
mod city_identity;
mod country_inference;
mod cursor;
mod fr_authority;
mod incremental;
mod insee;
mod manifest;
mod merge;
mod name_rules;
mod osm;
mod partition;
mod pilot;
mod schema;
mod seed;
mod slice;
mod sncf;
mod source_quality;
mod station_authority;
mod station_complex;
mod station_match;
mod station_quality;
mod station_rail_anchor;
mod wikidata;
mod wikidata_station;

pub use artifacts::{
    RegistryAuditArtifacts, RegistryBuildLayout, RegistryCanonicalArtifacts, read_json,
    read_json_lines, write_json, write_json_lines,
};
pub use audit::{
    RegistryAuditFinding, RegistryAuditFindingKind, RegistryAuditSeverity,
    classify_city_name_issue, classify_city_pair,
};
pub use city_identity::{
    build_city_identity_key, build_city_identity_stem, canonical_city_display_name,
    is_station_qualified_name,
};
pub use country_inference::{
    CountryInferenceInput, CountryInferenceReason, CountryInferenceResult, infer_country,
};
pub use cursor::{
    RegistryCursorMode, RegistrySourceCursor, RegistrySourceCursorState, load_cursor, save_cursor,
};
pub use fr_authority::{FranceAuthorityBuildSummary, build_france_authority_registry};
pub use incremental::{IncrementalPlan, build_incremental_plan};
pub use insee::InseeCommuneObservation;
pub use manifest::{
    RegistryAccessStrategy, RegistryEntityKind, RegistryManifest, RegistryProvider,
    RegistryRefreshStrategy, RegistrySourceDefinition, RegistryTargetDefinition,
};
pub use merge::{MergedRegistryCities, merge_registry_cities};
pub use name_rules::{NameRule, NameRuleAction, NameRuleScope, NameRuleSet, apply_name_rules};
pub use osm::{OsmPlaceObservation, OsmRelationRef, OsmStationObservation};
pub use partition::{RegistryPartition, partition_bundle_by_country};
pub use pilot::{PilotBuildSummary, build_pilot_registry};
pub use schema::{
    ExternalRecordRef, GeoBounds, RegistryAuthorityRole, RegistryCanonicalBundle, RegistryCity,
    RegistryCityAuthorityEvidence, RegistryCityAuthorityEvidenceCollection, RegistryCityCollection,
    RegistryCityFacts, RegistryCityFactsCollection, RegistryCitySignals,
    RegistryCitySignalsCollection, RegistryCityStationMembership, RegistryEvidenceKind,
    RegistryMeta, RegistryNameVariant, RegistryNameVariantCollection, RegistryNameVariantKind,
    RegistryObservationSource, RegistryStation, RegistryStationCityMembershipEvidence,
    RegistryStationCityMembershipEvidenceCollection, RegistryStationCollection, RegistryStatus,
    RegistryTrustTier,
};
pub use seed::{SeedPlan, build_seed_plan};
pub use slice::{WikidataCitySliceSummary, build_wikidata_city_slice};
pub use sncf::SncfStationReferenceObservation;
pub use source_quality::{
    RegistryRecordAuthorityStrength, RegistrySourceContractFinding, RegistrySourceCoverageRecord,
    RegistrySourceCoverageReport, audit_registry_source_contract,
    build_registry_source_coverage_report, city_authority_strength,
};
pub use station_authority::{
    StationAuthorityArtifact, StationAuthorityRecord, StationAuthorityRef, StationAuthorityRefKind,
    StationEnrichmentArtifact, StationEnrichmentRecord, StationIdentityResolutionStatus,
    StationMatchEvidence, StationMatchEvidenceKind, build_station_authority_artifact,
    build_station_enrichment_artifact,
};
pub use station_complex::{
    StationComplexArtifact, StationComplexRecord, build_station_complex_artifact,
};
pub use station_match::{
    is_customer_facing_rail_station, is_non_mainline_transport, is_valid_wikidata_qid,
};
pub use station_quality::{
    StationQualityArtifact, StationQualityFlag, StationQualityFlagKind, StationQualityRecord,
    StationQualitySeverity, audit_station_quality,
};
pub use station_rail_anchor::{
    StationRailAnchorArtifact, StationRailAnchorRecord, StationRailAnchorStrategy,
    build_station_rail_anchor_artifact,
};
pub use wikidata::{WikidataCityObservation, WikidataStationObservation};
pub use wikidata_station::{
    WikidataStationClaimSnapshot, WikidataStationClassification, classify_wikidata_station,
};
