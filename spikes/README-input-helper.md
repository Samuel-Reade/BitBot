# Spike B — input capture and bitbot-helper (harnesses)

Throwaway harnesses for BITBOT_SPEC.md §12 Spike B:

1. Does the Swift helper return correct window bounds and z-order on a Retina display, lining up with
   Electron's `screen` API? Do app-launch notifications arrive? → `--spike=windows` (automated, no permissions)
2. Does global input capture work in a **packaged** app, and which app does macOS attribute the
   permission to in dev vs packaged builds? Helper tap (Input Monitoring) vs `uiohook-napi`
   (Accessibility) → `--spike=input` (**manual only: it can show permission prompts**)

| What | Where |
|---|---|
| windows harness | `src/main/spike/windowsSpike.ts`, `src/main/spike/windows/*` (pure: `eligibility.ts`, `checks.ts`, `measure.ts`, `options.ts`, `format.ts`) |
| input harness | `src/main/spike/inputSpike.ts`, `src/main/spike/input/*` (pure: `counters.ts`, `options.ts`) |
| debug overlay + probe page | `src/renderer/spike/debug.ts` (`?role=overlay` / `?role=probe`), IPC in `src/shared/spikeWindows.ts` |
| tunables | `tuning.spikeWindows`, `tuning.spikeInput` (and `tuning.world` for §8.2 / snapshot rates) |
| packaging | `electron-builder.yml` (`npm run package:dir`) |
| tests | `test/spikeB-eligibility.test.ts`, `test/spikeB-checks.test.ts`, `test/spikeB-input.test.ts` |

Both harnesses drive the real `bitbot-helper` through `HelperClient` (`src/main/helper/`); they never
speak the protocol themselves.

## Building and running (dev)

Electron loads the built files in `out/`, and the helper binary must exist. In a VS Code terminal
`ELECTRON_RUN_AS_NODE=1` is set: always strip it, or Electron silently runs as plain Node. When other
agents may be building, use the repo lock:

```sh
bash helper/build-helper.sh            # once, and after helper/Sources changes (a stale binary = protocolError versionMismatch)
bash scripts/with-build-lock.sh "npm run build && env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . \
  --spike=windows --duration=25 --auto-app-test --capture=build/snapshots/debug-overlay.png"
```

Every run ends by itself after `--duration` (`0` = until Ctrl+C). One Ctrl+C (or `kill -TERM`) finishes
cleanly and still writes results; electron's `cli.js` echoes the signal, so a repeat within 1 s is
ignored, and a later second one exits at once without results.

## `--spike=windows` (automated, no permissions, no prompts)

Flags: `--duration=S` (default 30, `0` = until quit) · `--auto-app-test` · `--overlay=true|false`
(default true) · `--window-type=panel|none` (overlay window class, default `panel`) ·
`--capture=FILE.png` · `--results=DIR` · `--label=TEXT` · `--cpu-phase-s=S` (length of each helper-CPU
phase; the run is extended to fit both, e.g. `--duration=10 --cpu-phase-s=25` runs ~55 s).

What it does, in order:

