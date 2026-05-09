use serde::{Deserialize, Serialize};

use crate::{build_city_identity_key, is_station_qualified_name};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryAuditSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryAuditFindingKind {
    TrueDuplicate,
    Homonym,
    StationVariant,
    FeedAbbreviation,
    PlaceholderStop,
    ForeignCountryConflict,
    UnresolvedCity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryAuditFinding {
    pub kind: RegistryAuditFindingKind,
    pub severity: RegistryAuditSeverity,
    pub entity_ref: String,
    pub message: String,
}

pub fn classify_city_pair(
    left_name: &str,
    left_country: &str,
    right_name: &str,
    right_country: &str,
) -> RegistryAuditFindingKind {
    let left_key = build_city_identity_key(left_name, left_country);
    let right_key = build_city_identity_key(right_name, right_country);

    if left_key == right_key
        && (is_station_qualified_name(left_name) || is_station_qualified_name(right_name))
    {
        return RegistryAuditFindingKind::StationVariant;
    }
    if left_key == right_key {
        return RegistryAuditFindingKind::TrueDuplicate;
    }
    if left_name.eq_ignore_ascii_case(right_name)
        && !left_country.eq_ignore_ascii_case(right_country)
    {
        return RegistryAuditFindingKind::Homonym;
    }
    RegistryAuditFindingKind::UnresolvedCity
}

pub fn classify_city_name_issue(name: &str) -> Option<RegistryAuditFindingKind> {
    let trimmed = name.trim();
    let lower = trimmed.to_ascii_lowercase();

    if lower == "bus" || lower == "bahn" || lower.starts_with("bus ") {
        return Some(RegistryAuditFindingKind::PlaceholderStop);
    }
    if trimmed.len() <= 3 && trimmed.chars().any(|ch| ch.is_ascii_uppercase()) {
        return Some(RegistryAuditFindingKind::FeedAbbreviation);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn station_variant_is_classified_separately() {
        let kind = classify_city_pair("Paris", "FR", "Paris Gare de Lyon", "FR");
        assert_eq!(kind, RegistryAuditFindingKind::StationVariant);
    }

    #[test]
    fn same_name_different_country_is_homonym() {
        let kind = classify_city_pair("Baden", "AT", "Baden", "CH");
        assert_eq!(kind, RegistryAuditFindingKind::Homonym);
    }

    #[test]
    fn short_uppercase_name_is_feed_abbreviation() {
        assert_eq!(
            classify_city_name_issue("Gd"),
            Some(RegistryAuditFindingKind::FeedAbbreviation)
        );
    }
}
