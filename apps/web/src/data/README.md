# Web Runtime Data

This folder is for browser-side runtime data loading and adaptation.

Expected responsibilities:

- loading generated artifacts from `public/data/`
- schema-aware parsing and validation
- temporary adapters for transitional formats
- acting as the anti-corruption layer between runtime artifacts and web-facing
  planner datasets

Rules:

- canonical data production happens in the Rust pipeline
- this layer adapts runtime artifacts for the browser, it does not invent them
- UI code must not parse raw artifact files directly
- runtime contract changes should land here first, behind validation
