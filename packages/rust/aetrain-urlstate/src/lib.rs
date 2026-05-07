use std::collections::BTreeMap;
use std::{error::Error, fmt};

use aetrain_domain::CityId;

const URL_STATE_VERSION: &str = "v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UrlStateParseError(String);

impl UrlStateParseError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for UrlStateParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Error for UrlStateParseError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegDurationMinutes {
    pub min: u16,
    pub max: u16,
}

impl LegDurationMinutes {
    pub fn new(min: u16, max: u16) -> Result<Self, UrlStateParseError> {
        if min > max {
            return Err(UrlStateParseError::new(
                "leg duration min must be less than or equal to max",
            ));
        }
        Ok(Self { min, max })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FilterState {
    pub min_interest: u8,
    pub min_population_k: u32,
    pub leg_duration: Option<LegDurationMinutes>,
}

impl Default for FilterState {
    fn default() -> Self {
        Self {
            min_interest: 1,
            min_population_k: 0,
            leg_duration: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct UrlState {
    pub trip: Vec<CityId>,
    pub filters: FilterState,
    pub round_trip: bool,
    pub ui: BTreeMap<String, String>,
}

impl UrlState {
    pub fn parse_hash(hash: &str) -> Result<Self, UrlStateParseError> {
        let raw = hash.strip_prefix('#').unwrap_or(hash);
        if raw.is_empty() {
            return Ok(Self::default());
        }

        let mut parts = raw.split(';');
        let version = parts.next().unwrap_or_default();
        if version != URL_STATE_VERSION {
            return Err(UrlStateParseError::new(format!(
                "unsupported url state version: {version}"
            )));
        }

        let mut state = Self::default();
        for part in parts {
            if part.is_empty() {
                continue;
            }
            let Some((key, value)) = part.split_once('=') else {
                continue;
            };
            match key {
                "t" => {
                    let mut trip = Vec::<CityId>::new();
                    if !value.is_empty() {
                        for token in value.split(',') {
                            let decoded = decode_component(token)?;
                            trip.push(CityId::new(decoded).map_err(|error| {
                                UrlStateParseError::new(format!("invalid trip city id: {error}"))
                            })?);
                        }
                    }
                    state.trip = trip;
                }
                "fi" => {
                    state.filters.min_interest = value
                        .parse::<u8>()
                        .map_err(|_| UrlStateParseError::new("fi must be an unsigned integer"))?;
                }
                "fp" => {
                    state.filters.min_population_k = value
                        .parse::<u32>()
                        .map_err(|_| UrlStateParseError::new("fp must be an unsigned integer"))?;
                }
                "ll" => {
                    let Some((min, max)) = value.split_once('-') else {
                        return Err(UrlStateParseError::new(
                            "ll must be encoded as min-max in minutes",
                        ));
                    };
                    state.filters.leg_duration = Some(LegDurationMinutes::new(
                        min.parse::<u16>().map_err(|_| {
                            UrlStateParseError::new("ll min must be an unsigned integer")
                        })?,
                        max.parse::<u16>().map_err(|_| {
                            UrlStateParseError::new("ll max must be an unsigned integer")
                        })?,
                    )?);
                }
                "rt" => {
                    state.round_trip = matches!(value, "1" | "true" | "yes");
                }
                _ if key.starts_with("ui.") => {
                    let ui_key = decode_component(&key[3..])?;
                    let ui_value = decode_component(value)?;
                    state.ui.insert(ui_key, ui_value);
                }
                _ => {}
            }
        }

        Ok(state)
    }

    pub fn parse_hash_lossy(hash: &str) -> Self {
        Self::parse_hash(hash).unwrap_or_default()
    }

    pub fn to_hash(&self) -> String {
        let mut segments = vec![URL_STATE_VERSION.to_string()];
        segments.push(format!(
            "t={}",
            self.trip
                .iter()
                .map(|city_id| encode_component(city_id.as_str()))
                .collect::<Vec<_>>()
                .join(",")
        ));
        segments.push(format!("fi={}", self.filters.min_interest));
        segments.push(format!("fp={}", self.filters.min_population_k));
        if let Some(leg_duration) = &self.filters.leg_duration {
            segments.push(format!("ll={}-{}", leg_duration.min, leg_duration.max));
        }
        segments.push(format!("rt={}", if self.round_trip { 1 } else { 0 }));
        for (key, value) in &self.ui {
            segments.push(format!(
                "ui.{}={}",
                encode_component(key),
                encode_component(value)
            ));
        }
        format!("#{}", segments.join(";"))
    }
}

fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        let ch = byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~' | ':') {
            encoded.push(ch);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn decode_component(value: &str) -> Result<String, UrlStateParseError> {
    let mut bytes = Vec::<u8>::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            bytes.push(ch as u8);
            continue;
        }
        let high = chars
            .next()
            .ok_or_else(|| UrlStateParseError::new("percent-encoded token ended unexpectedly"))?;
        let low = chars
            .next()
            .ok_or_else(|| UrlStateParseError::new("percent-encoded token ended unexpectedly"))?;
        let hex = format!("{high}{low}");
        let byte = u8::from_str_radix(&hex, 16)
            .map_err(|_| UrlStateParseError::new("invalid percent-encoded byte"))?;
        bytes.push(byte);
    }
    String::from_utf8(bytes)
        .map_err(|_| UrlStateParseError::new("decoded component was not valid utf-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn city_id(value: &str) -> CityId {
        CityId::new(value).expect("valid city id")
    }

    #[test]
    fn round_trips_explicit_url_state() {
        let mut state = UrlState {
            trip: vec![
                city_id("paris-fr"),
                city_id("lyon-fr"),
                city_id("milano-it"),
            ],
            filters: FilterState {
                min_interest: 5,
                min_population_k: 100,
                leg_duration: Some(LegDurationMinutes::new(0, 240).expect("valid leg range")),
            },
            round_trip: true,
            ui: BTreeMap::new(),
        };
        state.ui.insert("sidebar".to_string(), "plan".to_string());

        let hash = state.to_hash();
        let reparsed = UrlState::parse_hash(&hash).expect("hash should parse");

        assert_eq!(reparsed, state);
    }

    #[test]
    fn preserves_ui_keys_with_spaces() {
        let parsed =
            UrlState::parse_hash("#v1;t=paris-fr;fi=1;fp=0;rt=0;ui.active%20panel=route%20score")
                .expect("hash should parse");

        assert_eq!(
            parsed.ui.get("active panel"),
            Some(&"route score".to_string())
        );
    }

    #[test]
    fn lossy_parse_falls_back_to_default() {
        let parsed = UrlState::parse_hash_lossy("#v2;t=Paris");
        assert_eq!(parsed, UrlState::default());
    }
}
