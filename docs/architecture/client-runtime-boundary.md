# Client/Runtime Boundary

This note defines what "front/back separation" means for Aetrain in Stage 1.

There is no traditional always-on application backend yet. The "back" side is:

- the offline Rust pipeline
- the generated runtime artifacts
- the shared planner engine

The "front" side is:

- the browser shell
- the renderer
- the DOM-facing interaction layer

## Boundary shape

The web app should have three explicit seams:

1. Dataset gateway
   - Location: `apps/web/src/data/`
   - Responsibility: load versioned runtime artifacts, validate them, and adapt
     them into a browser-facing planner dataset.
   - Rule: UI code never parses `meta.json`, `cities.json`, or other raw files
     directly.

2. Planner gateway
   - Location: `apps/web/src/engine/`
   - Responsibility: expose planner operations like "derive trip plan" behind a
     stable API, independent of whether the implementation is inline JS, a web
     worker, or Rust/WASM later.
   - Rule: UI code never speaks to worker message formats directly.

3. Planner store
   - Location: `apps/web/src/state/`
   - Responsibility: own trip/filter state and orchestrate when planner
     derivations are recomputed.
   - Rule: UI code mutates planning state through store methods, not by editing
     internal objects ad hoc.

## Why this matters

This shape keeps Aetrain maintainable across:

- web today
- native iOS later
- native Android later
- assistant surfaces later

The shared engine and runtime artifact contracts become the product truth. Any
single UI stays replaceable.

## Current transition status

Today the browser still uses transitional JS modules and a legacy Leaflet-based
surface, but the intended layering is now:

- `data/planner-dataset-contracts.js`: validates the runtime contract
- `data/runtime-data.js`: dataset gateway
- `engine/planner-client.js`: planner gateway
- `workers/planner.worker.js`: worker adapter
- `state/planner-store.js`: planner orchestration
- `state/planner-url-state.js`: readable share-state adapter
- `map/leaflet-map-surface.js`: rendering surface with Leaflet as camera/input
- `legacy/app.js`: current UI consumer of those boundaries

That is the migration path toward:

- Rust-generated runtime artifacts
- Rust/WASM planner engine on web
- platform-native renderers on iOS and Android

## Non-goals

- The web UI is not the place where canonical business logic should live.
- Raw pipeline shapes should not leak directly into renderer or sidebar code.
- One shared UI framework across all surfaces is not a goal.
