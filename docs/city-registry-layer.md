# City Registry Layer

The city registry is the authority layer between raw public sources and the
runtime trip-planning artifacts.

Its job is to answer four questions before GTFS or local feed data can create a
customer-facing city:

- What municipality or city is this?
- Which country owns that canonical identity?
- Which rail stations belong to it?
- Which enrichment facts can be attached without changing identity?

## Source Stack

The registry uses a hierarchy, not a flat merge.

1. `municipality_identity`

   Official municipality registries define canonical identity, country,
   administrative codes, coordinates, and boundaries.

   Primary sources:

   - Eurostat GISCO LAU for the pan-European backbone
   - national statistical offices where the national source is stronger or more
     current than the pan-European release

2. `station_identity`

   Official transport registries define passenger rail stations.

   OSM can add station observations and names, but OSM alone is not enough to
   mint a canonical city.

3. `station_city_membership`

   Official station municipality codes, polygon containment, or equivalent
   administrative evidence binds a station to a city.

   This is the main defense against promoted station names such as `Toulouse
   Matabiau`, `Avignon TGV`, or bus-stop placeholders surviving in
   `cities.json`.

4. `enrichment`

   Wikidata enriches records with QIDs, labels, aliases, descriptions, source
   URLs, and population where available.

   It does not override official identity unless the official layer is missing
   and a quality rule explicitly allows a provisional identity.

5. `interest_signal`

   Future tourism and customer-facing ranking data belongs here:

   - museums
   - UNESCO sites
   - protected nature
   - coastline and scenic indicators
   - historical-interest signals

   These facts attach to a stable city ID; they must not participate in
   canonical identity resolution.

6. `feed_evidence`

   GTFS and national timetable feeds contribute operational evidence: station
   use, route availability, and aliases.

   They do not create canonical cities silently.

## Artifact Schemas

The registry crate defines these first-class artifact records:

- `RegistryCity`
- `RegistryStation`
- `RegistryCityStationMembership`
- `RegistryNameVariant`
- `RegistryCityFacts`
- `RegistryCitySignals`
- `RegistryCityAuthorityEvidence`
- `RegistryStationCityMembershipEvidence`
- `RegistrySourceCoverageReport`

The important design change is evidence separation. A city can have many
external references, but promotion should be based on evidence with an explicit
`authority_role`, `trust_tier`, `evidence_kind`, and confidence.

## Quality Rules

The registry source contract enforces these rules:

- every active registry target needs a municipality or city identity source
- national authority sources must declare country coverage
- community station-city membership evidence cannot auto-promote membership
  without official or coordinate-containment corroboration
- official sources should be traceable to a declared source URL or a documented
  catalog entry

Runtime pipeline cleanup should consume the registry outputs in this order:

1. official municipality identity
2. official station identity
3. official or containment-backed station-city membership
4. linked-open-data enrichment
5. community observations
6. feed-local evidence

## Why This Prevents Toulouse-Class Bugs

The Toulouse failure happened because a Wikidata alias was allowed to bridge a
Spanish station cluster to the French `Q7880` entity.

With the registry contract:

- Wikidata aliases are enrichment evidence, not municipality identity
- the match must pass geography and country constraints
- the canonical coordinate comes from the authority layer
- station-like singleton cities can be demoted only when a stronger
  authoritative parent exists

This turns city cleanup from a set of ad hoc fixes into a typed source-policy
problem.
