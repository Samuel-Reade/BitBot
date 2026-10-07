#!/usr/bin/env bash
# Spike A overlay benchmark (BITBOT_SPEC.md §12). See spikes/README-overlay.md.
#
#   bash spikes/run-overlay-bench.sh [-d SECONDS] [-v "A1 A1i A2 B Bfull"] [-m "static walk synthetic"]
#                                    [-r REPEATS] [-l LABEL] [-p SECONDS] [-n] [-P] [-- extra harness flags]
#     -d  seconds per run, counted from when the window appears (default 20; first 2 s = warm-up)
#     -v  variants (default "A1 A1i A2 B Bfull"; A1i = A1 with the naive setInterval timer, moving modes only)
#     -m  modes (default "static walk synthetic")
#     -r  repeat the whole matrix N times, interleaved (default 1); the summary adds medians
#     -l  label (default bench-<timestamp>)        -p  idle pause / baseline before each run (default 2)
#     -n  skip the build                           -P  no window-position probe (resource-only runs)
#     after --: passed to every harness run, e.g. -- --window-type=none
#
# Every run is one call of spikes/analysis/bench-run.mjs inside scripts/with-build-lock.sh, so no
# other agent rebuilds out/ underneath it. Run it alone (nothing else busy on the Mac) for clean numbers.
# Output: spike-results/<label>/ (per-run JSON + .log/.gpu/.ws/.probe side files) and
#         spike-results/overlay-summary.{md,json} (also copied into spike-results/<label>/).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DURATION=20
# SPEC-DEVIATION: §12's matrix is A1 A2 B Bfull. A1i (A1 driven by a naive setInterval, ~58.8 Hz in
# Electron's main process) is added because the default A1 deadline timer is frequency-matched to the
# display and so cannot show beating within one run; A1i is the literal "free-running timer" case.
VARIANTS="A1 A1i A2 B Bfull"
MODES="static walk synthetic"
LABEL=""
PAUSE=2
BUILD=1
PROBE_FLAG=""
REPEATS=1

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }
while getopts "d:v:m:r:l:p:nPh" opt; do
  case "$opt" in
    d) DURATION="$OPTARG" ;;
    r) REPEATS="$OPTARG" ;;
    v) VARIANTS="$OPTARG" ;;
    m) MODES="$OPTARG" ;;
    l) LABEL="$OPTARG" ;;
    p) PAUSE="$OPTARG" ;;
    n) BUILD=0 ;;
    P) PROBE_FLAG="--no-probe" ;;
    h) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
done
shift $((OPTIND - 1))
EXTRA="$*"

case "$DURATION" in ''|*[!0-9.]*) echo "-d must be a number of seconds" >&2; exit 64 ;; esac
case "$REPEATS" in ''|*[!0-9]*|0) echo "-r must be a positive integer" >&2; exit 64 ;; esac
[ -n "$LABEL" ] || LABEL="bench-$(date +%Y%m%d-%H%M%S)"
case "$LABEL" in *[!A-Za-z0-9._-]*) echo "-l may only use letters, digits, '.', '_' and '-'" >&2; exit 64 ;; esac
DIR="$ROOT/spike-results/$LABEL"
LOCK="$ROOT/scripts/with-build-lock.sh"
mkdir -p "$DIR"

if [ "$BUILD" = 1 ]; then
  echo "== build"
  bash "$LOCK" "npm run build >/dev/null" || { echo "build failed" >&2; exit 1; }
fi

runs=0
failed=0
rep=1
while [ "$rep" -le "$REPEATS" ]; do
  run_label="$LABEL"
  [ "$REPEATS" -gt 1 ] && run_label="$LABEL-r$rep"
  for v in $VARIANTS; do
    for m in $MODES; do
      # A1i differs from A1 only while the window moves.
      if [ "$v" = A1i ] && [ "$m" = static ]; then continue; fi
      runs=$((runs + 1))
      echo "== $v $m (${DURATION}s, label $run_label)"
      if ! bash "$LOCK" "node spikes/analysis/bench-run.mjs --variant=$v --mode=$m --duration=$DURATION --pause=$PAUSE --label=$run_label --dir='$DIR' $PROBE_FLAG -- $EXTRA"; then
        failed=$((failed + 1))
      fi
    done
  done
  rep=$((rep + 1))
done

echo "== summary"
node "$ROOT/spikes/analysis/summarize.mjs" --dir "$DIR" --out "$ROOT/spike-results/overlay-summary" || failed=$((failed + 1))
cp "$ROOT/spike-results/overlay-summary.md" "$ROOT/spike-results/overlay-summary.json" "$DIR/" 2>/dev/null || true
echo "runs: $runs, failed: $failed — results in $DIR"
[ "$failed" = 0 ]
