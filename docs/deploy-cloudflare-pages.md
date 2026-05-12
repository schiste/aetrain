# Cloudflare Pages deployment

The Aetrain web app deploys to Cloudflare Pages at
`aetrain.pages.dev`. The deploy is git-integrated — every push to
`main` triggers a build.

## Build configuration

CF Pages reads the build config in this order:

1. `wrangler.toml` at the repo root (committed) declares
   `pages_build_output_dir = "apps/web/dist"`. This tells CF Pages
   where to find the production artifact.
2. The project `package.json` at repo root (committed) exposes
   `npm run build`, which delegates to
   `scripts/build-for-pages.sh`. The script installs `wasm-pack`
   if it's missing, ensures the `wasm32-unknown-unknown` rustup
   target is present, rebuilds `packages/rust/aetrain-routing-wasm`
   in release mode, then runs `npm ci && npm run build` inside
   `apps/web`. CF Pages re-runs the full pipeline on every deploy,
   so the wasm artifact is always in sync with the routing crate
   — there is no committed `pkg/` to drift.
3. `apps/web/public/_headers` (committed) ships into `dist/` via
   Vite's static-asset pipeline. It pins:
   - `Content-Type: text/javascript` for any `.ts` URL that ever
     leaks into the deploy (defensive against the original symptom).
   - Long cache for `/assets/*` (vite-fingerprinted).
   - Short cache + SWR for `/data/production/*` (versioned via
     `meta.json` and the service worker).
   - Never-cache for the HTML shell.

## Dashboard settings (one-time)

If a fresh Pages project doesn't pick up the `wrangler.toml`
automatically (it usually does, but the UI can lag), set these
manually in the dashboard:

- **Production branch**: `main`
- **Build command**: `npm run build`
- **Build output directory**: `apps/web/dist`
- **Root directory**: leave blank (`/`)
- **Environment variables**:
  - `RUST_VERSION` = `1.92.0` — must match the `channel` in
    `rust-toolchain.toml`. CF Pages uses this to provision rustup
    + the matching toolchain in the build image; without it the
    build script can't add the `wasm32-unknown-unknown` target.
  - `NODE_VERSION` — optional; pin if you want to lock the
    Node version the Pages image uses for `npm ci`.

## Why this matters

The first symptom of a misconfigured deploy is the browser console
showing:

```
TypeError: 'video/mp2t' is not a valid JavaScript MIME type.
The resource …/data/production/meta.json was preloaded …
  but not used within a few seconds…
```

Both come from the same root cause: CF Pages is serving the
*source* `apps/web/index.html` instead of the built one. Source
`index.html` references `/src/main.ts` directly; CF serves `.ts`
as MPEG-2 Transport Stream MIME (`video/mp2t`); the browser
refuses to import it as an ESM module; bootstrap fails; the
worker never spawns; the preloaded JSON never gets consumed; ergo
the preload warnings.

If you see those symptoms, check the deploy log for evidence that
`npm run build` ran and emitted `apps/web/dist/`. If it didn't,
the dashboard build command is wrong.
