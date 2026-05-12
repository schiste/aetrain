use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
};

use aetrain_normalize::{
    FetchStatus, FetchedSource, ManualOverrideRegistry, PipelineArtifactManifest, SourceManifest,
    TargetDefinition, build_pipeline_target, fetch_sources, resolve_cached_sources,
    sync_web_debug_artifacts,
};
use anyhow::{Context, Result, bail};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn main() -> Result<()> {
    let args = Args::parse(env::args().skip(1).collect())?;
    run(args)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    Run,
    Fetch,
    Build,
}

#[derive(Debug)]
struct Args {
    command: Command,
    manifest_path: PathBuf,
    overrides_path: PathBuf,
    cache_root: PathBuf,
    output_root: PathBuf,
    target_ids: Vec<String>,
    sync_web_debug: Option<PathBuf>,
    force: bool,
}

impl Args {
    fn parse(args: Vec<String>) -> Result<Self> {
        let mut command = Command::Run;
        let mut manifest_path = PathBuf::from("data/manifests/stage1.sources.toml");
        let mut overrides_path = PathBuf::from("data/overrides/city-overrides.toml");
        let mut cache_root = PathBuf::from("data/cache");
        let mut output_root = PathBuf::from("data/build/stage1");
        let mut target_ids = Vec::new();
        let mut sync_web_debug = None;
        let mut force = false;

        let mut index = 0usize;
        while index < args.len() {
            match args[index].as_str() {
                "run" => command = Command::Run,
                "fetch" => command = Command::Fetch,
                "build" => command = Command::Build,
                "--manifest" => {
                    index += 1;
                    manifest_path =
                        PathBuf::from(args.get(index).context("missing value for --manifest")?);
                }
                "--overrides" => {
                    index += 1;
                    overrides_path =
                        PathBuf::from(args.get(index).context("missing value for --overrides")?);
                }
                "--cache-root" => {
                    index += 1;
                    cache_root =
                        PathBuf::from(args.get(index).context("missing value for --cache-root")?);
                }
                "--output-root" => {
                    index += 1;
                    output_root =
                        PathBuf::from(args.get(index).context("missing value for --output-root")?);
                }
                "--target" => {
                    index += 1;
                    target_ids.push(
                        args.get(index)
                            .context("missing value for --target")?
                            .to_string(),
                    );
                }
                "--sync-web-debug" => {
                    index += 1;
                    sync_web_debug = Some(PathBuf::from(
                        args.get(index)
                            .context("missing value for --sync-web-debug")?,
                    ));
                }
                "--force" => force = true,
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => bail!("unknown argument: {other}"),
            }
            index += 1;
        }

        Ok(Self {
            command,
            manifest_path,
            overrides_path,
            cache_root,
            output_root,
            target_ids,
            sync_web_debug,
            force,
        })
    }
}

fn run(args: Args) -> Result<()> {
    let manifest = SourceManifest::load(&args.manifest_path)?;

    match args.command {
        Command::Fetch => {
            let scoped_manifest = fetch_manifest_scope(&manifest, &args.target_ids)?;
            let fetched = fetch_sources(&scoped_manifest, &args.cache_root, args.force)?;
            print_fetch_summary(&args.manifest_path, &fetched);
            Ok(())
        }
        Command::Build => {
            let scoped_manifest = build_manifest_scope(&manifest, &args.target_ids)?;
            let fetched = resolve_cached_sources(&scoped_manifest, &args.cache_root)?;
            let artifacts = build_targets(&manifest, &args, &fetched)?;
            print_fetch_summary(&args.manifest_path, &fetched);
            print_build_summary(&artifacts);
            Ok(())
        }
        Command::Run => {
            // Fetch must walk the full target closure (an aggregate
            // target like europe-validated has source_ids=[] but
            // depends on national targets that carry the actual GTFS
            // source ids). build_manifest_scope intentionally returns
            // only the directly-requested targets; using it here meant
            // fetch saw zero sources, returned an empty Vec, and the
            // subsequent build step then died with "missing source".
            let scoped_manifest = fetch_manifest_scope(&manifest, &args.target_ids)?;
            let fetched = fetch_sources(&scoped_manifest, &args.cache_root, args.force)?;
            let artifacts = build_targets(&manifest, &args, &fetched)?;
            print_fetch_summary(&args.manifest_path, &fetched);
            print_build_summary(&artifacts);
            Ok(())
        }
    }
}

