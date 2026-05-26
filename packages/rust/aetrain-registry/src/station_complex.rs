use std::collections::BTreeMap;

use aetrain_domain::{GeoPoint, Station};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StationComplexRecord {
    pub station_complex_id: String,
    pub display_name: String,
    pub location: GeoPoint,
    pub wikidata_qid: Option<String>,
    pub station_ids: Vec<String>,
    pub aliases: Vec<String>,
    pub source: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StationComplexArtifact {
    pub complexes: Vec<StationComplexRecord>,
}

pub fn build_station_complex_artifact(stations: &[Station]) -> StationComplexArtifact {
    let mut grouped = BTreeMap::<String, Vec<&Station>>::new();
    for station in stations {
        let Some(station_complex_id) = station.station_complex_id.as_deref() else {
            continue;
        };
        grouped
            .entry(station_complex_id.to_string())
            .or_default()
            .push(station);
    }

    let mut complexes = grouped
        .into_iter()
        .map(|(station_complex_id, mut members)| {
            members.sort_by(|left, right| left.station_id.cmp(&right.station_id));
            let primary = members[0];
            let location = average_station_location(&members);
            let mut aliases = members
                .iter()
                .flat_map(|station| station.aliases.iter().cloned())
                .collect::<Vec<_>>();
            aliases.sort();
            aliases.dedup();

            StationComplexRecord {
                station_complex_id,
                display_name: primary.display_name.clone(),
                location,
                wikidata_qid: primary.wikidata_qid.clone(),
                station_ids: members
                    .iter()
                    .map(|station| station.station_id.as_str().to_string())
                    .collect(),
                aliases,
                source: "station_complex_id".to_string(),
            }
        })
        .collect::<Vec<_>>();

    complexes.sort_by(|left, right| left.station_complex_id.cmp(&right.station_complex_id));
    StationComplexArtifact { complexes }
}

fn average_station_location(stations: &[&Station]) -> GeoPoint {
    let count = stations.len().max(1) as f64;
    let lat = stations
        .iter()
        .map(|station| station.location.lat)
        .sum::<f64>()
        / count;
    let lon = stations
        .iter()
        .map(|station| station.location.lon)
        .sum::<f64>()
        / count;
    GeoPoint { lat, lon }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aetrain_domain::{CityId, StationId, StationKind, StationScope};

    #[test]
    fn groups_station_complex_members() {
        let stations = vec![
            Station {
                station_id: StationId::new("station-a").expect("valid station id"),
                city_id: CityId::new("paris-fr").expect("valid city id"),
                display_name: "A".to_string(),
                location: GeoPoint { lat: 1.0, lon: 2.0 },
                rail_anchor_location: None,
                station_kind: StationKind::MainlineRail,
                station_scope: StationScope::CustomerStation,
                station_complex_id: Some("complex-paris".to_string()),
                wikidata_qid: Some("Q1".to_string()),
                uic_code: None,
                aliases: vec!["Alpha".to_string()],
                operators: Vec::new(),
                networks: Vec::new(),
                prominence: None,
                source_refs: Vec::new(),
            },
            Station {
                station_id: StationId::new("station-b").expect("valid station id"),
                city_id: CityId::new("paris-fr").expect("valid city id"),
                display_name: "B".to_string(),
                location: GeoPoint { lat: 3.0, lon: 4.0 },
                rail_anchor_location: None,
                station_kind: StationKind::SuburbanRail,
                station_scope: StationScope::StationPart,
                station_complex_id: Some("complex-paris".to_string()),
                wikidata_qid: None,
                uic_code: None,
                aliases: Vec::new(),
                operators: Vec::new(),
                networks: Vec::new(),
                prominence: None,
                source_refs: Vec::new(),
            },
        ];

        let artifact = build_station_complex_artifact(&stations);

        assert_eq!(artifact.complexes.len(), 1);
        assert_eq!(
            artifact.complexes[0].station_ids,
            vec!["station-a", "station-b"]
        );
        assert_eq!(
            artifact.complexes[0].location,
            GeoPoint { lat: 2.0, lon: 3.0 }
        );
    }
}
