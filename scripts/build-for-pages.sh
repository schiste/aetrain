#!/usr/bin/env bash
# build-for-pages.sh
# -----------------------------------------------------------------------------
# Orchestration entry point for `npm run build` from the repo root. Designed
# to be safe both on developer machines (macOS, wasm-pack already installed)
# and inside the Cloudflare Pages build container (Ubuntu, fresh checkout,
# only rustup + node available once RUST_VERSION is set in the dashboard).
#
# Steps:
#   1. Build the routing wasm crate via scripts/build-wasm.sh (toolchain
#      bootstrap + wasm-pack build — shared verbatim with CI).
#   2. Run the web app build (npm ci + vite build inside apps/web).
#
# The wasm toolchain logic lives in scripts/build-wasm.sh so production and CI
# build the crate identically; this script only adds the web build on top.
# -----------------------------------------------------------------------------

set -euo pipefail

# Resolve the repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

log() { printf '[build-for-pages] %s\n' "$*"; }

# ---- 1. routing wasm --------------------------------------------------------
# Delegate the entire wasm toolchain (rustup target, wasm-pack install, release
# build) to the shared script so the prod container and CI runners stay in sync.
log "building routing wasm via scripts/build-wasm.sh"
bash "${SCRIPT_DIR}/build-wasm.sh"

# ---- 2. web app build -------------------------------------------------------
log "building apps/web"
cd apps/web
npm ci
npm run build

log "done."
