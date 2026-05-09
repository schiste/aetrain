# Registry Workspace

`data/registry/` is the dedicated workspace for the canonical Europe-wide city
and station registry.

Rules:

- seed Europe once
- refresh by deltas after the seed
- never let timetable feeds mint canonical cities directly
- store immutable raw snapshots separately from canonical outputs

Subdirectories:

- `raw/`: immutable source-native registry snapshots
- `state/`: seed markers, refresh cursors, and snapshot bookkeeping
- `build/`: materialized observation, canonical, and audit artifacts
- `overrides/`: tracked rule files and rare manual registry overrides
