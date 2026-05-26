# Generated Dataset Target

This directory is the runtime home for generated runtime artifacts consumed by
the web app.

Near-term output shape:

- `meta.json`
- `cities.json`
- `edges.json` or `graph.json` during the transition
- `edge-geometries.manifest.json` plus `edge-geometries/chunk-*.json` for large route geometry payloads
- `services.manifest.json` plus `services/chunk-*.json` for deferred GTFS service-pattern payloads
- `service-places.manifest.json` plus `service-places/chunk-*.json` for deferred service-only/replacement-bus places
- `registry-places.manifest.json` plus `registry-places/chunk-*.json` for deferred authority-backed places
- `aliases.json`
- `attribution.json`

Rules:

- debug snapshots may live under named folders such as `production/`
- the long-term shape should move toward versioned immutable directories
- canonical build artifacts stay under `data/build/`, not here

This directory is for browser-ready projections only.
