use aetrain_domain::{GeoPoint, Station};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationRailAnchorStrategy {
    ExplicitRailAnchor,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StationRailAnchorRecord {
    pub station_id: String,
    pub station_location: GeoPoint,
    pub rail_anchor_location: GeoPoint,
    pub station_to_anchor_distance_m: Option<u32>,
    pub strategy: StationRailAnchorStrategy,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StationRailAnchorArtifact {
    pub anchors: Vec<StationRailAnchorRecord>,
}

pub fn build_station_rail_anchor_artifact(stations: &[Station]) -> StationRailAnchorArtifact {
    let mut anchors = stations
        .iter()
        .filter_map(|station| {
            let rail_anchor_location = station.rail_anchor_location?;
            Some(StationRailAnchorRecord {
                station_id: station.station_id.as_str().to_string(),
                station_location: station.location,
                rail_anchor_location,
                station_to_anchor_distance_m: Some(rounded_distance_m(
                    station.location,
                    rail_anchor_location,
                )),
                strategy: StationRailAnchorStrategy::ExplicitRailAnchor,
            })
        })
        .collect::<Vec<_>>();
    anchors.sort_by(|left, right| left.station_id.cmp(&right.station_id));
    StationRailAnchorArtifact { anchors }
}

fn rounded_distance_m(left: GeoPoint, right: GeoPoint) -> u32 {
    haversine_m(left, right).round().max(0.0) as u32
}

fn haversine_m(left: GeoPoint, right: GeoPoint) -> f64 {
    const EARTH_RADIUS_M: f64 = 6_371_000.0;
    let lat1 = left.lat.to_radians();
    let lat2 = right.lat.to_radians();
    let dlat = (right.lat - left.lat).to_radians();
    let dlon = (right.lon - left.lon).to_radians();
    let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());
    EARTH_RADIUS_M * c
}

#[cfg(test)]
mod tests {
    use super::*;
    use aetrain_domain::{CityId, StationId, StationKind, StationScope};

    #[test]
    fn emits_only_explicit_rail_anchors() {
        let stations = vec![Station {
            station_id: StationId::new("station-a").expect("valid station id"),
            city_id: CityId::new("paris-fr").expect("valid city id"),
            display_name: "A".to_string(),
            location: GeoPoint {
                lat: 48.0,
                lon: 2.0,
            },
            rail_anchor_location: Some(GeoPoint {
                lat: 48.0001,
                lon: 2.0001,
            }),
            station_kind: StationKind::MainlineRail,
            station_scope: StationScope::CustomerStation,
            station_complex_id: None,
            wikidata_qid: None,
            uic_code: None,
            aliases: Vec::new(),
            operators: Vec::new(),
            networks: Vec::new(),
            prominence: None,
            source_refs: Vec::new(),
        }];

        let artifact = build_station_rail_anchor_artifact(&stations);

        assert_eq!(artifact.anchors.len(), 1);
        assert!(artifact.anchors[0].station_to_anchor_distance_m.unwrap() > 0);
    }
}
