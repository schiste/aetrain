#!/bin/sh
set -eu

cargo run -p aetrain-pipeline -- run \
  --manifest data/manifests/stage1.sources.toml \
  --overrides data/overrides/city-overrides.toml \
  --sync-web-debug apps/web/public/data/production \
  "$@"