1. Looks up the Window Server's pid (`pgrep -x WindowServer`): §8.2 excludes its windows, and the helper
   reports them without a bundle id, so the eligibility rule excludes them by pid (if the lookup fails a
   `WARN Window Server pid` line says they are then excluded by the layer rule only).
   Starts the helper, logs `hello`, `diag` (pid, ppid, **responsiblePid / responsiblePath** = the process
   macOS TCC charges the helper's permission checks to) and the `inputAccess` preflight (never prompts).
2. Debug overlay (unless `--overlay=false`): one transparent, click-through, non-focusable, floating-level
   window covering the primary display's full bounds, shown with `showInactive()`. It outlines every
   window of each helper snapshot (4 Hz, 15 Hz during the CPU phase): **green solid = §8.2-eligible
   surface, grey dashed = ineligible** (the label says why: `layer`, `offscreen`, `alpha`, `small`,
   `own`, `excluded`), **blue dashed = Electron display bounds, orange dashed = work area, red = cursor
   crosshair** (~20 Hz). Labels: `#z wid <CGWindowID> L<layer> <bundle id> <w×h>` — never titles.
   Outlines are drawn on the outermost point *inside* each window's bounds, so a correct outline hugs the
   inner edge of the window. Look at the screen while it runs (or take your own screenshot and zoom in).
3. A 200×120 frameless **probe window** (magenta frame) is moved to 7 positions (work-area corners and
   centre, half off the right and half off the bottom edge); after each move the helper's `{x,y,w,h}` for
   its CGWindowID (`getMediaSourceId()` = `window:<id>:0`) must equal `win.getBounds()`.
4. Checks (each prints `PASS|FAIL|WARN|SKIP|INFO <name>: <detail>`): helper hello · TCC attribution ·
   retina scale (page css px = window pt, devicePixelRatio = scaleFactor) · uiohook-napi packaging
   (resolves + native prebuild present; **never loaded** here) · displays (helper `CGDisplayBounds` vs
   `screen.getAllDisplays()`, paired by id) · coordinates (probe, 7 positions) · coordinates (overlay) ·
   window ownership (our windows belong to the main pid, so §8.2's own-pid rule works) · level (overlay
   above layer 0, below the Dock and the menu bar; `LEVELS` lines list every layer with its owners) ·
   z-order (layers never increase front to back; `Z-ORDER` dump of the first 12 entries plus all layer-0
   windows in order) · app launch/terminate events (`--auto-app-test`: `open -g -a Calculator`, wait for
   `appLaunched`, SIGTERM that pid, wait for `appTerminated`; skipped if Calculator is already running) ·
   helper CPU (a 4 Hz and a 15 Hz phase, see below) · round-trip latency (bursts, see below) · hidden in
   fullscreen Spaces (see below).
5. App events (`appLaunched` / `appActivated` / `appTerminated`), `frontmostFullscreen` changes and every
   change of the overlay's presence in the helper's on-screen list (`overlay presence …`) are logged live
   the whole time.

Outputs: `spike-results/windows-<label|timestamp>.json` + `.log` in dev; **`~/Library/Logs/Bitbot/`** in a
packaged app (its cwd is `/`) unless `--results=DIR` (absolute) is given. The JSON has every check, the
coordinate rows (`requested`, `electron`, `helper`, `delta`), the level report, the z-order dump, the
latency bursts (raw samples), the CPU phases (every `ps` reading and both estimates), app events,
fullscreen states, overlay presence changes and the helper's diag. It contains bundle ids, pids and
bounds of on-screen windows (never titles): delete it when done. Exit status: 0 = no FAIL, 2 = a FAIL,
1 = results not written.

**How to read the helper CPU line.** Node cannot read another process's exact CPU time, so the harness
samples `ps -o time=` (cumulative CPU, rounded to 10 ms) every 200 ms and uses the two instants where
that value stepped up first and last in the phase: between them the CPU used is exact, and only the
two step times are uncertain (by one sampling interval each). Each phase prints
`0.220% (0.218–0.222%, edges over 22.8 s)`: an estimate with bounds that hold for any true value, then
`within` / `OVER` / `bounds straddle` the §11 0.5% budget. Checked against `proc_pid_rusage` ground
truth sampled alongside (8 harness phases of 8-25 s, plus a standalone helper): every bound was
consistent with it. A phase too short to resolve prints `n/a (below resolution: …)` instead of a
misleading number; at ~0.2% (4 Hz) that needs ~10 s, so use `--cpu-phase-s=25` for real figures. The
`ps %cpu` mean at the end is a decaying average that lags and read 0.6-0.7× the true value at 4 Hz: a
diagnostic only, never a CPU figure. Helper CPU also moves with what else the Mac is doing (seen: 4 Hz
0.21–0.32%, 15 Hz 0.70–0.90% across runs; higher with `--overlay=false`), so compare runs with
identical flags.

**How to read the latency line.** Round trips are measured in bursts (40 sequential `snapshot` and
`ping` requests after 3 untimed ones): after the checks, then at the end of each CPU phase (outside its
CPU window). Sub-millisecond round trips depend on how busy (awake) the Mac is, and they vary ~3× between
bursts of one run, so the line names the run configuration and pools all bursts. **Compare only runs
with identical flags**: with `--overlay=false` round trips were slower on average (pooled snapshot p50
0.8–1.1 ms vs 0.6 ms with the overlay), and dev and packaged runs with the same flags matched.

**Fullscreen check (manual, §8.6):** run with `--duration=0`, put any app into native fullscreen
(green button), wait ~2 s, leave fullscreen, then Ctrl+C. Each `frontmostFullscreen` change prints
`PASS|FAIL fullscreen visibility: … overlay IS / is not in the on-screen list`. Spike A found that an
Electron `panel` always joins fullscreen Spaces (`FullScreenAuxiliary`), so expect FAIL with the default
`--window-type=panel` and compare with `--window-type=none`; the app must hide the pet itself (§8.6).
The helper's fullscreen detection is itself unverified on this notched display, so the harness also logs
`overlay presence change: NOT in / IN the helper's on-screen list at +t s (helper frontmostFullscreen=…;
last appActivated …)` from every snapshot, whatever the helper concluded. If the overlay leaves the list
while the helper says `frontmostFullscreen=false`, the summary prints `WARN hidden in fullscreen Spaces`
(a missed detection, if a fullscreen app was frontmost then). `SKIP` means the helper reported no
fullscreen state **and** the overlay never left the list.

## `--spike=input` (MANUAL ONLY — can show macOS permission prompts)

```
--source=helper|uiohook  [--keys=true|false] [--mouse=true|false] [--request] [--duration=S (default 60, 0 = until quit)]
[--retry-on-grant=true|false (helper; default true)] [--results=DIR] [--label=TEXT]
```

- **helper**: logs `diag` and the `inputAccess` preflight; with `--request` calls `requestInputAccess`
  (`CGRequestListenEventAccess`: the system **Input Monitoring** prompt when undecided); then
  `startInputTap({keys, mouse})` — a listen-only tap that never prompts and fails with
  `reason notGranted` without the grant. While the tap is not running it re-checks the grant every second
  (preflight only) and, when it flips to granted, retries the tap once **in the same helper process**:
  `PASS` = nothing needs restarting. If macOS refuses it (`FAIL … tapCreateFailed`), the harness then
  SIGTERMs the helper; HelperClient respawns it and re-applies the tap, and
  `helper restart after grant (fresh helper process, same app)` prints `PASS` (a helper restart is
  enough: §15.1's "Relaunch Bitbot" can be an invisible helper restart) or `FAIL` (the app itself needs a
  relaunch; test 2 confirms). It is `SKIP` when the same-process retry already worked.
  It also cross-checks the helper's auto-repeat flag against a held-key set (`repeat-flag disagreements
  a/b`, both should stay 0) and measures event age at receipt (helper timestamp → main; a wrong
  timestamp unit shows up as `implausible` ages).
- **uiohook**: imports `uiohook-napi` (even loading it opens an IOHIDSystem connection), registers
  counting-only listeners and calls `uIOhook.start()` in try/catch. libuiohook calls
  `AXIsProcessTrustedWithOptions` **with the prompt option** and fails with `UIOHOOK_ERROR_AXAPI_DISABLED`
  until **Accessibility** is granted; it then installs an **active** tap (`kCGEventTapOptionDefault`, head
  insert, every mouse move too) and translates each key press to text with `UCKeyTranslate` on the main
  queue (uiohook-napi drops the text). So it needs Accessibility, not Input Monitoring.

Counts only: every 5 s and in total — key downs (and repeats), key ups, clicks by button (left / right /
other), scrolls (helper: continuous, momentum, zero-delta gesture edges, horizontal). **Key codes are never
printed or stored**; they only feed the in-memory held-key set. A count a source cannot observe is
`null` in the JSON and left out of the log line, never printed as 0: libuiohook dispatches a scroll only
when its whole-line delta is non-zero (sub-line trackpad scrolls and gesture edges never arrive), labels
diagonal scrolls vertical and has no continuous/momentum flag, and its repeats come from the held-key
set itself (no repeat-flag cross-check). The log goes to
**`~/Library/Logs/Bitbot/spike-input.log`** (appended; a packaged app started with `open` has no visible
stdout) and the results to `input-<source>-<timestamp>.json` (dev: `spike-results/`, packaged:
`~/Library/Logs/Bitbot/`). Each run logs `isPackaged`, ppid, `execPath`, bundle id and the helper `diag`.

## Packaged build

```sh
NO_UPDATE_NOTIFIER=1 bash scripts/with-build-lock.sh "NO_UPDATE_NOTIFIER=1 npm run package:dir"   # ~15 s
codesign -dv --verbose=2 dist/mac-arm64/Bitbot.app     # Identifier=com.bitbot.desktop, Signature=adhoc
codesign -d -r- dist/mac-arm64/Bitbot.app              # designated => cdhash H"…"   (changes with the app's content)
open -g -n dist/mac-arm64/Bitbot.app --args --spike=windows --duration=8 --overlay=false
# → ~/Library/Logs/Bitbot/windows-<timestamp>.{json,log} (or add --results=/abs/dir); "PASS TCC
#   attribution" = the helper's responsible process is …/Bitbot.app/Contents/MacOS/Bitbot
```

`electron-builder.yml`: `appId com.bitbot.desktop` (placeholder), ad-hoc identity `-`, no hardened
runtime, `LSUIElement`, helper in `Contents/Resources/bitbot-helper` (`extraResources`), uiohook's
`.node` unpacked (`asarUnpack`), local Electron (`electronDist`, no download), `npmRebuild: false`, and
hardened **Electron fuses** (no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`; asar-only with
integrity check) — with the stock fuses any process could run code *as Bitbot* and so use its Input
Monitoring grant. `NO_UPDATE_NOTIFIER=1` keeps electron-builder from asking the npm registry for updates.

