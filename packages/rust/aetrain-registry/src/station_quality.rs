use std::collections::{BTreeMap, BTreeSet};

use aetrain_domain::{City, Station};
use serde::{Deserialize, Serialize};

use crate::{
    StationComplexArtifact, StationRailAnchorArtifact,
    station_match::{
        is_customer_facing_rail_station, is_non_mainline_transport, is_valid_wikidata_qid,
    },
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationQualitySeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationQualityFlagKind {
    InvalidWikidataQid,
    DuplicateWikidataQid,
    MissingCityAttachment,
    NonMainlineRuntimeStation,
    MissingRailAnchor,
    EmptyStationComplex,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationQualityFlag {
    pub kind: StationQualityFlagKind,
    pub severity: StationQualitySeverity,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationQualityRecord {
    pub station_id: String,
    pub display_name: String,
    pub wikidata_qid: Option<String>,
    pub station_complex_id: Option<String>,
    pub flags: Vec<StationQualityFlag>,
    pub action: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationQualityArtifact {
    pub records: Vec<StationQualityRecord>,
}

pub fn audit_station_quality(
    cities: &[City],
    stations: &[Station],
    complexes: &StationComplexArtifact,
    rail_anchors: &StationRailAnchorArtifact,
) -> StationQualityArtifact {
    let city_ids = cities
        .iter()
        .map(|city| city.city_id.clone())
        .collect::<BTreeSet<_>>();
    let anchored_station_ids = rail_anchors
        .anchors
        .iter()
        .map(|anchor| anchor.station_id.as_str())
        .collect::<BTreeSet<_>>();
    let complex_ids = complexes
        .complexes
        .iter()
        .map(|complex| complex.station_complex_id.as_str())
        .collect::<BTreeSet<_>>();
    let qid_counts = wikidata_qid_counts(stations);

    let mut records = stations
        .iter()
        .filter_map(|station| {
            let mut flags = Vec::new();

            if !city_ids.contains(&station.city_id) {
                flags.push(flag(
                    StationQualityFlagKind::MissingCityAttachment,
                    StationQualitySeverity::Error,
                    format!("station references missing city {}", station.city_id),
                ));
            }

            if let Some(qid) = station.wikidata_qid.as_deref() {
                if !is_valid_wikidata_qid(qid) {
                    flags.push(flag(
                        StationQualityFlagKind::InvalidWikidataQid,
                        StationQualitySeverity::Error,
                        format!("station carries invalid Wikidata QID {qid}"),
                    ));
                }
                if qid_counts.get(qid).copied().unwrap_or_default() > 1
                    && !duplicate_qid_is_same_complex(station, stations)
                {
                    flags.push(flag(
                        StationQualityFlagKind::DuplicateWikidataQid,
                        StationQualitySeverity::Error,
                        format!("Wikidata QID {qid} is attached to multiple stations"),
                    ));
                }
            }

            if is_non_mainline_transport(&station.station_kind)
                && matches!(
                    station.station_scope,
                    aetrain_domain::StationScope::CustomerStation
                )
            {
                flags.push(flag(
                    StationQualityFlagKind::NonMainlineRuntimeStation,
                    StationQualitySeverity::Error,
                    "non-mainline transport station is marked customer-facing".to_string(),
                ));
            }

            if is_customer_facing_rail_station(&station.station_kind, &station.station_scope)
                && !anchored_station_ids.contains(station.station_id.as_str())
            {
                flags.push(flag(
                    StationQualityFlagKind::MissingRailAnchor,
                    StationQualitySeverity::Warning,
                    "customer-facing rail station has no explicit rail anchor".to_string(),
                ));
            }

            if let Some(station_complex_id) = station.station_complex_id.as_deref() {
                if !complex_ids.contains(station_complex_id) {
                    flags.push(flag(
                        StationQualityFlagKind::EmptyStationComplex,
                        StationQualitySeverity::Warning,
                        format!("station references unresolved complex {station_complex_id}"),
                    ));
                }
            }

            if flags.is_empty() {
                return None;
            }

            let action = if flags
                .iter()
                .any(|flag| flag.severity == StationQualitySeverity::Error)
            {
                "block_or_review".to_string()
            } else {
                "accepted_with_warning".to_string()
            };

            Some(StationQualityRecord {
                station_id: station.station_id.as_str().to_string(),
                display_name: station.display_name.clone(),
                wikidata_qid: station.wikidata_qid.clone(),
                station_complex_id: station.station_complex_id.clone(),
                flags,
                action,
            })
        })
        .collect::<Vec<_>>();

    records.sort_by(|left, right| left.station_id.cmp(&right.station_id));
    StationQualityArtifact { records }
}

fn wikidata_qid_counts(stations: &[Station]) -> BTreeMap<&str, usize> {
    let mut counts = BTreeMap::<&str, usize>::new();
    for station in stations {
        if let Some(qid) = station.wikidata_qid.as_deref() {
            *counts.entry(qid).or_default() += 1;
        }
    }
    counts
}

fn duplicate_qid_is_same_complex(station: &Station, stations: &[Station]) -> bool {
    let Some(qid) = station.wikidata_qid.as_deref() else {
        return false;
    };
    let Some(complex_id) = station.station_complex_id.as_deref() else {
        return false;
    };
    stations
        .iter()
        .filter(|candidate| candidate.wikidata_qid.as_deref() == Some(qid))
        .all(|candidate| candidate.station_complex_id.as_deref() == Some(complex_id))
}

fn flag(
    kind: StationQualityFlagKind,
    severity: StationQualitySeverity,
    message: String,
) -> StationQualityFlag {
    StationQualityFlag {
        kind,
        severity,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aetrain_domain::{CityId, GeoPoint, StationId, StationKind, StationScope};

    #[test]
    fn duplicate_station_qids_are_quality_errors() {
        let city_id = CityId::new("paris-fr").expect("valid city id");
        let cities = vec![City {
            city_id: city_id.clone(),
            slug: "paris".to_string(),
            display_name: "Paris".to_string(),
            country_code: "FR".to_string(),
            location: GeoPoint { lat: 0.0, lon: 0.0 },
            wikidata_qid: None,
            population: None,
            interest_score: None,
            station_ids: Vec::new(),
            aliases: Vec::new(),
        }];
        let stations = vec![
            station("station-a", &city_id),
            station("station-b", &city_id),
        ];

        let artifact = audit_station_quality(
            &cities,
            &stations,
            &StationComplexArtifact::default(),
            &StationRailAnchorArtifact::default(),
        );

        assert_eq!(artifact.records.len(), 2);
        assert!(artifact.records.iter().all(|record| {
            record
                .flags
                .iter()
                .any(|flag| flag.kind == StationQualityFlagKind::DuplicateWikidataQid)
        }));
    }

    fn station(id: &str, city_id: &CityId) -> Station {
        Station {
            station_id: StationId::new(id).expect("valid station id"),
            city_id: city_id.clone(),
            display_name: id.to_string(),
            location: GeoPoint { lat: 0.0, lon: 0.0 },
            rail_anchor_location: None,
            station_kind: StationKind::MainlineRail,
            station_scope: StationScope::CustomerStation,
            station_complex_id: None,
            wikidata_qid: Some("Q1".to_string()),
            uic_code: None,
            aliases: Vec::new(),
            operators: Vec::new(),
            networks: Vec::new(),
            prominence: None,
            source_refs: Vec::new(),
        }
    }
}
