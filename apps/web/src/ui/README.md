# Web UI

This folder hosts the custom-elements + TypeScript shell that drives the
Aetrain product loop. Light-DOM only (no shadow roots) so the existing
Playwright `#`-id selectors keep working and the canvas/map z-index
layering stays simple.

Layout:

- `tokens.css` — design tokens (colors, fonts, spacing) plus base styles
  loaded once by `index.html`.
- `runtime/` — the in-house signal/effect runtime, the tagged-template
  `html` helper, the `defineComponent` lifecycle, the shared formatters,
  and the AppContext registry.
- `components/` — custom elements that compose the sidebar and its
  interactive widgets (source switch, stats, filters, search, trip list,
  sidebar wrapper).
- `shell/` — the top-level `<ae-app>` element that boots the planner
  client + store + map surface and publishes the AppContext.

To add a new component, define it under `components/` with
`defineComponent(tag, factory)`. The factory returns a `render()` that
reads from the AppContext (`tryUseAppContext`) and any other signals;
re-runs are automatic.
