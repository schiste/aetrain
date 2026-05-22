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
mod wikidata;

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
pub use wikidata::{WikidataCityObservation, WikidataStationObservation};
