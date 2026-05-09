# Web Source Layout

`src/` is split by browser responsibilities, not by framework convention.

Target boundaries:

- `app-shell/`: browser bootstrap and app composition
- `ui/`: DOM-facing interface code
- `map/`: renderer and map interaction code
- `engine/`: browser-side bridge to the shared core
- `state/`: canonical app state and URL synchronization
- `data/`: runtime artifact loading and adaptation
- `workers/`: worker entry points

The goal is a thin browser shell around a shared Rust engine and a
performance-oriented renderer.

Important boundary rule:

- raw runtime artifacts enter through `data/`
- route computation enters through `engine/`
- UI modules should consume store or gateway APIs, not raw backend shapes
- the map surface should consume planner state and engine output, not reach into
  raw artifact parsing or worker messaging
- diagnostics should be verbose, structured, and present across boot, data,
  engine, state, URL sync, and rendering paths
