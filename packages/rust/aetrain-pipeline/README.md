# aetrain-pipeline

Executable entrypoints for running import, normalization, and export stages
from the shared Rust core.

This crate should coordinate stages, not absorb all normalization logic.

Current responsibilities:

- `fetch`: refresh active manifest sources into `data/cache/`
- `build`: resolve cached sources, build one or more manifest targets, and
  write target-scoped artifacts
- `run`: fetch first, then build
- optional runtime debug sync into `apps/web/public/data/production/`

This crate should stay thin. Adapter logic, manifest contracts, fetch state,
normalization rules, and export formats belong in `aetrain-normalize` and the
other shared Rust crates.
