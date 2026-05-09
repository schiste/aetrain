use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NameRuleAction {
    StripSuffix,
    ExpandAbbreviation,
    RejectToken,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct NameRuleScope {
    #[serde(default)]
    pub country_codes: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameRule {
    pub id: String,
    pub action: NameRuleAction,
    pub match_value: String,
    #[serde(default)]
    pub replace_value: Option<String>,
    #[serde(default)]
    pub scope: NameRuleScope,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameRuleSet {
    pub schema_version: u16,
    #[serde(rename = "rule", default)]
    pub rules: Vec<NameRule>,
}

impl NameRuleSet {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        toml::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))
    }
}

pub fn apply_name_rules(
    value: &str,
    country_code: Option<&str>,
    source_id: Option<&str>,
    rules: &NameRuleSet,
) -> Option<String> {
    let mut current = value.trim().to_string();

    for rule in &rules.rules {
        if !matches_scope(rule, country_code, source_id) {
            continue;
        }

        match rule.action {
            NameRuleAction::StripSuffix => {
                if current.ends_with(&rule.match_value) {
                    let stripped = current
                        .strip_suffix(&rule.match_value)
                        .expect("suffix presence already checked")
                        .trim()
                        .to_string();
                    current = stripped;
                }
            }
            NameRuleAction::ExpandAbbreviation => {
                if current == rule.match_value {
                    current = rule
                        .replace_value
                        .clone()
                        .unwrap_or_else(|| current.clone());
                }
            }
            NameRuleAction::RejectToken => {
                if current == rule.match_value {
                    return None;
                }
            }
        }
    }

    Some(current)
}

fn matches_scope(rule: &NameRule, country_code: Option<&str>, source_id: Option<&str>) -> bool {
    let country_match = rule.scope.country_codes.is_empty()
        || country_code.is_some_and(|code| {
            rule.scope
                .country_codes
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(code))
        });
    let source_match = rule.scope.source_ids.is_empty()
        || source_id.is_some_and(|id| {
            rule.scope
                .source_ids
                .iter()
                .any(|candidate| candidate == id)
        });
    country_match && source_match
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rule_set_and_applies_expansion() {
        let rules: NameRuleSet = toml::from_str(
            r#"
schema_version = 1

[[rule]]
id = "fr-st-to-saint"
action = "expand_abbreviation"
match_value = "St"
replace_value = "Saint"
scope = { country_codes = ["FR"] }
"#,
        )
        .expect("rules should parse");

        let expanded =
            apply_name_rules("St", Some("FR"), None, &rules).expect("value should stay valid");
        assert_eq!(expanded, "Saint");
    }

    #[test]
    fn reject_rule_can_drop_placeholder_token() {
        let rules = NameRuleSet {
            schema_version: 1,
            rules: vec![NameRule {
                id: "drop-bus".to_string(),
                action: NameRuleAction::RejectToken,
                match_value: "Bus".to_string(),
                replace_value: None,
                scope: NameRuleScope::default(),
                note: None,
            }],
        };

        assert_eq!(apply_name_rules("Bus", None, None, &rules), None);
    }
}
