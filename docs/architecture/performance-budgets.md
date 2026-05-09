# Performance Budgets

This document defines the performance budgets the Aetrain web app commits to.
It exists so that "fast" is measurable and so CI can fail when we regress.

Budgets are aspirational at first. Phase 0 ships the HUD that measures them
and the Playwright harness that asserts them on the canned fixture. Numbers
get tightened as we hit them. Loosening a budget requires a doc update with a
linked rationale.

## Device classes

| Class | Reference machine | Throttling profile | Use |
| --- | --- | --- | --- |
| `desktop-baseline` | 2019 MacBook Air, M1, Chromium | None | Hard budgets enforced in CI |
| `desktop-strict` | Same, with 4× CPU throttle, 3G fast network | Chrome DevTools "Fast 3G" + 4× CPU | Stretch budgets, warn-only in CI |
| `mobile-baseline` | iPhone 12 viewport, Chromium mobile UA | 4× CPU throttle | Hard budgets, Playwright `device: 'iPhone 12'` |

CI runs on `desktop-baseline` and `mobile-baseline` by default. The strict
class is run nightly; regressions there file an issue but do not fail the
build.

## Metrics

All times in milliseconds, all sizes in kilobytes (1024 bytes).

### Cold load (no service worker, empty cache)

| Metric | desktop-baseline | mobile-baseline | Source |
| --- | --- | --- | --- |
| First Contentful Paint | ≤ 800 | ≤ 1200 | Playwright `performance.timing` |
| Largest Contentful Paint | ≤ 1500 | ≤ 2400 | Playwright LCP entry |
| Time to Interactive (planner ready) | ≤ 2200 | ≤ 3500 | `web/bootstrap` `bootstrap-web-app:end` metric |
| Initial JS gzipped | ≤ 80 | ≤ 80 | Vite build report |
| Initial WASM gzipped (post Phase 1) | ≤ 250 | ≤ 250 | Vite build report |
| Eager dataset bytes | ≤ 1500 | ≤ 1500 | `web/data/runtime` cumulative `metric` events |

### Warm load (with service worker, post Phase 3)

| Metric | desktop-baseline | mobile-baseline |
| --- | --- | --- |
| First Contentful Paint | ≤ 250 | ≤ 400 |
| Time to Interactive | ≤ 600 | ≤ 1000 |

### Interaction

| Metric | desktop-baseline | mobile-baseline | Source |
| --- | --- | --- | --- |
| Frame time at zoom 5 (median) | ≤ 8 | ≤ 12 | `web/map/canvas-surface` `map-render` metric duration_ms |
| Frame time at zoom 5 (P95) | ≤ 16 | ≤ 24 | Same |
| `derive-trip` worker round-trip (P50) | ≤ 35 | ≤ 70 | `web/engine/planner-client` `planner-worker-request:success` |
| `derive-trip` worker round-trip (P95) | ≤ 80 | ≤ 160 | Same |
| `search-cities` round-trip (P50) | ≤ 20 | ≤ 40 | Same |
| URL hash commit latency (settle) | ≤ 250 | ≤ 250 | `web/state/planner-url-state` |

### Memory

| Metric | desktop-baseline | mobile-baseline |
| --- | --- | --- |
| JS heap used after 10 minutes idle | ≤ 80 MB | ≤ 50 MB |
| JS heap used after 100 trip mutations | ≤ 120 MB | ≤ 80 MB |

## How budgets are enforced

1. The `?perf` HUD (Phase 0) surfaces live numbers from
   `globalThis.__AETRAIN_DIAGNOSTICS__` for the developer in the browser.
2. The Playwright smoke suite (Phase 0) runs the canned golden path on each
   device class, scrapes the diagnostics buffer, and asserts each metric
   against the table above.
3. CI fails when a hard budget is exceeded. Strict-class regressions warn
   but do not fail.
4. Bundle budgets are enforced via `vite build` size report parsed by a
   small CI script.

The fixture used to measure interaction metrics is a deterministic scripted
session: load with `?source=production`, search for `Lyon`, add it to the
trip, search for `Madrid`, add it, pan once, zoom in twice, reload from the
hash. Every metric is sampled across that session.

## Revision policy

- Tightening a budget: open a PR with the new number and a HUD or
  Playwright run showing it is achievable.
- Loosening a budget: open a PR with the regression analysis and the
  intended remediation issue. Loosening without a remediation plan is
  rejected.
- Adding a metric: add the source diagnostic event in the same PR; metrics
  without an instrumented source are rejected.

## Open questions

- Strict-class CI requires a stable runner. Self-hosted runner with pinned
  hardware vs. a service like Calibre or SpeedCurve. To resolve in Phase 0.5
  before tightening any number.
- Mobile Safari coverage is not in CI yet; we measure on Chromium mobile
  emulation only. Real-device coverage is a Phase 4 deliverable.
