# Data Workspace

`data/` is the build-time workspace for source definitions, tracked overrides,
cache, and generated artifacts.

Subdirectories:

- `manifests/`: source manifests and ingest policy
- `overrides/`: tracked manual exceptions with rationale
- `cache/`: raw fetch cache and update state
- `build/`: canonical generated outputs

Rules:

- browser-shipped artifacts belong in `apps/web/public/data/`
- canonical pipeline outputs belong here first
