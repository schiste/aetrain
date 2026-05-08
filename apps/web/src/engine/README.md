# Web Engine Bridge

This folder is for the browser-side interface to the shared route engine.

Expected responsibilities:

- calling wasm bindings
- message contracts for workers
- translating browser requests into compact engine inputs

Rules:

- business logic stays in Rust
- this layer should remain a thin bridge