**Launch the packaged app with `open` or from Finder.** Started from a terminal its permission checks are
charged to the terminal app (the windows check then prints `WARN TCC attribution … started from a
terminal`). Note that `open` passes the caller's environment to the app on macOS 15.

## Manual permission tests (for the user)

Use the packaged app. Watch the log in a second terminal: `tail -f ~/Library/Logs/Bitbot/spike-input.log`.
To make macOS ask again from scratch: `tccutil reset ListenEvent com.bitbot.desktop` and/or
`tccutil reset Accessibility com.bitbot.desktop`.

1. **Helper tap, Input Monitoring, first request.**
   `open -g -n dist/mac-arm64/Bitbot.app --args --spike=input --source=helper --request --duration=180`
   - The log should show `TCC attributes the helper's input permission to: …/Bitbot.app/Contents/MacOS/Bitbot`
     and `helper tap (initial) FAIL … notGranted`.
   - The system prompt should name **"Bitbot"** ("…would like to receive keystrokes from any application").
     Note its exact wording and buttons.
   - Open System Settings → Privacy & Security → Input Monitoring and switch Bitbot on. Note whether macOS
     offers "Quit & Reopen". Do **not** quit yet: watch for `Input Monitoring preflight changed: listen
     false → true` and `helper tap (retry after the grant was detected, same process)` → PASS (works without
     any restart) or FAIL `tapCreateFailed`. After a FAIL the harness restarts the helper by itself: watch
     for `helper restart after grant (fresh helper process, same app)` → PASS (restarting the helper is
     enough; Bitbot itself needs no relaunch) or FAIL (the app needs a relaunch; test 2 checks that). If a
     tap went active, type/click/scroll and check that counts appear.
   - If `preflight changed` never appears within ~10 s of switching Bitbot on, note it: the grant is not
     visible to the running helper at all (then only test 2 can show whether a relaunch fixes it).
