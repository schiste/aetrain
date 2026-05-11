# Data Hardening Roadmap

This document is the working plan for hardening Aetrain's data layer before
onboarding more national feeds. It is intentionally backend-first and
pipeline-first.

The current state is good enough to prove the architecture, but not good
enough to scale input scope aggressively without increasing inconsistency.

## Goal

Move from:

- a mostly-correct Europe aggregate with partial registry authority

to:

- a measurable, auditable, registry-led dataset where feed-local heuristics are
  exceptions rather than the main source of truth

## Current Baseline

Latest verified `europe-validated` aggregate:

- `13,416` cities
- `21,587` stations
- `39,628` directed edges
- `20,293` aliases
- `0` duplicate candidates
- `1,979` issues

Current cleanup counters:

- `registry_overlay_match_count`: `20`
- `registry_overlay_unmatched_count`: `0`
- `registry_overlay_ambiguous_count`: `0`
- `registry_overlay_country_correction_count`: `6`
- `registry_overlay_station_rescue_count`: `3`
- `residual_station_like_city_count`: `121`
- `residual_zz_city_count`: `360`

Current authoritative registry coverage:

- `20` French cities with registry-owned `city_id`
- `20` cities with `wikidata_qid`
- `20` cities with `population`

This means the authority path is working, but coverage is still narrow.

## Rules

These are hard product-data rules, not soft preferences.

1. Do not onboard more countries until quality gates are improved.
2. The registry must become the source of truth for city identity.
3. Feeds may contribute evidence, but should not mint canonical cities
   silently.
4. Every fallback path must be measurable.
5. Unresolved cases must be surfaced explicitly, not hidden by heuristics.

## Hardening Axes

### 1. Registry Authority

Make registry identity the default for canonical cities, not a late overlay.

Required capabilities:

- registry-backed exact city match
- registry-backed station-variant rescue
- authoritative `city_id` adoption
- downstream remap propagation to:
  - stations
  - edges
  - geometries
  - aliases

Success signal:

- matched cities export registry-owned `city_id`
- no downstream dangling references after remap

### 2. Country Inference

Reduce and eventually eliminate silent `ZZ` leakage for resolvable cases.

Inference order:

1. authoritative registry match
2. explicit source mapping
3. coordinate evidence
4. source namespace clues
5. feed-country fallback only as last resort

Success signal:

- `residual_zz_city_count` decreases monotonically across cleanup passes

### 3. Station-vs-City Separation

Prevent station-shaped names from surviving as canonical cities.

Priority classes:

- station-qualified city rows
- station-complex variants
- bus/placeholder stop leakage
- local operator abbreviations that look like place names

Success signal:

- station variants move into aliases or stations, not `cities.json`

### 4. Naming Consistency

Normalize canonical display names and isolate feed-local naming noise.

Required handling:

- abbreviation expansion
- placeholder rejection
- multilingual alias retention
- canonical display name preference

Success signal:

- canonical display names become stable while aliases preserve local richness

### 5. Auditability

Every non-trivial cleanup path must emit counters or explicit findings.

Minimum tracked classes:

- unmatched registry candidate
- ambiguous registry candidate
- country correction
- station rescue
- station-like city residual
- unresolved `ZZ` residual
- unresolved route-like pseudo-city residual
- duplicate candidate
- suspicious abbreviation candidate

Success signal:

- regressions become visible in build output without manual inspection

## Phases

### Phase A — France Hardening

Goal:

- turn France from a pilot authority slice into the first robust registry-led
  country layer

Deliverables:

- expand French registry coverage beyond the current `20` cities
- convert obvious French station-promoted cities into registry-owned cities
- drive remaining French city naming off registry identity
- reduce France-linked `ZZ` rows

Exit criteria:

- French major-city layer is registry-authoritative
- no major French city still exports a feed-derived aggregate `city_id`
- remaining French unresolved rows are explicitly auditable

### Phase B — Quality Gates

Goal:

- make data quality a build-time contract

Deliverables:

- document thresholds
- fail or loudly warn on threshold regressions
- record counters in aggregate summaries

Initial gating targets:

- `registry_overlay_ambiguous_count == 0`
- `duplicate_count == 0`
- `residual_station_like_city_count < 100`
- `residual_zz_city_count < 250`
- `route_like_city_unresolved_count < 10`
- no decrease in registry-authoritative city coverage for already-covered
  countries

These are initial targets, not final ones. Tighten them over time.

### Phase C — Abbreviation and Placeholder Cleanup

Goal:

- reduce low-signal city identities that survive because names are weak rather
  than because data is truly ambiguous

Deliverables:

- stronger rule tables in `data/registry/overrides/`
- audit output for suspicious short tokens and placeholder families
- explicit separation between:
  - feed abbreviation
  - homonym
  - station variant
  - unresolved city

Exit criteria:

- suspicious abbreviation class is measured and trending down

### Phase D — Next-Country Registry Expansion

Goal:

- expand authority to the next best-supported countries only after the system is
  stable

Recommended order:

1. France completion
2. Luxembourg
3. Switzerland or Germany
4. Spain

Selection rule:

- expand where source quality and station/city clarity are good enough to reduce
  ambiguity, not where raw feed count is highest

## Build Gates

Before enabling more countries, the pipeline should enforce:

- summary counters written on every aggregate build
- no runtime artifact integrity failures
- no canonical dangling references
- registry authority coverage count reported per country
- stable issue trends over time

## Operational Output To Add Next

The following artifacts should become first-class outputs:

- `country-quality.json`
- `registry-match-report.json`
- `station-like-cities.json`
- `zz-cities.json`
- `abbreviation-candidates.json`

These are not optional niceties. They are the operator surface for deciding
whether a country is ready for broader onboarding.

## Definition Of "Ready For More Data"

We are ready to onboard more countries only when:

1. registry authority is proven beyond a tiny pilot slice
2. country inference is measurably improving
3. station-like canonical city leakage is materially lower
4. unresolved residuals are explicit and reviewable
5. quality gates catch regressions automatically

Until then, cleanup and consistency outrank breadth.
