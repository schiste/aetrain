use std::{collections::HashSet, fs, path::Path};

use aetrain_domain::{CityId, ServiceClass, SourceRef};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Gtfs,
    Supplementary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryListingStep {
    pub href_pattern: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceResolver {
    DirectoryListingCascade {
        index_url: String,
        #[serde(default)]
        steps: Vec<DirectoryListingStep>,
    },
    HtmlLatestMatch {
        page_url: String,
        href_pattern: String,
    },
    UdataLatestResource {
        dataset_api_url: String,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        title_pattern: Option<String>,
        #[serde(default)]
        url_pattern: Option<String>,
    },
    CkanLatestResource {
        package_show_url: String,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        name_pattern: Option<String>,
        #[serde(default)]
        url_pattern: Option<String>,
    },
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
    pub resolver: Option<SourceResolver>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub include_service_classes: Vec<ServiceClass>,
    #[serde(default)]
    pub notes: Option<String>,
}

impl SourceDefinition {
    pub fn is_stage_one_compatible(&self) -> bool {
        self.active
    }

    pub fn resolved_file_name(&self) -> String {
        self.resolved_file_name_for_url(&self.url)
    }

    pub fn resolved_file_name_for_url(&self, url: &str) -> String {
        self.file_name.clone().unwrap_or_else(|| {
            let without_query = url.split('?').next().unwrap_or(url);
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
pub struct TargetDefinition {
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
    pub web_debug_export: bool,
    #[serde(default)]
    pub customer_facing_scope_only: bool,
    #[serde(default)]
    pub registry_overlay_path: Option<String>,
    #[serde(default)]
    pub geometry_authority_registry_path: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceManifest {
    pub dataset_id: String,
    pub schema_version: u16,
    pub description: String,
    #[serde(default)]
    pub default_target_id: Option<String>,
    #[serde(rename = "source", default)]
    pub sources: Vec<SourceDefinition>,
    #[serde(rename = "target", default)]
    pub targets: Vec<TargetDefinition>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeometryAuthorityStatus {
    Planned,
    Ingested,
    TopologyClean,
    ProductionReady,
}

impl GeometryAuthorityStatus {
    pub fn is_promoted(&self) -> bool {
        matches!(self, Self::ProductionReady)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeometryAuthorityLoader {
    SncfRfnGeojson,
    GeofabrikRailwaysGpkg,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CountryGeometryAuthorityDefinition {
    pub country_code: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub loader: Option<GeometryAuthorityLoader>,
    pub status: GeometryAuthorityStatus,
    #[serde(default)]
    pub customer_facing: bool,
    #[serde(default)]
    pub max_promoted_station_attachment_gap_count: Option<u64>,
    #[serde(default)]
    pub max_promoted_topology_no_route_gap_count: Option<u64>,
    #[serde(default)]
    pub max_promoted_rejected_implausible_authority_detour_count: Option<u64>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CorridorGeometryAuthorityDefinition {
    pub corridor_id: String,
    pub from_country_code: String,
    pub to_country_code: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub loader: Option<GeometryAuthorityLoader>,
    pub status: GeometryAuthorityStatus,
    #[serde(default)]
    pub customer_facing: bool,
    #[serde(default)]
    pub allow_shape_fallback: bool,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeometryAuthoritySourceDefinition {
    pub source_id: String,
    pub loader: GeometryAuthorityLoader,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeometryAuthorityRoutePolicyAction {
    SuppressAuthorityUntilTopologyFixed,
    TightenAuthorityFootprint,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeometryAuthorityRoutePolicyDefinition {
    pub source_id: String,
    pub from_city_id: CityId,
    pub to_city_id: CityId,
    pub action: GeometryAuthorityRoutePolicyAction,
    #[serde(default)]
    pub max_snap_distance_m: Option<u32>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeometryAuthorityRegistry {
    pub dataset_id: String,
    pub schema_version: u16,
    pub description: String,
    #[serde(rename = "source", default)]
    pub sources: Vec<GeometryAuthoritySourceDefinition>,
    #[serde(rename = "country", default)]
    pub countries: Vec<CountryGeometryAuthorityDefinition>,
    #[serde(rename = "corridor", default)]
    pub corridors: Vec<CorridorGeometryAuthorityDefinition>,
    #[serde(rename = "route_policy", default)]
    pub route_policies: Vec<GeometryAuthorityRoutePolicyDefinition>,
}

impl GeometryAuthorityRegistry {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read authority registry {}", path.display()))?;
        toml::from_str(&raw)
            .with_context(|| format!("failed to parse authority registry {}", path.display()))
    }

    pub fn country(&self, country_code: &str) -> Option<&CountryGeometryAuthorityDefinition> {
        self.countries
            .iter()
            .find(|entry| entry.country_code.eq_ignore_ascii_case(country_code))
    }

    pub fn corridor(
        &self,
        left_country_code: &str,
        right_country_code: &str,
    ) -> Option<&CorridorGeometryAuthorityDefinition> {
        self.corridors.iter().find(|entry| {
            (entry
                .from_country_code
                .eq_ignore_ascii_case(left_country_code)
                && entry
                    .to_country_code
                    .eq_ignore_ascii_case(right_country_code))
                || (entry
                    .from_country_code
                    .eq_ignore_ascii_case(right_country_code)
                    && entry
                        .to_country_code
                        .eq_ignore_ascii_case(left_country_code))
        })
    }

    pub fn route_policy(
        &self,
        source_id: &str,
        left_city_id: &CityId,
        right_city_id: &CityId,
    ) -> Option<&GeometryAuthorityRoutePolicyDefinition> {
        self.route_policies.iter().find(|entry| {
            entry.source_id == source_id
                && ((&entry.from_city_id == left_city_id && &entry.to_city_id == right_city_id)
                    || (&entry.from_city_id == right_city_id
                        && &entry.to_city_id == left_city_id))
        })
    }
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

    pub fn active_targets(&self) -> Vec<&TargetDefinition> {
        self.targets.iter().filter(|target| target.active).collect()
    }

    pub fn target(&self, target_id: &str) -> Option<&TargetDefinition> {
        self.targets.iter().find(|target| target.id == target_id)
    }

    pub fn resolve_targets<'a>(
        &'a self,
        requested_ids: &[String],
    ) -> Result<Vec<&'a TargetDefinition>> {
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

            let active_targets = self.active_targets();
            if active_targets.is_empty() {
                bail!("manifest has no active targets");
            }
            return Ok(active_targets);
        }

        let mut targets = Vec::new();
        for target_id in requested_ids {
            let target = self
                .target(target_id)
                .with_context(|| format!("unknown target {}", target_id))?;
            if !target.active {
                bail!("target {} is not active", target.id);
            }
            targets.push(target);
        }

        Ok(targets)
    }

    pub fn resolve_target_closure<'a>(
        &'a self,
        requested_ids: &[String],
    ) -> Result<Vec<&'a TargetDefinition>> {
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
        target: &'a TargetDefinition,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
        ordered: &mut Vec<&'a TargetDefinition>,
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
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }

        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read overrides {}", path.display()))?;
        let parsed: ManualOverrideFile = toml::from_str(&raw)
            .with_context(|| format!("failed to parse overrides {}", path.display()))?;
        let mut city_overrides = parsed.city_overrides;
        city_overrides.extend(parsed.overrides);
        Ok(Self { city_overrides })
    }

    pub fn is_empty(&self) -> bool {
        self.city_overrides.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
struct ManualOverrideFile {
    #[serde(rename = "city_override", default)]
    city_overrides: Vec<ManualCityOverride>,
    #[serde(rename = "override", default)]
    overrides: Vec<ManualCityOverride>,
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

fn default_true() -> bool {
    true
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
            resolver: None,
            role: Some("schedule".to_string()),
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
            resolver: None,
            role: None,
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

    #[test]
    fn supplementary_source_can_be_active_without_service_classes() {
        let source = SourceDefinition {
            id: "wikidata-city-enrichment".to_string(),
            kind: SourceKind::Supplementary,
            country_code: "ZZ".to_string(),
            adapter: "wikidata".to_string(),
            url: "https://example.invalid/wikidata.json".to_string(),
            file_name: None,
            version_probe_url: None,
            active: true,
            resolver: None,
            role: Some("enrichment".to_string()),
            include_service_classes: Vec::new(),
            notes: None,
        };

        assert!(source.is_stage_one_compatible());
    }

    #[test]
    fn resolved_file_name_can_follow_resolved_download_url() {
        let source = SourceDefinition {
            id: "luxembourg-gtfs".to_string(),
            kind: SourceKind::Gtfs,
            country_code: "LU".to_string(),
            adapter: "gtfs_basic".to_string(),
            url: "https://data.public.lu/api/1/datasets/gtfs/".to_string(),
            file_name: None,
            version_probe_url: None,
            active: true,
            resolver: Some(SourceResolver::UdataLatestResource {
                dataset_api_url: "https://data.public.lu/api/1/datasets/gtfs/".to_string(),
                format: Some("zip".to_string()),
                title_pattern: Some("^gtfs-.*\\.zip$".to_string()),
                url_pattern: None,
            }),
            role: Some("schedule".to_string()),
            include_service_classes: vec![ServiceClass::Regional],
            notes: None,
        };

        assert_eq!(
            source.resolved_file_name_for_url(
                "https://download.data.public.lu/resources/gtfs/20260507/gtfs-20260506-20260712.zip"
            ),
            "gtfs-20260506-20260712.zip"
        );
    }

    #[test]
    fn resolve_targets_prefers_default_target_when_unspecified() {
        let manifest = SourceManifest {
            dataset_id: "stage1".to_string(),
            schema_version: 1,
            description: "test".to_string(),
            default_target_id: Some("sncf-fr".to_string()),
            sources: Vec::new(),
            targets: vec![
                TargetDefinition {
                    id: "sncf-fr".to_string(),
                    adapter: "sncf_fr".to_string(),
                    source_ids: vec!["sncf-fr-gtfs".to_string()],
                    input_target_ids: Vec::new(),
                    active: true,
                    canonical_export: true,
                    web_debug_export: true,
                    customer_facing_scope_only: false,
                    registry_overlay_path: None,
                    geometry_authority_registry_path: None,
                    notes: None,
                },
                TargetDefinition {
                    id: "inactive".to_string(),
                    adapter: "other".to_string(),
                    source_ids: Vec::new(),
                    input_target_ids: Vec::new(),
                    active: false,
                    canonical_export: true,
                    web_debug_export: true,
                    customer_facing_scope_only: false,
                    registry_overlay_path: None,
                    geometry_authority_registry_path: None,
                    notes: None,
                },
            ],
        };

        let resolved = manifest
            .resolve_targets(&[])
            .expect("default target should resolve");
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].id, "sncf-fr");
    }

    #[test]
    fn resolve_target_closure_returns_dependencies_before_aggregate() {
        let manifest = SourceManifest {
            dataset_id: "stage1".to_string(),
            schema_version: 1,
            description: "test".to_string(),
            default_target_id: Some("europe".to_string()),
            sources: Vec::new(),
            targets: vec![
                TargetDefinition {
                    id: "fr".to_string(),
                    adapter: "sncf_fr".to_string(),
                    source_ids: vec!["sncf-fr-gtfs".to_string()],
                    input_target_ids: Vec::new(),
                    active: true,
                    canonical_export: true,
                    web_debug_export: true,
                    customer_facing_scope_only: false,
                    registry_overlay_path: None,
                    geometry_authority_registry_path: None,
                    notes: None,
                },
                TargetDefinition {
                    id: "de".to_string(),
                    adapter: "gtfs_basic".to_string(),
                    source_ids: vec!["de-delfi-gtfs".to_string()],
                    input_target_ids: Vec::new(),
                    active: true,
                    canonical_export: true,
                    web_debug_export: true,
                    customer_facing_scope_only: false,
                    registry_overlay_path: None,
                    geometry_authority_registry_path: None,
                    notes: None,
                },
                TargetDefinition {
                    id: "europe".to_string(),
                    adapter: "aggregate_bundle".to_string(),
                    source_ids: Vec::new(),
                    input_target_ids: vec!["fr".to_string(), "de".to_string()],
                    active: true,
                    canonical_export: true,
                    web_debug_export: true,
                    customer_facing_scope_only: false,
                    registry_overlay_path: None,
                    geometry_authority_registry_path: None,
                    notes: None,
                },
            ],
        };

        let resolved = manifest
            .resolve_target_closure(&[])
            .expect("aggregate closure should resolve");
        let ids = resolved
            .iter()
            .map(|target| target.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["fr", "de", "europe"]);
    }
}
