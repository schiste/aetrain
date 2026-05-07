use aetrain_domain::{City, CityId, DATASET_SCHEMA_VERSION, Station, TravelEdge};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSnapshot {
    pub source_id: String,
    pub fetched_at: String,
    pub version_hint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AliasRecord {
    pub alias: String,
    pub city_id: CityId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeDatasetMeta {
    pub schema_version: u16,
    pub dataset_version: String,
    pub generated_at: String,
    pub country_count: u16,
    pub city_count: u32,
    pub edge_count: u32,
    pub alias_count: u32,
    pub station_artifact_path: Option<String>,
    pub attribution_path: String,
}

impl RuntimeDatasetMeta {
    pub fn from_canonical(
        meta: &DatasetMeta,
        country_count: u16,
        city_count: u32,
        edge_count: u32,
        alias_count: u32,
    ) -> Self {
        Self {
            schema_version: meta.schema_version,
            dataset_version: meta.dataset_version.clone(),
            generated_at: meta.generated_at.clone(),
            country_count,
            city_count,
            edge_count,
            alias_count,
            station_artifact_path: Some("stations.json".to_string()),
            attribution_path: meta.attribution_path.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeCountryRecord {
    pub code: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeCityRecord {
    pub city_id: CityId,
    pub slug: String,
    pub display_name: String,
    pub country_index: u16,
    pub lat_e5: i32,
    pub lon_e5: i32,
    pub population: Option<u32>,
    pub interest_score: Option<u8>,
    pub map_rank: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeGraph {
    pub edge_offsets: Vec<u32>,
    pub edge_targets: Vec<u32>,
    pub edge_durations_min: Vec<u16>,
    pub edge_mode_flags: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeGraphError {
    OffsetCountMismatch {
        expected: usize,
        actual: usize,
    },
    EdgeArrayLengthMismatch {
        targets: usize,
        durations: usize,
        mode_flags: usize,
    },
    FinalOffsetMismatch {
        expected: usize,
        actual: usize,
    },
    OffsetOutOfOrder {
        index: usize,
        previous: u32,
        current: u32,
    },
    TargetOutOfBounds {
        edge_index: usize,
        target: u32,
        city_count: usize,
    },
}

impl RuntimeGraph {
    pub fn edge_count(&self) -> usize {
        self.edge_targets.len()
    }

    pub fn validate(&self, city_count: usize) -> Result<(), RuntimeGraphError> {
        let expected_offset_count = city_count + 1;
        if self.edge_offsets.len() != expected_offset_count {
            return Err(RuntimeGraphError::OffsetCountMismatch {
                expected: expected_offset_count,
                actual: self.edge_offsets.len(),
            });
        }

        if self.edge_targets.len() != self.edge_durations_min.len()
            || (!self.edge_mode_flags.is_empty()
                && self.edge_mode_flags.len() != self.edge_targets.len())
        {
            return Err(RuntimeGraphError::EdgeArrayLengthMismatch {
                targets: self.edge_targets.len(),
                durations: self.edge_durations_min.len(),
                mode_flags: self.edge_mode_flags.len(),
            });
        }

        let final_offset = self.edge_offsets.last().copied().unwrap_or_default() as usize;
        if final_offset != self.edge_targets.len() {
            return Err(RuntimeGraphError::FinalOffsetMismatch {
                expected: self.edge_targets.len(),
                actual: final_offset,
            });
        }

        for index in 1..self.edge_offsets.len() {
            let previous = self.edge_offsets[index - 1];
            let current = self.edge_offsets[index];
            if current < previous {
                return Err(RuntimeGraphError::OffsetOutOfOrder {
                    index,
                    previous,
                    current,
                });
            }
        }

        for (edge_index, target) in self.edge_targets.iter().copied().enumerate() {
            if target as usize >= city_count {
                return Err(RuntimeGraphError::TargetOutOfBounds {
                    edge_index,
                    target,
                    city_count,
                });
            }
        }

        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeAliasRecord {
    pub normalized_alias: String,
    pub city_index: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RuntimeAliasIndex {
    pub records: Vec<RuntimeAliasRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeAliasError {
    CityIndexOutOfBounds {
        record_index: usize,
        city_index: u32,
        city_count: usize,
    },
    NotSorted {
        record_index: usize,
        previous: String,
        current: String,
    },
}

impl RuntimeAliasIndex {
    pub fn validate(&self, city_count: usize) -> Result<(), RuntimeAliasError> {
        for (index, record) in self.records.iter().enumerate() {
            if record.city_index as usize >= city_count {
                return Err(RuntimeAliasError::CityIndexOutOfBounds {
                    record_index: index,
                    city_index: record.city_index,
                    city_count,
                });
            }

            if index > 0 && self.records[index - 1].normalized_alias > record.normalized_alias {
                return Err(RuntimeAliasError::NotSorted {
                    record_index: index,
                    previous: self.records[index - 1].normalized_alias.clone(),
                    current: record.normalized_alias.clone(),
                });
            }
        }

        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeStationRecord {
    pub station_id: String,
    pub city_index: u32,
    pub display_name: String,
    pub lat_e5: i32,
    pub lon_e5: i32,
    pub uic_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RuntimeStationArtifact {
    pub stations: Vec<RuntimeStationRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeDatasetBundle {
    pub meta: RuntimeDatasetMeta,
    pub countries: Vec<RuntimeCountryRecord>,
    pub cities: Vec<RuntimeCityRecord>,
    pub graph: RuntimeGraph,
    pub aliases: RuntimeAliasIndex,
}

impl RuntimeDatasetBundle {
    pub fn validate(&self) -> Result<(), RuntimeDatasetValidationError> {
        let city_count = self.cities.len();
        let country_count = self.countries.len();

        if self.meta.country_count as usize != country_count {
            return Err(RuntimeDatasetValidationError::CountryCountMismatch {
                expected: country_count,
                actual: self.meta.country_count as usize,
            });
        }
        if self.meta.city_count as usize != city_count {
            return Err(RuntimeDatasetValidationError::CityCountMismatch {
                expected: city_count,
                actual: self.meta.city_count as usize,
            });
        }
        if self.meta.edge_count as usize != self.graph.edge_count() {
            return Err(RuntimeDatasetValidationError::EdgeCountMismatch {
                expected: self.graph.edge_count(),
                actual: self.meta.edge_count as usize,
            });
        }
        if self.meta.alias_count as usize != self.aliases.records.len() {
            return Err(RuntimeDatasetValidationError::AliasCountMismatch {
                expected: self.aliases.records.len(),
                actual: self.meta.alias_count as usize,
            });
        }

        for (city_index, city) in self.cities.iter().enumerate() {
            if city.country_index as usize >= country_count {
                return Err(RuntimeDatasetValidationError::CountryIndexOutOfBounds {
                    city_index,
                    country_index: city.country_index,
                    country_count,
                });
            }
        }

        self.graph
            .validate(city_count)
            .map_err(RuntimeDatasetValidationError::Graph)?;
        self.aliases
            .validate(city_count)
            .map_err(RuntimeDatasetValidationError::Aliases)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeDatasetValidationError {
    CountryCountMismatch {
        expected: usize,
        actual: usize,
    },
    CityCountMismatch {
        expected: usize,
        actual: usize,
    },
    EdgeCountMismatch {
        expected: usize,
        actual: usize,
    },
    AliasCountMismatch {
        expected: usize,
        actual: usize,
    },
    CountryIndexOutOfBounds {
        city_index: usize,
        country_index: u16,
        country_count: usize,
    },
    Graph(RuntimeGraphError),
    Aliases(RuntimeAliasError),
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

    #[test]
    fn runtime_graph_requires_consistent_offsets() {
        let graph = RuntimeGraph {
            edge_offsets: vec![0, 2, 1, 3],
            edge_targets: vec![1, 2, 0],
            edge_durations_min: vec![55, 120, 80],
            edge_mode_flags: vec![1, 1, 1],
        };

        let error = graph.validate(3).expect_err("expected invalid graph");
        assert_eq!(
            error,
            RuntimeGraphError::OffsetOutOfOrder {
                index: 2,
                previous: 2,
                current: 1
            }
        );
    }

    #[test]
    fn runtime_dataset_validation_accepts_sorted_aliases_and_graph() {
        let dataset = RuntimeDatasetBundle {
            meta: RuntimeDatasetMeta {
                schema_version: DATASET_SCHEMA_VERSION,
                dataset_version: "2026-05-07".to_string(),
                generated_at: "2026-05-07T12:00:00Z".to_string(),
                country_count: 1,
                city_count: 2,
                edge_count: 2,
                alias_count: 2,
                station_artifact_path: Some("stations.json".to_string()),
                attribution_path: "attribution.json".to_string(),
            },
            countries: vec![RuntimeCountryRecord {
                code: "FR".to_string(),
                display_name: "France".to_string(),
            }],
            cities: vec![
                RuntimeCityRecord {
                    city_id: CityId::new("paris-fr").expect("valid city id"),
                    slug: "paris".to_string(),
                    display_name: "Paris".to_string(),
                    country_index: 0,
                    lat_e5: 4_885_660,
                    lon_e5: 235_220,
                    population: Some(2_161_000),
                    interest_score: Some(10),
                    map_rank: Some(1),
                },
                RuntimeCityRecord {
                    city_id: CityId::new("lyon-fr").expect("valid city id"),
                    slug: "lyon".to_string(),
                    display_name: "Lyon".to_string(),
                    country_index: 0,
                    lat_e5: 4_576_400,
                    lon_e5: 483_570,
                    population: Some(516_000),
                    interest_score: Some(7),
                    map_rank: Some(24),
                },
            ],
            graph: RuntimeGraph {
                edge_offsets: vec![0, 1, 2],
                edge_targets: vec![1, 0],
                edge_durations_min: vec![120, 120],
                edge_mode_flags: vec![1, 1],
            },
            aliases: RuntimeAliasIndex {
                records: vec![
                    RuntimeAliasRecord {
                        normalized_alias: "lyon".to_string(),
                        city_index: 1,
                    },
                    RuntimeAliasRecord {
                        normalized_alias: "paris".to_string(),
                        city_index: 0,
                    },
                ],
            },
        };

        dataset.validate().expect("expected valid runtime dataset");
    }
}
