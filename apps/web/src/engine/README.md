# Web Engine Bridge

This folder is for the browser-side interface to the shared route engine.

Expected responsibilities:

- calling wasm bindings
- message contracts for workers
- translating browser requests into compact engine inputs
- exposing a stable planner gateway to the UI/state layer

Current browser-facing operations should stay narrow:

- derive trip plan
- search cities
- later: route scoring, reachability, and URL codecs via shared Rust bindings

Rules:

- business logic stays in Rust
- this layer should remain a thin bridge
- the UI should talk to engine ports, not to worker internals
