# Web State

This folder is for canonical browser app state.

Expected responsibilities:

- trip state
- filters
- URL synchronization
- derived UI state that belongs to the browser shell
- orchestration between UI events, dataset state, and planner derivations

Current examples:

- `planner-store.js`: trip, filters, and search orchestration
- `planner-url-state.js`: readable hash state aligned with the shared URL-state
  grammar

Rules:

- the URL remains the authoritative share format
- local storage is convenience only
- UI layers should mutate planner state through explicit store methods
