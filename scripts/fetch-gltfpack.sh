#!/usr/bin/env bash
# Fetches the gltfpack WASM CLI (M2 "Processing pipeline": optimize_glb step
# meshopt compression) via npm into backend/.tools, gitignored and out of the
# uv-managed Python dependency tree entirely. Local dev/CI only -- the Docker
# image source-builds gltfpack onto PATH instead (prebuilt Linux zips are
# glibc-version-pinned and don't match the bookworm base image).
#
# Usage: scripts/fetch-gltfpack.sh
set -euo pipefail

npm install --prefix "$(dirname "$0")/../backend/.tools" --no-save gltfpack@1.2.0

"$(dirname "$0")/../backend/.tools/node_modules/.bin/gltfpack" -v
