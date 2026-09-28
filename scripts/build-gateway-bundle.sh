#!/usr/bin/env bash
# Builds the pinned R0Wi/mcp-gateway source bundle (Python package + prebuilt
# Svelte login/consent UI) so the VPS needs no Node.js. Run on a dev machine.
#
#   scripts/build-gateway-bundle.sh <out-dir>
# Produces <out-dir>/mcp-gateway-<commit>.tar.gz
set -euo pipefail

GATEWAY_REPO=https://github.com/R0Wi/mcp-gateway.git
GATEWAY_COMMIT=59c1efd00e0c1baea4ed7861429200d2d6be0e83   # keep in sync with components.lock

out=${1:?usage: build-gateway-bundle.sh <out-dir>}
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q src
git -C "$work/src" config core.autocrlf false   # LF tree, so LF patches apply on Windows too
git -C "$work/src" fetch -q --depth 1 "$GATEWAY_REPO" "$GATEWAY_COMMIT"
git -C "$work/src" checkout -q FETCH_HEAD
test "$(git -C "$work/src" rev-parse HEAD)" = "$GATEWAY_COMMIT"

# MCPRelay patches on top of the pinned commit (documented in components.lock).
repo=$(cd "$(dirname "$0")/.." && pwd)
for p in "$repo"/patches/mcp-gateway/*.patch; do
  [ -e "$p" ] || continue
  git -C "$work/src" apply --whitespace=nowarn "$p"
  echo "applied $(basename "$p")"
done

(cd "$work/src/ui" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)
test -f "$work/src/src/mcp_gateway/static/ui/index.html"

bundle="$out/mcp-gateway-${GATEWAY_COMMIT:0:12}.tar.gz"
# Pack inside $work first: GNU tar treats "C:/..." archive names as remote hosts.
tar -C "$work/src" -czf "$work/bundle.tar.gz" pyproject.toml README.md src
mv "$work/bundle.tar.gz" "$bundle"
sha256sum "$bundle"
