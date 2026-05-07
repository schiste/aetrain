# Contributing to Aetrain

Thanks for your interest! This document covers the practical mechanics of
contributing. For the social side, see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Getting set up

The repository is in transition from a single-file prototype to a structured
multi-app workspace.

To run the shared Rust checks:

```sh
cargo test
```

To browse the legacy prototype locally:

```sh
python3 -m http.server --directory apps/web 8080
# open http://localhost:8080/prototype/
```

If you're touching `tools/docx_to_md.py` or its compatibility shim, no
dependencies are needed — it's stdlib-only Python 3.

## Workflow

1. **Open an issue first** for anything beyond a typo or one-line fix. This
   saves you from writing a PR we can't merge.
2. **Branch from `main`**. Use a descriptive name: `feat/leg-filter-presets`,
   `fix/divicon-marker-css`, `docs/contributing-cleanup`.
3. **Keep PRs focused.** One concern per PR. If you find adjacent issues while
   working, open separate issues for them.
4. **Write a clear PR description.** What changed, why, and what you tested.
   Screenshots or short clips for UI changes.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/). The prefix
makes the changelog write itself once we automate it:

```
feat(map): add leg-duration preset chips
fix(filters): clamp interest slider to non-negative
docs: clarify GTFS pipeline scope
```

## Code style

- 2-space indent for everything except Python/Go/Rust (4) — enforced by
  [.editorconfig](./.editorconfig).
- Rust shared logic belongs under `packages/rust/`.
- The web shell belongs under `apps/web/src/` and should stay thin; business
  logic should move into shared crates rather than being reimplemented in the
  app.
- Manual data overrides belong in `data/overrides/` and must carry rationale
  and traceability.

## Licensing of contributions

Aetrain is [AGPL-3.0](./LICENSE). By submitting a contribution you agree to
license it under the same terms — there is no separate CLA. If you are
contributing on behalf of an employer, ensure they're aware and approve.

The network-use clause matters for contributors too: if you fork Aetrain into
a hosted service, you must publish your modifications. We picked AGPL to keep
the project's improvements flowing back to the community rather than into
closed-source rebrands.

## Reporting bugs and requesting features

Use the GitHub issue forms (Bug report / Feature request). They prompt for
the structured info we need — please don't skip the reproduction steps for
bugs; they save days of triage.

## Security issues

**Do not file security reports as public issues.** See
[SECURITY.md](./SECURITY.md) for the private disclosure channel.
