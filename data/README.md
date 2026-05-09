# Data Workspace

`data/` is the build-time workspace for source definitions, tracked overrides,
cache, and generated artifacts.

Subdirectories:

- `manifests/`: source manifests, target definitions, and ingest policy
- `inventory/`: source discovery registries and onboarding status
- `overrides/`: tracked manual exceptions with rationale
- `cache/`: raw fetch cache and update state
- `build/`: target-scoped generated outputs

Rules:

- browser-shipped artifacts belong in `apps/web/public/data/`
- canonical pipeline outputs belong here first
- each build target owns its own artifact root:
  - `build/stage1/<target>/canonical/`
    - rich outputs such as `bundle.json`, `issues.json`, `station-mappings.json`, and `edge-geometries.json`
  - `build/stage1/<target>/runtime/web/`
    - compact browser artifacts including `route-geometries.json`
  - `build/stage1/<target>/runtime/web-debug/`
    - current web-facing debug artifacts including `edge-geometries.json`
