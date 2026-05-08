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

- stores a rolling in-memory event buffer on
  `globalThis.__AETRAIN_DIAGNOSTICS__`
- exposes helper methods such as `dump()`, `table()`, and `clear()`
- exposes runtime tuning such as `setConsoleLevel()` and `setMaxEvents()`
- writes console output at a configurable verbosity level while still keeping
  the full event stream in memory

Current console-level controls:

- default console level is `info`
- `?diag=debug` enables full debug and metric console output
- `localStorage["aetrain-diagnostics-console-level"] = "debug"` persists it
- `window.__AETRAIN_DIAGNOSTICS__.setConsoleLevel("debug")` changes it live

The intent is that developers can inspect both live console output and a
structured post-hoc event stream during debugging and performance work.

## Why this is a rule

The project is explicitly performance-first and multi-surface. That means we
cannot accept "hard to observe" clients. Diagnostics should be present before
the apps become complicated, not retrofitted after regressions appear.
