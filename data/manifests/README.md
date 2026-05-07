# Source Manifests

Manifests define what Stage 1 ingests.

The default policy is:

- include every feed we can normalize with acceptable confidence
- include intercity rail, regional rail, and ferry
- exclude unsupported or untrusted feeds until an adapter exists

Manifests belong in version control because they are part of the product
definition, not just build tooling.
