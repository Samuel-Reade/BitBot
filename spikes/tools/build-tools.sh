#!/usr/bin/env bash
# Builds the §12 spike diagnostics tools (arm64, ad-hoc signed) with the Command Line Tools only.
#
#   bash spikes/tools/build-tools.sh   ->  build/tools/probe
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT/build/tools"

fail() {
  echo "build-tools: error: $*" >&2
  exit 1
}

for tool in swiftc codesign xcrun; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' not found (install the Xcode Command Line Tools)"
done
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)" || fail "no macOS SDK found"

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d "$OUT_DIR/.build.XXXXXX")" || fail "cannot create a work directory in $OUT_DIR"
trap 'rm -rf "$WORK"' EXIT

swiftc -O -swift-version 5 -sdk "$SDK" -target arm64-apple-macos13.0 -module-name Probe \
  -o "$WORK/probe" "$ROOT/spikes/tools/probe.swift" || fail "swiftc failed"
codesign --sign - --force "$WORK/probe" || fail "codesign failed"
mv -f "$WORK/probe" "$OUT_DIR/probe"
echo "$OUT_DIR/probe"
