# Web App

This directory now contains two things:

- the modularized web app entry used for local development
- the original single-file prototype in [prototype/index.html](./prototype/index.html)

## What it is

The current app is the existing HTML proof of concept split into modules:
dataset, planner logic, and UI/map wiring. That keeps the current behavior
working while making it possible to replace embedded data and browser-only
logic incrementally with generated datasets, workers, and shared Rust code.

The intended browser boundary is now explicit:

- `src/data/` is the runtime dataset gateway
- `src/engine/` is the planner gateway
- `src/state/` is the trip/filter orchestration layer
- `src/map/` is the rendering and map-interaction surface
- `src/legacy/` is a temporary consumer of those boundaries, not the owner of
  them

Long-term intent:

- the browser shell stays thin
- the renderer becomes custom and performance-oriented
- routing, parsing, and heavy graph logic move behind worker + wasm boundaries
- verbose structured diagnostics remain available across boot, data, engine,
  state, URL sync, and rendering

Current performance-oriented web model:

- planner graph build, routing, and search happen behind the planner gateway in
  a worker-first flow
- production datasets may carry planner-ready artifacts such as prepared route
  pairs and search indexes
- the map surface renders through scheduled canvas layers with viewport culling,
  label budgets, and cached projected inputs
- URL state is readable but committed off the immediate render hot path

## Current layout

- `src/legacy/`: modularized transition app built from the original prototype
- `src/app-shell/`: browser bootstrap and composition boundary
- `src/ui/`: non-map user interface
- `src/map/`: renderer-facing map layer
- `src/engine/`: web-side bridge to shared core logic
- `src/state/`: URL and UI state orchestration
- `src/data/`: runtime dataset loading and adaptation
- `src/workers/`: worker entry points
- `src/main.js`: current browser entrypoint
- `public/data/`: generated static dataset target
- `prototype/`: preserved original single-file prototype

## Running it locally

To run the current app locally, any static file server will work. For example:

```sh
python3 -m http.server --directory apps/web 8080
```

Then open <http://localhost:8080/>.

The original one-file prototype remains available at
<http://localhost:8080/prototype/>.

For browser diagnostics, inspect `window.__AETRAIN_DIAGNOSTICS__` in the
console. It keeps a rolling event buffer and helper methods such as `dump()`,
`table()`, and `clear()`.

## Limits right now

- The app still uses embedded prototype data under `src/legacy/data.js`.
- Shared Rust logic is scaffolded in the repo but not yet bound into the web app.
- The current map surface is now a dedicated Leaflet-plus-canvas module, but it
  is still transitional and browser-only.
- The final city graph, manifest ingestion, worker boundary, and URL codec are
  being moved into shared Rust crates and thin browser adapters.

## Why this directory exists

`apps/web/` remains the long-term home of the web surface. Right now it hosts
the cleaned-up transition app and the archived prototype side by side so the
existing product behavior can keep evolving without staying trapped in one
HTML file. The eventual goal is a high-performance browser app with:

- generated runtime artifacts
- worker-based route computation
- a custom renderer for dense city and network layers
- minimal browser-side business logic
