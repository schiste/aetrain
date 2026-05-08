mod fetch;
mod manifest;
mod pipeline;
mod sncf;

pub use fetch::{
    FetchStatus, FetchedSource, SourceStateRecord, SourceStateRegistry, fetch_sources,
    load_source_state_registry, resolve_cached_sources,
};
pub use manifest::{
    IssueSeverity, ManualCityOverride, ManualOverrideRegistry, NormalizationIssue,
    SourceDefinition, SourceKind, SourceManifest, TargetDefinition,
};
pub use pipeline::{
    AdapterBuildArtifacts, AdapterBuildRequest, PipelineAdapter, PipelineArtifactManifest,
    PipelineAttributionFile, PipelineBuildSummary, PipelineOutputPaths, PipelineSourceArtifact,
    build_pipeline_target, sync_web_debug_artifacts,
};
pub use sncf::{
    BasicGtfsBuildOutput, BasicGtfsBuildSummary, DEFAULT_DUPLICATE_DISTANCE_METERS,
    DuplicateCityCandidate, DuplicateCityReport, SncfBuildOutput, SncfBuildSummary,
    StationMappingRecord, StationMappingReport, StationMappingStrategy, build_gtfs_basic_dataset,
    build_sncf_dataset, bundle_from_basic_output, bundle_from_output,
};
