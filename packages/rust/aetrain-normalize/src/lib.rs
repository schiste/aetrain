mod fetch;
mod manifest;
mod sncf;

pub use fetch::{
    FetchStatus, FetchedSource, SourceStateRecord, SourceStateRegistry, fetch_sources,
    load_source_state_registry,
};
pub use manifest::{
    IssueSeverity, ManualCityOverride, ManualOverrideRegistry, NormalizationIssue,
    SourceDefinition, SourceKind, SourceManifest,
};
pub use sncf::{
    DEFAULT_DUPLICATE_DISTANCE_METERS, DuplicateCityCandidate, DuplicateCityReport,
    SncfBuildOutput, SncfBuildSummary, build_sncf_dataset,
};
