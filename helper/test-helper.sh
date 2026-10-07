#!/usr/bin/env bash
# Builds and runs bitbot-helper's Swift unit tests (helper/Tests) for the host architecture, using
# only the Command Line Tools. They compile helper/Sources/Helper.swift without main.swift, so no
# helper starts; they never create an input tap and never show a permission prompt.
#
#   bash helper/test-helper.sh
#
# The protocol contract of the built binary is covered by the Vitest suite (test/helperClient.test.ts).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCES=("$ROOT/helper/Sources/Helper.swift" "$ROOT/helper/Tests/HelperTests.swift")
OUT_DIR="$ROOT/build/helper-tests"

fail() {
  echo "test-helper: error: $*" >&2
  exit 1
}

for tool in swiftc xcrun; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' not found (install the Xcode Command Line Tools: xcode-select --install)"
done
for source in "${SOURCES[@]}"; do
  [ -f "$source" ] || fail "missing source $source"
done
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)" || fail "no macOS SDK found"

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d "$OUT_DIR/.build.XXXXXX")" || fail "cannot create a work directory in $OUT_DIR"
trap 'rm -rf "$WORK"' EXIT

echo "test-helper: compiling"
swiftc -O -swift-version 5 -parse-as-library -sdk "$SDK" \
  -target "$(uname -m)-apple-macos13.0" \
  -module-name BitbotHelperTests \
  -o "$WORK/helper-tests" \
  "${SOURCES[@]}" || fail "swiftc failed"
"$WORK/helper-tests"
