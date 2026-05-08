# Web Workers

This folder is for browser worker entry points.

Target responsibilities:

- shortest-path queries
- reachability queries
- search index access
- dataset parsing if it becomes expensive enough to move off the main thread

Workers should call into shared Rust or wasm-backed logic wherever practical.
