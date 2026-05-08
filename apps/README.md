# App Surfaces

`apps/` contains end-user product surfaces.

Rules:

- each app stays thin and presentation-focused
- shared routing, parsing, dataset, and business logic belong in `packages/rust/`
- web is the first shipped client, not the long-term architectural center
- future mobile apps are intended to be native, performance-first clients
- every app must emit verbose structured diagnostics and performance timings to
  make debugging and optimization easy from day one

Current surfaces:

- `web/`: current browser app and preserved prototype
- `ios/`: planned native iOS client
- `android/`: planned native Android client
- `chatgpt/`: secondary assistant-facing surface
