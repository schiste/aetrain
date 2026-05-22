use std::{env, path::PathBuf};

use aetrain_registry::{RegistryManifest, build_registry_source_coverage_report, write_json};
use anyhow::{Context, Result};

fn main() -> Result<()> {
    let repo_root = env::current_dir().context("failed to resolve current directory")?;
    let mut args = env::args().skip(1);
    let manifest_path = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root.join("data/manifests/registry.europe.toml"));
    let output_path = args.next().map(PathBuf::from);

    let manifest = RegistryManifest::load(&manifest_path)?;
    let report = build_registry_source_coverage_report(&manifest);

    if let Some(path) = output_path {
        write_json(&path, &report)?;
    } else {
        println!("{}", serde_json::to_string_pretty(&report)?);
    }

    Ok(())
}
