# Aetrain Architecture

This document defines the product architecture and the technical decisions that
matter before implementation scale-up. It is intentionally opinionated: the
goal is to remove ambiguity, not to list every possible future option.

## Product Thesis

Aetrain is a client-side European rail journey builder.

The product is city-first for users, data-driven under the hood, and shareable
by URL without requiring server-side trip storage.

The core loop is:

1. Pick cities visually.
2. Build and edit a multi-stop journey.
3. Explore what is reachable next.
4. Share the exact journey via the URL.

## Stage Model

### Stage 1: Static Journey Builder on Real Data

Stage 1 is the foundation, not a throwaway prototype.

It includes:

- Journey building UX
- Real transport datasets (GTFS and supplementary sources where needed)
- Canonical normalization from raw operator data to Aetrain entities
- Build-time Wikidata enrichment
- URL-portable journey state
- Fastest-travel-time routing semantics only
- Static hosting only

It explicitly excludes:

- Server-side trip storage
- User accounts
- Live timetable APIs
- Political border rendering

### Stage 2: Smarter Static Planning

Stage 2 improves decision quality on top of the same static architecture:

- Better cross-border stitching
- Better train-type filtering
- Better recommendation quality
- Better constraint handling (time, interest, trip shape)
- Better enrichment quality and search quality

### Stage 3: Dynamic Platform Features

Only after Stage 1 and 2 are solid do we introduce runtime services:

- Live timetable and disruption layers
- Affiliate and commercial integrations
- Accounts and saved trips
- Community or sharing features beyond URL portability
- Server-assisted optimization or AI itinerary generation

## Architecture Principles

### 1. Static-first at runtime

The web app must work as a static site. Dataset generation is allowed to be
heavy; serving the app should remain simple.

Consequence:

- The browser consumes generated artifacts.
- Any expensive normalization or enrichment happens offline.

### 2. URL is the canonical share format

Journey state must be reconstructable from the URL alone.

Consequence:

- The app must not require backend persistence for the core product loop.
- Local storage is optional convenience only and can never be the source of
  truth for a shareable trip.

### 3. City-first product, station-aware pipeline

Users plan in cities, but transport data originates at station or stop level.

Consequence:

- The pipeline must resolve raw stops into canonical cities.
- Station-level data is retained as supporting data for later features, but
  stations are not the canonical planning unit.
- The frontend should route on a derived city graph, not directly on raw GTFS
  stops.

### 4. Stable canonical IDs everywhere

Names change; source-specific identifiers differ; URLs must remain durable.

Consequence:

- Every city and station gets a stable Aetrain ID.
- URL state, routing graph edges, and enrichment joins all use canonical IDs.

### 5. No decorative cartography dependency

The product is about journey construction, not map ornament.

Consequence:

- No country borders in Stage 1.
- No dependency on external tile servers.
- Map layers should be limited to what improves planning: cities, connections,
  active route, reachable highlights, and labels.

### 6. Code-first normalization, tracked overrides only as a last resort

Normalization quality should come from deterministic code, not hidden manual
patching.

Consequence:

- We fix as much as possible through source adapters, normalization rules, and
  heuristics.
- Manual curation is allowed only when code-based resolution is not sufficient.
- Every manual override must be stored in a tracked registry with rationale and
  provenance.

## Key Technical Decisions

## Decision 1: Separate the runtime app from the data pipeline

Use a static browser app for runtime and a dedicated offline pipeline for
ingestion, normalization, enrichment, and artifact generation.

Chosen shape:

- `apps/web/`: the static browser application
- `packages/`: shared browser-safe domain code
- `scripts/`: pipeline entry points and build utilities

Rationale:

- Product requirements are static-hosting-friendly.
- The hard problem is data preparation, not request/response serving.
- This keeps Stage 1 deployable anywhere.

## Decision 2: Use Rust for the shared core, TypeScript for the web shell

Rust is the primary implementation language for shared domain logic, routing,
normalization, and build pipeline code. TypeScript is used for the web
application shell and browser integration.

Rationale:

- Rust gives the best long-term combination of performance, portability, and
  logic reuse across multiple app surfaces.
- The same core can be compiled to WebAssembly for the web app and exposed
  natively later for iOS, Android, desktop, CLI, or server components.
- TypeScript remains the pragmatic language for browser UI composition,
  platform APIs, and fast frontend iteration.

Consequence:

- Shared business logic should live in Rust crates, not be reimplemented per
  client.
- Browser-facing bindings should be thin wrappers around the Rust core.
- Artifact schemas remain the contract between build-time and runtime.

## Decision 3: Treat generated artifacts as the public contract

The pipeline output is the product interface between build-time and runtime.

Stage 1 artifacts should be versioned and immutable, for example:

- `meta.json`
- `countries.json`
- `cities.json`
- `graph.json`
- `aliases.json`
- `stations.json`
- `attribution.json`

Stored under a versioned directory such as:

`apps/web/public/data/2026-05-xx/`

`meta.json` must include:

- dataset version
- source feed versions or fetch dates
- schema version
- generation timestamp
- attribution pointers

The important split is:

