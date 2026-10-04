#!/usr/bin/env bash
# Regenerate test/fixtures/nm/vectors.json with Night Market's own code (AA 00059 P0).
#   APP_VOLUME=<Night Market app volume: tree + node_modules + light compile> harness/nm/export-vectors.sh
# (vendor/night-market/build.sh documents how such a volume is prepared.) Public test data only.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${APP_VOLUME:?APP_VOLUME must name a prepared Night Market app volume}"
docker run --rm -v "$APP_VOLUME:/app:ro" -v "$HERE:/probe:ro" -w /app "${BUN_IMAGE:-oven/bun:1.3.11}" \
  bun /probe/export-vectors.ts >"$HERE/../../test/fixtures/nm/vectors.json"
echo "wrote test/fixtures/nm/vectors.json"
