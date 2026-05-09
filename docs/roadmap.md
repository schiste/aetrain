# Web Frontend Roadmap

This document is the working plan for taking `apps/web/` from its current
transitional shape to a stable, performant, multi-surface-ready frontend. It
is a living document; revise it as decisions land. PRs that diverge from this
plan should explain why in the description.

## North Star

A web client that:

- renders the full European city graph at 60fps on mid-range hardware
- recovers any shareable trip from the URL alone, with no backend
- carries shared business logic in Rust crates, not in JavaScript
- treats every observable surface (boot, data, engine, render, URL) as
  diagnostic-instrumented by default
- stays replaceable: future iOS/Android clients should reuse the same
  gateways and contracts

See [`ARCHITECTURE.md`](../ARCHITECTURE.md), especially Decisions 2, 3, 4, 11,
12, and 13, for the architectural commitments this roadmap operationalizes.

## Scope

In scope:

- `apps/web/` shell, components, renderer, state, URL codec, build
- `packages/ts/web-bindings/` for the WASM/Rust boundary
- the minimum slice of `packages/rust/aetrain-routing` needed to replace the
  worker's JS engine
- diagnostics, performance budgets, CI gates, test harness

Out of scope (other roadmaps own these):

- offline data pipeline scope, source feeds, or pipeline crates beyond what
  the runtime contract requires
- iOS/Android clients (this roadmap respects the boundaries they will need;
  it does not implement them)
- Stage 2/3 features such as live timetables, accounts, or booking

## Locked Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Component model | Custom elements + TypeScript, no framework | UI surface is small; we own the lifecycle; zero framework lock-in for multi-surface story |
| Sequence | WASM planner before UI refactor | Lock the engine semantics first so the UI rewrites against a stable contract |
| TypeScript scope | Strict, all of `apps/web/src/` in one pass | Short-term cost worth a clean baseline before WASM lands |
| Perf enforcement | HUD overlay plus CI-asserted budgets | Numbers without teeth decay; CI fails on regression |
| Plan home | This file (`docs/roadmap.md`) | Tracked alongside the architecture docs; references-able from PRs |

## Phases

The phases are sequential at the level of *exit criteria*, but small slices
within each can overlap.

### Phase 0 — Foundations

Everything that needs to be true before either WASM or UI churn begins.

Deliverables:

- TypeScript migration of `apps/web/src/` to `--strict`, including
  `--noUncheckedIndexedAccess`. One coordinated PR; no `.js` files remain
  under `src/` after merge.
- `?perf` HUD overlay, fed from `__AETRAIN_DIAGNOSTICS__`. Surfaces rolling
  frame time, last render-plan stats, worker round-trip P50/P95, dataset
  bytes loaded, current render reason.
- Playwright smoke harness exercising the golden path:
  load → search → add stop → reload from URL → assert trip restored.
  Runs on one desktop viewport and one mobile viewport.
- CI matrix: `cargo test`, `npm test`, Playwright smoke, type-check.
- Performance budgets written to
  [`docs/architecture/performance-budgets.md`](architecture/performance-budgets.md)
  per device class. Initial values are aspirational; the HUD measures, the
  Playwright suite asserts.

Exit criteria:

- Zero `.js` under `apps/web/src/`.
- HUD reachable via `?perf=1`.
- CI green on smoke + type-check + tests.
- Budget document committed and referenced from PRs.

### Phase 1 — WASM planner behind the existing gateway

Replace `apps/web/src/legacy/core.ts` (post-migration) as the worker's
engine. The planner gateway protocol does not change.

Deliverables:

- Minimal `packages/rust/aetrain-routing` API: `build_graph`, `dijkstra`,
  `dijkstra_all`, `find_interesting_stops`, `search_cities`. Wire format
  matches the current JS shapes; we keep the option to migrate to scaled-int
  artifacts later without breaking the gateway.
- `packages/ts/web-bindings/` wraps `wasm-bindgen` output and conforms to
  `engine/planner-protocol.ts`. The worker imports from `web-bindings`,
  never from `legacy/core`.
- Inline JS fallback retained for SSR/test/no-WASM environments. A fixture
  corpus asserts wire-equivalence between the JS and WASM paths.
- Bundle and runtime gates enforced in CI:
  - WASM blob ≤ 250 KB gzipped
  - Worker round-trip P50 ≥ 1.5× faster than the JS path on the production
    dataset for `derive-trip` and `dijkstra-all`

Exit criteria:

- `workers/planner.worker.ts` no longer imports from `legacy/core`.
- Equivalence corpus and perf gates are part of the CI build.
- The HUD shows engine kind (`wasm` / `js-fallback`) and round-trip metrics.

### Phase 2 — UI refactor: custom elements + TypeScript

The pillar. The legacy directory is deleted at the end of this phase.

