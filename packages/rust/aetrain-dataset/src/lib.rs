use aetrain_domain::{City, CityId, DATASET_SCHEMA_VERSION, Station, TravelEdge};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceSnapshot {
    pub source_id: String,
    pub fetched_at: String,
    pub version_hint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatasetMeta {
    pub schema_version: u16,
    pub dataset_version: String,
    pub generated_at: String,
    pub source_snapshots: Vec<SourceSnapshot>,
    pub attribution_path: String,
}

impl DatasetMeta {
    pub fn new(dataset_version: impl Into<String>, generated_at: impl Into<String>) -> Self {
        Self {
            schema_version: DATASET_SCHEMA_VERSION,
            dataset_version: dataset_version.into(),
            generated_at: generated_at.into(),
            source_snapshots: Vec::new(),
            attribution_path: "attribution.json".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AliasRecord {
    pub alias: String,
    pub city_id: CityId,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DatasetBundle {
    pub meta: DatasetMeta,
    pub cities: Vec<City>,
    pub stations: Vec<Station>,
    pub edges: Vec<TravelEdge>,
    pub aliases: Vec<AliasRecord>,
}

impl DatasetBundle {
    pub fn city(&self, city_id: &CityId) -> Option<&City> {
        self.cities.iter().find(|city| &city.city_id == city_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dataset_meta_defaults_to_current_schema() {
        let meta = DatasetMeta::new("2026-05-07", "2026-05-07T12:00:00Z");
        assert_eq!(meta.schema_version, DATASET_SCHEMA_VERSION);
        assert_eq!(meta.attribution_path, "attribution.json");
    }
}
