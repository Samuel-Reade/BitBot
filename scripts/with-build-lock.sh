#!/usr/bin/env bash
# Runs a command while holding a repo-wide lock, so concurrent agents sharing out/ never
# rebuild it underneath each other's Electron runs. Usage: bash scripts/with-build-lock.sh "<command>"
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/build/.build-lock"
mkdir -p "$ROOT/build"
for _ in $(seq 1 1200); do
  if mkdir "$LOCK" 2>/dev/null; then
    echo $$ > "$LOCK/pid"
    trap 'rm -rf "$LOCK"' EXIT
    cd "$ROOT" && bash -c "$1"
    exit $?
  fi
  # Break stale locks left by killed processes.
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  sleep 0.5
done
echo "with-build-lock: timed out waiting for $LOCK" >&2
exit 1
