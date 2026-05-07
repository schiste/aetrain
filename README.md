# Aetrain

> Interactive European rail trip planner — built in the open.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Status: prototype](https://img.shields.io/badge/status-early%20prototype-orange.svg)](#project-status)

<!--
TODO(you): write the project pitch here. 3-5 sentences, no more.

This block is the most important text in the repo: it's what someone sees in
the first 10 seconds on GitHub, in social previews, and in search results.
The decision is yours, not the converter's, because positioning is a
product/voice call:

  - Who is this *for*? (Trip planners? OSS rail-data folks? Curious devs?)
  - What does it *do* in one sentence a non-technical reader can grasp?
  - What makes it *different* from existing tools (interrail.eu, Rome2Rio,
    Google Maps)?

Suggested shape (5-10 lines):

  Aetrain helps you plan multi-stop European rail trips visually. Pick cities
  on an interactive map; Aetrain calculates routes, suggests interesting
  detours along the way, and filters destinations by travel time, popularity,
  or population. Built on a curated dataset of 369 cities and 748 connections
  derived from public GTFS feeds, it runs as a single static page with no
  external services or tracking.

Replace the placeholder paragraph below with your version.
-->

**Aetrain is an early-stage build.** _A clear pitch goes here — see the comment above._

## Project status

Early Stage 1 build-out, in public. The original legacy prototype now lives at
`apps/web/prototype/index.html`, and `apps/web/` itself now serves the
modularized version of that same proof of concept while shared Rust crates and
generated static datasets take shape underneath it. Expect breaking changes;
APIs, data contracts, and repo structure are intentionally still moving.

The architectural direction — a weekly GTFS pipeline producing static JSON
plus an optional dynamic timetable layer — is documented in
[ARCHITECTURE.md](./ARCHITECTURE.md). Expect that document to evolve as the
Stage 1 data model and pipeline harden.

## Quick start

```sh
# Run the shared Rust workspace checks
cargo test

# Fetch or refresh the first live SNCF sources and build canonical Stage 1 outputs
tools/pipeline/run-stage1.sh

# Browse the current modularized web app (any static server works)
python3 -m http.server --directory apps/web 8080
# then open http://localhost:8080/
```

The web app is now split into modules, but it still uses embedded prototype
data and is not yet wired to live generated datasets or wasm bindings. The
first live import pipeline writes raw source cache state under `data/cache/`
and canonical build artifacts under `data/build/stage1/sncf-fr/`.

## Repository layout

```
aetrain/
├── apps/
│   ├── web/              # current web shell + legacy prototype under prototype/
│   └── chatgpt/          # future app surface placeholder
├── ARCHITECTURE.md       # public architecture and staged technical decisions
├── data/                 # source manifests, overrides, build-time cache
├── packages/
│   ├── rust/             # shared domain, routing, url state, pipeline logic
│   └── ts/               # thin app-facing bindings and wrappers
├── tools/                # pipeline orchestration and local utilities
├── docs/                 # generated docs (not tracked) — see tools/
├── scripts/              # compatibility shims for relocated tools
├── LICENSE               # AGPL-3.0
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── SECURITY.md
```

## Contributing

We welcome contributions of all sizes. Please read [CONTRIBUTING.md](./CONTRIBUTING.md)
before opening a pull request, and abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

To report a security issue privately, see [SECURITY.md](./SECURITY.md).

## License

Aetrain is licensed under the [GNU Affero General Public License v3.0](./LICENSE).

The AGPL's network-use clause means: if you run a modified version of Aetrain
as a network service, you must offer the source of your modifications to its
users. We chose AGPL deliberately — see CONTRIBUTING.md for context.
