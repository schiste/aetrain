#!/bin/sh
set -eu

cargo run -p aetrain-pipeline -- run --manifest data/manifests/stage1.sources.toml "$@"
