# Stage 1 Pipeline

This directory hosts orchestration entry points for dataset generation.

The heavy logic should live in reusable Rust crates under `packages/rust/`.

Expected responsibilities here:

- selecting manifests
- invoking source adapters
- running normalization and enrichment stages
- exporting versioned dataset artifacts into `apps/web/public/data/`
- producing attribution and build metadata