2. **Relaunch after the grant.**
   `open -g -n dist/mac-arm64/Bitbot.app --args --spike=input --source=helper --duration=60`
   - Expect `helper tap (initial) PASS` and no prompt. Type a little, hold a key for ~2 s (repeats),
     click left/right, scroll with the trackpad and with a wheel if you have one.
   - Check: `repeat-flag disagreements 0/0`; `event age at receipt` p50 a few ms and `implausible 0`;
     counts match what you did (modifier-only presses are not counted, by design). Look for
     `helper stderr: input tap re-enabled` lines (the tap was disabled by a timeout).
3. **Does the grant survive an update?** Note `codesign -d -r- dist/mac-arm64/Bitbot.app`, then rebuild
   the way an update would, with changed content:
   `NO_UPDATE_NOTIFIER=1 bash scripts/with-build-lock.sh "NO_UPDATE_NOTIFIER=1 npm run package:dir -- -c.buildVersion=2"`
   (sets CFBundleVersion 2). Check that the cdhash changed, then run test 2 again without touching System
   Settings. Expected for ad-hoc builds: `notGranted` (the grant is tied to the old cdhash) even though
   Settings may still show Bitbot switched on; remove it with "−" (or `tccutil reset ListenEvent
   com.bitbot.desktop`) and grant again. (Ad-hoc builds here are deterministic: rebuilding identical
   sources reproduces the same cdhash, so the grant is expected to carry over — that is not an update test.)
