# Rust Core

This namespace is the heart of Aetrain.

It owns:

- canonical domain types
- routing
- URL state
- dataset contracts
- normalization
- pipeline logic
- Wikidata enrichment support

Every app surface should treat these crates as the source of truth for
performance-critical logic.
