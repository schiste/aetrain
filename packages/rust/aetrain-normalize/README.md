# aetrain-normalize

Build-time normalization and pipeline orchestration contracts.

This crate currently owns:

- source manifest and target definitions
- raw-source fetch/update state
- manual override registry loading
- normalization issue reporting
- adapter-facing pipeline orchestration
- the first `sncf_fr` adapter entrypoint

This is the place for durable pipeline structure, not for browser-facing code
or product UI concerns.
