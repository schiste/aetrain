# Web App

This directory now contains two things:

- the modularized web app entry used for local development
- the original single-file prototype in [prototype/index.html](./prototype/index.html)

## What it is

The current app is the existing HTML proof of concept split into modules:
dataset, planner logic, and UI/map wiring. That keeps the current behavior
working while making it possible to replace embedded data and browser-only
logic incrementally with generated datasets and shared Rust code.

## Current layout

- `src/legacy/`: modularized transition app built from the original prototype
- `src/main.js`: current browser entrypoint
- `public/data/`: generated static dataset target
- `prototype/`: preserved original single-file prototype

## Running it locally

To run the current app locally, any static file server will work. For example:

```sh
python3 -m http.server --directory apps/web 8080
```

Then open <http://localhost:8080/>.

The original one-file prototype remains available at
<http://localhost:8080/prototype/>.

## Limits right now

- The app still uses embedded prototype data under `src/legacy/data.js`.
- Shared Rust logic is scaffolded in the repo but not yet bound into the web app.
- The final city graph, manifest ingestion, and URL codec are being moved into
  shared Rust crates.

## Why this directory exists

`apps/web/` remains the long-term home of the web surface. Right now it hosts
the cleaned-up transition app and the archived prototype side by side so the
existing product behavior can keep evolving without staying trapped in one
HTML file.
