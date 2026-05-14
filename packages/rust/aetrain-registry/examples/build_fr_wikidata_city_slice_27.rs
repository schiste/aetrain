use std::path::PathBuf;

use aetrain_registry::build_wikidata_city_slice;
use anyhow::Result;

fn main() -> Result<()> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()?;
    let output_root = repo_root.join("data/registry/fixtures/fr-wikidata-27");
    let summary = build_wikidata_city_slice(
        "aetrain-registry-fr-wikidata-27",
        "fr-wikidata-27",
        "2026-05-14T00:00:00Z",
        &repo_root.join("data/registry/raw/wikidata/fr-city-enrichment-27.jsonl"),
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