- Canonical artifacts can be rich, traceable, and station-aware.
- Runtime artifacts must be optimized for browser startup and route queries.

The browser hot path should eagerly load only:

- `meta.json`
- `countries.json`
- `cities.json`
- `graph.json`

The browser should load these only when needed:

- `aliases.json` on first search interaction if it is large enough to matter
- `stations.json` only for future station-aware product surfaces
- `attribution.json` from an about/help surface, not as part of initial route rendering

## Decision 4: The browser consumes a city graph, not raw GTFS

Stage 1 route planning in the browser should run on a derived city graph.

Pipeline-internal model:

- raw source stop
- canonical city
- supporting station data
- source-level connectivity

Browser-facing model:

- city
- city-to-city edge
- search alias
- enrichment metadata

Runtime graph representation should be compact and index-based:

- stable `city_id` strings for URLs and external references
- dense city indexes for in-memory routing
- adjacency offsets + targets + durations arrays for fast shortest-path setup
- country table indirection instead of repeated country names per city row
- scaled integer coordinates (`lat_e5` / `lon_e5`) instead of repeated floats in the wire format

That gives us two important properties at once:

- Stable public identifiers
- Fast browser parsing and low memory churn

Rationale:

- Smaller payload
- Cleaner URLs
- Cleaner UX
- Fewer operator-specific artifacts leaking into the product

Tradeoff:

- Detailed station selection is deferred until the product really needs it.
- Some raw source nuance is intentionally collapsed into city-level planning
  semantics.

Stage 1 edge semantics are intentionally narrow:

- An edge answers only: "is there a usable connection between these planning
  cities, and what is the fastest travel time we currently know?"
- Fare class, seat availability, booking rules, and itinerary preference are
  deferred to downstream booking surfaces and later product stages.

## Decision 5: Keep a city-canonical model with retained station support data

The canonical model is:

### City

Fields:

- `city_id`
- `slug`
- `display_name`
- `country_code`
- `lat`
- `lon`
- `wikidata_qid`
- `population`
- `interest_score`
- `station_ids[]`
- `aliases[]`

### Station

Fields:

- `station_id`
- `city_id`
- `display_name`
- `lat`
- `lon`
- `uic_code` when available
- `source_refs[]`

### Edge

Fields:

- `from_city_id`
- `to_city_id`
- `duration_min`
- `service_class`
- `change_count_estimate`
- `source_confidence`
- `provenance`

Important rule:

`city_id` is an Aetrain identifier, not a GTFS identifier and not a Wikidata
identifier.

Important consequence:

- The route engine, URL state, and most product APIs are city-based.
- Station data is retained for future capability, but it does not define the
  user-facing planning model.
- The canonical model is not shipped directly to the browser; the browser gets
  a runtime projection tuned for map rendering, search, and shortest-path
  queries.

## Decision 6: Normalize by adapter, then resolve to canonical entities

The pipeline should not pretend all GTFS feeds are uniform. It should use
source adapters with a common output shape.

Each adapter is responsible for:

- feed download and verification
- operator-specific route filtering
- route type interpretation
- station extraction
- edge extraction
- source metadata capture

Then a shared normalization layer resolves:

- station grouping
- city assignment
- cross-source duplicates
- alias generation
- cross-border edge stitching

This avoids hard-coding country-specific logic into the generic pipeline.

Stage 1 feed scope is broad by default:

- ingest every feed we can normalize with acceptable confidence
- include intercity rail, regional rail, and ferry
- exclude non-rail urban transit unless a later rule explicitly requires it

## Decision 7: Use UIC first, geocluster second, curated overrides last

Canonical station and city resolution should follow this priority:

1. UIC or other strong rail identifier
2. Trusted source-specific station identifiers
3. Geographic clustering with conservative thresholds
4. Curated overrides checked into the repo with explicit metadata

Rationale:

- GTFS names are operational, not product-safe.
- Pure fuzzy matching is too fragile for a core graph.

Curated overrides are not forbidden, but they are the exception path. Every
override must record:

- why code-based normalization failed
- what source entities are being overridden
- who added the override
- when it was added
- a link to a tracking issue or note

## Decision 8: Wikidata is build-time only

The frontend must not call Wikidata directly.

Wikidata enrichment is an offline step that produces cached, versioned fields
for the app dataset.

Stage 1 should store at least:

- `wikidata_qid`
- population
- labels/descriptions when helpful
- optional source URLs for auditability

Rationale:

- Better reliability
- Faster app startup
- Respectful access patterns
- Deterministic builds

Operational rule:

- Use dumps or narrowly scoped APIs/queries during the pipeline.
- Never depend on WDQS for bulk client-facing runtime access.

## Decision 9: URL state lives in the hash fragment, is versioned, and stays readable

Journey state should be encoded in `location.hash`, not in server-resolved
paths.

Recommended Stage 1 shape:

`#v1;t=paris-fr,lyon-fr,milano-it;fi=5;fp=100;ll=0-240`

Meaning:

- `v1`: URL schema version
- `t`: ordered trip city IDs
- `fi`: minimum interest
- `fp`: minimum population threshold
- `ll`: leg duration min-max in minutes
- `rt`: round-trip flag
- `ui.*`: additional explicit UI state such as sidebar, active panel, or map
  framing preferences

