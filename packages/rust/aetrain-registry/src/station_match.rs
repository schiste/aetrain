use aetrain_domain::{StationKind, StationScope};

pub fn is_valid_wikidata_qid(value: &str) -> bool {
    let Some(rest) = value.strip_prefix('Q') else {
        return false;
    };
    !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit())
}

pub fn is_customer_facing_rail_station(kind: &StationKind, scope: &StationScope) -> bool {
    matches!(
        kind,
        StationKind::MainlineRail
            | StationKind::HighSpeedRail
            | StationKind::AirportRail
            | StationKind::SuburbanRail
    ) && matches!(
        scope,
        StationScope::CustomerStation | StationScope::StationPart
    )
}

pub fn is_non_mainline_transport(kind: &StationKind) -> bool {
    matches!(
        kind,
        StationKind::Metro | StationKind::Tram | StationKind::Bus | StationKind::Ferry
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_wikidata_qids() {
        assert!(is_valid_wikidata_qid("Q747541"));
        assert!(!is_valid_wikidata_qid("747541"));
        assert!(!is_valid_wikidata_qid("Q"));
        assert!(!is_valid_wikidata_qid("QABC"));
    }

    #[test]
    fn classifies_customer_facing_rail() {
        assert!(is_customer_facing_rail_station(
            &StationKind::MainlineRail,
            &StationScope::CustomerStation
        ));
        assert!(!is_customer_facing_rail_station(
            &StationKind::Metro,
            &StationScope::CustomerStation
        ));
    }
}
