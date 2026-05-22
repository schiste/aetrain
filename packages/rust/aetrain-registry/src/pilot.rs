use std::{collections::BTreeMap, path::Path};

use aetrain_domain::{CityId, GeoPoint, StationId};
use anyhow::{Context, Result, anyhow};
use deunicode::deunicode;

use crate::{
    ExternalRecordRef, GeoBounds, NameRuleSet, OsmStationObservation, RegistryAuditFinding,
    RegistryAuditFindingKind, RegistryAuditSeverity, RegistryAuthorityRole, RegistryBuildLayout,
    RegistryCanonicalBundle, RegistryCity, RegistryCityCollection, RegistryCityFacts,
    RegistryCityFactsCollection, RegistryCitySignals, RegistryCitySignalsCollection,
    RegistryCityStationMembership, RegistryMeta, RegistryNameVariant,
    RegistryNameVariantCollection, RegistryNameVariantKind, RegistryStation,
    RegistryStationCollection, RegistryStatus, RegistryTrustTier, WikidataCityObservation,
    apply_name_rules, read_json_lines, write_json, write_json_lines,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PilotBuildSummary {
    pub city_count: usize,
    pub station_count: usize,
    pub membership_count: usize,
    pub audit_count: usize,
}

pub fn build_pilot_registry(
    dataset_id: &str,
    scope: &str,
    generated_at: &str,
    wikidata_input_path: &Path,
    osm_input_path: &Path,
    rules_path: &Path,
    output_root: &Path,
) -> Result<PilotBuildSummary> {
    let layout = RegistryBuildLayout::under(output_root);
    layout.ensure()?;

    let wikidata_cities = read_json_lines::<WikidataCityObservation>(wikidata_input_path)
        .with_context(|| {
            format!(
                "failed to load pilot wikidata observations from {}",
                wikidata_input_path.display()
            )
        })?;
    let osm_stations =
        read_json_lines::<OsmStationObservation>(osm_input_path).with_context(|| {
            format!(
                "failed to load pilot osm observations from {}",
                osm_input_path.display()
            )
        })?;
    let rules = NameRuleSet::load(rules_path)
        .with_context(|| format!("failed to load pilot rules from {}", rules_path.display()))?;

    let meta = RegistryMeta {
        schema_version: 1,
        dataset_id: dataset_id.to_string(),
        scope: scope.to_string(),
        generated_at: generated_at.to_string(),
    };

    let mut cities = Vec::new();
    let mut city_lookup = BTreeMap::<(String, String), CityId>::new();
    for observation in &wikidata_cities {
        let country_code = observation
            .country_code
            .clone()
            .ok_or_else(|| anyhow!("pilot city {} is missing country_code", observation.qid))?;
        let cleaned_name = apply_name_rules(
            &observation.label,
            Some(country_code.as_str()),
            Some("wikidata-pilot"),
            &rules,
        )
        .ok_or_else(|| anyhow!("pilot city {} was rejected by name rules", observation.qid))?;
        let location = observation
            .location
            .ok_or_else(|| anyhow!("pilot city {} is missing coordinates", observation.qid))?;
        let city_id = CityId::new(format!(
            "{}-{}-{}",
            slugify(&cleaned_name),
            country_code.to_ascii_lowercase(),
            observation.qid.to_ascii_lowercase()
        ))?;
        city_lookup.insert(
            (
                cleaned_name.to_ascii_lowercase(),
                country_code.to_ascii_uppercase(),
            ),
            city_id.clone(),
        );
        cities.push(RegistryCity {
            city_id,
            slug: slugify(&cleaned_name),
            display_name: cleaned_name,
            country_code,
            identity_point: location,
            map_anchor_point: location,
            bbox: None,
            wikidata_qid: Some(observation.qid.clone()),
            population: normalize_population(observation.population),
            status: RegistryStatus::Resolved,
            external_refs: vec![ExternalRecordRef {
                source_id: "wikidata-pilot".to_string(),
                external_id: observation.qid.clone(),
                authority_role: Some(RegistryAuthorityRole::Enrichment),
                trust_tier: Some(RegistryTrustTier::LinkedOpenData),
            }],
        });
    }

    let mut stations = Vec::new();
    let mut memberships = Vec::new();
    let mut variants = Vec::new();
    let mut findings = Vec::new();

    for observation in &osm_stations {
        let country_code = observation.country_code.clone().ok_or_else(|| {
            anyhow!(
                "pilot station {} is missing country_code",
                observation.object_id
            )
        })?;
        let display_name = observation
            .display_name
            .clone()
            .unwrap_or_else(|| observation.name.clone());
        let station_id = StationId::new(format!(
            "osm-{}-{}",
            slugify(observation.object_id.as_str()),
            slugify(display_name.as_str())
        ))?;
        stations.push(RegistryStation {
            station_id: station_id.clone(),
            display_name: display_name.clone(),
            country_code: country_code.clone(),
            location: GeoPoint {
                lat: observation.location.lat,
                lon: observation.location.lon,
            },
            uic_code: None,
            status: RegistryStatus::Resolved,
            external_refs: Vec::new(),
        });

        let city_hint = observation
            .city_hint
            .as_ref()
            .map(|value| value.as_str())
            .unwrap_or(display_name.as_str());
        let cleaned_hint = apply_name_rules(
            city_hint,
            Some(country_code.as_str()),
            Some("osm-pilot"),
            &rules,
        )
        .unwrap_or_else(|| city_hint.to_string());

        if let Some(city_id) = city_lookup.get(&(
            cleaned_hint.to_ascii_lowercase(),
            country_code.to_ascii_uppercase(),
        )) {
            memberships.push(RegistryCityStationMembership {
                city_id: city_id.clone(),
                station_id: station_id.clone(),
                is_primary: true,
            });
            variants.push(RegistryNameVariant {
                city_id: city_id.clone(),
                value: display_name,
                kind: RegistryNameVariantKind::StationVariant,
                source: "osm-pilot".to_string(),
            });
        } else {
            findings.push(RegistryAuditFinding {
                kind: RegistryAuditFindingKind::UnresolvedCity,
                severity: RegistryAuditSeverity::Warning,
                entity_ref: observation.object_id.clone(),
                message: format!(
                    "pilot station {} could not be matched to city hint {}",
                    observation.object_id, cleaned_hint
                ),
            });
        }
    }

    let stations_by_id = stations
        .iter()
        .map(|station| (station.station_id.clone(), station))
        .collect::<BTreeMap<_, _>>();
    for city in &mut cities {
        let linked_stations = memberships
            .iter()
            .filter(|membership| membership.city_id == city.city_id)
            .filter_map(|membership| stations_by_id.get(&membership.station_id).copied())
            .collect::<Vec<_>>();
        if let Some(first_station) = linked_stations.first() {
            city.map_anchor_point = first_station.location;
            city.bbox = Some(bounding_box(city.identity_point, &linked_stations));
        }
    }

    let city_facts = cities
        .iter()
        .map(|city| RegistryCityFacts {
            city_id: city.city_id.clone(),
            station_count: Some(
                memberships
                    .iter()
                    .filter(|membership| membership.city_id == city.city_id)
                    .count() as u32,
            ),
            museum_count: None,
            unesco_site_count: None,
            protected_area_distance_km: None,
            coastline_distance_km: None,
            source_refs: city.external_refs.clone(),
        })
        .collect::<Vec<_>>();
    let city_signals = cities
        .iter()
        .map(|city| RegistryCitySignals {
            city_id: city.city_id.clone(),
            nature_interest_score: None,
            historical_interest_score: None,
            museum_interest_score: None,
            scenic_score: None,
            score_version: None,
            computed_at: None,
        })
        .collect::<Vec<_>>();

    let bundle = RegistryCanonicalBundle {
        meta: meta.clone(),
        cities: cities.clone(),
        stations: stations.clone(),
        memberships: memberships.clone(),
        name_variants: variants.clone(),
        city_facts: city_facts.clone(),
        city_signals: city_signals.clone(),
        city_authority_evidence: Vec::new(),
        membership_evidence: Vec::new(),
    };

    write_json_lines(
        &layout
            .observations_dir
            .join("wikidata-city-observations.jsonl"),
        &wikidata_cities,
    )?;
    write_json_lines(
        &layout
            .observations_dir
            .join("osm-station-observations.jsonl"),
        &osm_stations,
    )?;
    write_json(
        &layout.canonical_dir.join("cities.json"),
        &RegistryCityCollection {
            meta: meta.clone(),
            cities,
        },
    )?;
    write_json(
        &layout.canonical_dir.join("stations.json"),
        &RegistryStationCollection {
            meta: meta.clone(),
            stations,
        },
    )?;
    write_json(&layout.canonical_dir.join("memberships.json"), &memberships)?;
    write_json(
        &layout.canonical_dir.join("name-variants.json"),
        &RegistryNameVariantCollection {
            meta: meta.clone(),
            variants,
        },
    )?;
    write_json(
        &layout.canonical_dir.join("facts.json"),
        &RegistryCityFactsCollection {
            meta: meta.clone(),
            facts: city_facts,
        },
    )?;
    write_json(
        &layout.canonical_dir.join("signals.json"),
        &RegistryCitySignalsCollection {
            meta: meta.clone(),
            signals: city_signals,
        },
    )?;
    write_json(&layout.canonical_dir.join("bundle.json"), &bundle)?;
    write_json(&layout.audit_dir.join("findings.json"), &findings)?;

    Ok(PilotBuildSummary {
        city_count: bundle.cities.len(),
        station_count: bundle.stations.len(),
        membership_count: bundle.memberships.len(),
        audit_count: findings.len(),
    })
}

fn slugify(value: &str) -> String {
    let ascii = deunicode(value);
    let mut slug = String::with_capacity(ascii.len());
    let mut last_was_dash = false;
    for ch in ascii.chars() {
        let normalized = if ch.is_ascii_alphanumeric() {
            last_was_dash = false;
            Some(ch.to_ascii_lowercase())
        } else if !last_was_dash {
            last_was_dash = true;
            Some('-')
        } else {
            None
        };
        if let Some(ch) = normalized {
            slug.push(ch);
        }
    }
    slug.trim_matches('-').to_string()
}

fn normalize_population(population: Option<u64>) -> Option<u64> {
    population.filter(|value| *value >= 20_000)
}

fn bounding_box(identity_point: GeoPoint, stations: &[&RegistryStation]) -> GeoBounds {
    let mut min_lat = identity_point.lat;
    let mut min_lon = identity_point.lon;
    let mut max_lat = identity_point.lat;
    let mut max_lon = identity_point.lon;
    for station in stations {
        min_lat = min_lat.min(station.location.lat);
        min_lon = min_lon.min(station.location.lon);
        max_lat = max_lat.max(station.location.lat);
        max_lon = max_lon.max(station.location.lon);
    }
    GeoBounds {
        min_lat,
        min_lon,
        max_lat,
        max_lon,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("aetrain-registry-pilot-{label}-{nanos}"))
    }

    #[test]
    fn pilot_builder_emits_bundle_from_small_fixture() {
        let root = temp_path("build");
        fs::create_dir_all(&root).expect("temp root should exist");
        let wikidata_path = root.join("wikidata.jsonl");
        let osm_path = root.join("osm.jsonl");
        let rules_path = root.join("rules.toml");
        let output_root = root.join("out");

        write_json_lines(
            &wikidata_path,
            &[WikidataCityObservation {
                qid: "Q90".to_string(),
                label: "Paris".to_string(),
                aliases: vec!["City of Light".to_string()],
                country_code: Some("FR".to_string()),
                location: Some(GeoPoint {
                    lat: 48.8566,
                    lon: 2.3522,
                }),
                population: Some(2_145_906),
            }],
        )
        .expect("wikidata fixture should write");
        write_json_lines(
            &osm_path,
            &[OsmStationObservation {
                object_id: "node/1309031698".to_string(),
                name: "Gare de Lyon".to_string(),
                display_name: Some("Paris Gare de Lyon".to_string()),
                city_hint: Some("Paris".to_string()),
                country_code: Some("FR".to_string()),
                location: GeoPoint {
                    lat: 48.8436635,
                    lon: 2.3744869,
                },
                tags: vec![("railway".to_string(), "station".to_string())],
                relations: Vec::new(),
            }],
        )
        .expect("osm fixture should write");
        fs::write(
            &rules_path,
            "schema_version = 1\n\n[[rule]]\nid = 'drop-bus'\naction = 'reject_token'\nmatch_value = 'Bus'\n",
        )
        .expect("rules should write");

        let summary = build_pilot_registry(
            "aetrain-registry-pilot",
            "pilot",
            "2026-05-09T00:00:00Z",
            &wikidata_path,
            &osm_path,
            &rules_path,
            &output_root,
        )
        .expect("pilot build should succeed");

        assert_eq!(summary.city_count, 1);
        assert_eq!(summary.station_count, 1);
        assert_eq!(summary.membership_count, 1);
        assert_eq!(summary.audit_count, 0);
        assert!(output_root.join("canonical/bundle.json").exists());
        assert!(output_root.join("canonical/facts.json").exists());
        assert!(output_root.join("canonical/signals.json").exists());
    }
}
