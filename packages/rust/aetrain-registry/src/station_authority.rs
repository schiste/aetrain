use aetrain_domain::{Station, StationKind, StationScope};
use serde::{Deserialize, Serialize};

use crate::station_match::is_valid_wikidata_qid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationAuthorityRefKind {
    WikidataQid,
    UicCode,
    SourceRecord,
    GtfsStopId,
    OsmNode,
    OsmRelation,
    NationalStationId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationAuthorityRef {
    pub kind: StationAuthorityRefKind,
    pub value: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationMatchEvidenceKind {
    IdentifierExact,
    WikidataQidAccepted,
    WikidataQidInvalid,
    CoordinateDistance,
    NameAliasMatch,
    ManualOverride,
    SourceCarryForward,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationMatchEvidence {
    pub kind: StationMatchEvidenceKind,
    pub source: String,
    pub confidence: u8,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationIdentityResolutionStatus {
    Resolved,
    Provisional,
    NeedsReview,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationAuthorityRecord {
    pub station_id: String,
    pub display_name: String,
    pub station_kind: StationKind,
    pub station_scope: StationScope,
    pub station_complex_id: Option<String>,
    pub wikidata_qid: Option<String>,
    pub authority_refs: Vec<StationAuthorityRef>,
    pub match_evidence: Vec<StationMatchEvidence>,
    pub resolution_status: StationIdentityResolutionStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationAuthorityArtifact {
    pub records: Vec<StationAuthorityRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationEnrichmentRecord {
    pub station_id: String,
    pub labels: Vec<String>,
    pub aliases: Vec<String>,
    pub operators: Vec<String>,
    pub networks: Vec<String>,
    pub prominence: Option<u16>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StationEnrichmentArtifact {
    pub records: Vec<StationEnrichmentRecord>,
}

pub fn build_station_authority_artifact(stations: &[Station]) -> StationAuthorityArtifact {
    let mut records = stations
        .iter()
        .map(build_station_authority_record)
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.station_id.cmp(&right.station_id));
    StationAuthorityArtifact { records }
}

pub fn build_station_enrichment_artifact(stations: &[Station]) -> StationEnrichmentArtifact {
    let mut records = stations
        .iter()
        .map(|station| {
            let mut labels = vec![station.display_name.clone()];
            labels.extend(station.aliases.iter().cloned());
            labels.sort();
            labels.dedup();

            StationEnrichmentRecord {
                station_id: station.station_id.as_str().to_string(),
                labels,
                aliases: station.aliases.clone(),
                operators: sorted_unique(&station.operators),
                networks: sorted_unique(&station.networks),
                prominence: station.prominence,
            }
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.station_id.cmp(&right.station_id));
    StationEnrichmentArtifact { records }
}

fn build_station_authority_record(station: &Station) -> StationAuthorityRecord {
    let mut authority_refs = Vec::new();
    let mut match_evidence = Vec::new();
    let mut resolution_status = StationIdentityResolutionStatus::Provisional;

    if let Some(qid) = station.wikidata_qid.as_deref() {
        authority_refs.push(StationAuthorityRef {
            kind: StationAuthorityRefKind::WikidataQid,
            value: qid.to_string(),
            source: "station.wikidata_qid".to_string(),
        });
        if is_valid_wikidata_qid(qid) {
            match_evidence.push(StationMatchEvidence {
                kind: StationMatchEvidenceKind::WikidataQidAccepted,
                source: "wikidata".to_string(),
                confidence: 95,
                message: "station carries a syntactically valid Wikidata QID".to_string(),
            });
            resolution_status = StationIdentityResolutionStatus::Resolved;
        } else {
            match_evidence.push(StationMatchEvidence {
                kind: StationMatchEvidenceKind::WikidataQidInvalid,
                source: "wikidata".to_string(),
                confidence: 0,
                message: "station carries an invalid Wikidata QID".to_string(),
            });
            resolution_status = StationIdentityResolutionStatus::NeedsReview;
        }
    }

    if let Some(uic_code) = station.uic_code.as_deref() {
        authority_refs.push(StationAuthorityRef {
            kind: StationAuthorityRefKind::UicCode,
            value: uic_code.to_string(),
            source: "station.uic_code".to_string(),
        });
        match_evidence.push(StationMatchEvidence {
            kind: StationMatchEvidenceKind::IdentifierExact,
            source: "uic".to_string(),
            confidence: 90,
            message: "station carries a UIC code".to_string(),
        });
        if matches!(
            resolution_status,
            StationIdentityResolutionStatus::Provisional
        ) {
            resolution_status = StationIdentityResolutionStatus::Resolved;
        }
    }

    for source_ref in &station.source_refs {
        authority_refs.push(StationAuthorityRef {
            kind: StationAuthorityRefKind::SourceRecord,
            value: source_ref.raw_id.clone(),
            source: source_ref.source_id.clone(),
        });
    }

    if station.wikidata_qid.is_none() && station.uic_code.is_none() {
        match_evidence.push(StationMatchEvidence {
            kind: StationMatchEvidenceKind::SourceCarryForward,
            source: "canonical_station".to_string(),
            confidence: 60,
            message: "station is carried from source data without external authority identity"
                .to_string(),
        });
    }

    StationAuthorityRecord {
        station_id: station.station_id.as_str().to_string(),
        display_name: station.display_name.clone(),
        station_kind: station.station_kind.clone(),
        station_scope: station.station_scope.clone(),
        station_complex_id: station.station_complex_id.clone(),
        wikidata_qid: station.wikidata_qid.clone(),
        authority_refs,
        match_evidence,
        resolution_status,
    }
}

fn sorted_unique(values: &[String]) -> Vec<String> {
    let mut values = values.to_vec();
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use aetrain_domain::{CityId, GeoPoint, SourceRef, StationId};

    #[test]
    fn builds_authority_refs_and_invalid_qid_evidence() {
        let station = Station {
            station_id: StationId::new("station-uic-87271007").expect("valid station id"),
            city_id: CityId::new("paris-fr").expect("valid city id"),
            display_name: "Paris Gare de Lyon".to_string(),
            location: GeoPoint { lat: 0.0, lon: 0.0 },
            rail_anchor_location: None,
            station_kind: StationKind::MainlineRail,
            station_scope: StationScope::CustomerStation,
            station_complex_id: None,
            wikidata_qid: Some("not-a-qid".to_string()),
            uic_code: Some("87271007".to_string()),
            aliases: Vec::new(),
            operators: Vec::new(),
            networks: Vec::new(),
            prominence: None,
            source_refs: vec![SourceRef {
                source_id: "sncf".to_string(),
                raw_id: "raw-1".to_string(),
            }],
        };

        let artifact = build_station_authority_artifact(&[station]);

        assert_eq!(artifact.records.len(), 1);
        assert_eq!(
            artifact.records[0].resolution_status,
            StationIdentityResolutionStatus::NeedsReview
        );
        assert_eq!(artifact.records[0].authority_refs.len(), 3);
    }
}
