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

Manifest structure:

- `[[target]]`: a durable named build target, its adapter, source membership,
  and export policy
- `[[source]]`: a raw feed or supplementary dataset with fetch metadata and
  normalization role

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
