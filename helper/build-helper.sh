#!/usr/bin/env bash
# Builds bitbot-helper (BITBOT_SPEC.md §5.3) as a universal arm64 + x86_64 binary, ad-hoc signed,
# using only the Command Line Tools (swiftc, lipo, codesign; no Xcode project, no SwiftPM).
#
#   bash helper/build-helper.sh        ->  build/helper/bitbot-helper
#
# Sources: helper/Sources/*.swift (main.swift = startup, Helper.swift = everything else).
# Unit tests: bash helper/test-helper.sh.
#
# The finished binary replaces the old one with a rename, so a helper that is currently running
# keeps executing its original (unmodified) file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCES=("$ROOT/helper/Sources/main.swift" "$ROOT/helper/Sources/Helper.swift")
OUT_DIR="$ROOT/build/helper"
OUT="$OUT_DIR/bitbot-helper"
MIN_MACOS="13.0"
ARCHS=(arm64 x86_64)

fail() {
  echo "build-helper: error: $*" >&2
  exit 1
}

for tool in swiftc lipo codesign xcrun; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' not found (install the Xcode Command Line Tools: xcode-select --install)"
done
for source in "${SOURCES[@]}"; do
  [ -f "$source" ] || fail "missing source $source"
done

SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)" || fail "no macOS SDK found (xcrun --sdk macosx --show-sdk-path)"

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d "$OUT_DIR/.build.XXXXXX")" || fail "cannot create a work directory in $OUT_DIR"
trap 'rm -rf "$WORK"' EXIT

slices=()
for arch in "${ARCHS[@]}"; do
  echo "build-helper: compiling $arch (macOS $MIN_MACOS+)"
  swiftc -O -swift-version 5 -sdk "$SDK" \
    -target "$arch-apple-macos$MIN_MACOS" \
    -module-name BitbotHelper \
    -o "$WORK/bitbot-helper-$arch" \
    "${SOURCES[@]}" || fail "swiftc failed for $arch"
  slices+=("$WORK/bitbot-helper-$arch")
done

lipo -create -output "$WORK/bitbot-helper" "${slices[@]}" || fail "lipo failed"
# Ad-hoc signature with a stable identifier (the default appends a per-build hash). Packaging
# re-signs the binary with the app's identity.
codesign --sign - --force --identifier bitbot-helper "$WORK/bitbot-helper" || fail "codesign failed"
codesign --verify --strict "$WORK/bitbot-helper" || fail "signature does not verify"

archs="$(lipo -archs "$WORK/bitbot-helper")"
for arch in "${ARCHS[@]}"; do
  [[ " $archs " == *" $arch "* ]] || fail "universal binary is missing $arch (has: $archs)"
done

mv -f "$WORK/bitbot-helper" "$OUT"
echo "build-helper: built $OUT ($archs)"
echo "$OUT"
