#!/usr/bin/env bash
# build-for-pages.sh
# -----------------------------------------------------------------------------
# Orchestration entry point for `npm run build` from the repo root. Designed
# to be safe both on developer machines (macOS, wasm-pack already installed)
# and inside the Cloudflare Pages build container (Ubuntu, fresh checkout,
# only rustup + node available once RUST_VERSION is set in the dashboard).
#
# Steps:
#   1. Ensure wasm-pack is on PATH (install precompiled binary if missing).
#   2. Ensure the wasm32-unknown-unknown rustup target is installed.
#   3. Build the wasm crate (release) so apps/web can import the pkg/.
#   4. Run the web app build (npm ci + vite build inside apps/web).
#
# The script is intentionally idempotent — re-running it on a dev box that
# already has the toolchain is a no-op for the install steps.
# -----------------------------------------------------------------------------

set -euo pipefail

# Resolve the repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

WASM_CRATE_DIR="packages/rust/aetrain-routing-wasm"

log() { printf '[build-for-pages] %s\n' "$*"; }

# wasm-pack invokes `cargo build --message-format=json-render-diagnostics`
# and parses the JSON stream. Some dev environments install a `cargo`
# shim earlier on PATH (e.g. CTO wrappers that mangle stdout) which
# breaks the JSON contract and yields:
#
#   Error: Expected at least one compiler artifact in the output of `cargo build`
#
# If a real rustup-managed cargo is available, prepend its directory to
# PATH and point $CARGO at it directly so wasm-pack's subprocess hits
# the real binary, not any wrapper. On a stock CF Pages image both
# checks are no-ops — the only `cargo` on PATH is already the
# rustup-managed one.
if [ -x "${HOME}/.cargo/bin/cargo" ]; then
  export PATH="${HOME}/.cargo/bin:${PATH}"
  export CARGO="${CARGO:-${HOME}/.cargo/bin/cargo}"
elif command -v rustup >/dev/null 2>&1; then
  if real_cargo="$(rustup which cargo 2>/dev/null)"; then
    export PATH="$(dirname "${real_cargo}"):${PATH}"
    export CARGO="${CARGO:-${real_cargo}}"
  fi
fi

# ---- 1. wasm-pack -----------------------------------------------------------
if command -v wasm-pack >/dev/null 2>&1; then
  log "wasm-pack already installed: $(command -v wasm-pack)"
else
  log "wasm-pack not found on PATH — installing precompiled binary"
  # The official installer drops the binary under ~/.cargo/bin when CARGO_HOME
  # is unset, which matches both rustup's default and CF Pages' build image.
  curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

  # Make sure the freshly-installed binary is reachable for the rest of this
  # script. We don't permanently mutate PATH — the installer's location is the
  # same one rustup advertises, so subsequent shells pick it up naturally.
  if [ -x "${HOME}/.cargo/bin/wasm-pack" ]; then
    export PATH="${HOME}/.cargo/bin:${PATH}"
  fi

  if ! command -v wasm-pack >/dev/null 2>&1; then
    log "ERROR: wasm-pack install did not produce a usable binary"
    exit 1
  fi
  log "wasm-pack installed: $(command -v wasm-pack)"
fi

# ---- 2. wasm32 target -------------------------------------------------------
# rustup is a hard requirement here. Both CF Pages (with RUST_VERSION set) and
# developer machines using rust-toolchain.toml have it; if it's missing we
# fail loudly rather than silently producing a broken wasm crate.
if ! command -v rustup >/dev/null 2>&1; then
  log "ERROR: rustup not found on PATH. On Cloudflare Pages set the"
  log "       RUST_VERSION environment variable (e.g. 1.92.0) to install it."
  log "       Locally, see https://rustup.rs/."
  exit 1
fi

# `rustup target add` is idempotent — it prints "already installed" and exits 0
# when the target is present, so we can call it unconditionally.
log "ensuring wasm32-unknown-unknown rustup target is installed"
rustup target add wasm32-unknown-unknown >/dev/null

# ---- 3. wasm-pack build -----------------------------------------------------
log "building ${WASM_CRATE_DIR} (release, target=web)"
wasm-pack build "${WASM_CRATE_DIR}" --target web --release

# ---- 4. web app build -------------------------------------------------------
log "building apps/web"
cd apps/web
npm ci
npm run build

log "done."
