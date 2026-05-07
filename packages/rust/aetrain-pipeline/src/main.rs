use std::{
    env, fs,
    path::{Path, PathBuf},
};

use aetrain_normalize::{
    FetchStatus, SourceKind, SourceManifest, build_sncf_dataset, fetch_sources,
};
use anyhow::{Context, Result, bail};
use serde_json::to_vec_pretty;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn main() -> Result<()> {
    let args = Args::parse(env::args().skip(1).collect())?;
    run(args)
}

#[derive(Debug)]
struct Args {
    manifest_path: PathBuf,
    cache_root: PathBuf,
    output_root: PathBuf,
    force: bool,
}

impl Args {
    fn parse(args: Vec<String>) -> Result<Self> {
        let mut manifest_path = PathBuf::from("data/manifests/stage1.sources.toml");
        let mut cache_root = PathBuf::from("data/cache");
        let mut output_root = PathBuf::from("data/build/stage1");
        let mut force = false;

        let mut index = 0usize;
        while index < args.len() {
            match args[index].as_str() {
                "run" => {}
                "--manifest" => {
                    index += 1;
                    manifest_path =
                        PathBuf::from(args.get(index).context("missing value for --manifest")?);
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
            manifest_path,
            cache_root,
            output_root,
            force,
        })
    }
}

fn run(args: Args) -> Result<()> {
    let manifest = SourceManifest::load(&args.manifest_path)?;
    let fetched = fetch_sources(&manifest, &args.cache_root, args.force)?;

    let generated_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .context("failed to format build timestamp")?;
    let dataset_version = generated_at
        .replace([':', '-'], "")
        .replace('T', "-")
        .replace('Z', "");

    let sncf_gtfs = fetched
        .iter()
        .find(|source| {
            source.definition.adapter == "sncf_fr" && source.definition.kind == SourceKind::Gtfs
        })
        .context("missing active SNCF GTFS source in manifest")?;
    let sncf_stations = fetched
        .iter()
        .find(|source| {
            source.definition.adapter == "sncf_fr"
                && source.definition.kind == SourceKind::Supplementary
        })
        .context("missing active SNCF station reference source in manifest")?;

    let output = build_sncf_dataset(
        &sncf_gtfs.local_path,
        &sncf_stations.local_path,
        &dataset_version,
        &generated_at,
        fetched
            .iter()
            .map(|source| aetrain_dataset::SourceSnapshot {
                source_id: source.definition.id.clone(),
                fetched_at: source.fetched_at.clone(),
                version_hint: source.etag.clone().or_else(|| source.last_modified.clone()),
            })
            .collect(),
    )?;

    let output_dir = args.output_root.join("sncf-fr");
    fs::create_dir_all(&output_dir)
        .with_context(|| format!("failed to create {}", output_dir.display()))?;

    write_json(&output_dir.join("meta.json"), &output.meta)?;
    write_json(&output_dir.join("cities.json"), &output.cities)?;
    write_json(&output_dir.join("stations.json"), &output.stations)?;
    write_json(&output_dir.join("edges.json"), &output.edges)?;
    write_json(&output_dir.join("aliases.json"), &output.aliases)?;
    write_json(
        &output_dir.join("duplicate-candidates.json"),
        &output.duplicates,
    )?;
    write_json(&output_dir.join("issues.json"), &output.issues)?;
    write_json(&output_dir.join("summary.json"), &output.summary)?;

    println!("pipeline completed");
    println!("manifest: {}", args.manifest_path.display());
    println!("output: {}", output_dir.display());
    for source in &fetched {
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
    println!(
        "cities={} stations={} edges={} duplicate_candidates={} issues={}",
        output.summary.city_count,
        output.summary.station_count,
        output.summary.edge_count,
        output.summary.duplicate_count,
        output.summary.issue_count
    );

    Ok(())
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    let bytes = to_vec_pretty(value).context("failed to serialize JSON output")?;
    fs::write(path, bytes).with_context(|| format!("failed to write {}", path.display()))
}

fn print_help() {
    println!(
        "Usage: cargo run -p aetrain-pipeline -- [run] [--manifest PATH] [--cache-root DIR] [--output-root DIR] [--force]"
    );
}