Target layout under `apps/web/src/ui/`:

```
ui/
├── primitives/   # ae-button, ae-range, ae-dual-range, ae-pill,
│                 # ae-search-input, ae-stat, ae-icon
├── components/   # ae-trip-list, ae-trip-stop, ae-suggestion,
│                 # ae-filters, ae-source-switch, ae-sidebar
├── shell/        # ae-app — replaces legacy/shell + legacy/app
├── runtime/      # tiny templating + reactive helpers
└── tokens.ts     # design tokens; CSS custom properties source of truth
```

Open design choices to resolve at the start of Phase 2:

- Templating: `lit-html` standalone vs. an in-repo tagged-template + diff
  helper vs. direct `document.createElement`. Pick once, document, hold.
- Store binding: subscribe-and-rerender vs. a tiny `signal()` helper. Pick
  the simpler shape that lets us avoid a stale-render bug.

Migration order, strangler-style:

1. `ae-source-switch` — simplest, validates the pattern.
2. `ae-stats` — read-only.
3. `ae-filters` — form-heaviest piece.
4. `ae-search` — async coupling to the store.
5. `ae-trip-list` — the legacy-bound centerpiece; replaces `innerHTML`.
6. `ae-app` shell takes over from `mountLegacyApp`.
7. Delete `apps/web/src/legacy/`.

The map surface (`map/leaflet-map-surface.ts`) is untouched in this phase
beyond mechanical TS fixes; its public API is already the right shape for
the new shell to consume.

Exit criteria:

- `apps/web/src/legacy/` directory removed.
- All sidebar surfaces are custom elements.
- HUD baseline and Playwright smoke still pass; no perf regressions ≥5%
  on tracked metrics.

### Phase 3 — Performance loop and polish

Begins overlapping with Phase 2 once the new shell is half-migrated.

Deliverables:

- Lazy-load edge-geometry chunks by viewport (manifest already supports
  per-chunk fetch). Note: viewport-aware geometry streaming is a Phase 3.x
  follow-up — it requires a viewport-driven re-fetch loop in the map
  renderer that streams chunks based on visible bounds, large enough to
  warrant a dedicated PR with refreshed e2e coverage.
- Pre-warm the planner worker during dataset fetch (currently serial).
- Service worker keyed on `meta.dataset_version` for offline + instant
  revisits.
- Mobile-first pass with the new components; tokens-driven theming.
- A11y audit: keyboard map nav, screen-reader trip list, ARIA on filters.
- Fly-to and suggestion-reveal animation polish.

Exit criteria:

- LCP and TTI budgets met cold and warm on the budget device class.
- Lighthouse a11y score ≥ 95 on the sidebar surfaces.
- Service worker passes a controlled offline-reload test.

### Phase 4 — Stability harness deepening

Begins in parallel with Phase 3. Some baseline lands earlier.

Deliverables:

- Visual regression baselines for canonical map states (dataset switch,
  zoom-to-city, full trip rendered, mobile sidebar collapse).
- Property-based tests for the URL codec round-trip.
- Fault-injection E2E flows: corrupted dataset, worker crash, network 500,
  malformed URL hash.

Exit criteria:

- Visual regression on a per-PR basis with reviewable diffs.
- URL codec covered by property tests, not only fixture tests.
- Each fault-injection scenario has an asserted user-visible recovery path.

## Cross-Cutting Rules

- Diagnostics-first is mandatory. Every new module gets
  `createDiagnostics("web/<area>/<sub>")` and emits at minimum boot, error,
  and per-frame metric events relevant to its scope. Refer to
  [`docs/architecture/diagnostics-logging.md`](architecture/diagnostics-logging.md).
- One concern per PR. Conventional Commits, scoped to the touched module
  (`feat(ui): ae-trip-list`, `refactor(worker): use web-bindings`,
  `chore(web): typescript strict pass`).
- No new code imports from `apps/web/src/legacy/`. The directory is
  delete-on-sight after Phase 2; new imports keep it alive longer.
- The planner gateway protocol is a public contract. Changing it forces a
  matching change in the worker, the inline fallback, and any future native
  client adapter. Bump the protocol version in
  `engine/planner-protocol.ts` if the shape changes.

## Open Questions Carried Forward

These do not block Phase 0 but need answers before the phase that owns them
begins.

- Phase 1: do we accept a temporary debug WASM build in dev (larger, with
  panic strings) or always ship release-mode WASM? Affects DX vs. dev
  bundle size.
- Phase 2: templating helper choice (see "Open design choices" above).
- Phase 2: store binding shape (subscribe-and-rerender vs. signals).
- Phase 3: do we want runtime A/B for the canvas renderer vs. a future
  WebGL/WebGPU path, or commit to one and migrate?
- Phase 4: hosted visual-regression service vs. self-hosted snapshots?
