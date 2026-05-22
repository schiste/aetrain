# Source Manifests

Manifests define what Stage 1 ingests and which build targets are exported.

The default policy is:

- include every feed we can normalize with acceptable confidence
- include intercity rail, regional rail, and ferry
- exclude unsupported or untrusted feeds until an adapter exists

Manifests belong in version control because they are part of the product
definition, not just build tooling.

The current `stage1.sources.toml` includes:

- one `sncf-fr` target using the `sncf_fr` adapter
- the official SNCF static GTFS export
- the official SNCF passenger-station reference export
- the official SNCF RFN line-geometry export used for route-shape fallback

The `registry.europe.toml` manifest is intentionally a design-time manifest for
the future canonical Europe-wide registry. It defines the seed/refresh contract
for official municipality identity, official station identity, station-city
membership, Wikidata enrichment, and OSM station-observation sources, but it is
not wired into the current fetch/build CLI yet.

Manifest structure:

- `[[target]]`: a durable named build target, its adapter, source membership,
  and export policy
- `[[source]]`: a raw feed or supplementary dataset with fetch metadata and
  normalization role

Registry sources also declare:

- `authority_role`: what the source is allowed to decide, such as
  `municipality_identity`, `station_identity`, `station_city_membership`, or
  `enrichment`
- `trust_tier`: source class, such as `official`, `linked_open_data`, or
  `community`
- `country_codes`: explicit coverage for national authority sources

Aggregate targets may also declare:

- `registry_overlay_path`: registry-backed city authority used during
  aggregation
- `registry_source_manifest_path`: registry-source authority contract used to
  emit `quality/registry-source-coverage.json` and enforce the
  `source_contract_error_count_zero` gate
- `complete_registry_country_codes`: countries where the registry overlay is
  complete enough to forbid feed-created canonical cities
- `geometry_authority_registry_path`: the infrastructure-geometry authority
  registry that defines which countries and corridors are merely tracked versus
  promoted and held to zero-regression gates

The `role` field matters once a target has more than one source of the same
kind. Adapters should resolve sources by declared role such as `schedule` or
`stations_reference`, not by positional assumptions.

For the SNCF target, the route-geometry precedence is:

- GTFS `shapes.txt` when the timetable feed provides usable shapes
- the RFN geometry source via the `rail_geometry` role when GTFS has no shapes
- straight-line fallback only when neither source can provide a usable path

Sources may also carry a version probe URL when the download endpoint does not
publish stable `ETag` or `Last-Modified` headers. That lets the pipeline skip
unchanged sources without redownloading them blindly.

Sources can also carry a `resolver` when the manifest should point at an
official catalog instead of a brittle dated file URL.

Current resolver types:

- `html_latest_match`: scrapes a public dataset page and picks the latest
  matching link
- `udata_latest_resource`: resolves the latest matching file from a Udata-style
  dataset API such as `data.public.lu`
- `directory_listing_cascade`: walks one or more directory-listing pages and
  picks the latest matching link at each step
- `ckan_latest_resource`: resolves the latest matching file from a CKAN
  `package_show` response

Resolvers are expected to produce a concrete download URL. The fetch cache then
stores both:

- the configured manifest URL
- the resolved concrete download URL

That makes change detection and audit trails explicit when a catalog rotates
resource URLs over time.
