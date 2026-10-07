# Spike A — overlay window approach (harness)

Throwaway harness for BITBOT_SPEC.md §12 Spike A / §5.2: measure and compare ways of drawing the pet
over the desktop, then record the decision in `docs/decisions/overlay.md`.

| Variant | Window | How the pet moves |
|---|---|---|
| **A1** | small (edge = bodyHeight × 2.5, 240 pt at M) | `setPosition` from a 60 Hz **main-process timer** (`--a1-timer=deadline` drift-free absolute deadlines, default; `interval` = naive `setInterval`, ≈ 58-59 Hz; the bench calls that run **A1i**) |
| **A2** | small | `setPosition` on every **renderer requestAnimationFrame** (renderer sends `spike:overlay:frame`, main moves the window) |
| **B** | display-sized, transparent | small canvas moved with `translate3d` + `will-change: transform` every rAF |
| **Bfull** | display-sized, transparent | display-sized canvas, pet placed with `camera.setViewOffset` (same perspective as A — verified pixel-identical, see Findings) |

All variants share the production pipeline (§5.1): a fixed-step 30 Hz simulation in main owns the
pet's ground-contact point; presentation interpolates between the two newest states one sim step
behind real time. Every variant renders on **every** rAF (no adaptive throttling), so the numbers are
worst-case costs, not the §11 steady state. Window settings are §5.2's (see `src/main/spike/overlay/window.ts`).

## Running the harness

Electron runs the built files in `out/`, so build first. Always strip `ELECTRON_RUN_AS_NODE`
(VS Code terminals export it; without `env -u` Electron silently runs as plain Node). When other
agents may be building, wrap build + run in the repo lock:

```sh
bash scripts/with-build-lock.sh "npm run build && env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . \
  --spike=overlay --variant=A2 --mode=walk --duration=15"
```

Flags: `--variant=A1|A2|B|Bfull` `--mode=static|walk|synthetic|follow|interactive`
`--duration=SECONDS` (from when the window appears; `0` = until Ctrl+C; default 15)
`--window-type=panel|none` (default `panel`) `--size=S|M|L` `--palette=<id>`
`--results=DIR` (default `<repo>/spike-results`) `--label=TEXT` `--a1-timer=deadline|interval`
`--capture=FILE.png` (dev check: our own page cropped to the pet viewport at exit; `capturePage`, no permission).

Modes:
- `static` — stands at the bottom centre of the work area (baseline: rendering at 60 fps, no movement).
- `walk` — walks the ground (work-area bottom = Dock top) at `tuning.move.walkSpeed` (120 pt/s), turning at the ends.
- `synthetic` — chases a deterministic Lissajous target (peak 750 pt/s) at ≤ 600 pt/s: fast 2-D motion that is
  identical run to run and never touches the mouse.
- `follow` — chases the real cursor at ≤ 600 pt/s, stopping with its head 24 pt below it.
- `interactive` — walks, and you can hover / click (pet) / drag / toss / right-click it (checklist below).

The first 2 s are warm-up and excluded from all statistics. At exit the harness reads Activity Monitor's
memory figure for its processes with `footprint` (~0.25 s, after the measurement window), prints a `RESULT`
line and writes `overlay-<variant>-<mode>-<label or timestamp>.json`. At startup it prints
`[spike:overlay] wid=<CGWindowID>`. Tunables are in `tuning.spikeOverlay` (`src/shared/tuning.ts`).

Ending a run: `--duration` ends it cleanly; so does **one** Ctrl+C (or `kill -TERM`). A terminal Ctrl+C reaches
Electron twice within a few ms (the whole process group gets SIGINT and electron's `cli.js` forwards it
again); the echo is ignored. A second Ctrl+C at least 1 s later (`signalRepeatGraceMs`) exits at once
**without** results — only for a hung run.

## The benchmark (lead runs this alone)

```sh
bash spikes/run-overlay-bench.sh                 # A1 A1i A2 B Bfull × static walk synthetic (A1i: moving modes), 20 s each
bash spikes/run-overlay-bench.sh -r 3            # whole matrix 3× interleaved; summary adds medians
bash spikes/run-overlay-bench.sh -r 3 -P         # same without the window-position probe (resource-only numbers)
bash spikes/run-overlay-bench.sh -d 30 -v "A1 A2" -m walk -- --window-type=none
```

