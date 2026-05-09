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
- Austria: official ÖBB GTFS built successfully after adding support for nested
  GTFS archive roots
- Germany: official nationwide DELFI GTFS built successfully through the
  directory-listing resolver
- Switzerland: official national GTFS built successfully from the public
  dataset page, with a signed-download redirect workaround
- Spain:
  - mainline / AVE / long-distance GTFS built successfully
  - Cercanías / Rodalies GTFS built successfully after tolerant CSV trimming

France, Luxembourg, Austria, Germany, Switzerland, and the two Spain targets
are now source-verified and rail-validated in the current pipeline.

### 2. Direct-feed candidates validated in this pass, but not rail-ready yet

- Estonia: the historical `peatus.ee/gtfs/gtfs.zip` endpoint now returns a
  shutdown HTML page instead of a GTFS archive
- Lithuania: the official `LTSAR.zip` archive fetches correctly, but the
  verified feed currently exposes bus-only `route_type=3` services and produced
  zero rail artifacts in `gtfs_basic`

These sources remain inventoried, but they are intentionally inactive in the
seed manifest until the endpoint or feed scope issue is resolved.

### 3. Official, but still blocked after live validation

- Norway: the documented `Current_latest-gtfs.zip` URL is an official GTFS stop
  dump with `stops.txt` and `feed_info.txt`, not a usable national timetable
  feed
- Finland: official FINAP and Digitraffic rail APIs were verified, but this
  pass did not validate a downloadable national GTFS or NeTEx rail package

Required engineering:

- Norway:
  - verify the real timetable publication path in Entur's ecosystem
  - or switch the country to a NeTEx-first ingest path
- Finland:
  - either onboard a public national package if one exists
  - or build a new adapter against the official API surfaces

### 4. Official, but still needs API-key support

- Ireland
- Sweden

Required engineering:

- environment-driven API key injection
- explicit secret-free manifest templates
- per-source auth metadata and fetch diagnostics

### 5. Official, but still gated by contract, registration, or licence workflow

- Belgium
- Netherlands

Required engineering:

- source gating metadata
- operator runbook for manual approval / contract completion
- ability to keep sources inventoried before activation

### 6. Official, but still needs a new adapter family

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
