# aetrain-registry

Canonical registry scaffolding for the Europe-wide city and station layer.

This crate does not fetch live data yet.

It currently defines:

- registry manifest parsing
- canonical city/station/name-variant schemas
- seed and incremental cursor contracts
- city identity and merge rules
- country inference policy
- audit classifications
- source-specific observation models for Wikidata and OSM

The goal is to make the registry the source of truth for identity, while GTFS
and infrastructure feeds become mapped observations instead of city creators.
