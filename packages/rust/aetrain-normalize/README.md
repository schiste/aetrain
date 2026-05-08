# aetrain-normalize

Build-time normalization and pipeline orchestration contracts.

This crate currently owns:

- source manifest and target definitions
- raw-source fetch/update state
- manual override registry loading
- normalization issue reporting
- adapter-facing pipeline orchestration
- the `sncf_fr` and `gtfs_basic` adapter entrypoints
- compact `runtime/web` export preparation alongside `runtime/web-debug`

This is the place for durable pipeline structure, not for browser-facing code
or product UI concerns.
