use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

use aetrain_dataset::{DatasetBundle, DatasetMeta, SourceSnapshot};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::{
    DuplicateCityReport, FetchedSource, ManualOverrideRegistry, NormalizationIssue, SourceKind,
    SourceManifest, TargetDefinition, build_sncf_dataset, bundle_from_output,
};

pub trait PipelineAdapter {
    fn adapter_id(&self) -> &'static str;
    fn build(&self, request: AdapterBuildRequest<'_>) -> Result<AdapterBuildArtifacts>;
}

#[derive(Clone, Copy)]
struct SncfAdapter;

#[derive(Clone)]
pub struct AdapterBuildRequest<'a> {
    pub manifest: &'a SourceManifest,
    pub target: &'a TargetDefinition,
    pub sources: Vec<&'a FetchedSource>,
    pub dataset_version: &'a str,
    pub generated_at: &'a str,
    pub source_snapshots: Vec<SourceSnapshot>,
    pub overrides: &'a ManualOverrideRegistry,
}

impl<'a> AdapterBuildRequest<'a> {
    pub fn source_by_kind(&self, kind: SourceKind) -> Result<&'a FetchedSource> {
        self.sources
            .iter()
            .copied()
            .find(|source| source.definition.kind == kind)
            .with_context(|| format!("target {} is missing a {:?} source", self.target.id, kind))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AdapterBuildArtifacts {
    pub canonical: DatasetBundle,
    pub duplicates: DuplicateCityReport,
    pub issues: Vec<NormalizationIssue>,
    pub counters: BTreeMap<String, u64>,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineBuildSummary {
    pub city_count: usize,
    pub station_count: usize,
    pub edge_count: usize,
    pub alias_count: usize,
    pub duplicate_count: usize,
    pub issue_count: usize,
    pub counters: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineSourceArtifact {
    pub source_id: String,
    pub local_path: String,
    pub fetched_at: String,
    pub sha256: String,
    pub version_hint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineOutputPaths {
    pub target_root: String,
    pub canonical_dir: Option<String>,
    pub web_debug_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineArtifactManifest {
    pub dataset_id: String,
    pub target_id: String,
    pub adapter: String,
    pub dataset_version: String,
    pub generated_at: String,
    pub source_snapshots: Vec<SourceSnapshot>,
    pub source_artifacts: Vec<PipelineSourceArtifact>,
    pub outputs: PipelineOutputPaths,
    pub summary: PipelineBuildSummary,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineAttributionFile {
    pub dataset_id: String,
    pub target_id: String,
    pub dataset_version: String,
    pub generated_at: String,
    pub sources: Vec<PipelineSourceArtifact>,
}

pub fn build_pipeline_target(
    manifest: &SourceManifest,
    target: &TargetDefinition,
    fetched_sources: &[FetchedSource],
    overrides: &ManualOverrideRegistry,
    output_root: &Path,
    dataset_version: &str,
    generated_at: &str,
) -> Result<PipelineArtifactManifest> {
    let source_map = fetched_sources
        .iter()
        .map(|source| (source.definition.id.clone(), source))
        .collect::<HashMap<_, _>>();
    let sources = target
        .source_ids
        .iter()
        .map(|source_id| {
            source_map.get(source_id).copied().with_context(|| {
                format!(
                    "target {} references missing source {}",
                    target.id, source_id
                )
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let source_snapshots = sources
        .iter()
        .map(|source| SourceSnapshot {
            source_id: source.definition.id.clone(),
            fetched_at: source.fetched_at.clone(),
            version_hint: source
                .probe_version
                .clone()
                .or_else(|| source.etag.clone())
                .or_else(|| source.last_modified.clone()),
        })
        .collect::<Vec<_>>();

    let request = AdapterBuildRequest {
        manifest,
        target,
        sources: sources.clone(),
        dataset_version,
        generated_at,
        source_snapshots: source_snapshots.clone(),
        overrides,
    };

    let adapter = adapter_for(&target.adapter)
        .with_context(|| format!("unsupported adapter {}", target.adapter))?;
    let artifacts = adapter.build(request)?;
    export_pipeline_target(
        manifest,
        target,
        &artifacts,
        &sources,
        output_root,
        dataset_version,
        generated_at,
        source_snapshots,
    )
}

pub fn sync_web_debug_artifacts(
    artifact_manifest: &PipelineArtifactManifest,
    destination: &Path,
) -> Result<()> {
    let Some(source_dir) = artifact_manifest.outputs.web_debug_dir.as_ref() else {
        bail!(
            "target {} does not export runtime/web-debug artifacts",
            artifact_manifest.target_id
        );
    };

    let source_dir = PathBuf::from(source_dir);
    fs::create_dir_all(destination)
        .with_context(|| format!("failed to create {}", destination.display()))?;

    for file_name in ["meta.json", "cities.json", "edges.json", "attribution.json"] {
        fs::copy(source_dir.join(file_name), destination.join(file_name)).with_context(|| {
            format!(
                "failed to copy {} into {}",
                file_name,
                destination.display()
            )
        })?;
    }

    Ok(())
}

fn export_pipeline_target(
    manifest: &SourceManifest,
    target: &TargetDefinition,
    artifacts: &AdapterBuildArtifacts,
    sources: &[&FetchedSource],
    output_root: &Path,
    dataset_version: &str,
    generated_at: &str,
    source_snapshots: Vec<SourceSnapshot>,
) -> Result<PipelineArtifactManifest> {
    let target_root = output_root.join(&target.id);
    fs::create_dir_all(&target_root)
        .with_context(|| format!("failed to create {}", target_root.display()))?;

    let attribution = PipelineAttributionFile {
        dataset_id: manifest.dataset_id.clone(),
        target_id: target.id.clone(),
        dataset_version: dataset_version.to_string(),
        generated_at: generated_at.to_string(),
        sources: sources
            .iter()
            .map(|source| PipelineSourceArtifact {
                source_id: source.definition.id.clone(),
                local_path: source.local_path.display().to_string(),
                fetched_at: source.fetched_at.clone(),
                sha256: source.sha256.clone(),
                version_hint: source
                    .probe_version
                    .clone()
                    .or_else(|| source.etag.clone())
                    .or_else(|| source.last_modified.clone()),
            })
            .collect(),
    };

    let canonical_dir = if target.canonical_export {
        let canonical_dir = target_root.join("canonical");
        fs::create_dir_all(&canonical_dir)
            .with_context(|| format!("failed to create {}", canonical_dir.display()))?;
        export_canonical_bundle(&canonical_dir, artifacts, &attribution)?;
        Some(canonical_dir)
    } else {
        None
    };

    let web_debug_dir = if target.web_debug_export {
        let runtime_dir = target_root.join("runtime").join("web-debug");
        fs::create_dir_all(&runtime_dir)
            .with_context(|| format!("failed to create {}", runtime_dir.display()))?;
        export_web_debug_bundle(
            &runtime_dir,
            &artifacts.canonical.meta,
            &artifacts.canonical,
            &attribution,
        )?;
        Some(runtime_dir)
    } else {
        None
    };

    let summary = PipelineBuildSummary {
        city_count: artifacts.canonical.cities.len(),
        station_count: artifacts.canonical.stations.len(),
        edge_count: artifacts.canonical.edges.len(),
        alias_count: artifacts.canonical.aliases.len(),
        duplicate_count: artifacts.duplicates.candidates.len(),
        issue_count: artifacts.issues.len(),
        counters: artifacts.counters.clone(),
    };

    let artifact_manifest = PipelineArtifactManifest {
        dataset_id: manifest.dataset_id.clone(),
        target_id: target.id.clone(),
        adapter: target.adapter.clone(),
        dataset_version: dataset_version.to_string(),
        generated_at: generated_at.to_string(),
        source_snapshots,
        source_artifacts: attribution.sources.clone(),
        outputs: PipelineOutputPaths {
            target_root: target_root.display().to_string(),
            canonical_dir: canonical_dir
                .as_ref()
                .map(|path| path.display().to_string()),
            web_debug_dir: web_debug_dir
                .as_ref()
                .map(|path| path.display().to_string()),
        },
        summary,
        notes: artifacts.notes.clone(),
    };

    write_json(
        &target_root.join("artifact-manifest.json"),
        &artifact_manifest,
    )?;
    write_json(
        &target_root.join("summary.json"),
        &artifact_manifest.summary,
    )?;
    Ok(artifact_manifest)
}

fn export_canonical_bundle(
    output_dir: &Path,
    artifacts: &AdapterBuildArtifacts,
    attribution: &PipelineAttributionFile,
) -> Result<()> {
    write_json(&output_dir.join("bundle.json"), &artifacts.canonical)?;
    write_json(&output_dir.join("meta.json"), &artifacts.canonical.meta)?;
    write_json(&output_dir.join("cities.json"), &artifacts.canonical.cities)?;
    write_json(
        &output_dir.join("stations.json"),
        &artifacts.canonical.stations,
    )?;
    write_json(&output_dir.join("edges.json"), &artifacts.canonical.edges)?;
    write_json(
        &output_dir.join("aliases.json"),
        &artifacts.canonical.aliases,
    )?;
    write_json(
        &output_dir.join("duplicate-candidates.json"),
        &artifacts.duplicates,
    )?;
    write_json(&output_dir.join("issues.json"), &artifacts.issues)?;
    write_json(&output_dir.join("attribution.json"), attribution)?;
    Ok(())
}

fn export_web_debug_bundle(
    output_dir: &Path,
    meta: &DatasetMeta,
    canonical: &DatasetBundle,
    attribution: &PipelineAttributionFile,
) -> Result<()> {
    write_json(&output_dir.join("meta.json"), meta)?;
    write_json(&output_dir.join("cities.json"), &canonical.cities)?;
    write_json(&output_dir.join("edges.json"), &canonical.edges)?;
    write_json(&output_dir.join("attribution.json"), attribution)?;
    Ok(())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).context("failed to serialize JSON output")?;
    fs::write(path, bytes).with_context(|| format!("failed to write {}", path.display()))
}

fn adapter_for(adapter_id: &str) -> Option<&'static dyn PipelineAdapter> {
    static SNCF_ADAPTER: SncfAdapter = SncfAdapter;

    match adapter_id {
        "sncf_fr" => Some(&SNCF_ADAPTER),
        _ => None,
    }
}

impl PipelineAdapter for SncfAdapter {
    fn adapter_id(&self) -> &'static str {
        "sncf_fr"
    }

    fn build(&self, request: AdapterBuildRequest<'_>) -> Result<AdapterBuildArtifacts> {
        let gtfs = request.source_by_kind(SourceKind::Gtfs)?;
        let stations = request.source_by_kind(SourceKind::Supplementary)?;

        if !request.overrides.is_empty() {
            bail!(
                "adapter {} does not yet apply manual overrides; clear overrides or implement override application first",
                self.adapter_id()
            );
        }

        let output = build_sncf_dataset(
            &gtfs.local_path,
            &stations.local_path,
            request.dataset_version,
            request.generated_at,
            request.source_snapshots,
        )?;

        let counters = BTreeMap::from([
            (
                "station_reference_count".to_string(),
                output.summary.station_reference_count as u64,
            ),
            (
                "gtfs_station_count".to_string(),
                output.summary.gtfs_station_count as u64,
            ),
            (
                "matched_station_count".to_string(),
                output.summary.matched_station_count as u64,
            ),
            (
                "unmatched_station_count".to_string(),
                output.summary.unmatched_station_count as u64,
            ),
        ]);

        Ok(AdapterBuildArtifacts {
            canonical: bundle_from_output(&output),
            duplicates: output.duplicates,
            issues: output.issues,
            counters,
            notes: vec![
                format!("adapter={}", self.adapter_id()),
                format!("target={}", request.target.id),
            ],
        })
    }
}
