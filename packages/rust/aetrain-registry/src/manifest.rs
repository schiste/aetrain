use std::{collections::HashSet, fs, path::Path};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryProvider {
    Wikidata,
    Osm,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryEntityKind {
    CityRegistry,
    StationRegistry,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryAccessStrategy {
    BulkSnapshot,
    RegionalSnapshot,
    CuratedSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryRefreshStrategy {
    RecentChanges,
    ReplicationDiff,
    ManualRerun,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistrySourceDefinition {
    pub id: String,
    pub provider: RegistryProvider,
    pub entity_kind: RegistryEntityKind,
    pub access_strategy: RegistryAccessStrategy,
    pub refresh_strategy: RegistryRefreshStrategy,
    #[serde(default)]
    pub seed_once: bool,
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryTargetDefinition {
    pub id: String,
    pub adapter: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub input_target_ids: Vec<String>,
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default = "default_true")]
    pub canonical_export: bool,
    #[serde(default = "default_true")]
    pub audit_export: bool,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryManifest {
    pub dataset_id: String,
    pub schema_version: u16,
    pub description: String,
    #[serde(default)]
    pub default_target_id: Option<String>,
    #[serde(rename = "source", default)]
    pub sources: Vec<RegistrySourceDefinition>,
    #[serde(rename = "target", default)]
    pub targets: Vec<RegistryTargetDefinition>,
}

impl RegistryManifest {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read manifest {}", path.display()))?;
        toml::from_str(&raw).with_context(|| format!("failed to parse manifest {}", path.display()))
    }

    pub fn active_sources(&self) -> Vec<&RegistrySourceDefinition> {
        self.sources.iter().filter(|source| source.active).collect()
    }

    pub fn active_targets(&self) -> Vec<&RegistryTargetDefinition> {
        self.targets.iter().filter(|target| target.active).collect()
    }

    pub fn target(&self, target_id: &str) -> Option<&RegistryTargetDefinition> {
        self.targets.iter().find(|target| target.id == target_id)
    }

    pub fn resolve_targets<'a>(
        &'a self,
        requested_ids: &[String],
    ) -> Result<Vec<&'a RegistryTargetDefinition>> {
        if requested_ids.is_empty() {
            if let Some(default_target_id) = &self.default_target_id {
                let target = self.target(default_target_id).with_context(|| {
                    format!("default_target_id {default_target_id} not found in manifest")
                })?;
                if !target.active {
                    bail!("default target {} is not active", target.id);
                }
                return Ok(vec![target]);
            }

            let active = self.active_targets();
            if active.is_empty() {
                bail!("manifest has no active targets");
            }
            return Ok(active);
        }

        let mut resolved = Vec::new();
        for target_id in requested_ids {
            let target = self
                .target(target_id)
                .with_context(|| format!("unknown target {}", target_id))?;
            if !target.active {
                bail!("target {} is not active", target.id);
            }
            resolved.push(target);
        }
        Ok(resolved)
    }

    pub fn resolve_target_closure<'a>(
        &'a self,
        requested_ids: &[String],
    ) -> Result<Vec<&'a RegistryTargetDefinition>> {
        let roots = self.resolve_targets(requested_ids)?;
        let mut ordered = Vec::new();
        let mut visiting = HashSet::new();
        let mut visited = HashSet::new();

        for target in roots {
            self.visit_target_dependency_order(target, &mut visiting, &mut visited, &mut ordered)?;
        }

        Ok(ordered)
    }

    fn visit_target_dependency_order<'a>(
        &'a self,
        target: &'a RegistryTargetDefinition,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
        ordered: &mut Vec<&'a RegistryTargetDefinition>,
    ) -> Result<()> {
        if visited.contains(&target.id) {
            return Ok(());
        }
        if !visiting.insert(target.id.clone()) {
            bail!("target dependency cycle detected at {}", target.id);
        }

        for dependency_id in &target.input_target_ids {
            let dependency = self
                .target(dependency_id)
                .with_context(|| format!("unknown target dependency {dependency_id}"))?;
            if !dependency.active {
                bail!(
                    "target {} depends on inactive target {}",
                    target.id,
                    dependency.id
                );
            }
            self.visit_target_dependency_order(dependency, visiting, visited, ordered)?;
        }

        visiting.remove(&target.id);
        visited.insert(target.id.clone());
        ordered.push(target);
        Ok(())
    }
}

const fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_registry_manifest() {
        let manifest: RegistryManifest = toml::from_str(
            r#"
dataset_id = "aetrain-registry"
schema_version = 1
description = "Registry scaffold"
default_target_id = "europe-city-registry"

[[source]]
id = "wikidata-city-seed"
provider = "wikidata"
entity_kind = "city_registry"
access_strategy = "bulk_snapshot"
refresh_strategy = "recent_changes"
seed_once = true
active = true

[[target]]
id = "europe-city-registry"
adapter = "registry_europe"
source_ids = ["wikidata-city-seed"]
active = true
"#,
        )
        .expect("manifest should parse");

        assert_eq!(manifest.dataset_id, "aetrain-registry");
        assert_eq!(manifest.active_sources().len(), 1);
        assert_eq!(
            manifest.resolve_targets(&[]).expect("default target").len(),
            1
        );
    }

    #[test]
    fn resolves_dependency_closure_in_order() {
        let manifest = RegistryManifest {
            dataset_id: "registry".to_string(),
            schema_version: 1,
            description: "test".to_string(),
            default_target_id: Some("europe".to_string()),
            sources: Vec::new(),
            targets: vec![
                RegistryTargetDefinition {
                    id: "seed".to_string(),
                    adapter: "registry_seed".to_string(),
                    source_ids: Vec::new(),
                    input_target_ids: Vec::new(),
                    active: true,
                    canonical_export: true,
                    audit_export: true,
                    notes: None,
                },
                RegistryTargetDefinition {
                    id: "europe".to_string(),
                    adapter: "registry_europe".to_string(),
                    source_ids: Vec::new(),
                    input_target_ids: vec!["seed".to_string()],
                    active: true,
                    canonical_export: true,
                    audit_export: true,
                    notes: None,
                },
            ],
        };

        let ids = manifest
            .resolve_target_closure(&[])
            .expect("closure should resolve")
            .iter()
            .map(|target| target.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["seed", "europe"]);
    }
}
