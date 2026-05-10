use std::path::Path;

use aetrain_domain::CityId;
use anyhow::{Context, Result, anyhow};
use deunicode::deunicode;

use crate::{
    ExternalRecordRef, GeoBounds, NameRuleSet, RegistryBuildLayout, RegistryCanonicalBundle,
    RegistryCity, RegistryCityCollection, RegistryCityFacts, RegistryCityFactsCollection,
    RegistryCitySignals, RegistryCitySignalsCollection, RegistryMeta, RegistryNameVariant,
    RegistryNameVariantCollection, RegistryNameVariantKind, RegistryStationCollection,
    RegistryStatus, WikidataCityObservation, apply_name_rules, read_json_lines, write_json,
    write_json_lines,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WikidataCitySliceSummary {
    pub city_count: usize,
    pub alias_count: usize,
}

pub fn build_wikidata_city_slice(
    dataset_id: &str,
    scope: &str,
    generated_at: &str,
    input_path: &Path,
    rules_path: &Path,
    output_root: &Path,
) -> Result<WikidataCitySliceSummary> {
    let layout = RegistryBuildLayout::under(output_root);
    layout.ensure()?;

    let observations =
        read_json_lines::<WikidataCityObservation>(input_path).with_context(|| {
            format!(
                "failed to load wikidata observations from {}",
                input_path.display()
            )
        })?;
    let rules = NameRuleSet::load(rules_path)
        .with_context(|| format!("failed to load name rules from {}", rules_path.display()))?;

    let meta = RegistryMeta {
        schema_version: 1,
        dataset_id: dataset_id.to_string(),
        scope: scope.to_string(),
        generated_at: generated_at.to_string(),
    };

    let mut cities = Vec::new();
    let mut variants = Vec::new();

    for observation in &observations {
        let country_code = observation
            .country_code
            .clone()
            .ok_or_else(|| anyhow!("wikidata city {} is missing country_code", observation.qid))?;
        let cleaned_name = apply_name_rules(
            &observation.label,
            Some(country_code.as_str()),
            Some("wikidata-slice"),
            &rules,
        )
        .ok_or_else(|| {
            anyhow!(
                "wikidata city {} was rejected by name rules",
                observation.qid
            )
        })?;
        let location = observation
            .location
            .ok_or_else(|| anyhow!("wikidata city {} is missing coordinates", observation.qid))?;
        let city_id = CityId::new(format!(
            "{}-{}-{}",
            slugify(&cleaned_name),
            country_code.to_ascii_lowercase(),
            observation.qid.to_ascii_lowercase()
        ))?;

        let external_refs = vec![
            ExternalRecordRef {
                source_id: "wikidata-manual-fr-10".to_string(),
                external_id: observation.qid.clone(),
            },
            ExternalRecordRef {
                source_id: "wikidata-entity-url".to_string(),
                external_id: format!("https://www.wikidata.org/wiki/{}", observation.qid),
            },
        ];
        for alias in &observation.aliases {
            variants.push(RegistryNameVariant {
                city_id: city_id.clone(),
                value: alias.clone(),
                kind: RegistryNameVariantKind::CanonicalAlias,
                source: "wikidata-manual-fr-10".to_string(),
            });
        }

        cities.push(RegistryCity {
            city_id,
            slug: slugify(&cleaned_name),
            display_name: cleaned_name,
            country_code,
            identity_point: location,
            map_anchor_point: location,
            bbox: Some(GeoBounds {
                min_lat: location.lat,
                min_lon: location.lon,
                max_lat: location.lat,
                max_lon: location.lon,
            }),
            wikidata_qid: Some(observation.qid.clone()),
            population: observation.population.filter(|value| *value >= 20_000),
            status: RegistryStatus::Resolved,
            external_refs,
        });
    }

    let facts = cities
        .iter()
        .map(|city| RegistryCityFacts {
            city_id: city.city_id.clone(),
            station_count: None,
            museum_count: None,
            unesco_site_count: None,
            protected_area_distance_km: None,
            coastline_distance_km: None,
            source_refs: city.external_refs.clone(),
        })
        .collect::<Vec<_>>();
    let signals = cities
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
        stations: Vec::new(),
        memberships: Vec::new(),
        name_variants: variants.clone(),
        city_facts: facts.clone(),
        city_signals: signals.clone(),
    };

    write_json_lines(
        &layout
            .observations_dir
            .join("wikidata-city-observations.jsonl"),
        &observations,
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
            stations: Vec::new(),
        },
    )?;
    write_json(
        &layout.canonical_dir.join("memberships.json"),
        &Vec::<crate::RegistryCityStationMembership>::new(),
    )?;
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
            facts,
        },
    )?;
    write_json(
        &layout.canonical_dir.join("signals.json"),
        &RegistryCitySignalsCollection {
            meta: meta.clone(),
            signals,
        },
    )?;
    write_json(&layout.canonical_dir.join("bundle.json"), &bundle)?;
    write_json(
        &layout.audit_dir.join("findings.json"),
        &Vec::<crate::RegistryAuditFinding>::new(),
    )?;

    Ok(WikidataCitySliceSummary {
        city_count: bundle.cities.len(),
        alias_count: bundle.name_variants.len(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read_json;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_path(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("aetrain-registry-slice-{label}-{nanos}"))
    }

    #[test]
    fn slice_builder_emits_city_only_bundle() {
        let workdir = temp_path("build");
        fs::create_dir_all(&workdir).expect("temp dir should create");
        let input = workdir.join("wikidata.jsonl");
        fs::write(
            &input,
            concat!(
                "{\"qid\":\"Q90\",\"label\":\"Paris\",\"aliases\":[\"Ville de Paris\"],\"country_code\":\"FR\",\"location\":{\"lat\":48.8566,\"lon\":2.3522},\"population\":2145906}\n",
                "{\"qid\":\"Q456\",\"label\":\"Lyon\",\"aliases\":[],\"country_code\":\"FR\",\"location\":{\"lat\":45.7640,\"lon\":4.8357},\"population\":522969}\n"
            ),
        )
        .expect("input should write");
        let rules = workdir.join("rules.toml");
        fs::write(&rules, "schema_version = 1\n").expect("rules should write");
        let out = workdir.join("out");

        let summary = build_wikidata_city_slice(
            "aetrain-registry-fr-test",
            "fr-test",
            "2026-05-10T00:00:00Z",
            &input,
            &rules,
            &out,
        )
        .expect("slice build should succeed");

        assert_eq!(summary.city_count, 2);
        assert_eq!(summary.alias_count, 1);
        let bundle: RegistryCanonicalBundle =
            read_json(&out.join("canonical/bundle.json")).expect("bundle should read");
        assert_eq!(bundle.cities.len(), 2);
        assert_eq!(bundle.stations.len(), 0);
        assert_eq!(bundle.memberships.len(), 0);
        assert_eq!(bundle.city_facts.len(), 2);
        assert_eq!(bundle.city_signals.len(), 2);
    }
}
