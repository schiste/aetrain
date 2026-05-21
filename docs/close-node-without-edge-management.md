# Close Node Without Edge Management

`close-node-without-edge-candidates.json` is a build-time quality artifact for
city nodes that are geographically close but do not have a direct graph edge.
It is a cleanup triage surface, not an edge-generation source.

## Rule

Never create a direct edge from distance alone.

An edge can be added only when one of these sources supports it:

- consecutive GTFS stop observations after station/city normalization
- a promoted railway authority graph path between the two city nodes
- a reviewed corridor rule with source provenance and regression coverage

## Classification Policy

`invalid_coordinate_overlap`

- meaning: at least one city has an invalid `0,0` coordinate
- owner: source adapter
- action: fix or reject the bad coordinate before any graph inference
- automation: can block export or quarantine; must not create edges

`probable_duplicate_same_position`

- meaning: same-country, name-related city nodes are within `10m`
- owner: city registry
- action: merge, alias, or bind both stations to the same registry city
- automation: safe only when registry or station evidence agrees

`cross_feed_duplicate_same_position`

- meaning: cross-country/feed city nodes are within `10m` and name-related
- owner: country inference
- action: fix feed-country leakage, then merge only with evidence
- automation: review required because border stations can be legitimate

`probable_duplicate_near_position`

- meaning: name-related city nodes are within `100m`
- owner: city registry
- action: compare station memberships, registry identity, and source provenance
- automation: merge only with supporting evidence

`nearby_name_variant`

- meaning: name-related city nodes are within `1km`
- owner: city registry
- action: decide whether this is an alias, substation, or true nearby locality
- automation: review required

`nearby_indirect_graph_connection`

- meaning: no direct edge exists, but the graph connects the nodes within 2-3 hops
- owner: graph model
- action: review whether this is a transfer/city-cluster split
- automation: do not add an edge by default

`nearby_unconnected_same_country`

- meaning: same-country nodes are close and graph-disconnected within 3 hops
- owner: rail topology
- action: audit GTFS consecutive stops and railway authority topology
- automation: edge candidate only with source evidence

`nearby_unconnected_cross_country`

- meaning: cross-country nodes are close and graph-disconnected within 3 hops
- owner: corridor scope
- action: audit border/corridor authority and country inference
- automation: edge candidate only with corridor evidence

## Operating Practice

Fix order:

1. `P0` coordinate and duplicate defects.
2. `P1` near duplicates and short-distance unconnected cases.
3. `P2` alias/membership candidates.
4. `P3` topology and transfer-model candidates.

Promotion rule:

- a country cannot be customer-facing if `P0` close-node findings remain
- `P1` findings need explicit acceptance or remediation plan
- `P2/P3` findings can remain only when documented as non-blocking backlog
