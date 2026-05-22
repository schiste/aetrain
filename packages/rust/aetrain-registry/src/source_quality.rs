use serde::{Deserialize, Serialize};

use crate::{
    RegistryAuditSeverity, RegistryAuthorityRole, RegistryCity, RegistryManifest, RegistryProvider,
    RegistrySourceDefinition, RegistryTargetDefinition, RegistryTrustTier,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistrySourceCoverageReport {
    pub dataset_id: String,
    pub source_count: usize,
    pub active_source_count: usize,
    pub official_source_count: usize,
    pub linked_open_data_source_count: usize,
    pub community_source_count: usize,
    pub sources: Vec<RegistrySourceCoverageRecord>,
    pub findings: Vec<RegistrySourceContractFinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistrySourceCoverageRecord {
    pub source_id: String,
    pub provider: String,
    pub entity_kind: String,
    pub authority_role: RegistryAuthorityRole,
    pub trust_tier: RegistryTrustTier,
    pub country_codes: Vec<String>,
    pub seed_once: bool,
    pub active: bool,
    pub source_url: Option<String>,
    pub license: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistrySourceContractFinding {
    pub severity: RegistryAuditSeverity,
    pub source_id: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryRecordAuthorityStrength {
    OfficialIdentity,
    LinkedOpenDataIdentity,
    CommunityIdentity,
    EnrichedOnly,
    Unverified,
}

pub fn build_registry_source_coverage_report(
    manifest: &RegistryManifest,
) -> RegistrySourceCoverageReport {
    let sources = manifest
        .sources
        .iter()
        .map(source_coverage_record)
        .collect::<Vec<_>>();
    let active_source_count = sources.iter().filter(|source| source.active).count();
    let official_source_count = sources
        .iter()
        .filter(|source| source.trust_tier == RegistryTrustTier::Official)
        .count();
    let linked_open_data_source_count = sources
        .iter()
        .filter(|source| source.trust_tier == RegistryTrustTier::LinkedOpenData)
        .count();
    let community_source_count = sources
        .iter()
        .filter(|source| source.trust_tier == RegistryTrustTier::Community)
        .count();

    RegistrySourceCoverageReport {
        dataset_id: manifest.dataset_id.clone(),
        source_count: sources.len(),
        active_source_count,
        official_source_count,
        linked_open_data_source_count,
        community_source_count,
        sources,
        findings: audit_registry_source_contract(manifest),
    }
}

pub fn audit_registry_source_contract(
    manifest: &RegistryManifest,
) -> Vec<RegistrySourceContractFinding> {
    let mut findings = Vec::new();

    for target in manifest.active_targets() {
        audit_target_sources(manifest, target, &mut findings);
    }

    for source in manifest.active_sources() {
        audit_source_definition(source, &mut findings);
    }

    findings
}

pub fn city_authority_strength(city: &RegistryCity) -> RegistryRecordAuthorityStrength {
    let mut saw_enrichment = false;
    let mut saw_community_identity = false;
    let mut saw_linked_open_data_identity = false;

    for source_ref in &city.external_refs {
        let Some(role) = &source_ref.authority_role else {
            continue;
        };
        let Some(tier) = &source_ref.trust_tier else {
            continue;
        };

        if !matches!(
            role,
            RegistryAuthorityRole::MunicipalityIdentity | RegistryAuthorityRole::CityIdentity
        ) {
            if *role == RegistryAuthorityRole::Enrichment {
                saw_enrichment = true;
            }
            continue;
        }

        match tier {
            RegistryTrustTier::Official => {
                return RegistryRecordAuthorityStrength::OfficialIdentity;
            }
            RegistryTrustTier::LinkedOpenData => {
                saw_linked_open_data_identity = true;
            }
            RegistryTrustTier::Community => {
                saw_community_identity = true;
            }
            RegistryTrustTier::Derived | RegistryTrustTier::ManualOverride => {}
        }
    }

    if saw_linked_open_data_identity {
        RegistryRecordAuthorityStrength::LinkedOpenDataIdentity
    } else if saw_community_identity {
        RegistryRecordAuthorityStrength::CommunityIdentity
    } else if city.wikidata_qid.is_some() || saw_enrichment {
        RegistryRecordAuthorityStrength::EnrichedOnly
    } else {
        RegistryRecordAuthorityStrength::Unverified
    }
}

fn audit_target_sources(
    manifest: &RegistryManifest,
    target: &RegistryTargetDefinition,
    findings: &mut Vec<RegistrySourceContractFinding>,
) {
    let mut has_identity_source = false;
    for source_id in &target.source_ids {
        let Some(source) = manifest
            .sources
            .iter()
            .find(|source| source.id == *source_id)
        else {
            findings.push(RegistrySourceContractFinding {
                severity: RegistryAuditSeverity::Error,
                source_id: source_id.clone(),
                message: format!("target {} references unknown registry source", target.id),
            });
            continue;
        };
        if matches!(
            source.effective_authority_role(),
            RegistryAuthorityRole::MunicipalityIdentity | RegistryAuthorityRole::CityIdentity
        ) {
            has_identity_source = true;
        }
    }

    if !has_identity_source {
        findings.push(RegistrySourceContractFinding {
            severity: RegistryAuditSeverity::Error,
            source_id: target.id.clone(),
            message: format!(
                "target {} has no municipality or city identity authority source",
                target.id
            ),
        });
    }
}

fn audit_source_definition(
    source: &RegistrySourceDefinition,
    findings: &mut Vec<RegistrySourceContractFinding>,
) {
    let role = source.effective_authority_role();
    let tier = source.effective_trust_tier();

    if tier == RegistryTrustTier::Official
        && source.source_url.is_none()
        && !matches!(source.provider, RegistryProvider::EurostatGisco)
    {
        findings.push(RegistrySourceContractFinding {
            severity: RegistryAuditSeverity::Warning,
            source_id: source.id.clone(),
            message: "official registry sources should declare a source_url".to_string(),
        });
    }

    if matches!(
        source.provider,
        RegistryProvider::NationalGeographicAuthority
            | RegistryProvider::NationalStatisticalOffice
            | RegistryProvider::NationalTransportAuthority
    ) && source.country_codes.is_empty()
    {
        findings.push(RegistrySourceContractFinding {
            severity: RegistryAuditSeverity::Error,
            source_id: source.id.clone(),
            message: "national authority sources must declare country_codes".to_string(),
        });
    }

    if role == RegistryAuthorityRole::StationCityMembership && tier == RegistryTrustTier::Community
    {
        findings.push(RegistrySourceContractFinding {
            severity: RegistryAuditSeverity::Warning,
            source_id: source.id.clone(),
            message: "community station-city membership evidence must not auto-promote canonical membership without an official or coordinate containment corroboration".to_string(),
        });
    }
}

fn source_coverage_record(source: &RegistrySourceDefinition) -> RegistrySourceCoverageRecord {
    RegistrySourceCoverageRecord {
        source_id: source.id.clone(),
        provider: provider_key(&source.provider).to_string(),
        entity_kind: entity_kind_key(source).to_string(),
        authority_role: source.effective_authority_role(),
        trust_tier: source.effective_trust_tier(),
        country_codes: source.country_codes.clone(),
        seed_once: source.seed_once,
        active: source.active,
        source_url: source.source_url.clone(),
        license: source.license.clone(),
    }
}

fn provider_key(provider: &RegistryProvider) -> &'static str {
    match provider {
        RegistryProvider::EurostatGisco => "eurostat_gisco",
        RegistryProvider::NationalGeographicAuthority => "national_geographic_authority",
        RegistryProvider::NationalStatisticalOffice => "national_statistical_office",
        RegistryProvider::NationalTransportAuthority => "national_transport_authority",
        RegistryProvider::Wikidata => "wikidata",
        RegistryProvider::Osm => "osm",
    }
}

fn entity_kind_key(source: &RegistrySourceDefinition) -> &'static str {
    match source.entity_kind {
        crate::RegistryEntityKind::MunicipalityRegistry => "municipality_registry",
        crate::RegistryEntityKind::CityRegistry => "city_registry",
        crate::RegistryEntityKind::StationRegistry => "station_registry",
        crate::RegistryEntityKind::CityStationMembership => "city_station_membership",
        crate::RegistryEntityKind::CityEnrichment => "city_enrichment",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ExternalRecordRef, RegistryAccessStrategy, RegistryEntityKind, RegistryRefreshStrategy,
        RegistryStatus, RegistryTargetDefinition,
    };
    use aetrain_domain::{CityId, GeoPoint};

    #[test]
    fn source_coverage_report_counts_trust_tiers() {
        let manifest = RegistryManifest {
            dataset_id: "aetrain-registry".to_string(),
            schema_version: 1,
            description: "test".to_string(),
            default_target_id: Some("europe".to_string()),
            sources: vec![
                source(
                    "eurostat-lau",
                    RegistryProvider::EurostatGisco,
                    RegistryEntityKind::MunicipalityRegistry,
                    RegistryAuthorityRole::MunicipalityIdentity,
                    RegistryTrustTier::Official,
                    vec!["AT", "BE", "FR"],
                ),
                source(
                    "wikidata-city",
                    RegistryProvider::Wikidata,
                    RegistryEntityKind::CityEnrichment,
                    RegistryAuthorityRole::Enrichment,
                    RegistryTrustTier::LinkedOpenData,
                    Vec::new(),
                ),
                source(
                    "osm-station",
                    RegistryProvider::Osm,
                    RegistryEntityKind::StationRegistry,
                    RegistryAuthorityRole::StationIdentity,
                    RegistryTrustTier::Community,
                    Vec::new(),
                ),
            ],
            targets: vec![RegistryTargetDefinition {
                id: "europe".to_string(),
                adapter: "registry_europe".to_string(),
                source_ids: vec![
                    "eurostat-lau".to_string(),
                    "wikidata-city".to_string(),
                    "osm-station".to_string(),
                ],
                input_target_ids: Vec::new(),
                active: true,
                canonical_export: true,
                audit_export: true,
                notes: None,
            }],
        };

        let report = build_registry_source_coverage_report(&manifest);

        assert_eq!(report.source_count, 3);
        assert_eq!(report.official_source_count, 1);
        assert_eq!(report.linked_open_data_source_count, 1);
        assert_eq!(report.community_source_count, 1);
        assert!(report.findings.is_empty());
    }

    #[test]
    fn audit_rejects_target_without_identity_source() {
        let manifest = RegistryManifest {
            dataset_id: "aetrain-registry".to_string(),
            schema_version: 1,
            description: "test".to_string(),
            default_target_id: Some("europe".to_string()),
            sources: vec![source(
                "wikidata-city",
                RegistryProvider::Wikidata,
                RegistryEntityKind::CityEnrichment,
                RegistryAuthorityRole::Enrichment,
                RegistryTrustTier::LinkedOpenData,
                Vec::new(),
            )],
            targets: vec![RegistryTargetDefinition {
                id: "europe".to_string(),
                adapter: "registry_europe".to_string(),
                source_ids: vec!["wikidata-city".to_string()],
                input_target_ids: Vec::new(),
                active: true,
                canonical_export: true,
                audit_export: true,
                notes: None,
            }],
        };

        let findings = audit_registry_source_contract(&manifest);

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].severity, RegistryAuditSeverity::Error);
    }

    #[test]
    fn city_authority_strength_prefers_official_identity() {
        let city = RegistryCity {
            city_id: CityId::new("paris-fr-q90").expect("valid city id"),
            slug: "paris".to_string(),
            display_name: "Paris".to_string(),
            country_code: "FR".to_string(),
            identity_point: GeoPoint { lat: 0.0, lon: 0.0 },
            map_anchor_point: GeoPoint { lat: 0.0, lon: 0.0 },
            bbox: None,
            wikidata_qid: Some("Q90".to_string()),
            population: Some(2_145_906),
            status: RegistryStatus::Resolved,
            external_refs: vec![
                ExternalRecordRef {
                    source_id: "wikidata-city".to_string(),
                    external_id: "Q90".to_string(),
                    authority_role: Some(RegistryAuthorityRole::Enrichment),
                    trust_tier: Some(RegistryTrustTier::LinkedOpenData),
                },
                ExternalRecordRef {
                    source_id: "eurostat-lau".to_string(),
                    external_id: "FR-75056".to_string(),
                    authority_role: Some(RegistryAuthorityRole::MunicipalityIdentity),
                    trust_tier: Some(RegistryTrustTier::Official),
                },
            ],
        };

        assert_eq!(
            city_authority_strength(&city),
            RegistryRecordAuthorityStrength::OfficialIdentity
        );
    }

    fn source(
        id: &str,
        provider: RegistryProvider,
        entity_kind: RegistryEntityKind,
        authority_role: RegistryAuthorityRole,
        trust_tier: RegistryTrustTier,
        country_codes: Vec<&str>,
    ) -> RegistrySourceDefinition {
        RegistrySourceDefinition {
            id: id.to_string(),
            provider,
            entity_kind,
            access_strategy: RegistryAccessStrategy::BulkSnapshot,
            refresh_strategy: RegistryRefreshStrategy::AnnualRelease,
            authority_role: Some(authority_role),
            trust_tier: Some(trust_tier),
            country_codes: country_codes
                .into_iter()
                .map(|country| country.to_string())
                .collect(),
            source_url: Some("https://example.test/source".to_string()),
            license: Some("open".to_string()),
            seed_once: true,
            active: true,
            notes: None,
        }
    }
}
