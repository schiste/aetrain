use anyhow::{Result, bail};

use crate::{RegistryManifest, RegistrySourceDefinition};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedPlan {
    pub target_id: String,
    pub source_ids: Vec<String>,
}

pub fn build_seed_plan(manifest: &RegistryManifest, target_id: &str) -> Result<SeedPlan> {
    let target = manifest
        .target(target_id)
        .ok_or_else(|| anyhow::anyhow!("unknown target {}", target_id))?;
    if !target.input_target_ids.is_empty() {
        bail!("seed plan expects a concrete source-backed target, not an aggregate target");
    }

    let sources = target
        .source_ids
        .iter()
        .map(|source_id| {
            manifest
                .sources
                .iter()
                .find(|source| &source.id == source_id)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "target {} references missing source {}",
                        target.id,
                        source_id
                    )
                })
        })
        .collect::<Result<Vec<&RegistrySourceDefinition>>>()?;

    if sources.iter().any(|source| !source.seed_once) {
        bail!("all registry seed sources must declare seed_once = true");
    }

    Ok(SeedPlan {
        target_id: target.id.clone(),
        source_ids: sources.iter().map(|source| source.id.clone()).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RegistryAccessStrategy, RegistryEntityKind, RegistryProvider, RegistryRefreshStrategy,
        RegistrySourceDefinition, RegistryTargetDefinition,
    };

    #[test]
    fn seed_plan_requires_seed_once_sources() {
        let manifest = RegistryManifest {
            dataset_id: "aetrain-registry".to_string(),
            schema_version: 1,
            description: "test".to_string(),
            default_target_id: None,
            sources: vec![RegistrySourceDefinition {
                id: "wikidata-city-seed".to_string(),
                provider: RegistryProvider::Wikidata,
                entity_kind: RegistryEntityKind::CityRegistry,
                access_strategy: RegistryAccessStrategy::BulkSnapshot,
                refresh_strategy: RegistryRefreshStrategy::RecentChanges,
                authority_role: None,
                trust_tier: None,
                country_codes: Vec::new(),
                source_url: None,
                license: None,
                seed_once: false,
                active: true,
                notes: None,
            }],
            targets: vec![RegistryTargetDefinition {
                id: "registry".to_string(),
                adapter: "registry_europe".to_string(),
                source_ids: vec!["wikidata-city-seed".to_string()],
                input_target_ids: Vec::new(),
                active: true,
                canonical_export: true,
                audit_export: true,
                notes: None,
            }],
        };

        let err = build_seed_plan(&manifest, "registry").expect_err("seed_once should be required");
        assert!(err.to_string().contains("seed_once"));
    }
}