`A1i` is a bench alias for A1 with `--a1-timer=interval` (results labelled `<label>-a1i`, shown as
"A1 (interval)"): the literal free-running-timer case. The default A1 deadline timer runs at 60.000 Hz, matched
to the display within ~40 ppm, so within one run it cannot show beating (see "lock R" below).

Per run (`spikes/analysis/bench-run.mjs`, each inside `scripts/with-build-lock.sh`): a 2 s idle pause that
doubles as a baseline (sampled at its start, every second and at its end), then the harness via
`env -u ELECTRON_RUN_AS_NODE`; on its `wid=` line it samples `ioreg` GPU "Device Utilization %" every 0.5 s,
WindowServer and probe CPU time (`ps -o pid=,time=`) and whole-machine CPU counters (`os.cpus()`) every 1 s,
and runs `build/tools/probe winpos --wid <wid> --hz 250 --seconds <D-3>` for **every** variant (B/Bfull: on
their static window), because the probe's own window-server queries cost WindowServer ~2-3 % of a core —
as much as the A-vs-B WindowServer gap. `-P` turns the probe off for all runs; a missing probe is skipped
with a note. A watchdog SIGTERMs at D+25 s (results are still flushed) and SIGKILLs the process group 8 s
later. Then `spikes/analysis/summarize.mjs` writes `spike-results/overlay-summary.md` + `.json` (copied into
`spike-results/<label>/`). Re-summarize any time:
`node spikes/analysis/summarize.mjs --dir spike-results/<label> --out /tmp/x`.

For numbers you can trust: AC power, Low Power Mode off, nothing else busy (quit heavy apps, no other agents
building or testing), don't touch the mouse (B/Bfull receive forwarded mouse moves from the whole screen),
and use `-r 3`. Every run records its conditions, and the summary flags runs on battery, in Low Power Mode, or
with "other load" > 0.5 cores — see Findings for why that matters so much here.

## Manual checklist (interactive mode)

Run each of A1, A2, B, Bfull (and the `--window-type=none` variants for items 4 and 7):

```sh
bash scripts/with-build-lock.sh "npm run build" && \
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --spike=overlay --variant=A2 --mode=interactive --duration=0
```

Live lines appear in the terminal; Ctrl+C once (or right-click > Quit spike harness) writes the results.

1. **Smoothness** — watch it walk; also run `--mode=synthetic` and `--mode=follow` (move the mouse fast). Any
   periodic hitch or uneven speed? Compare variants one after another, same mode.
2. **Click-through outside the pet** — click, scroll and drag in the app underneath, right next to the pet
   (inside its 240 pt square for A1/A2; anywhere on screen for B/Bfull). Everything must reach that app.
3. **Hover / click / drag / toss on the pet** — `hover on -> mouse events ON` appears when over the silhouette
   (and `off` when leaving); a click logs `click on pet (pet!)`; dragging keeps the grab point under the cursor
   without lag; releasing while moving tosses it (falls, small bounce, lands, walks on).
