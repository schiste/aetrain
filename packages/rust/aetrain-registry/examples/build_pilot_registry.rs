use std::path::PathBuf;

use aetrain_registry::build_pilot_registry;
use anyhow::Result;

fn main() -> Result<()> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()?;
    let output_root = repo_root.join("data/registry/build/pilot");
    let summary = build_pilot_registry(
        "aetrain-registry-pilot",
        "pilot",
        "2026-05-09T00:00:00Z",
        &repo_root.join("data/registry/raw/wikidata/pilot-city-observations.jsonl"),
        &repo_root.join("data/registry/raw/osm/pilot-station-observations.jsonl"),
        &repo_root.join("data/registry/overrides/city-name-rules.toml"),
        &output_root,
    )?;

    println!(
        "pilot registry: cities={} stations={} memberships={} audit={}",
        summary.city_count, summary.station_count, summary.membership_count, summary.audit_count
    );
    println!("output_root={}", output_root.display());
    Ok(())
}
