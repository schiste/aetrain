use std::path::PathBuf;

use aetrain_registry::build_wikidata_city_slice;
use anyhow::Result;

fn main() -> Result<()> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()?;
    let output_root = repo_root.join("data/registry/fixtures/fr-wikidata-10");
    let summary = build_wikidata_city_slice(
        "aetrain-registry-fr-wikidata-10",
        "fr-wikidata-10",
        "2026-05-10T00:00:00Z",
        &repo_root.join("data/registry/raw/wikidata/fr-city-enrichment-10.jsonl"),
        &repo_root.join("data/registry/overrides/city-name-rules.toml"),
        &output_root,
    )?;

    println!(
        "wikidata slice: cities={} aliases={}",
        summary.city_count, summary.alias_count
    );
    println!("output_root={}", output_root.display());
    Ok(())
}
