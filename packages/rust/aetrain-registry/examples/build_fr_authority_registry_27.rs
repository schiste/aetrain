use aetrain_registry::build_france_authority_registry;
use anyhow::{Context, Result};

fn main() -> Result<()> {
    let repo_root = std::env::current_dir().context("failed to resolve repository root")?;
    let output_root = repo_root.join("data/registry/fixtures/fr-authority-27");
    let summary = build_france_authority_registry(
        "aetrain-registry-fr-authority-27",
        "fr-authority-27",
        "2026-05-22T00:00:00Z",
        &repo_root.join("data/registry/raw/insee/fr-cog-communes-27.jsonl"),
        &repo_root.join("data/cache/raw/sncf-fr-stations/sncf-fr-stations.csv"),
        &repo_root.join("data/registry/raw/wikidata/fr-city-enrichment-27.jsonl"),
        &repo_root.join("data/registry/overrides/city-name-rules.toml"),
        &output_root,
    )?;

    println!(
        "France authority registry: cities={} stations={} memberships={} city_evidence={} membership_evidence={} audit={}",
        summary.city_count,
        summary.station_count,
        summary.membership_count,
        summary.city_authority_evidence_count,
        summary.membership_evidence_count,
        summary.audit_count
    );
    Ok(())
}
