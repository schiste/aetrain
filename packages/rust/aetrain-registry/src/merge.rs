use std::collections::BTreeMap;

use crate::{
    RegistryCity, RegistryNameVariant, RegistryNameVariantKind, build_city_identity_key,
    canonical_city_display_name,
};

#[derive(Clone, Debug, PartialEq)]
pub struct MergedRegistryCities {
    pub cities: Vec<RegistryCity>,
    pub name_variants: Vec<RegistryNameVariant>,
}

pub fn merge_registry_cities(cities: &[RegistryCity]) -> MergedRegistryCities {
    let mut buckets = BTreeMap::<String, Vec<RegistryCity>>::new();
    for city in cities {
        buckets
            .entry(build_city_identity_key(
                &city.display_name,
                &city.country_code,
            ))
            .or_default()
            .push(city.clone());
    }

    let mut merged = Vec::new();
    let mut variants = Vec::new();

    for bucket in buckets.into_values() {
        let names = bucket
            .iter()
            .map(|city| city.display_name.clone())
            .collect::<Vec<_>>();
        let canonical_name =
            canonical_city_display_name(&names).unwrap_or_else(|| bucket[0].display_name.clone());
        let representative = bucket
            .iter()
            .max_by_key(|city| city.population.unwrap_or(0))
            .cloned()
            .unwrap_or_else(|| bucket[0].clone());

        for city in &bucket {
            if city.display_name != canonical_name {
                variants.push(RegistryNameVariant {
                    city_id: representative.city_id.clone(),
                    value: city.display_name.clone(),
                    kind: RegistryNameVariantKind::CanonicalAlias,
                    source: "merge".to_string(),
                });
            }
        }

        let mut representative = representative;
        representative.display_name = canonical_name;
        merged.push(representative);
    }

    MergedRegistryCities {
        cities: merged,
        name_variants: variants,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RegistryStatus;
    use aetrain_domain::{CityId, GeoPoint};

    fn city(city_id: &str, display_name: &str, country_code: &str) -> RegistryCity {
        RegistryCity {
            city_id: CityId::new(city_id).expect("valid city id"),
            slug: display_name.to_ascii_lowercase(),
            display_name: display_name.to_string(),
            country_code: country_code.to_string(),
            identity_point: GeoPoint { lat: 0.0, lon: 0.0 },
            map_anchor_point: GeoPoint { lat: 0.0, lon: 0.0 },
            bbox: None,
            wikidata_qid: None,
            population: None,
            status: RegistryStatus::Resolved,
            external_refs: Vec::new(),
        }
    }

    #[test]
    fn merges_station_qualified_duplicate_city() {
        let merged = merge_registry_cities(&[
            city("paris-fr-75056", "Paris", "FR"),
            city("paris-fr-alt", "Paris Gare de Lyon", "FR"),
        ]);

        assert_eq!(merged.cities.len(), 1);
        assert_eq!(merged.cities[0].display_name, "Paris");
        assert_eq!(merged.name_variants.len(), 1);
    }

    #[test]
    fn keeps_homonyms_from_different_countries_separate() {
        let merged = merge_registry_cities(&[
            city("baden-at", "Baden", "AT"),
            city("baden-ch", "Baden", "CH"),
        ]);

        assert_eq!(merged.cities.len(), 2);
    }
}
