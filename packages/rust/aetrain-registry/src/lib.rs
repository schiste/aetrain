mod artifacts;
mod audit;
mod city_identity;
mod country_inference;
mod cursor;
mod incremental;
mod manifest;
mod merge;
mod name_rules;
mod osm;
mod partition;
mod schema;
mod seed;
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
pub use incremental::{IncrementalPlan, build_incremental_plan};
pub use manifest::{
    RegistryAccessStrategy, RegistryEntityKind, RegistryManifest, RegistryProvider,
    RegistryRefreshStrategy, RegistrySourceDefinition, RegistryTargetDefinition,
};
pub use merge::{MergedRegistryCities, merge_registry_cities};
pub use name_rules::{NameRule, NameRuleAction, NameRuleScope, NameRuleSet, apply_name_rules};
pub use osm::{OsmPlaceObservation, OsmRelationRef, OsmStationObservation};
pub use partition::{RegistryPartition, partition_bundle_by_country};
pub use schema::{
    ExternalRecordRef, RegistryCanonicalBundle, RegistryCity, RegistryCityCollection,
    RegistryCityStationMembership, RegistryMeta, RegistryNameVariant,
    RegistryNameVariantCollection, RegistryNameVariantKind, RegistryObservationSource,
    RegistryStation, RegistryStationCollection, RegistryStatus,
};
pub use seed::{SeedPlan, build_seed_plan};
pub use wikidata::{WikidataCityObservation, WikidataStationObservation};
