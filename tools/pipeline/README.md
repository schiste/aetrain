# Stage 1 Pipeline

This directory hosts orchestration entry points for dataset generation.

The heavy logic should live in reusable Rust crates under `packages/rust/`.

Expected responsibilities here:

- selecting manifests
- invoking source adapters
- running normalization and enrichment stages
- managing raw-source updates in `data/cache/`
- exporting canonical build artifacts into `data/build/`
- projecting browser runtime artifacts into `apps/web/public/data/` later
- producing attribution and build metadata

Current Stage 1 entrypoint:

```sh
tools/pipeline/run-stage1.sh
```

That command:

- loads `data/manifests/stage1.sources.toml`
- fetches or skips active sources based on cached `ETag` / `Last-Modified`
- stores raw files under `data/cache/raw/`
- writes the first SNCF canonical artifacts under `data/build/stage1/sncf-fr/`
