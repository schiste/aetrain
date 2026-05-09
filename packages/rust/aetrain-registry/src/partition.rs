use std::collections::BTreeSet;

use crate::RegistryCanonicalBundle;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryPartition {
    pub country_code: String,
}

pub fn partition_bundle_by_country(
    bundle: &RegistryCanonicalBundle,
    country_code: &str,
) -> RegistryCanonicalBundle {
    let cities = bundle
        .cities
        .iter()
        .filter(|city| city.country_code.eq_ignore_ascii_case(country_code))
        .cloned()
        .collect::<Vec<_>>();
    let city_ids = cities
        .iter()
        .map(|city| city.city_id.clone())
        .collect::<BTreeSet<_>>();
    let memberships = bundle
        .memberships
        .iter()
        .filter(|membership| city_ids.contains(&membership.city_id))
        .cloned()
        .collect::<Vec<_>>();
    let station_ids = memberships
        .iter()
        .map(|membership| membership.station_id.clone())
        .collect::<BTreeSet<_>>();
    let stations = bundle
        .stations
        .iter()
        .filter(|station| station_ids.contains(&station.station_id))
        .cloned()
        .collect::<Vec<_>>();
    let name_variants = bundle
        .name_variants
        .iter()
        .filter(|variant| city_ids.contains(&variant.city_id))
        .cloned()
        .collect::<Vec<_>>();

    RegistryCanonicalBundle {
        meta: bundle.meta.clone(),
        cities,
        stations,
        memberships,
        name_variants,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RegistryCity, RegistryCityStationMembership, RegistryMeta, RegistryNameVariant,
        RegistryNameVariantKind, RegistryStation, RegistryStatus,
    };
    use aetrain_domain::{CityId, GeoPoint, StationId};

    #[test]
    fn partition_filters_bundle_by_country() {
        let bundle = RegistryCanonicalBundle {
            meta: RegistryMeta {
                schema_version: 1,
                dataset_id: "aetrain-registry".to_string(),
                scope: "europe".to_string(),
                generated_at: "2026-05-09T00:00:00Z".to_string(),
            },
            cities: vec![
                RegistryCity {
                    city_id: CityId::new("paris-fr").expect("valid city id"),
                    display_name: "Paris".to_string(),
                    country_code: "FR".to_string(),
                    location: GeoPoint { lat: 0.0, lon: 0.0 },
                    wikidata_qid: None,
                    population: None,
                    status: RegistryStatus::Resolved,
                    external_refs: Vec::new(),
                },
                RegistryCity {
                    city_id: CityId::new("baden-ch").expect("valid city id"),
                    display_name: "Baden".to_string(),
                    country_code: "CH".to_string(),
                    location: GeoPoint { lat: 0.0, lon: 0.0 },
                    wikidata_qid: None,
                    population: None,
                    status: RegistryStatus::Resolved,
                    external_refs: Vec::new(),
                },
            ],
            stations: vec![
                RegistryStation {
                    station_id: StationId::new("station-paris").expect("valid station id"),
                    display_name: "Paris Gare de Lyon".to_string(),
                    country_code: "FR".to_string(),
                    location: GeoPoint { lat: 0.0, lon: 0.0 },
                    uic_code: None,
                    status: RegistryStatus::Resolved,
                    external_refs: Vec::new(),
                },
                RegistryStation {
                    station_id: StationId::new("station-baden").expect("valid station id"),
                    display_name: "Baden".to_string(),
                    country_code: "CH".to_string(),
                    location: GeoPoint { lat: 0.0, lon: 0.0 },
                    uic_code: None,
                    status: RegistryStatus::Resolved,
                    external_refs: Vec::new(),
                },
            ],
            memberships: vec![
                RegistryCityStationMembership {
                    city_id: CityId::new("paris-fr").expect("valid city id"),
                    station_id: StationId::new("station-paris").expect("valid station id"),
                    is_primary: true,
                },
                RegistryCityStationMembership {
                    city_id: CityId::new("baden-ch").expect("valid city id"),
                    station_id: StationId::new("station-baden").expect("valid station id"),
                    is_primary: true,
                },
            ],
            name_variants: vec![RegistryNameVariant {
                city_id: CityId::new("paris-fr").expect("valid city id"),
                value: "Paris Gare de Lyon".to_string(),
                kind: RegistryNameVariantKind::StationVariant,
                source: "osm".to_string(),
            }],
        };

        let fr = partition_bundle_by_country(&bundle, "FR");
        assert_eq!(fr.cities.len(), 1);
        assert_eq!(fr.stations.len(), 1);
        assert_eq!(fr.memberships.len(), 1);
        assert_eq!(fr.name_variants.len(), 1);
    }
}