4. **Focus is never stolen** — before each click/drag/right-click, click into TextEdit (or any editor) so it
   is frontmost with a caret. Then interact with the pet and immediately type: the text must land in TextEdit.
   Each interaction prints `… -> Bitbot became the active app: NO (PASS)`; any `focus: did-become-active`
   line is a FAIL. Do this with the default `panel` window **and** with `--window-type=none` (see Findings:
   AppKit logs that it ignores the non-activating style on Electron's panel).
5. **Right-click menu** — a native menu (Pet / Stay here / Hide (2 s) / Quit) at the cursor. Note whether your
   app loses focus while it is open and whether it gets it back afterwards (verdict line).
6. **Window level** — the pet stays above normal windows (drag a Finder window under it) but under the Dock,
   menu bar, Spotlight (⌘Space) and Notification Center. `build/tools/probe levels` lists layers front to back.
7. **Fullscreen** — put another app in fullscreen and go to its Space. Expected from the Electron sources:
   with `panel` the pet still shows over it (Electron forces FullScreenAuxiliary on panels); with
   `--window-type=none` it must not. Record both. (Production hides via the helper's fullscreen event, §8.6.)
8. **Spaces / Mission Control** — the pet is on every desktop (Ctrl+←/→) and is not listed as a window in
   Mission Control.

## Reading the output

Per-run JSON (`schema: bitbot.spike.overlay/1`): `options`, `env` (versions, power source, thermal state,
load average), `display`, `window` (wid, bounds, state, anchor, pet box, GL renderer), `measure`
(warm-up/measured seconds, end reason), `sim` (steps; `wakeIntervalMs` between wakes that computed a step;
`wakeLatenessMs` = how late those wakes were against their target, the step's nominal time − `simLeadMs`:
above `simLeadMs` the step was computed after its nominal time; `stepsPerWake`, where `"0"` = an early wake
that only re-armed the timer; dropped steps), `presentation` (A1/A2: tick intervals + raw, setPosition
calls/durations, starved ticks, A2 frame-message latency, position mismatches), `renderer` (rAF intervals +
raw, render/callback ms, starved frames, mouse moves, hit tests), `cpu` (per process type: mean from
cumulative CPU time, p95/max from 1 s samples, idle wakeups/s, RSS), `memory` (`footprint`: Activity Monitor's
"Memory" = phys_footprint per process type and total, with peaks and footprint's de-duplicated total, read
once at the end; `rssMeanMB`), `metricsSamples` (raw), `interaction` (hover/click-through toggles,
safety-net firings with `cursorMoved`/`raced` and `safetyNetMissedLeaves`, pets, drags, menus, focus events,
per-interaction verdicts), `capture`, `errors`, `warnings`, `summary`.

`overlay-summary.md` explains each column in its header. In short:
- **CPU %** = percent of one core (Activity Monitor style; §11 budget < 3 % roaming). Browser = main,
  Tab = renderer, GPU = GPU process. **WindowServer %** and **GPU %** are system-wide (they include the cost of
  compositing our window, and the probe's queries when `probe` = ok), **other load** flags contaminated runs.
- **mem MB** = Activity Monitor's "Memory" (phys_footprint) summed over Bitbot's processes — the §11 budget
  unit (< 300 MB). **RSS MB** (summed workingSetSize) double-counts shared pages and misses GPU memory: don't
  compare it with the budget.
- **Frame pacing**: rAF interval stats and % long (> 20 ms: dropped frames); for A1/A2 the presentation
  (window move) interval spread and its phase consistency `R` against the display period. R ≈ 0 = the timer
  beats against the display within the run (A1i); R ≈ 1 only says the rate matches — A1's deadline timer
  has R ≈ 1 by construction while sitting at a random, fixed point of the frame for the whole run.
- **Window motion** (A1/A2, from the probe): interval between real position changes (mean ± sd, CV), longest
  gap, and the judder indicator — % of display frames with 0 or ≥ 2 position changes while moving, at the best
  vsync alignment, averaged over all alignments, and at the worst one (the vsync phase is unknown to the
  probe). For A1 (deadline) best/worst bracket what different runs look like; compare A1 and A2 on "avg".
- **Safety net**: a firing means mouse events were on while the cursor was outside the pet box. `raced` = the
  renderer's leave arrived anyway (just later); `cursorMoved: false` = the pet moved away from a still cursor
  (no mouse event can exist); `safetyNetMissedLeaves` = moving cursor and no leave at all, i.e. forwarding
  really missed it. The cursor history starts at hover-on (and again after a drag or the menu), so a cursor
  flicked off the pet within one sim step still counts as moved.

## Findings so far (agent validation runs, not the benchmark)

- **`type: 'panel'`** (Electron 44 sources: `electron_ns_panel.mm`, `native_window_mac.mm`): Electron makes an
  `ElectronNSPanel` — an NSWindow subclass whose `styleMask` getter ORs in `NSWindowStyleMaskNonactivatingPanel`,
  level `NSFloatingWindowLevel`, and whose `setCollectionBehavior:` ORs in `CanJoinAllSpaces |
  FullScreenAuxiliary` on every call. So `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: false})` cannot
  hide a panel over fullscreen apps, in any call order. On macOS 15.6 AppKit logs
  `NSWindow does not support nonactivating panel styleMask 0x80` 4× per panel window (never with
  `--window-type=none`), so whether clicks really stay non-activating must be checked by hand (checklist item 4).
- **Without `panel`**: `fullscreenable: false` makes the constructor *add* FullScreenAuxiliary; the later
  `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: false, skipTransformProcessType: true})` removes it, so
  call it after construction and never call `setFullScreenable` afterwards. `skipTransformProcessType: true` is
  required: otherwise `visibleOnFullScreen: false` calls `DockShow()` and the agent app gets a Dock icon.
  `hiddenInMissionControl` sets `NSWindowCollectionBehaviorTransient`.
- **Level**: `probe levels` puts our window (layer 3) directly below the Dock (20), menu bar (24) and status
  items (25) and above normal windows (0).
- **`app.getAppMetrics()` `percentCPUUsage` is divided by the core count** (a process at 14.6 % of a core
  reports 1.46 on the 10-core M4); `cumulativeCPUUsage` is plain CPU seconds. The harness uses the latter.
- **Node `setInterval(1000/60)` in Electron's main process runs at ~58 Hz** (17 ms; 174 ticks in 3 s), i.e. it
  beats against the 60 Hz display; the drift-free deadline timer averages exactly 60 Hz but its ticks jitter
  by several ms.
- **Bfull draws exactly what A draws**: `--capture` of A1, B and Bfull in static mode gives 56 244 opaque device
  pixels with the same bounding box in all three; A1 and B are byte-identical PNGs.
- **Sim timer lateness** in Electron main is several ms; rendering exactly one step behind real time starved
  presentation in 4-8 % of frames. Steps are therefore computed up to `simLeadMs` (8 ms) before their nominal
  time (render time is unchanged); starved frames went to 0 in the re-runs. Measured lateness against the
  (early) target in the fix-round smoke runs: p95 3.3-15 ms (A2 highest: main also handles 60 frame msgs/s).
- **Memory (corrected)**: Activity Monitor's figure (phys_footprint via `footprint`) is ~190-196 MB for A1, A2
  and B (GPU process ~100 MB, renderer ~48 MB, main ~35 MB, network utility ~6.5 MB) — inside the §11 300 MB
  budget. **Bfull is ~605-633 MB** (peak 655-695): its GPU process holds ~520-550 MB. B has the same
  display-sized window with a 240 pt canvas and its GPU process stays at ~100 MB, so the ~420-450 MB delta is
  the display-sized (3420×2214 px) WebGL canvas with its buffers and compositor surfaces — 2× over budget.
  Summed RSS is ~355 MB for every variant: it overstates A/B and completely hides Bfull's cost (an earlier
  "already at the 300 MB budget" note here was based on RSS and was wrong). 5 s smoke runs on battery; confirm
  with the bench.
- **The window-position probe is not free**: `probe winpos` at 250 Hz uses ~4 % of a core itself and costs
  WindowServer ~2-3 % (reviewer measurement on the static Dock window), so the bench now probes every variant.
- **CPU numbers swing several-fold with machine state**: the same 5-6 s A2 walk run measured 29.9 % and 7.9 %
  of a core, minutes apart, while another process was pegging a core and the Mac was on battery (macOS moves
  threads between performance and efficiency cores). Hence the conditions columns and `-r`.

## Files

- `src/main/spike/overlaySpike.ts` (entry), `src/main/spike/overlay/*` (harness, sim, fixed-step clock,
  window, interaction, focus monitor, CPU metrics, `footprint` memory, Ctrl+C gate, results), `src/renderer/spike/petSpike.ts` +
  `src/renderer/spike/overlay/*` (renderer half), `src/shared/spikeOverlay.ts` (channels, payloads,
  interpolation), `tuning.spikeOverlay`.
- `spikes/run-overlay-bench.sh`, `spikes/analysis/bench-run.mjs`, `spikes/analysis/summarize.mjs`,
  `spikes/analysis/lib/*.mjs` (stats, judder analysis, system samplers + A1i alias, report) with `.d.mts`
  types for the tests.
- `test/spikeOverlay.test.ts` — unit tests for the pure parts (clock, sim, interpolation, stats, metrics
  aggregation, options, judder analysis, parsers, Ctrl+C gate, footprint parsing), InteractionController
  (hover/click-through, safety-net classification, drag/toss/pet click; Electron's Menu mocked) and the
  per-run summary (`summarizeRun`: warm-up filtering, probe offset, other load, flags).

Privacy: no network code; the harness reads only the cursor position, our own window and (via `footprint`)
our own processes' memory totals; the bench reads GPU utilization counters, CPU-time counters and our window's
bounds — never titles, keys, URLs or screen contents.
