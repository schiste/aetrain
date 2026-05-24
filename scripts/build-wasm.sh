#!/usr/bin/env bash
# build-wasm.sh
# -----------------------------------------------------------------------------
# Single source of truth for building the routing wasm crate. The crate's
# generated `pkg/` is gitignored, so every clean checkout (Cloudflare Pages
# production container AND CI runners) must regenerate it before apps/web can
# `vite build` — otherwise vite fails to resolve the wasm glue module.
#
# This script is invoked by:
#   - scripts/build-for-pages.sh  (production Cloudflare Pages build)
#   - .github/workflows/ci.yml    (web-static job, before the web build)
#   - .github/workflows/visual-regression.yml (before the web build)
#
# Steps:
#   1. Ensure wasm-pack is on PATH (install precompiled binary if missing).
#   2. Ensure the wasm32-unknown-unknown rustup target is installed.
#   3. Build the wasm crate (release) so apps/web can import the pkg/.
#
# Intentionally idempotent — re-running on a box that already has the toolchain
# is a no-op for the install steps, so it is safe to call from any entry point.
# -----------------------------------------------------------------------------

set -euo pipefail

# Resolve the repo root regardless of where the script is invoked from. CI runs
# this with an arbitrary working directory, so never rely on cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

WASM_CRATE_DIR="packages/rust/aetrain-routing-wasm"

log() { printf '[build-wasm] %s\n' "$*"; }

# ---- 0. diagnostics ---------------------------------------------------------
# Dump Rust-related env vars + rustup presence so failures of the CF Pages
# auto-install (triggered by setting RUST_VERSION as a build-time env var) are
# observable from the build log. Cheap to keep; fits the project's
# diagnostics-first convention.
log "RUST_VERSION=${RUST_VERSION:-<unset>}"
log "rustup on PATH: $(command -v rustup 2>/dev/null || echo '<missing>')"
log "cargo on PATH:  $(command -v cargo 2>/dev/null || echo '<missing>')"

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

# ---- 1. rustup --------------------------------------------------------------
# rustup is required for both the wasm32 target install and wasm-pack's own
# installer. CF Pages can auto-install it when RUST_VERSION is set as a
# build-time env var, but that hand-off has proven unreliable for this
# project, so we bootstrap rustup ourselves if it isn't on PATH. GitHub-hosted
# runners and dev boxes already have rustup, so this branch is a no-op there.
if ! command -v rustup >/dev/null 2>&1; then
  log "rustup not found — installing toolchain via rustup.rs (--profile minimal)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path
  export PATH="${HOME}/.cargo/bin:${PATH}"
  log "rustup installed: $(command -v rustup)"
fi

# `rustup target add` is idempotent — it prints "already installed" and exits 0
# when the target is present, so we can call it unconditionally.
log "ensuring wasm32-unknown-unknown rustup target is installed"
rustup target add wasm32-unknown-unknown >/dev/null

# ---- 2. wasm-pack -----------------------------------------------------------
# Must run after rustup is on PATH: the precompiled wasm-pack installer
# (wasm-pack-init) refuses to run without a detectable Rust installation.
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

# ---- 3. wasm-pack build -----------------------------------------------------
log "building ${WASM_CRATE_DIR} (release, target=web)"
wasm-pack build "${WASM_CRATE_DIR}" --target web --release

log "done."
