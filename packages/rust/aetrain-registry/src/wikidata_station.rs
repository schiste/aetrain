use aetrain_domain::{GeoPoint, StationKind, StationScope};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WikidataStationClaimSnapshot {
    pub qid: String,
    pub label: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub country_code: Option<String>,
    pub location: Option<GeoPoint>,
    #[serde(default)]
    pub instance_of: Vec<String>,
    #[serde(default)]
    pub part_of: Vec<String>,
    #[serde(default)]
    pub has_parts: Vec<String>,
    #[serde(default)]
    pub uic_station_codes: Vec<String>,
    #[serde(default)]
    pub ibnr_ids: Vec<String>,
    #[serde(default)]
    pub osm_relation_ids: Vec<String>,
    #[serde(default)]
    pub station_codes: Vec<String>,
    #[serde(default)]
    pub operators: Vec<String>,
    #[serde(default)]
    pub networks: Vec<String>,
    #[serde(default)]
    pub connecting_lines: Vec<String>,
    #[serde(default)]
    pub connecting_services: Vec<String>,
    pub platform_track_count: Option<u16>,
    pub patronage: Option<u64>,
    pub official_website: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikidataStationClassification {
    pub station_kind: StationKind,
    pub station_scope: StationScope,
    pub is_runtime_candidate: bool,
}

pub fn classify_wikidata_station(
    snapshot: &WikidataStationClaimSnapshot,
) -> WikidataStationClassification {
    let instance_text = snapshot
        .instance_of
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ");

    let station_kind = if instance_text.contains("bus") {
        StationKind::Bus
    } else if instance_text.contains("metro") || instance_text.contains("underground station") {
        StationKind::Metro
    } else if instance_text.contains("tram") {
        StationKind::Tram
    } else if instance_text.contains("airport railway") {
        StationKind::AirportRail
    } else if instance_text.contains("high-speed") || instance_text.contains("inter-city") {
        StationKind::HighSpeedRail
    } else if instance_text.contains("platform") {
        StationKind::Platform
    } else if instance_text.contains("station complex") || !snapshot.has_parts.is_empty() {
        StationKind::StationComplex
    } else if instance_text.contains("railway") || instance_text.contains("central station") {
        StationKind::MainlineRail
    } else {
        StationKind::Unknown
    };

    let station_scope = match station_kind {
        StationKind::Bus | StationKind::Metro | StationKind::Tram => StationScope::NonRailStop,
        StationKind::Platform => StationScope::PlatformArea,
        StationKind::StationComplex => StationScope::InterchangeComplex,
        StationKind::Unknown => StationScope::Unknown,
        _ if !snapshot.part_of.is_empty() => StationScope::StationPart,
        _ => StationScope::CustomerStation,
    };
    let is_runtime_candidate = matches!(
        station_kind,
        StationKind::MainlineRail
            | StationKind::HighSpeedRail
            | StationKind::AirportRail
            | StationKind::SuburbanRail
    );

    WikidataStationClassification {
        station_kind,
        station_scope,
        is_runtime_candidate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_bus_and_mainline_station_snapshots() {
        let bus = snapshot(vec!["bus station"]);
        let rail = snapshot(vec!["central station", "railway station"]);

        assert_eq!(
            classify_wikidata_station(&bus).station_kind,
            StationKind::Bus
        );
        assert_eq!(
            classify_wikidata_station(&rail).station_kind,
            StationKind::MainlineRail
        );
    }

    fn snapshot(instance_of: Vec<&str>) -> WikidataStationClaimSnapshot {
        WikidataStationClaimSnapshot {
            qid: "Q1".to_string(),
            label: "Station".to_string(),
            aliases: Vec::new(),
            description: None,
            country_code: None,
            location: None,
            instance_of: instance_of.into_iter().map(str::to_string).collect(),
            part_of: Vec::new(),
            has_parts: Vec::new(),
            uic_station_codes: Vec::new(),
            ibnr_ids: Vec::new(),
            osm_relation_ids: Vec::new(),
            station_codes: Vec::new(),
            operators: Vec::new(),
            networks: Vec::new(),
            connecting_lines: Vec::new(),
            connecting_services: Vec::new(),
            platform_track_count: None,
            patronage: None,
            official_website: None,
            image_url: None,
        }
    }
}
