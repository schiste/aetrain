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

Manifest structure:

- `[[target]]`: a durable named build target, its adapter, source membership,
  and export policy
- `[[source]]`: a raw feed or supplementary dataset with fetch metadata and
  normalization role

Sources may also carry a version probe URL when the download endpoint does not
publish stable `ETag` or `Last-Modified` headers. That lets the pipeline skip
unchanged sources without redownloading them blindly.
