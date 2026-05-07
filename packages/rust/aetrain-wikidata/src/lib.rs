use aetrain_domain::CityId;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WikidataCityRecord {
    pub city_id: CityId,
    pub wikidata_qid: String,
    pub label: Option<String>,
    pub population: Option<u64>,
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WikidataAccessPolicy {
    pub build_time_only: bool,
    pub allow_live_client_queries: bool,
    pub prefer_dumps_for_bulk_loads: bool,
    pub note: &'static str,
}

pub fn default_access_policy() -> WikidataAccessPolicy {
    WikidataAccessPolicy {
        build_time_only: true,
        allow_live_client_queries: false,
        prefer_dumps_for_bulk_loads: true,
        note: "Use build-time enrichment only and avoid bulk client-facing WDQS access.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_policy_matches_stage_one_rules() {
        let policy = default_access_policy();
        assert!(policy.build_time_only);
        assert!(!policy.allow_live_client_queries);
        assert!(policy.prefer_dumps_for_bulk_loads);
    }
}