Rules:

- Use canonical IDs, never labels
- Keep it readable even if the URL becomes long
- Include all journey-defining parameters explicitly
- Do not compress by default
- Parse failures must degrade gracefully to an empty journey

Rationale:

- Portable links
- Easy debugging
- No backend dependency
- Easier backwards compatibility than opaque blobs
- Better inspectability across app surfaces and developer tooling

## Decision 10: The URL is authoritative, local storage is not

If local storage exists at all, it is only for convenience such as restoring a
draft after accidental reload.

Rules:

- Sharing always uses the URL
- Opening a URL always wins over local storage
- The app must be correct with local storage disabled

## Decision 11: Route computation moves off the main thread

The route engine should live in a Web Worker once the graph is no longer tiny.

Stage 1 browser routing responsibilities:

- shortest path between selected cities
- reachability from last stop
- candidate suggestion scoring

Implementation direction:

- adjacency lists
- Dijkstra for shortest path
- Dijkstra-all for reachability
- typed arrays or compact arrays in memory after load

Rationale:

- Keeps the interface responsive
- Prevents filter and route recomputation from blocking interaction

## Decision 12: Dense network layers render on canvas, not per-node SVG

Leaflet remains acceptable for Stage 1, but rendering strategy must change from
prototype assumptions.

Recommended layer split:

- Canvas: full network edges, dense city dots
- SVG/HTML overlay: active route, selected stops, labels, reachable emphasis

Rationale:

- Better performance at larger graph sizes
- Keeps the no-tiles, no-borders approach
- Preserves the existing geographic interaction model

## Decision 13: Search is prebuilt offline

Autocomplete should not scan raw display labels at runtime.

The pipeline should build an alias/search index containing:

- canonical name
- aliases
- ASCII-folded aliases
- common spelling variants
- country hints where useful

The browser then loads a ready-to-use search structure keyed to `city_id`.

## Decision 14: Attribution is a first-class artifact

Because the product blends GTFS feeds, Wikidata, and supplementary sources,
source attribution must be generated, not remembered manually.

Stage 1 should emit an attribution artifact with:

- source name
- source URL
- license
- retrieval date
- notes or caveats

This keeps legal and operational provenance attached to the dataset build.

## Decision 15: The repository is structured for multiple apps from the start

The repo should assume more than one client surface even if Stage 1 only ships
the web app.

Rationale:

- Shared logic is a strategic asset.
- We want future iOS, Android, ChatGPT, CLI, or server surfaces to reuse core
  logic instead of cloning it.
- High portability requires separation between core logic and presentation
  layers from the beginning.

## Stage 1 Runtime Architecture

At runtime, the system should look like this:

1. Load static app shell
2. Load current dataset metadata
3. Load city graph and search index
4. Parse URL state
5. Initialize worker with graph
6. Render map and trip state
7. Recompute route/reachability when URL state changes
8. Write canonical state back to the URL

No server round-trip is required for the core experience.

## Stage 1 Repository Shape

Target shape:

```text
aetrain/
├── ARCHITECTURE.md
├── apps/
│   ├── web/
│   │   ├── src/
│   │   ├── public/
│   │   │   └── data/
│   │   └── index.html
│   └── chatgpt/          # future app surface, optional until needed
├── packages/
│   ├── rust/
│   │   ├── aetrain-domain/
│   │   ├── aetrain-routing/
│   │   ├── aetrain-urlstate/
│   │   ├── aetrain-normalize/
│   │   ├── aetrain-dataset/
│   │   └── aetrain-wikidata/
│   └── ts/
│       └── web-bindings/ # thin app-facing wrappers around wasm/core bindings
├── data/
│   ├── manifests/        # source manifests and feed definitions
│   ├── overrides/        # tracked manual overrides with rationale
│   └── cache/            # build-time cache, usually gitignored
└── tools/
    ├── pipeline/         # orchestration entry points
    └── docx_to_md.py
```

Notes:

- `packages/rust/` is the reusable core.
- `apps/*` should stay thin and presentation-focused.
- `data/overrides/` is mandatory if manual curation exists at all.
- `tools/pipeline/` orchestrates builds, but the heavy logic should still live
  in the reusable Rust crates.

## Stage 1 Non-Goals

To keep the architecture honest, Stage 1 does not attempt to solve:

- Seat availability
- Booking transactions
- Live delays or disruptions
- Multi-user state synchronization
- Full station-by-station booking-grade itinerary detail
- Personalized recommendation models

If a Stage 1 feature requires any of those, it belongs in a later stage or
needs to be cut down.

## Immediate Build Order

Implement in this order:

1. Canonical entity schema
2. URL state schema
3. Source manifest format
4. One-country GTFS adapter end to end
5. Canonical city graph export
6. Browser app that loads dataset and rebuilds trip state from URL
7. Reachability and shortest-path worker
8. Wikidata enrichment and attribution export
9. Additional country adapters
10. Suggestion logic on top of the normalized graph

This ordering keeps the product honest: shareable journeys and canonical data
land before cosmetic features.
