# Legacy Transition App

This folder contains the modularized proof-of-concept implementation.

Why it still exists:

- it preserves working product behavior while the final architecture is built
- it lets the app evolve without staying trapped in a single HTML file

Exit criteria:

- runtime data comes from generated artifacts
- route computation moves behind worker and shared-core boundaries
- the map renderer no longer depends on per-city or per-edge Leaflet objects
