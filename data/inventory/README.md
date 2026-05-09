# Europe Rail Inventory

`data/inventory/` tracks source discovery and onboarding status before a feed is
promoted into a runnable pipeline manifest.

Files:

- `europe-rail-onboarding.toml`: country-by-country registry for Europe, the
  United Kingdom, and nearby transcontinental states that matter to a
  Europe-wide rail product

Status intent:

- `onboarded_manifest_ready`: the current pipeline can fetch and normalize the
  feed with existing adapters
- `ready_after_catalog_resolver`: the source is official and usable, but the
  published URL changes over time and needs a resolver step
- `ready_with_api_key_support`: the source is official, but download requires a
  key or account flow the pipeline does not yet manage
- `ready_after_contract_or_license_step`: the source is official, but access is
  gated by a contract, portal registration, or specific licence flow
- `ready_after_feed_scope_fix`: the source is official and fetchable, but the
  verified feed does not currently produce national rail coverage for Aetrain's
  scope
- `ready_after_netex_adapter`: the official source is available, but not in a
  format the current adapters ingest
- `ready_after_new_adapter`: the official source is available, but it uses a
  non-GTFS rail format that needs dedicated ingestion logic
- `needs_official_source_verification`: no official machine-readable national
  source was verified in this pass
- `covered_by_neighboring_target`: no standalone national source is needed
  because service is covered by a neighboring country's feed
- `out_of_scope_no_rail`: no active national heavy-rail target exists
