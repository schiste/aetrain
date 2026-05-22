use anyhow::{Result, bail};

use crate::{
    RegistryCursorMode, RegistryManifest, RegistryRefreshStrategy, RegistrySourceCursor,
    RegistrySourceDefinition,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IncrementalPlan {
    pub target_id: String,
    pub source_ids: Vec<String>,
}

pub fn build_incremental_plan(
    manifest: &RegistryManifest,
    target_id: &str,
    cursors: &[RegistrySourceCursor],
) -> Result<IncrementalPlan> {
    let target = manifest
        .target(target_id)
        .ok_or_else(|| anyhow::anyhow!("unknown target {}", target_id))?;
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

    for source in &sources {
        match source.refresh_strategy {
            RegistryRefreshStrategy::RecentChanges | RegistryRefreshStrategy::ReplicationDiff => {}
            RegistryRefreshStrategy::AnnualRelease | RegistryRefreshStrategy::ManualRerun => {
                bail!("source {} does not support incremental refresh", source.id)
            }
        }

        let cursor = cursors
            .iter()
            .find(|cursor| cursor.source_id == source.id)
            .ok_or_else(|| {
                anyhow::anyhow!("missing cursor for incremental source {}", source.id)
            })?;
        if cursor.mode != RegistryCursorMode::Incremental {
            bail!("cursor for source {} is not in incremental mode", source.id);
        }
        if cursor.state.seed_snapshot_id.is_none() {
            bail!(
                "cursor for source {} is missing a seed snapshot marker",
                source.id
            );
        }
    }

    Ok(IncrementalPlan {
        target_id: target.id.clone(),
        source_ids: sources.iter().map(|source| source.id.clone()).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RegistryAccessStrategy, RegistryEntityKind, RegistryProvider, RegistrySourceCursorState,
        RegistrySourceDefinition, RegistryTargetDefinition,
    };

    #[test]
    fn incremental_plan_requires_seed_cursor() {
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
                seed_once: true,
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

        let err = build_incremental_plan(
            &manifest,
            "registry",
            &[RegistrySourceCursor {
                source_id: "wikidata-city-seed".to_string(),
                mode: RegistryCursorMode::Incremental,
                last_successful_refresh_at: None,
                state: RegistrySourceCursorState::default(),
            }],
        )
        .expect_err("seed snapshot marker should be required");

        assert!(err.to_string().contains("seed snapshot"));
    }
}
