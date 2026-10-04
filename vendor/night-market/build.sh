#!/usr/bin/env bash
# Rebuild the vendored Night Market bundle in Docker (AA 00059, plan D1 / I-V).
#
#   NM_DIR=<solana-night-market checkout> vendor/night-market/build.sh           rebuild into this dir
#   NM_DIR=<solana-night-market checkout> vendor/night-market/build.sh --check   rebuild, compare SHA-256
#
# NM_DIR must be a clean checkout of acedward/solana-night-market whose tree is the pinned one
# (PROVENANCE.md), with the vendor/passport submodule at the pinned commit. The checkout is only read:
# its files are copied into a throwaway Docker volume (Night Market's own scripts/docker-check.sh
# excludes), where `bun install --frozen-lockfile` and `bun run contracts` (the light compile with the
# pinned compactc 0.35.0 / 0.34.0 archives, SHA-256 verified by Night Market's fetch-compactc.sh) run,
# then `bun build` writes the bundle. Needs Docker with the local image oven/bun:1.3.11 (never pulled)
# and network access from containers (npm registry, GitHub release archives, Debian apt for unzip).
#
# APP_VOLUME=<volume> reuses an already prepared volume (tree + node_modules + light compile) instead.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${NM_DIR:?NM_DIR must name a solana-night-market checkout}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
MODE="${1:-build}"

PIN_TREE=64b482f695bb2362f5a38f49df9eff6f86efcf0a          # Night Market PR #1 head 10b29b1 (= 35557f9)
PIN_PASSPORT=599327b918b55afc95d6c98a89bcd15f4e8b0d53       # vendor/passport submodule (Passport PR #6)
PIN_ACCOUNT_JS=a51ecae28870ee30129b1d6121c42230cca34af819f0b7a5bd1f3948b883ce86  # the light compile's account module

tree="$(git -C "$NM_DIR" rev-parse 'HEAD^{tree}')"
[[ "$tree" == "$PIN_TREE" ]] || { echo "build: $NM_DIR tree is $tree, not the pinned $PIN_TREE" >&2; exit 65; }
sub="$(git -C "$NM_DIR/vendor/passport" rev-parse HEAD)"
[[ "$sub" == "$PIN_PASSPORT" ]] || { echo "build: vendor/passport is $sub, not the pinned $PIN_PASSPORT" >&2; exit 65; }
[[ -z "$(git -C "$NM_DIR" status --porcelain)" ]] || { echo "build: $NM_DIR is not clean" >&2; exit 65; }
docker image inspect "$BUN_IMAGE" >/dev/null || { echo "build: $BUN_IMAGE is not present locally (never pulled)" >&2; exit 65; }

OUT="$(mktemp -d "${TMPDIR:-/tmp}/s00059-vendor.XXXXXX")"
VOL="${APP_VOLUME:-}"
OWN_VOL=""
cleanup() {
  rm -rf "$OUT"
  [[ -n "$OWN_VOL" ]] && docker volume rm -f "$OWN_VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ -z "$VOL" ]]; then
  OWN_VOL="s00059-vendor-$$-$RANDOM"
  VOL="$OWN_VOL"
  docker volume create "$VOL" >/dev/null
  echo "build: preparing $VOL from $NM_DIR" >&2
  docker run --rm -v "$NM_DIR:/src:ro" -v "$VOL:/app" "$BUN_IMAGE" bash -c \
    'cd /src && tar cf - --exclude=./node_modules --exclude=.git --exclude=./.tools --exclude=dist --exclude=test-results --exclude=playwright-report --exclude=./vendor/passport/contract/contracts/managed --exclude=./vendor/passport/contract/contracts/erc20-vault/managed --exclude=./vendor/passport/contract/contracts/erc20-vault/node_modules . | (cd /app && tar xf -)'
  # The copy must be byte-identical to the checkout (a bind mount can serve a stale file).
  list="$OUT/host.sha"
  (cd "$NM_DIR" && git ls-files -z | grep -zv '^vendor/passport$' | xargs -0 shasum -a 256
   cd vendor/passport && git ls-files -z | xargs -0 shasum -a 256 | sed 's#  #  vendor/passport/#') >"$list"
  docker run --rm -v "$list:/tmp/host.sha:ro" -v "$VOL:/app" -w /app "$BUN_IMAGE" sha256sum --quiet -c /tmp/host.sha
  docker run --rm -v "$VOL:/app" -w /app "$BUN_IMAGE" bun install --frozen-lockfile >&2
  docker run --rm -v "$VOL:/app" -w /app "$BUN_IMAGE" bash -c \
    'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends unzip curl ca-certificates >/dev/null && bun run contracts' >&2
fi

got_js="$(docker run --rm -v "$VOL:/app:ro" "$BUN_IMAGE" sha256sum /app/vendor/passport/contract/contracts/managed/account/contract/index.js | cut -d' ' -f1)"
[[ "$got_js" == "$PIN_ACCOUNT_JS" ]] || { echo "build: the account module is $got_js, not the pinned light compile $PIN_ACCOUNT_JS" >&2; exit 65; }

docker run --rm -v "$VOL:/app:ro" -v "$HERE:/probe:ro" -v "$OUT:/out" -w /app "$BUN_IMAGE" \
  bun build /probe/entry.ts --target=node --format=esm \
  --external @midnight-ntwrk/compact-runtime-0.20 --external @midnightntwrk/ledger-v9 \
  --outfile /out/night-market-core.mjs >&2

new="$(shasum -a 256 "$OUT/night-market-core.mjs" | cut -d' ' -f1)"
if [[ "$MODE" == "--check" ]]; then
  old="$(shasum -a 256 "$HERE/night-market-core.mjs" | cut -d' ' -f1)"
  if [[ "$new" == "$old" ]]; then
    echo "vendor:check: PASS ($new)"
  else
    echo "vendor:check: FAIL (rebuilt $new, committed $old)" >&2
    exit 1
  fi
else
  cp "$OUT/night-market-core.mjs" "$HERE/night-market-core.mjs"
  echo "build: wrote $HERE/night-market-core.mjs ($new)"
fi
