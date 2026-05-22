use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use aetrain_domain::{CityId, GeoPoint, StationId};
use anyhow::{Context, Result, anyhow};
use csv::{ReaderBuilder, StringRecord, Trim};
use deunicode::deunicode;

use crate::{
    ExternalRecordRef, GeoBounds, InseeCommuneObservation, NameRuleSet, RegistryAuditFinding,
    RegistryAuditFindingKind, RegistryAuditSeverity, RegistryAuthorityRole, RegistryBuildLayout,
    RegistryCanonicalBundle, RegistryCity, RegistryCityAuthorityEvidence,
    RegistryCityAuthorityEvidenceCollection, RegistryCityCollection, RegistryCityFacts,
    RegistryCityFactsCollection, RegistryCitySignals, RegistryCitySignalsCollection,
    RegistryCityStationMembership, RegistryEvidenceKind, RegistryMeta, RegistryNameVariant,
    RegistryNameVariantCollection, RegistryNameVariantKind, RegistryStation,
    RegistryStationCityMembershipEvidence, RegistryStationCityMembershipEvidenceCollection,
    RegistryStationCollection, RegistryStatus, RegistryTrustTier, SncfStationReferenceObservation,
    WikidataCityObservation, apply_name_rules, read_json_lines, write_json, write_json_lines,
};

const INSEE_SOURCE_ID: &str = "fr-insee-cog-municipalities";
const SNCF_STATION_SOURCE_ID: &str = "fr-sncf-gares-voyageurs";
const SNCF_MEMBERSHIP_SOURCE_ID: &str = "fr-sncf-gares-voyageurs-commune-membership";
const WIKIDATA_SOURCE_ID: &str = "wikidata-city-enrichment-seed";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FranceAuthorityBuildSummary {
    pub city_count: usize,
    pub station_count: usize,
    pub membership_count: usize,
    pub city_authority_evidence_count: usize,
    pub membership_evidence_count: usize,
    pub audit_count: usize,
}

