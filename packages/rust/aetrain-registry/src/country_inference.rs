use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CountryInferenceInput {
    pub explicit_country: Option<String>,
    pub registry_country: Option<String>,
    pub coordinate_country: Option<String>,
    pub source_country: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CountryInferenceReason {
    ExplicitAuthoritative,
    RegistryMatch,
    CoordinateMatch,
    SourceFallback,
    Unresolved,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CountryInferenceResult {
    pub country_code: Option<String>,
    pub reason: CountryInferenceReason,
}

pub fn infer_country(input: &CountryInferenceInput) -> CountryInferenceResult {
    if let Some(country) = input.explicit_country.as_ref() {
        return CountryInferenceResult {
            country_code: Some(country.clone()),
            reason: CountryInferenceReason::ExplicitAuthoritative,
        };
    }
    if let Some(country) = input.registry_country.as_ref() {
        return CountryInferenceResult {
            country_code: Some(country.clone()),
            reason: CountryInferenceReason::RegistryMatch,
        };
    }
    if let Some(country) = input.coordinate_country.as_ref() {
        return CountryInferenceResult {
            country_code: Some(country.clone()),
            reason: CountryInferenceReason::CoordinateMatch,
        };
    }
    if let Some(country) = input.source_country.as_ref() {
        return CountryInferenceResult {
            country_code: Some(country.clone()),
            reason: CountryInferenceReason::SourceFallback,
        };
    }
    CountryInferenceResult {
        country_code: None,
        reason: CountryInferenceReason::Unresolved,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_country_wins() {
        let result = infer_country(&CountryInferenceInput {
            explicit_country: Some("DE".to_string()),
            registry_country: Some("CH".to_string()),
            coordinate_country: Some("FR".to_string()),
            source_country: Some("LU".to_string()),
        });

        assert_eq!(result.country_code.as_deref(), Some("DE"));
        assert_eq!(result.reason, CountryInferenceReason::ExplicitAuthoritative);
    }

    #[test]
    fn source_country_is_last_fallback() {
        let result = infer_country(&CountryInferenceInput {
            explicit_country: None,
            registry_country: None,
            coordinate_country: None,
            source_country: Some("ES".to_string()),
        });

        assert_eq!(result.country_code.as_deref(), Some("ES"));
        assert_eq!(result.reason, CountryInferenceReason::SourceFallback);
    }
}