fn build_targets(
    manifest: &SourceManifest,
    args: &Args,
    fetched_sources: &[FetchedSource],
) -> Result<Vec<PipelineArtifactManifest>> {
    let overrides = ManualOverrideRegistry::load(&args.overrides_path)?;
    let requested_targets = manifest.resolve_targets(&args.target_ids)?;
    let targets = if matches!(args.command, Command::Run) {
        manifest.resolve_target_closure(&args.target_ids)?
    } else {
        requested_targets.clone()
    };
    let requested_target_ids = requested_targets
        .iter()
        .map(|target| target.id.as_str())
        .collect::<HashSet<_>>();
    let generated_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .context("failed to format build timestamp")?;
    let dataset_version = generated_at
        .replace([':', '-'], "")
        .replace('T', "-")
        .replace('Z', "");

    let mut artifacts = Vec::new();
    for target in targets {
        let artifact = build_pipeline_target(
            manifest,
            args.manifest_path.parent().unwrap_or(Path::new(".")),
            target,
            fetched_sources,
            &overrides,
            &args.output_root,
            &dataset_version,
            &generated_at,
        )
        .with_context(|| format!("failed to build target {}", target.id))?;
        artifacts.push(artifact);
    }

    if let Some(sync_root) = &args.sync_web_debug {
        let selected_artifacts = artifacts
            .iter()
            .filter(|artifact| requested_target_ids.contains(artifact.target_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        sync_runtime_projections(sync_root, &selected_artifacts)?;
    }

    Ok(artifacts)
}

fn sync_runtime_projections(
    sync_root: &Path,
    artifacts: &[PipelineArtifactManifest],
) -> Result<()> {
    if artifacts.is_empty() {
        return Ok(());
    }

    if artifacts.len() == 1 {
        sync_web_debug_artifacts(&artifacts[0], sync_root).with_context(|| {
            format!(
                "failed to sync target {} into {}",
                artifacts[0].target_id,
                sync_root.display()
            )
        })?;
        return Ok(());
    }

    for artifact in artifacts {
        let target_dir = sync_root.join(&artifact.target_id);
        sync_web_debug_artifacts(artifact, &target_dir).with_context(|| {
            format!(
                "failed to sync target {} into {}",
                artifact.target_id,
                target_dir.display()
            )
        })?;
    }

    Ok(())
}

fn fetch_manifest_scope(
    manifest: &SourceManifest,
    target_ids: &[String],
) -> Result<SourceManifest> {
    let targets = manifest.resolve_target_closure(target_ids)?;
    Ok(scoped_manifest_for_targets(manifest, &targets))
}

fn build_manifest_scope(
    manifest: &SourceManifest,
    target_ids: &[String],
) -> Result<SourceManifest> {
    let targets = manifest.resolve_targets(target_ids)?;
    Ok(scoped_manifest_for_targets(manifest, &targets))
}

fn scoped_manifest_for_targets(
    manifest: &SourceManifest,
    targets: &[&TargetDefinition],
) -> SourceManifest {
    let source_ids = targets
        .iter()
        .flat_map(|target| target.source_ids.iter().cloned())
        .collect::<HashSet<_>>();
    let target_ids = targets
        .iter()
        .map(|target| target.id.as_str())
        .collect::<HashSet<_>>();

    let mut scoped = manifest.clone();
    scoped.sources = manifest
        .sources
        .iter()
        .filter(|source| source_ids.contains(&source.id))
        .cloned()
        .collect();
    scoped.targets = manifest
        .targets
        .iter()
        .filter(|target| target_ids.contains(target.id.as_str()))
        .cloned()
        .collect();
    scoped
}

fn print_fetch_summary(manifest_path: &Path, fetched: &[FetchedSource]) {
    println!("pipeline fetch completed");
    println!("manifest: {}", manifest_path.display());
    for source in fetched {
        let status = match source.status {
            FetchStatus::Downloaded => "downloaded",
            FetchStatus::SkippedUpToDate => "up-to-date",
        };
        println!(
            "source {}: {} ({})",
            source.definition.id,
            status,
            source.local_path.display()
        );
    }
}

fn print_build_summary(artifacts: &[PipelineArtifactManifest]) {
    println!("pipeline build completed");
    for artifact in artifacts {
        println!(
            "target {}: root={} cities={} stations={} edges={} aliases={} duplicates={} issues={}",
            artifact.target_id,
            artifact.outputs.target_root,
            artifact.summary.city_count,
            artifact.summary.station_count,
            artifact.summary.edge_count,
            artifact.summary.alias_count,
            artifact.summary.duplicate_count,
            artifact.summary.issue_count
        );
        if let Some(canonical_dir) = &artifact.outputs.canonical_dir {
            println!("  canonical: {}", canonical_dir);
        }
        if let Some(web_dir) = &artifact.outputs.web_dir {
            println!("  runtime/web: {}", web_dir);
        }
        if let Some(web_debug_dir) = &artifact.outputs.web_debug_dir {
            println!("  runtime/web-debug: {}", web_debug_dir);
        }
    }
}

fn print_help() {
    println!("Usage:");
    println!("  cargo run -p aetrain-pipeline -- [run|fetch|build] [options]");
    println!();
    println!("Options:");
    println!(
        "  --manifest PATH         Manifest file (default: data/manifests/stage1.sources.toml)"
    );
    println!(
        "  --overrides PATH        Override file (default: data/overrides/city-overrides.toml)"
    );
    println!("  --cache-root DIR        Raw source cache directory (default: data/cache)");
    println!("  --output-root DIR       Build artifact root (default: data/build/stage1)");
    println!("  --target TARGET_ID      Target to build (repeatable)");
    println!("  --sync-web-debug DIR    Copy runtime/web-debug artifacts into DIR after build");
    println!("  --force                 Force source re-download during fetch/run");
}
