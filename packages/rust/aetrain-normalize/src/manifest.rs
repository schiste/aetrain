use std::{fs, path::Path};

use aetrain_domain::{CityId, ServiceClass, SourceRef};
use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Gtfs,
    Supplementary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceDefinition {
    pub id: String,
    pub kind: SourceKind,
    pub country_code: String,
    pub adapter: String,
    pub url: String,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub version_probe_url: Option<String>,
    pub active: bool,
    #[serde(default)]
    pub include_service_classes: Vec<ServiceClass>,
    #[serde(default)]
    pub notes: Option<String>,
}

impl SourceDefinition {
    pub fn is_stage_one_compatible(&self) -> bool {
        self.active && !self.include_service_classes.is_empty()
    }

    pub fn resolved_file_name(&self) -> String {
        self.file_name.clone().unwrap_or_else(|| {
            let without_query = self.url.split('?').next().unwrap_or(self.url.as_str());
            without_query
                .rsplit('/')
                .next()
                .filter(|segment| !segment.is_empty())
                .unwrap_or("source.bin")
                .to_string()
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceManifest {
    pub dataset_id: String,
    pub schema_version: u16,
    pub description: String,
    #[serde(rename = "source", default)]
    pub sources: Vec<SourceDefinition>,
}

impl SourceManifest {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read manifest {}", path.display()))?;
        toml::from_str(&raw).with_context(|| format!("failed to parse manifest {}", path.display()))
    }

    pub fn active_sources(&self) -> Vec<&SourceDefinition> {
        self.sources
            .iter()
            .filter(|source| source.is_stage_one_compatible())
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManualCityOverride {
    pub id: String,
    pub target_city_id: CityId,
    pub source_refs: Vec<SourceRef>,
    pub reason: String,
    pub added_by: String,
    pub added_at: String,
    pub tracking_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ManualOverrideRegistry {
    pub city_overrides: Vec<ManualCityOverride>,
}

impl ManualOverrideRegistry {
    pub fn is_empty(&self) -> bool {
        self.city_overrides.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizationIssue {
    pub severity: IssueSeverity,
    pub source_id: String,
    pub entity_ref: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_one_source_can_include_ferry() {
        let source = SourceDefinition {
            id: "sncf-fr".to_string(),
            kind: SourceKind::Gtfs,
            country_code: "FR".to_string(),
            adapter: "sncf_fr".to_string(),
            url: "https://example.invalid/feed.zip".to_string(),
            file_name: Some("feed.zip".to_string()),
            version_probe_url: None,
            active: true,
            include_service_classes: vec![
                ServiceClass::Intercity,
                ServiceClass::Regional,
                ServiceClass::Ferry,
            ],
            notes: Some("Fastest-travel-time only".to_string()),
        };

        assert!(source.is_stage_one_compatible());
        assert!(
            source
                .include_service_classes
                .contains(&ServiceClass::Ferry)
        );
    }

    #[test]
    fn resolved_file_name_prefers_manifest_override() {
        let source = SourceDefinition {
            id: "sncf-fr".to_string(),
            kind: SourceKind::Gtfs,
            country_code: "FR".to_string(),
            adapter: "sncf_fr".to_string(),
            url: "https://example.invalid/path/from/url.zip".to_string(),
            file_name: Some("from-manifest.zip".to_string()),
            version_probe_url: None,
            active: true,
            include_service_classes: vec![ServiceClass::Regional],
            notes: None,
        };

        assert_eq!(source.resolved_file_name(), "from-manifest.zip");
    }

    #[test]
    fn override_registry_starts_empty() {
        let registry = ManualOverrideRegistry::default();
        assert!(registry.is_empty());
    }
}
