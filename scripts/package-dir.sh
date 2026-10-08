#!/usr/bin/env bash
# Builds the unpacked macOS app (dist/mac-<arch>/Bitbot.app) for testing with Input Monitoring (§7.1; README
# "Permissions in dev"). Signing (decided 2026-10-08, docs/decisions/input-and-helper.md §6.5):
#   - with a code-signing certificate named "Bitbot Dev" in your keychain: signed with it and the hardened runtime
#     (entitlements: build-resources/entitlements.mac.plist), so an Input Monitoring grant survives rebuilds;
#   - without it: ad-hoc (electron-builder.yml), and macOS forgets the grant whenever the app changes.
# No network: see electron-builder.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
IDENTITY="Bitbot Dev"

npm run build:helper
npx electron-vite build

export NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
  echo "package-dir: signing with \"$IDENTITY\" (hardened runtime)"
  npx electron-builder --mac --dir \
    -c.mac.identity="$IDENTITY" \
    -c.mac.hardenedRuntime=true \
    -c.mac.entitlements=build-resources/entitlements.mac.plist \
    -c.mac.entitlementsInherit=build-resources/entitlements.mac.plist
else
  echo "package-dir: no \"$IDENTITY\" certificate found: ad-hoc signature (Input Monitoring grants won't survive rebuilds)"
  npx electron-builder --mac --dir
fi
