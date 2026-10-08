# Decision record: overlay window approach (Spike A → Milestone 1)

- **Status:** **decided 2026-10-07: approach B, hardened.** The user chose B ("the pet can be anywhere on the computer screen"). Milestone 1 built it and measured it in the real app; it beats A2 on every number that compares. Manual checks on the real app are still to run (below).
- **Dates:** spike 2026-10-06; decision and M1 measurements 2026-10-07.
- **Spec:** §2, §5.1, §5.2, §8.6, §8.7, §9.4, §11, §12 (Spike A), §13.1. The spec carries dated "Decided" notes at §5.1 and §5.2.
- **Measured on:** Apple M4 (MacBook Air, 10 cores), macOS 15.6, one 60 Hz Retina display (1710×1107 pt @2x), Electron 44.6 (Chrome 152).

## Decision

**Approach B, hardened**, as built in Milestone 1:

- **Overlay.** One display-sized transparent window draws the pet on a 240 pt canvas, moved only by compositor transforms (`translate3d`).
  - It is a normal window, not a panel, and never accepts mouse input: `setIgnoreMouseEvents(true)` once, no forwarding.
  - macOS should keep it off fullscreen Spaces and Split View (expected from Electron's sources; manual check 4).
- **Grab area** (the "hit window"). A small invisible panel that the overlay's page opens with `window.open`.
  - It shares the overlay's renderer process.
  - It is shown only while the cursor is near the pet and the helper's window list confirms the overlay is on screen. Fail closed: no answer means hidden.
  - It is click-through except over the pet's silhouette, and is kept directly above the overlay in z-order (`moveAbove`), so other apps' floating panels stay clickable.
  - Stale input can't switch it back on: every reset gets a new epoch, and messages from an older epoch are dropped. Space changes (helper protocol 3 `spaceChanged`), app activations and fullscreen pushes hide it at once.
- **Simulation** at a fixed 30 Hz in main.
  - The renderer interpolates one step behind and renders WebGL only when the pet's look changes; moving it is a transform.
  - The loop parks while the pet is hidden.

Code:
- `src/main/windows/`: overlayWindow, hitWindow, petWindow, petInteraction, hitArea, overlaySession.
- `src/main/bitbotApp.ts` and `src/renderer/pet/overlay.ts`.
- Dev check: `electron . --check=overlay` (`src/main/dev/overlayCheck.ts`).

## Evidence (Milestone 1)

### Focus, the gate: passed on real input

On 2026-10-07 the user ran the spike's plain-B interactive harness for 96 minutes, with real mouse input:
- clicked the pet 15 times;
- dragged it 18 times;
- used its right-click menu 6 times.

Electron's `did-become-active` and `browser-window-focus` never fired. All 39 verdicts read "became the active app: NO" (`spike-results/overlay-B-interactive-20261007-210139.json`, gitignored).

So clicks on Electron's `type: 'panel'` windows don't activate Bitbot, despite AppKit's "nonactivating panel styleMask 0x80" warning. The M1 grab area is the same kind of panel. The app logs a PASS/FAIL verdict line after every press, drag and menu, so this stays checked in every run. The visible half (typing keeps going into the other app) is manual check 1.

### Dev check: 59/59 functional checks pass

The check drives synthetic input into Bitbot's own windows only. On the final code, and in every round:

- **Windows.** The overlay is not focusable, always on top and visible on all workspaces. The grab area is not focusable and always on top. No Dock icon.
- **Processes.** Exactly one renderer process: the grab area has the overlay's OS pid.
- **Grab area visibility.** Hidden while the cursor is far. Shown 44–88 ms after it comes near, once the helper confirms the overlay is on screen. Its bounds cover the pet's box.
  - The helper lists it at layer 3 directly in front of the overlay, 2–6 ms after showing. It leaves the list 9–16 ms after hiding.
  - Its capture is fully transparent.
- **Hover.** Comes from the grab area's own mousemove, not only from main's cursor samples.
- **Click, drag, drop.**
  - A click without a drag leaves the pet exactly in place.
  - A drag is followed exactly by the simulation.
  - Released in the air, the pet lands in 438–463 ms (physics: 467 ms).
  - An overlay capture shows the pet's pixels at the new spot and none at the old.
- **Release and menu paths.** A lost mouseup releases. Right-click opens and closes the menu.
- **Hide.** Hiding during a drag releases the pet, hides both windows and parks the loop (0 renderer frames while hidden); showing restores everything.
- **Reload.** A page reload leaves exactly one grab area, still grabbable.
- **Whole run.** Zero focus events, no network requests, no errors.

### Cost, same session (AC power, load average 4–8)

CPU as % of one core, median (min–max) of 3 interleaved rounds. Electron's cumulative CPU deltas, the spike's method, so it compares with the tables below. Helper CPU is from `ps`.

| Run | main | renderer | GPU | Electron total |
|---|---|---|---|---|
| B: idle (cursor far, pet still) | 1.83 (1.29–1.87) | 0.03 | 0.01 | 1.88 |
| B: hidden | 0.13 | 0.00 | 0.00 | 0.13 |
| B: near and still | 2.37 (1.75–2.45) | 0.49 | 0.01 | 2.87 |
| B: walk, cursor moving near | **3.14** (2.80–3.49) | 6.34 | 4.16 | 13.31 |
| B: chase 600 pt/s, cursor near | **4.48** (4.40–6.08) | 6.25 | 3.90 | 14.64 |
| B: drag 120 pt/s | 6.48 (5.87–8.87) | 9.49 | 4.36 | 20.33 |
| B: drag 600 pt/s | 8.50 (8.49–11.23) | 9.87 | 4.48 | 22.72 |
| **A2 walk** (spike) | **13.52** (10.91–14.61) | 11.65 | 13.40 | 39.67 |
| **A2 synthetic** (spike) | **13.30** (10.82–15.88) | 13.04 | 14.77 | 41.11 |

- **Main is the like-for-like number** (simulation, IPC, window moves): B costs about a quarter of A2.
- **Renderer and GPU numbers aren't like-for-like.** The M1 overlay does 0 WebGL renders while the pet moves (a static pet; only the transform changes), while the spike's A2 renders every frame.
- **Moving rows have no walking yet.** M1 has none; the dev check moves the pet with a scripted mover.
- **Drag rows include injection cost.** They include the check injecting about 67 synthetic events/s from main.
- **Helper:** 0.1–0.2% on top.
- **Memory (phys_footprint, Electron processes):** 185.5 MB, vs A2 188–193 MB. The helper adds 4.7 MB.
- **Hidden meets §11's "< 1%".** Idle costs 1.8% of main because the 30 Hz loop runs while the pet is shown. That's within §11's "< 3% roaming", and a later performance item.

### Responsiveness

| Metric | Value |
|---|---|
| Pet moves under a still cursor → clickable | p95 46 ms (range 44–49), max 51 ms; 0 missed |
| Pet moves away from a still cursor → click-through again | p95 45 ms (43–49), max 49 ms; 0 missed |
| Drag: input → frame that draws it | p95 ~15 ms (within one 60 Hz frame) at 120 and 600 pt/s |
| Pet's box outside the grab area | 0.00% of wakes in every moving phase |
| Renderer while idle, hidden, near and still | 0 frames |

### Bugs the check found (fixed, each with a regression test)

1. **Drags were drawn one frame late.** The grab area's `mousemove` is frame-aligned. A press now follows `pointerrawupdate`, which brought input→frame p95 down from 30 to 15 ms.
2. **Main's idea of where a held pet is drawn was a step behind.** The grab area trailed a fast drag: 54–58% of wakes uncovered at 600 pt/s.
3. **Most grab-area moves were also resizes.** Rounding gave 268 or 269 pt; one size per box now, which saves ~1.5–2 points of main CPU while chasing.
4. **`tuning.hitArea.innerMarginPt` 4 → 24.** A 600 pt/s pet covers 20 pt between two 30 Hz wakes. This costs +0.7–1.9 points of main CPU while a pet moves fast near the cursor; a velocity-aware placement can replace it in M3/M4.

The glue phase also found that Electron 44's `before-mouse-event` has no `modifiers` field, so a drag's held button is read from `button`.

### What the check can't see

Synthetic events reach the page whatever `setIgnoreMouseEvents` says. So the check proves Bitbot's own pipeline, but not:
- real click-through;
- the panel's non-activation (shown separately above, with real clicks in the spike);
- AppKit's mouse capture during drags.

These are the manual checks below.

## M1 code review (2026-10-08)

Six reviewers with different focuses, then skeptics who tried to disprove each finding. Fixed, each with a test:

- **A dropped pet under a still cursor stayed click-through.** Main's one cursor sample after a drop fell inside the renderer's 70 ms quiet window and was ignored; nothing re-sent it. A hover-reset now makes main's next sample count.
- **A stale "overlay on screen" answer was trusted for up to ~2.5 s while the helper was slow.** An answer now counts for `tuning.hitArea.onScreenMaxAgeMs` (800 ms); after that the grab area is hidden until a fresh one, except during a drag or the menu.
- **The helper was asked twice a second while a fullscreen app hid the pet** (or the pet wasn't drawn). It isn't asked then any more.
- **A page that could never load (e.g. no WebGL) was recreated every ~21 s all day.** Recreation now backs off, doubling up to `tuning.overlay.recreateMaxDelayMs` (5 min), and resets on `pet:ready`.
- **Dev `--snapshot` and `--spike` runs used the packaged app's profile.** They now use `Bitbot-dev-tools`.
- Tests: the no-network scan catches more ways to reach the network; `npm test` type-checks and fails on a stale helper build; two order- or timing-dependent tests fixed; negative IPC allowlist checks.
- **A silent renderer hang after `pet:ready` was not detected** (fixed in M2). Chromium's `unresponsive` comes from input acks, and the overlay takes no input, so the pet would freeze until restart. Main now pings a ready page (`pet:ping`) every `tuning.overlay.watchdog.pingMs` (2 s); 3 pings in a row without a `pet:pong` recreate it with its renderer killed. The count is reset after a system sleep.

Real but not fixed (unconfirmed trigger, or later work):

- **App switches re-check at once,** while a Space animation may still be running. Waiting `spaceSettleMs` would delay grabbing after every app switch, so it waits for manual check 4 (does `spaceChanged` arrive on device?).
- **A display rearrangement** can show the grab area for ≤100 ms at the old spot before the re-layout.
- **A dev helper built before protocol 3** is used as current (no `spaceChanged`); the mismatch is logged. Packaged builds always rebuild it.
- **`drawn: false` before `pet:ready`** is overridden by the ready. Clicks still fail closed.
- **The 30 Hz loop runs while fullscreen or locked** (§11 "< 1% hidden"). Scheduled: event-driven idle (M2), fullscreen/lock hiding (M8).
- **`--spike` and `--check` run in packaged builds.** Spike B's tests need that; strip the spike code before any real distribution (Phase 4).

## M2 measurements: the idle style (2026-10-08)

Decided (c) asked M2 to prototype a cheaper idle and decide with numbers. M2 built both, plus a third:

- **Continuous:** §6.4's idle, bobbing and swaying all the time, rendered at 30 fps (asleep: 10 fps).
- **Event:** still between short events every 3–8 s (a blink, a glance, a breath, an antenna wiggle), rendering only during them. Asleep, only the zzz runs, in 2 s bursts every 8 s.
- **Still:** only blinks and looks; the outline never changes. The dev check uses it to time the grab area.

Measured by the dev check on the same M4 as above (battery, load average ≈4, one run; CPU as % of one core, all Bitbot processes):

| Pet | Event | Continuous |
|---|---|---|
| Idle, cursor far | 6.1 (renders 5/s) | 20.6 (renders 30/s) |
| Asleep | 4.2 (renders 2/s) | 10.4 (renders 10/s) |
| Hidden | 0.3 | 0.3 |

- About 1.5–1.9 points of every row is main's 30 Hz simulation loop, which runs while the pet is shown (the M9 performance pass).
- A drag now renders every frame (the pet swings): 36–40% while dragging, against M1's 20–23% for a static pet. §11 allows 60 fps while dragged.
- Memory: 195 MB (Electron processes).
- **Neither style meets §11's 3% idle / 1% asleep yet.** Event is about a third of continuous awake and under half asleep.

**Decided 2026-10-08: calm (event) by default.** The user chose the calm idle; "eventually there will be a way to make Bitbot busy", not now. `tuning.anim.idleMode = 'event'` carries the SPEC-DEVIATION; the developer panel still switches styles.

For M3: climbing is only previewed in place (rolled a quarter turn about the body's centre). On a real wall the pet turns about its contact point and reaches up to ≈175 pt sideways, past the 240 pt canvas's 120 pt half-width: the canvas anchor has to move with the surface.

Also found while measuring: an animated outline moves under a still cursor, so after every render that changed the pose the overlay tests hover again at the last cursor it saw (a click must never be caught where the pet no longer is). Parts an animation draws outside the measured pet box are never grabbable (SPEC-DEVIATION in placement.ts).

## M3: the world (2026-10-08)

- **Built:** the world model (eligible windows, visible top and side pieces under occlusion, the ground and screen walls), routes (walk, drop, jump, climb, short hops onto and off walls; Dijkstra over travel time plus penalties), locomotion along them, riding and flinging, falls landing on the first surface crossed, a wanderer standing in for the M6 brain, the snapshot rate (decided adaptive), the debug view and the developer panel's World section.
- **Climbing:** the pet turns a quarter turn about its contact point, and the canvas anchor moves with the turn (`tuning.render.climbAnchor`), so nothing is clipped at sizes S, M and L. Main turns the pet's box the same way (`boxFor`) for the grab area and the safety net.
- **Dev check:** new world checks with one made-up window (the user's real windows are left out, so results never depend on the desktop): the pet gets onto its top, rides it 120 of 120 pt with the 15 Hz snapshot rate, and falls back when it closes. 65/65 functional checks, 0 thresholds failed.
- **Found by the check:** a snapshot asked for right after a pushed one made a 20 pt window move read as a fling (speed = move ÷ a few ms). Window speed is now measured over at least `tuning.move.flingMinIntervalS` (1/15 s).
- **On the real desktop** (90 s, dev build): the pet hopped to a window's side, climbed it, walked its top, dropped to the Dock and climbed the other side; clean quit, no errors.
- **Not covered yet:** multiple displays (Phase 4), tossing (M4), the cost of real walking (the dev check moves the pet by teleport; walking renders at 60 fps like a drag).

## Manual checks (the real app)

Start it with `npm run build:helper` (once), then `npm start`. The pet stands on the Dock at the bottom centre, and a small monitor icon appears in the menu bar.

1. **Focus.**
   - Click into a TextEdit document.
   - Click the pet, drag it, right-click it and choose Hide, pressing ⌥⌘B to bring it back. After each step, type: the letters must land in TextEdit.
   - The terminal prints `… -> Bitbot became the active app: NO (PASS)` per interaction.
2. **Click-through.** Click, scroll and drag right next to the pet. Everything must reach the app below. Hover a text field beside the pet: the I-beam cursor must not flicker.
3. **Drag.** Drag the pet fast and drop it in mid-air: it follows smoothly and falls onto the Dock. Switch desktops (⌃→): the pet is there and grabbable.
4. **Fullscreen.**
   - Put an app into native fullscreen: the pet must be gone, and a click where it stood reaches the app.
   - Repeat in Split View.
   - Press ⌥⌘B twice there.
   - Launch Bitbot while a fullscreen Space is active.
5. **Level.** The pet stays under the Dock, the menu bar, Spotlight and Notification Center. Another app's floating panel (TextEdit's Fonts panel) over the pet stays clickable.
6. **Screenshot picker.** Press ⌘⇧4 then Space: the picker still selects app windows, not a screen-sized Bitbot window.
7. **Tray.** The menu works with another app frontmost; Hide/Show, ⌥⌘B and Quit work.

**If check 1 fails** (a click activates Bitbot): A2 doesn't help, since it also needs a panel. Replace the grab area with a real non-activating NSPanel owned by bitbot-helper. Main's cursor stream does the hit test and the helper forwards presses; PetInteraction and hitArea stay.

**If check 4 fails for the overlay itself:** hide it on the helper's `frontmostFullscreen` / `spaceChanged` signals, which brings the M8 fade forward.

## Spike A analysis (2026-10-06)

Kept as measured during the spike. Where it says "unverified" or "pending", see Evidence (Milestone 1) above.

### Why B over A

§5.2 prefers A "if smooth" because it expected A to be cheaper and B to cost more to composite. Neither held:

1. **A isn't cheaper.**
   - Moving a window keeps Electron's main process at **8.3–12.2% of a core** while A's pet moves. That's about 6–8 points above A's own static level (2.8–3.1%).
   - B's main process stays at **1.1–1.6%**. `setPosition` alone takes 0.4–0.7 ms per call, 60 times a second, plus Electron/Chromium's handling of each move.
   - **This main-process gap is the reliable difference.** Total CPU medians while moving are A 26.8–31.9% vs B 24.2–24.6%, but individual runs overlap (B 20.6–26.9%, A1i 25.9–32.8%).
   - **B's compositing isn't free either.** B's renderer + GPU-process CPU is 1–4 points higher than A's while moving. A's main-process cost outweighs it.
2. **A isn't fully smooth on screen.** An external probe sampled the window position at 250 Hz.
   - At the best possible vsync alignment, A1 and A2 left **0.6–2.6% of moving frames without a window update**. That's about one hitch per second, each lasting one or two frames.
   - Averaged over alignments it was 1.4–4.2%.
   - **The cause:** `setPosition` can only run on Electron's main thread. Main's wake-up lateness p95 is about 3 ms in runs where no window moves, and **5–22 ms while A moves its window**, so the moves themselves make main late.
   - **A naive `setInterval` (A1i)** actually ran at ≈56 Hz, so 6–8% of frames get no update.
   - **What B's evidence is.** B's renderer produced every frame (rAF p99 18.7 ms, 0% long frames). A's renderer passes that same test, so it doesn't prove B looks smooth on screen. B's canvas moves inside a window that doesn't move, which the probe can't see. **B's on-screen smoothness is inferred; your side-by-side look (check 3) decides.**
3. **B doesn't cost more to composite with a small canvas.**
   - Memory: ≈190 MB for both.
   - System GPU utilization: ≈28% for both, of which ≈20–23% was other apps.
   - WindowServer: A1 ≈ B; A2 reads 1–4 points higher.
   - **Bfull is ruled out.** A display-sized canvas uses 591–661 MB, twice §11's 300 MB, and ≈80% GPU.
4. **Never in the way (§2).** In the spike's plain B, the display-sized overlay takes mouse input while the pet is hovered; a stalled main thread at that moment could swallow clicks anywhere on the display. The hardened design removes that, because only a pet-sized window ever takes input. A has the same containment by construction.
5. **Fewer windows later.** The §9.4 speech bubble, the debug overlay and effects (§8.7 teleport sparkle) can all be drawn in the overlay.

**Costs of B**, all estimates until M1 measures them:

- **Hit window:** about 1–2 ms per hit-test round trip, renderer → main → toggle. Moves at A's per-move cost, but only while the cursor is near a moving pet.
- **Memory:** ≈0 if `window.open` shares the renderer process. Otherwise one more renderer, about 25–50 MB on top of B's ≈190 MB (peak ≈245 MB, against a 300 MB budget).
- **The bubble** must be covered by the hit window, because it is clickable (§9.4).
- **Displays:** one overlay per display. In Phase 1 there is only a primary-display overlay, so a pet dragged toward another display clips at the edge until it teleports back (§8.7).

### How it was measured

- **Code:** harness in `src/main/spike/overlay/*` and `src/renderer/spike/overlay/*`; benchmark `spikes/run-overlay-bench.sh`; analysis `spikes/analysis/*`. Raw results are in `spike-results/bench-final/`, `fps*/` and `fpsfix*/`, which git ignores; the tables below summarize them.
- **Pipeline:** every variant runs the production shape from §5.1. A fixed-step 30 Hz sim in main owns the pet's position, presentation is interpolated one step behind, and the pet renders every frame (worst case).
- **Variants:**
  - **A1:** 240 pt window moved by a 60 Hz main-process deadline timer.
  - **A1i:** the same with a naive `setInterval`.
  - **A2:** window moved on each renderer frame via IPC.
  - **B:** display-sized window; 240 pt canvas moved by `translate3d`.
  - **Bfull:** display-sized canvas.
- **Modes:**
  - static;
  - walk (120 pt/s along the Dock);
  - synthetic: a deterministic Lissajous chase at up to 600 pt/s. **It stands in for §12's "follow the cursor at 600 pt/s"**, so runs are comparable and your mouse is never touched. The real `--mode=follow` exists but was only smoke-tested.
- **Runs:** 20 s each, the first 2 s discarded. Three interleaved repeats, 42 runs, all exit 0, probe on in every run.
- **Metrics:**
  - CPU from cumulative CPU time per process type, as % of one core.
  - Memory = phys_footprint (Activity Monitor's "Memory").
  - GPU = `ioreg` Device Utilization.
  - WindowServer = its CPU time, which **includes ≈2–3 points from the probe itself**.
  - Window motion = probe of the window position, 4 ms sampling (±2 ms).
- **Conditions:** battery power (Low Power Mode off); about **1–3 cores of other load** besides WindowServer's ≈0.4 core. Repeats of the same configuration differed by at most 1.35×. Effects such as macOS moving threads to efficiency cores are an unquantified risk.
- **Compare variants with each other,** not with §11. §11's budgets are for an M1-class Mac, and these numbers come from an M4 on battery under load; those two effects pull in opposite directions.

### Results (medians of 3 runs; CPU in % of one core)

| Variant | Mode | CPU total | Main | Renderer | GPU proc | Memory MB | GPU % (system) | WindowServer % |
|---|---|---|---|---|---|---|---|---|
| A1 | static | 23.6 | 2.8 | 9.2 | 11.6 | 190 | 28 | 45.4 |
| A1 | walk | 29.9 | 9.3 | 9.4 | 11.0 | 183 | 28 | 44.6 |
| A1 | synthetic | 28.2 | 9.2 | 8.8 | 10.5 | 190 | 27 | 45.6 |
| A1i | walk | 29.2 | 9.6 | 8.8 | 10.3 | 191 | 28 | 44.6 |
| A1i | synthetic | 26.8 | 8.5 | 8.5 | 9.8 | 192 | 27 | 47.0 |
| A2 | static | 24.8 | 3.1 | 9.8 | 11.8 | 190 | 29 | 49.5 |
| A2 | walk | 30.6 | 10.9 | 9.2 | 10.4 | 184 | 28 | 46.1 |
| A2 | synthetic | 31.9 | 11.4 | 9.6 | 10.9 | 194 | 27 | 46.7 |
| **B** | static | **22.5** | 1.3 | 9.5 | 11.8 | 189 | 29 | 45.5 |
| **B** | walk | **24.6** | 1.3 | 11.1 | 12.2 | 189 | 29 | 45.4 |
| **B** | synthetic | **24.2** | 1.6 | 10.8 | 11.8 | 192 | 27 | 45.4 |
| Bfull | static | 20.4 | 1.2 | 8.4 | 10.7 | **633** | **80** | 45.4 |
| Bfull | walk | 20.9 | 1.5 | 8.9 | 10.8 | **597** | **81** | 47.3 |
| Bfull | synthetic | 23.3 | 1.4 | 9.8 | 11.8 | **597** | **81** | 47.5 |

Static medians are within noise of each other for A1, A2 and B (22.5–24.8%).

#### Window motion as the window server saw it (A only; 3 runs each)

The figures are the % of moving frames with no window update, shown as "best alignment / average over alignments". Best alignment is a lower bound. The probe can't see the display's real vsync phase.

| Variant | Walk | Synthetic | Worst alignment (0 or ≥2 updates) |
|---|---|---|---|
| A1 (deadline timer) | 0.9/2.0 · 0.8/1.7 · 0.9/3.8 | 0.6/1.7 · 0.9/1.7 · 1.8/4.2 | 14–27% |
| A1i (`setInterval`, ≈56 Hz) | 6.8/8.0 · 6.9/7.9 · 7.2/8.4 | 6.2/7.6 · 7.3/8.1 · 7.8/8.9 | 15–21% |
| A2 (renderer vsync) | 0.7/1.4 · 2.4/3.4 · 2.6/3.3 | 1.7/2.4 · 1.2/2.2 · 1.7/2.8 | 15–19% |

- **Longest gap** without a move: 36–47 ms in every A run (one or two missed frames, depending on phase).
- **A1's timer** runs at 60.000 Hz against the display's ≈60.0024 Hz, so its phase should drift through every alignment about every 7 minutes. *Derived from the rates, not observed: each probe run covered 17 s.*

### Render rate vs cost (static pet; A2 and B)

The §11 budget (< 3% roaming, < 1% asleep/hidden) depends far more on frame rate than on A vs B.

- **How:** the same harness with a render-rate cap (`--render-fps`), 2 interleaved runs per point.
- **Run differences:** 15 s runs (13 s measured), probe off, run after the main benchmark. At 60 fps they read 2–3 points higher than the benchmark's static runs.

| Actual frame rate | A2 total | B total | Renderer + GPU process |
|---|---|---|---|
| 0 (nothing drawn; sim still runs) | 2.2–2.5 | 2.0–2.3 | ≈0.7 |
| 10.6 | 9.0–9.4 | 8.7–8.9 | ≈7.2–7.4 |
| 16.5 | 10.4–10.7 | 9.5–11.3 | ≈8.2–9.8 |
| 30.4 | 15.6–15.9 | 14.7–15.8 | ≈13.4–14.4 |
| 60 | 27.2–28.0 | 25.5–26.3 | ≈24.5 |

- **The 12 and 20 fps batch.** An earlier batch had a scheduling bug and rendered at 12 and 20 fps instead of its targets. Those points fit the same curve: 9.1–9.6 and 11.0–13.6.
- **Per-frame cost.** Rendering costs about 4 ms of CPU per frame at 60 fps, and about 6–7 ms per frame at 10 fps.
- **Where the cost probably goes (inferred).**
  - The renderer's own JavaScript in `pet.render()` is only 0.30–0.49 ms per frame (mean; p95 ≈0.7 ms).
  - The GPU process executing the WebGL commands is mixed in with compositing; no empty-scene control run separated the two.
  - So "the Electron/Chromium frame pipeline dominates" is likely but not proven.
  - Why low frame rates cost more per frame is also untested.

### Interactive properties

These come from Electron 44's sources and docs plus automated checks; the click and focus parts are unverified.

- **Focus.** `type: 'panel'` makes an `ElectronNSPanel` whose `styleMask` reports `NSWindowStyleMaskNonactivatingPanel`.
  - Electron fixed `focus()` and `show()` on panels so they don't activate the app on Sonoma and later ([#40307](https://ayakael.net/mirrors/electron/commit/b55d7f4a16293164693618b8a0822370f7f4d46c), [#41750](https://ayakael.net/mirrors/electron/commit/05fba85aa38dba54e513cca786ed8ffac1f9f6a5)). We never call `focus()`; we use `showInactive()`.
  - **Clicks are unverified, and AppKit warns about the style (see above).**
  - Panel focus behavior has changed between Electron versions. **Pin Electron's major version**, and repeat check 1 on every upgrade.
- **Click-through.** `setIgnoreMouseEvents(true, {forward: true})` plus a raycast hit test against invisible proxies (mean halo ≈2 pt, max 6 pt around the antenna tip). A safety net in main forces click-through whenever the cursor is outside the pet's box.
  - Known gap: a pet walking under a *still* cursor generates no mouse event. Main's cursor poll covers that in the hardened design.
- **Level.** Layer 3 (`floating`): above app windows (0), below the Dock (20), the menu bar (24) and status items (25). Measured with `CGWindowList` (`spike-results/windows-final-dev.json`). Spotlight and Notification Center are part of check 5.
- **Fullscreen** (§12 "hidden in fullscreen Spaces"): **pending.**
  - Electron's panel overrides `setCollectionBehavior:` to always add `CanJoinAllSpaces | FullScreenAuxiliary`. So a *panel* overlay can't be kept off fullscreen Spaces, and would have to rely on the helper's fullscreen detection. That detection is unverified on device, and doesn't see Split View (input-and-helper.md).
  - The hardened design avoids this by not making the overlay a panel. *Not yet observed:* no `--window-type=none` run has been made in a fullscreen Space.
- **Mission Control.** `hiddenInMissionControl` (Transient collection behaviour).
- **Dock icon.** `setVisibleOnAllWorkspaces` needs `skipTransformProcessType: true`. Without it Electron transforms the process type and the agent app gets a Dock icon.

### Risk to raise now: §11's budget vs "feels alive"

§11 asks for under 3% average while roaming, and also for 30 fps idle and 60 fps moving.

- **Here:** 30 fps idle rendering alone costs ≈15% of a core, and 60 fps while moving ≈25%.
- **No clean number yet.** These come from an M4 on battery under load, while §11 targets an M1-class Mac. The two effects pull in opposite directions.
- **The real conflict is between two §2 principles.** A continuous idle bob and antenna sway (§6.4) mean continuous rendering ("Feels alive"), and that is what blows the budget ("Light on resources").

**Options**, to decide before M2 builds the animator:

- **(a)** Relax §11, for example to ≈8–10% roaming on M1-class hardware, and keep a continuous idle at ≈15 fps.
- **(b)** Keep 3%: an idle that is mostly still and animates on events (blinks, glances, small hops), rendering only when something changes. Moving at 60 fps stays expensive while it lasts.
- **(c)** Prototype the cheaper idle in M2 (event-driven frames, a lower pixel ratio, or idle loops pre-rendered to sprites the compositor plays) and decide with numbers.

**Recommendation: (c).** Re-measure on AC power with other apps closed before treating any absolute number as final.

**Decided 2026-10-07: (c).** The user approved prototyping an event-driven idle in M2. M1 already renders on demand: 0 frames while the pet stands still.