4. **uiohook, Accessibility.** Two questions: is Input Monitoring alone enough (expected: no), and is
   Accessibility alone enough (expected: yes)?
   - **4a, Input Monitoring only** (granted in test 1/3; Accessibility not granted:
     `tccutil reset Accessibility com.bitbot.desktop` first if unsure):
     `open -g -n dist/mac-arm64/Bitbot.app --args --spike=input --source=uiohook --duration=120`
     Expected: `uiohook import PASS` — note whether the log says `via import()` or `via require` (the ESM
     loader reading app.asar is untested; `require` is the fallback) — then the **Accessibility** prompt
     naming Bitbot and `uiohook start() FAIL … UIOHOOK_ERROR_AXAPI_DISABLED`.
   - **4b, Accessibility only.** Remove Input Monitoring first: `tccutil reset ListenEvent
     com.bitbot.desktop` (check that Bitbot is gone from Privacy & Security → Input Monitoring). Then grant
     Accessibility (Privacy & Security → Accessibility) and run the same command again: expect
     `uiohook start() PASS` and counts — that PASS is what shows Accessibility alone is enough. Note any
     other prompt (e.g. Input Monitoring) that appears.
   - **4c, both (optional).** Switch Input Monitoring back on and run once more; note whether anything
     changes.
   - Compare with test 2 (same actions): **keys and clicks** should match (uiohook counts every
     auto-repeat keydown as a down and numbers mouse buttons from 1; the log already maps them). For
     scrolling compare **only a notched wheel mouse** (one event per notch in both): trackpad scroll counts
     differ by design, since libuiohook drops scrolls whose whole-line delta is 0 (sub-line trackpad
     movement, gesture begin/end) and labels diagonal scrolls vertical; its log line therefore shows
     `scroll N (whole-line events only, no breakdown)`. Its tap is active (it can add latency to all
     input).
5. **Dev attribution (optional).** From a terminal:
   `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --spike=input --source=helper --duration=30`
   — the log names Terminal / VS Code as the responsible app; in dev, grants go to that app, not Bitbot.
6. **Clean up:** remove Bitbot from Input Monitoring and Accessibility (or the two `tccutil reset`
   commands above) and delete `~/Library/Logs/Bitbot/spike-input.log` and the `input-*.json` / `windows-*`
   files there.

Send back: the `spike-input.log` section of each run, the prompt wording, and the outcomes of test 1
(same-process retry, then the helper restart), test 3 (rebuild), and tests 4a (Input Monitoring alone)
and 4b (Accessibility alone).
