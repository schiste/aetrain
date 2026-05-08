# Stage 1 Pipeline

This directory hosts orchestration entry points for dataset generation.

The heavy logic should live in reusable Rust crates under `packages/rust/`.

Expected responsibilities here:

- selecting manifests
- selecting build targets
- invoking source adapters
- running normalization and enrichment stages
- managing raw-source updates in `data/cache/`
- exporting canonical build artifacts into `data/build/`
- projecting runtime debug artifacts alongside canonical artifacts
- optionally syncing the current runtime debug target into `apps/web/public/data/`
- producing attribution and build metadata

Current Stage 1 entrypoint:

```sh
tools/pipeline/run-stage1.sh
```

That command:

- loads `data/manifests/stage1.sources.toml`
- loads `data/overrides/city-overrides.toml`
- fetches or skips active sources based on cached `ETag` / `Last-Modified`
- stores raw files under `data/cache/raw/`
- builds the default manifest target from cached or freshly fetched sources
  - including the official RFN geometry source when the target declares `rail_geometry`
- writes canonical artifacts under `data/build/stage1/<target>/canonical/`
  - including `station-mappings.json` for normalization auditability
  - including `edge-geometries.json` for route-shape export
- writes compact runtime artifacts under `data/build/stage1/<target>/runtime/web/`
  - including `route-geometries.json` for browser rendering
- writes runtime debug artifacts under `data/build/stage1/<target>/runtime/web-debug/`
- syncs the selected target runtime projection into `apps/web/public/data/production/`

The Rust CLI also supports the underlying staged commands directly:

```sh
cargo run -p aetrain-pipeline -- fetch
cargo run -p aetrain-pipeline -- build --target sncf-fr
cargo run -p aetrain-pipeline -- run --sync-web-debug apps/web/public/data/production
```
