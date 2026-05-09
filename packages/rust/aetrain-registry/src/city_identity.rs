use deunicode::deunicode;

const STATION_SUFFIXES: &[&str] = &["gare centrale", "gare central", "central station"];
const STATION_TOKENS: &[&str] = &[
    "gare",
    "station",
    "hauptbahnhof",
    "bahnhof",
    "hbf",
    "bhf",
    "hb",
];

pub fn build_city_identity_key(display_name: &str, country_code: &str) -> String {
    format!(
        "{}|{}",
        build_city_identity_stem(display_name),
        country_code.trim().to_ascii_lowercase()
    )
}

pub fn build_city_identity_stem(display_name: &str) -> String {
    let normalized = normalize_tokens(display_name);
    let stripped = strip_station_qualifier(normalized);
    stripped.trim().to_string()
}

pub fn canonical_city_display_name(names: &[String]) -> Option<String> {
    names
        .iter()
        .filter(|name| !is_station_qualified_name(name))
        .max_by_key(|name| name.len())
        .cloned()
        .or_else(|| names.iter().max_by_key(|name| name.len()).cloned())
}

pub fn is_station_qualified_name(name: &str) -> bool {
    let tokens = normalize_tokens(name);
    STATION_SUFFIXES
        .iter()
        .any(|suffix| tokens.join(" ").ends_with(suffix))
        || tokens
            .iter()
            .enumerate()
            .skip(1)
            .any(|(_, token)| STATION_TOKENS.iter().any(|candidate| candidate == token))
}

fn strip_station_qualifier(tokens: Vec<String>) -> String {
    if let Some(index) = tokens
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, token)| {
            STATION_TOKENS
                .iter()
                .any(|candidate| candidate == token)
                .then_some(index)
        })
    {
        return tokens[..index].join(" ");
    }

    let mut normalized = tokens.join(" ");
    for suffix in STATION_SUFFIXES {
        if normalized.ends_with(suffix) {
            normalized.truncate(normalized.len() - suffix.len());
            return normalized.trim().to_string();
        }
    }
    normalized
}

fn normalize_tokens(value: &str) -> Vec<String> {
    let ascii = deunicode(value);
    let mut sanitized = String::with_capacity(ascii.len());
    for ch in ascii.chars() {
        if ch.is_ascii_alphanumeric() {
            sanitized.push(ch.to_ascii_lowercase());
        } else {
            sanitized.push(' ');
        }
    }
    sanitized
        .split_whitespace()
        .map(|token| token.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn station_qualified_variants_share_same_identity_key() {
        let city = build_city_identity_key("Paris", "FR");
        let station = build_city_identity_key("Paris Gare de Lyon", "FR");
        assert_eq!(city, station);
    }

    #[test]
    fn same_name_different_country_stays_distinct() {
        let at = build_city_identity_key("Baden", "AT");
        let ch = build_city_identity_key("Baden", "CH");
        assert_ne!(at, ch);
    }

    #[test]
    fn canonical_display_name_prefers_non_station_name() {
        let chosen =
            canonical_city_display_name(&["Paris Gare de Lyon".to_string(), "Paris".to_string()])
                .expect("name should resolve");
        assert_eq!(chosen, "Paris");
    }
}