pub fn build_france_authority_registry(
    dataset_id: &str,
    scope: &str,
    generated_at: &str,
    insee_input_path: &Path,
    sncf_station_input_path: &Path,
    wikidata_input_path: &Path,
    rules_path: &Path,
    output_root: &Path,
) -> Result<FranceAuthorityBuildSummary> {
    let layout = RegistryBuildLayout::under(output_root);
    layout.ensure()?;

    let insee_communes = read_json_lines::<InseeCommuneObservation>(insee_input_path)
        .with_context(|| {
            format!(
                "failed to load INSEE observations from {}",
                insee_input_path.display()
            )
        })?;
    let sncf_stations =
        load_sncf_station_references(sncf_station_input_path).with_context(|| {
            format!(
                "failed to load SNCF stations from {}",
                sncf_station_input_path.display()
            )
        })?;
    let wikidata_cities = read_json_lines::<WikidataCityObservation>(wikidata_input_path)
        .with_context(|| {
            format!(
                "failed to load Wikidata observations from {}",
                wikidata_input_path.display()
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

    let wikidata_by_name = build_wikidata_lookup(&wikidata_cities, &rules);
    let mut city_id_by_code = BTreeMap::<String, CityId>::new();
    let mut cities = Vec::new();
    let mut name_variants = Vec::new();
    let mut city_authority_evidence = Vec::new();

    for commune in &insee_communes {
        let code_insee = normalize_french_code_insee(&commune.code_insee);
        let cleaned_name = apply_name_rules(
            &commune.display_name,
            Some(commune.country_code.as_str()),
            Some(INSEE_SOURCE_ID),
            &rules,
        )
        .ok_or_else(|| {
            anyhow!(
                "INSEE commune {} was rejected by name rules",
                commune.code_insee
            )
        })?;
        let wikidata = wikidata_by_name.get(&normalize_place_key(&cleaned_name));
        let city_id = CityId::new(match wikidata {
            Some(observation) => format!(
                "{}-fr-{}",
                slugify(&cleaned_name),
                observation.qid.to_ascii_lowercase()
            ),
            None => format!("{}-fr-{}", slugify(&cleaned_name), code_insee),
        })?;
        city_id_by_code.insert(code_insee.clone(), city_id.clone());

        let mut external_refs = vec![ExternalRecordRef {
            source_id: INSEE_SOURCE_ID.to_string(),
            external_id: code_insee.clone(),
            authority_role: Some(RegistryAuthorityRole::MunicipalityIdentity),
            trust_tier: Some(RegistryTrustTier::Official),
        }];
        if let Some(observation) = wikidata {
            external_refs.push(ExternalRecordRef {
                source_id: WIKIDATA_SOURCE_ID.to_string(),
                external_id: observation.qid.clone(),
                authority_role: Some(RegistryAuthorityRole::Enrichment),
                trust_tier: Some(RegistryTrustTier::LinkedOpenData),
            });
            external_refs.push(ExternalRecordRef {
                source_id: "wikidata-entity-url".to_string(),
                external_id: format!("https://www.wikidata.org/wiki/{}", observation.qid),
                authority_role: Some(RegistryAuthorityRole::Enrichment),
                trust_tier: Some(RegistryTrustTier::LinkedOpenData),
            });
            for alias in &observation.aliases {
                name_variants.push(RegistryNameVariant {
                    city_id: city_id.clone(),
                    value: alias.clone(),
                    kind: RegistryNameVariantKind::CanonicalAlias,
                    source: WIKIDATA_SOURCE_ID.to_string(),
                });
            }
        }

        city_authority_evidence.push(RegistryCityAuthorityEvidence {
            city_id: city_id.clone(),
            source_ref: ExternalRecordRef {
                source_id: INSEE_SOURCE_ID.to_string(),
                external_id: code_insee,
                authority_role: Some(RegistryAuthorityRole::MunicipalityIdentity),
                trust_tier: Some(RegistryTrustTier::Official),
            },
            evidence_kind: RegistryEvidenceKind::OfficialCode,
            confidence: 100,
        });

        cities.push(RegistryCity {
            city_id,
            slug: slugify(&cleaned_name),
            display_name: cleaned_name,
            country_code: "FR".to_string(),
            identity_point: commune.location,
            map_anchor_point: commune.location,
            bbox: Some(GeoBounds {
                min_lat: commune.location.lat,
                min_lon: commune.location.lon,
                max_lat: commune.location.lat,
                max_lon: commune.location.lon,
            }),
            wikidata_qid: wikidata.map(|observation| observation.qid.clone()),
            population: wikidata.and_then(|observation| observation.population),
            status: RegistryStatus::Resolved,
            external_refs,
        });
    }

    let mut stations = Vec::new();
    let mut memberships = Vec::new();
    let mut membership_evidence = Vec::new();
    let mut findings = Vec::new();
    let mut seen_station_ids = BTreeSet::<StationId>::new();

    for reference in &sncf_stations {
        let Some(code_insee) = reference
            .code_insee
            .as_deref()
            .map(normalize_french_code_insee)
        else {
            continue;
        };
        let Some(city_id) = city_id_by_code.get(&code_insee).cloned() else {
            continue;
        };
        let station_id = StationId::new(stable_station_id(reference))?;
        if !seen_station_ids.insert(station_id.clone()) {
            continue;
        }

        stations.push(RegistryStation {
            station_id: station_id.clone(),
            display_name: reference.display_name.clone(),
            country_code: "FR".to_string(),
            location: reference.location,
            uic_code: reference.uic_codes.first().cloned(),
            status: RegistryStatus::Resolved,
            external_refs: vec![ExternalRecordRef {
                source_id: SNCF_STATION_SOURCE_ID.to_string(),
                external_id: reference.raw_id.clone(),
                authority_role: Some(RegistryAuthorityRole::StationIdentity),
                trust_tier: Some(RegistryTrustTier::Official),
            }],
        });
        memberships.push(RegistryCityStationMembership {
            city_id: city_id.clone(),
            station_id: station_id.clone(),
            is_primary: false,
        });
        membership_evidence.push(RegistryStationCityMembershipEvidence {
            city_id: city_id.clone(),
            station_id: station_id.clone(),
            source_ref: ExternalRecordRef {
                source_id: SNCF_MEMBERSHIP_SOURCE_ID.to_string(),
                external_id: code_insee,
                authority_role: Some(RegistryAuthorityRole::StationCityMembership),
                trust_tier: Some(RegistryTrustTier::Official),
            },
            evidence_kind: RegistryEvidenceKind::OfficialCode,
            confidence: 100,
        });
        name_variants.push(RegistryNameVariant {
            city_id,
            value: reference.display_name.clone(),
            kind: RegistryNameVariantKind::StationVariant,
            source: SNCF_STATION_SOURCE_ID.to_string(),
        });
    }

    mark_primary_station_memberships(&mut memberships, &stations);
    attach_city_bounds(&mut cities, &stations, &memberships);

    let station_count_by_city =
        memberships
            .iter()
            .fold(BTreeMap::<CityId, u32>::new(), |mut counts, membership| {
                *counts.entry(membership.city_id.clone()).or_default() += 1;
                counts
            });
    for city in &cities {
        if !station_count_by_city.contains_key(&city.city_id) {
            findings.push(RegistryAuditFinding {
                kind: RegistryAuditFindingKind::UnresolvedCity,
                severity: RegistryAuditSeverity::Warning,
                entity_ref: city.city_id.to_string(),
                message: format!(
                    "France authority city {} has no SNCF station membership in this scoped build",
                    city.display_name
                ),
            });
        }
    }

    let city_facts = cities
        .iter()
        .map(|city| RegistryCityFacts {
            city_id: city.city_id.clone(),
            station_count: station_count_by_city.get(&city.city_id).copied(),
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
        name_variants: name_variants.clone(),
        city_facts: city_facts.clone(),
        city_signals: city_signals.clone(),
        city_authority_evidence: city_authority_evidence.clone(),
        membership_evidence: membership_evidence.clone(),
    };

    write_json_lines(
        &layout
            .observations_dir
            .join("insee-commune-observations.jsonl"),
        &insee_communes,
    )?;
    write_json_lines(
        &layout
            .observations_dir
            .join("sncf-station-observations.jsonl"),
        &sncf_stations,
    )?;
    write_json_lines(
        &layout
            .observations_dir
            .join("wikidata-city-observations.jsonl"),
        &wikidata_cities,
    )?;
    write_json(&layout.canonical_dir.join("bundle.json"), &bundle)?;
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
            variants: name_variants,
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
    write_json(
        &layout.canonical_dir.join("city-authority-evidence.json"),
        &RegistryCityAuthorityEvidenceCollection {
            meta: meta.clone(),
            evidence: city_authority_evidence.clone(),
        },
    )?;
    write_json(
        &layout.canonical_dir.join("membership-evidence.json"),
        &RegistryStationCityMembershipEvidenceCollection {
            meta,
            evidence: membership_evidence.clone(),
        },
    )?;
    write_json(&layout.audit_dir.join("findings.json"), &findings)?;

    Ok(FranceAuthorityBuildSummary {
        city_count: bundle.cities.len(),
        station_count: bundle.stations.len(),
        membership_count: bundle.memberships.len(),
        city_authority_evidence_count: city_authority_evidence.len(),
        membership_evidence_count: membership_evidence.len(),
        audit_count: findings.len(),
    })
}

fn load_sncf_station_references(path: &Path) -> Result<Vec<SncfStationReferenceObservation>> {
    let mut reader = ReaderBuilder::new()
        .flexible(true)
        .trim(Trim::All)
        .from_path(path)?;
    let headers = reader
        .headers()
        .context("failed to read SNCF station reference headers")?
        .iter()
        .map(normalize_header)
        .collect::<Vec<_>>();
    let index_of = |name: &str| {
        headers
            .iter()
            .position(|header| header == name)
            .with_context(|| format!("missing {name} column in {}", path.display()))
    };
    let name_idx = index_of("nom")?;
    let position_idx = index_of("position_geographique")?;
    let code_insee_idx = index_of("codeinsee")?;
    let codes_uic_idx = index_of("codes_uic")?;
    let id_idx = index_of("id")?;

    let mut observations = Vec::new();
    for row in reader.records() {
        let row = row.context("failed to read SNCF station reference record")?;
        let display_name = cell(&row, name_idx).to_string();
        let Some(location) = parse_lat_lon_pair(cell(&row, position_idx)) else {
            continue;
        };
        observations.push(SncfStationReferenceObservation {
            raw_id: cell(&row, id_idx).to_string(),
            display_name,
            code_insee: non_empty(cell(&row, code_insee_idx)).map(normalize_french_code_insee),
            location,
            uic_codes: extract_digit_sequences(cell(&row, codes_uic_idx)),
        });
    }
    Ok(observations)
}

fn build_wikidata_lookup<'a>(
    observations: &'a [WikidataCityObservation],
    rules: &NameRuleSet,
) -> BTreeMap<String, &'a WikidataCityObservation> {
    let mut lookup = BTreeMap::new();
    for observation in observations {
        if observation
            .country_code
            .as_deref()
            .is_some_and(|country| !country.eq_ignore_ascii_case("FR"))
        {
            continue;
        }
        if let Some(cleaned) = apply_name_rules(
            &observation.label,
            Some("FR"),
            Some(WIKIDATA_SOURCE_ID),
            rules,
        ) {
            lookup.insert(normalize_place_key(&cleaned), observation);
        }
        for alias in &observation.aliases {
            lookup
                .entry(normalize_place_key(alias))
                .or_insert(observation);
        }
    }
    lookup
}

fn mark_primary_station_memberships(
    memberships: &mut [RegistryCityStationMembership],
    stations: &[RegistryStation],
) {
    let station_order = stations
        .iter()
        .enumerate()
        .map(|(index, station)| (station.station_id.clone(), index))
        .collect::<BTreeMap<_, _>>();
    let mut first_by_city = BTreeMap::<CityId, usize>::new();
    for (index, membership) in memberships.iter().enumerate() {
        let station_order = station_order
            .get(&membership.station_id)
            .copied()
            .unwrap_or(usize::MAX);
        first_by_city
            .entry(membership.city_id.clone())
            .and_modify(|existing| {
                if station_order < *existing {
                    *existing = index;
                }
            })
            .or_insert(index);
    }
    for index in first_by_city.into_values() {
        memberships[index].is_primary = true;
    }
}

fn attach_city_bounds(
    cities: &mut [RegistryCity],
    stations: &[RegistryStation],
    memberships: &[RegistryCityStationMembership],
) {
    let stations_by_id = stations
        .iter()
        .map(|station| (station.station_id.clone(), station))
        .collect::<BTreeMap<_, _>>();
    let stations_by_city = memberships.iter().fold(
        BTreeMap::<CityId, Vec<&RegistryStation>>::new(),
        |mut grouped, membership| {
            if let Some(station) = stations_by_id.get(&membership.station_id) {
                grouped
                    .entry(membership.city_id.clone())
                    .or_default()
                    .push(station);
            }
            grouped
        },
    );
    for city in cities {
        let Some(city_stations) = stations_by_city.get(&city.city_id) else {
            continue;
        };
        city.bbox = Some(bounding_box(city.identity_point, city_stations));
    }
}

fn stable_station_id(reference: &SncfStationReferenceObservation) -> String {
    if let Some(uic) = reference.uic_codes.first() {
        format!("station-uic-{uic}")
    } else {
        format!("station-sncf-{}", slugify(&reference.raw_id))
    }
}

fn parse_lat_lon_pair(value: &str) -> Option<GeoPoint> {
    let (lat, lon) = value.split_once(',')?;
    Some(GeoPoint {
        lat: lat.trim().parse().ok()?,
        lon: lon.trim().parse().ok()?,
    })
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

fn normalize_header(value: &str) -> String {
    value
        .trim_start_matches('\u{feff}')
        .trim()
        .to_ascii_lowercase()
}

fn cell(record: &StringRecord, index: usize) -> &str {
    record.get(index).unwrap_or("").trim()
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn extract_digit_sequences(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in value.chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn normalize_french_code_insee(input: impl AsRef<str>) -> String {
    match input.as_ref() {
        "75101" | "75102" | "75103" | "75104" | "75105" | "75106" | "75107" | "75108" | "75109"
        | "75110" | "75111" | "75112" | "75113" | "75114" | "75115" | "75116" | "75117"
        | "75118" | "75119" | "75120" => "75056".to_string(),
        "69381" | "69382" | "69383" | "69384" | "69385" | "69386" | "69387" | "69388" | "69389" => {
            "69123".to_string()
        }
        "13201" | "13202" | "13203" | "13204" | "13205" | "13206" | "13207" | "13208" | "13209"
        | "13210" | "13211" | "13212" | "13213" | "13214" | "13215" | "13216" => {
            "13055".to_string()
        }
        other => other.to_string(),
    }
}

fn normalize_place_key(value: &str) -> String {
    let ascii = deunicode(value);
    let mut normalized = String::with_capacity(ascii.len());
    for ch in ascii.chars() {
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch.to_ascii_lowercase());
        } else {
            normalized.push(' ');
        }
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
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
        std::env::temp_dir().join(format!("aetrain-registry-fr-authority-{label}-{nanos}"))
    }

    #[test]
    fn france_authority_builder_links_stations_by_insee_code() {
        let workdir = temp_path("build");
        fs::create_dir_all(&workdir).expect("temp dir should create");
        let insee = workdir.join("insee.jsonl");
        fs::write(
            &insee,
            "{\"code_insee\":\"31555\",\"display_name\":\"Toulouse\",\"country_code\":\"FR\",\"location\":{\"lat\":43.6044,\"lon\":1.4433}}\n",
        )
        .expect("insee should write");
        let stations = workdir.join("stations.csv");
        fs::write(
            &stations,
            "\u{feff}nom,position_geographique,codeinsee,codes_uic,id\nToulouse Matabiau,\"43.611206, 1.453616\",31555,87611004,station-1\n",
        )
        .expect("stations should write");
        let wikidata = workdir.join("wikidata.jsonl");
        fs::write(
            &wikidata,
            "{\"qid\":\"Q7880\",\"label\":\"Toulouse\",\"aliases\":[\"Tolosa\"],\"country_code\":\"FR\",\"location\":{\"lat\":43.6044,\"lon\":1.4433},\"population\":514819}\n",
        )
        .expect("wikidata should write");
        let rules = workdir.join("rules.toml");
        fs::write(&rules, "schema_version = 1\n").expect("rules should write");
        let out = workdir.join("out");

        let summary = build_france_authority_registry(
            "aetrain-registry-fr-authority-test",
            "fr-authority-test",
            "2026-05-22T00:00:00Z",
            &insee,
            &stations,
            &wikidata,
            &rules,
            &out,
        )
        .expect("authority build should succeed");

        assert_eq!(summary.city_count, 1);
        assert_eq!(summary.station_count, 1);
        assert_eq!(summary.membership_count, 1);
        let bundle: RegistryCanonicalBundle =
            read_json(&out.join("canonical/bundle.json")).expect("bundle should read");
        assert_eq!(bundle.cities[0].wikidata_qid.as_deref(), Some("Q7880"));
        assert_eq!(bundle.city_authority_evidence.len(), 1);
        assert_eq!(bundle.membership_evidence.len(), 1);
        assert_eq!(bundle.memberships[0].city_id, bundle.cities[0].city_id);
        assert_eq!(
            bundle.stations[0].station_id.as_str(),
            "station-uic-87611004"
        );
    }
}
