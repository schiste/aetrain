# Europe Rail Data Onboarding

This document turns the Europe-wide discovery pass into an explicit pipeline
roadmap.

## Current Result

After a country-by-country source pass, Europe falls into five practical
groups.

### 1. Ready now with the current pipeline

- France: already onboarded with GTFS, station reference data, and official RFN
  geometry
- Luxembourg: official GTFS resolved through the data.public.lu dataset API and
  successfully built with the current `gtfs_basic` path

France and Luxembourg are now both source-verified and rail-validated in the
current pipeline.

### 2. Direct-feed candidates validated in this pass, but not rail-ready yet

- Estonia: the historical `peatus.ee/gtfs/gtfs.zip` endpoint now returns a
  shutdown HTML page instead of a GTFS archive
- Lithuania: the official `LTSAR.zip` archive fetches correctly, but the
  verified feed currently exposes bus-only `route_type=3` services and produced
  zero rail artifacts in `gtfs_basic`

These sources remain inventoried, but they are intentionally inactive in the
seed manifest until the endpoint or feed scope issue is resolved.

### 3. Official and promising, but needs a catalog resolver

- Austria
- Switzerland
- Germany
- Finland
- Norway
- Spain

Common issue:

- the source is official, but the file URL rotates by date, resource id, or
  archive listing

Required engineering:

- add source-resolution support for CKAN/Udata/directory-listing style feeds
- preserve the resolved URL in fetch audit state
- avoid hardcoding dated URLs into manifests

### 4. Official, but needs API-key support

- Ireland
- Sweden

Required engineering:

- environment-driven API key injection
- explicit secret-free manifest templates
- per-source auth metadata and fetch diagnostics

### 5. Official, but gated by contract, registration, or licence workflow

- Belgium
- Netherlands

Required engineering:

- source gating metadata
- operator runbook for manual approval / contract completion
- ability to keep sources inventoried before activation

### 6. Official, but needs a new adapter family

- Slovenia: NeTEx-first national access point
- United Kingdom: official rail timetable/open-data ecosystem, but not a
  national GTFS feed

Required engineering:

- NeTEx adapter for timetable/stops import
- non-GTFS rail adapter for UK rail timetable formats if UK national coverage is
  a Stage 1 requirement

## Geometry Direction

For Europe-scale mapping, schedule ingestion and rail geometry should be treated
as separate layers.

Recommended long-term order:

1. schedule ingestion from official national feeds
2. official infrastructure geometry where available
3. OSM/Geofabrik rail graph fallback where official geometry is absent
4. route-shape precedence:
   - GTFS `shapes.txt`
   - official infrastructure graph
   - OSM rail graph
   - straight-line fallback only as the final escape hatch

## Country Registry

The canonical status registry lives in:

- `data/inventory/europe-rail-onboarding.toml`

That file is the source of truth for:

- countries already seed-manifest ready
- countries blocked on auth, contract, or format work
- countries with no verified official machine-readable national source yet
- countries with no active national rail target
