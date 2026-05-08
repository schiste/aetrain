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
- `legacy/`: transitional proof-of-concept code being retired

The goal is a thin browser shell around a shared Rust engine and a
performance-oriented renderer.
