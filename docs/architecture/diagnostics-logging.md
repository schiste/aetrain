# Diagnostics And Logging

Aetrain treats verbose diagnostics as a core product rule.

## Rule

Every app surface should emit:

- structured lifecycle logs
- performance timings for expensive paths
- enough contextual metadata to reconstruct what the app was doing

This applies to:

- app boot
- dataset loading
- engine or worker requests
- state mutations
- URL synchronization
- rendering

## Current web implementation

The current browser app uses:

- `apps/web/src/app-shell/diagnostics.js`

That module:

- writes verbose logs to the console
- stores a rolling in-memory event buffer on
  `globalThis.__AETRAIN_DIAGNOSTICS__`
- exposes helper methods such as `dump()`, `table()`, and `clear()`

The intent is that developers can inspect both live console output and a
structured post-hoc event stream during debugging and performance work.

## Why this is a rule

The project is explicitly performance-first and multi-surface. That means we
cannot accept "hard to observe" clients. Diagnostics should be present before
the apps become complicated, not retrofitted after regressions appear.
