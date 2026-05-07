use std::{error::Error, fmt};

pub const DATASET_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdError {
    kind: &'static str,
    value: String,
    message: &'static str,
}

impl IdError {
    fn new(kind: &'static str, value: String, message: &'static str) -> Self {
        Self {
            kind,
            value,
            message,
        }
    }
}

impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}: {}", self.kind, self.value, self.message)
    }
}

impl Error for IdError {}

fn validate_id(kind: &'static str, value: String) -> Result<String, IdError> {
    if value.is_empty() {
        return Err(IdError::new(kind, value, "must not be empty"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(IdError::new(
            kind,
            value,
            "must contain only lowercase ascii letters, digits, and hyphens",
        ));
    }
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CityId(String);

impl CityId {
    pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
        Ok(Self(validate_id("city_id", value.into())?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CityId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StationId(String);

impl StationId {
    pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
        Ok(Self(validate_id("station_id", value.into())?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for StationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeoPoint {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceKind {
    Rail,
    Ferry,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceClass {
    Intercity,
    Regional,
    Ferry,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceRef {
    pub source_id: String,
    pub raw_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct City {
    pub city_id: CityId,
    pub slug: String,
    pub display_name: String,
    pub country_code: String,
    pub location: GeoPoint,
    pub wikidata_qid: Option<String>,
    pub population: Option<u64>,
    pub interest_score: Option<u8>,
    pub station_ids: Vec<StationId>,
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Station {
    pub station_id: StationId,
    pub city_id: CityId,
    pub display_name: String,
    pub location: GeoPoint,
    pub uic_code: Option<String>,
    pub source_refs: Vec<SourceRef>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TravelEdge {
    pub from_city_id: CityId,
    pub to_city_id: CityId,
    pub duration_min: u32,
    pub service_kind: ServiceKind,
    pub service_class: ServiceClass,
    pub change_count_estimate: Option<u8>,
    pub source_confidence: u8,
    pub provenance: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_lowercase_city_ids() {
        let city_id = CityId::new("paris-fr").expect("valid city id");
        assert_eq!(city_id.as_str(), "paris-fr");
    }

    #[test]
    fn rejects_invalid_station_ids() {
        let err = StationId::new("Paris Nord").expect_err("expected invalid id");
        assert_eq!(
            err.to_string(),
            "station_id Paris Nord: must contain only lowercase ascii letters, digits, and hyphens"
        );
    }
}
