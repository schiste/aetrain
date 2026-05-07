use aetrain_domain::{CityId, ServiceClass, SourceRef};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Gtfs,
    Supplementary,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceDefinition {
    pub id: String,
    pub kind: SourceKind,
    pub country_code: String,
    pub adapter: String,
    pub url: String,
    pub active: bool,
    pub include_service_classes: Vec<ServiceClass>,
    pub notes: Option<String>,
}

impl SourceDefinition {
    pub fn is_stage_one_compatible(&self) -> bool {
        self.active && !self.include_service_classes.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceManifest {
    pub dataset_id: String,
    pub schema_version: u16,
    pub description: String,
    pub sources: Vec<SourceDefinition>,
}

impl SourceManifest {
    pub fn active_sources(&self) -> Vec<&SourceDefinition> {
        self.sources
            .iter()
            .filter(|source| source.is_stage_one_compatible())
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManualCityOverride {
    pub id: String,
    pub target_city_id: CityId,
    pub source_refs: Vec<SourceRef>,
    pub reason: String,
    pub added_by: String,
    pub added_at: String,
    pub tracking_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ManualOverrideRegistry {
    pub city_overrides: Vec<ManualCityOverride>,
}

impl ManualOverrideRegistry {
    pub fn is_empty(&self) -> bool {
        self.city_overrides.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IssueSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
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
    fn override_registry_starts_empty() {
        let registry = ManualOverrideRegistry::default();
        assert!(registry.is_empty());
    }
}
