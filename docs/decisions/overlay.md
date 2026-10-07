# Decision record: overlay window approach (Spike A)

- **Status:** **provisional recommendation.**
  - The automated measurements are done.
  - Not yet built: the input "hit window" that the recommended design depends on.
  - Not yet verified: clicks, focus and fullscreen hiding. **Focus gates everything.**
- **Date:** 2026-10-06
- **Spec:** §2, §5.1, §5.2, §8.6, §8.7, §9.4, §11, §12 (Spike A)
- **Measured on:** Apple M4 (MacBook Air), macOS 15.6, one 60 Hz Retina display (1710×1107 pt @2x), Electron 44.6 (Chrome 152).

## Recommendation

**Approach B, hardened — provisionally.**

- **Overlay.** One transparent overlay window draws the pet on a small canvas. The canvas moves only by compositor transforms (`translate3d`); the window itself never moves. The overlay **never accepts mouse input**: `setIgnoreMouseEvents(true)` once, with no forwarding.
- **Hit window.** A small invisible window takes the clicks, and only while the cursor is near the pet.
- **M1 starts by building and measuring that hit window.** If it fails any check below, fall back to **A2**: a small window moved on every renderer frame, already implemented and measured here.

The proposed design and what is still unknown:

1. **The overlay is not a panel.** It never takes clicks, so it doesn't need Electron's non-activating `panel` type. As a normal window with `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: false})`, macOS itself should keep it off fullscreen Spaces, Split View included. *Expected from Electron's sources; not yet observed.*
2. **The hit window is a small panel.** It is opened with `window.open` from the overlay's renderer, so it should share that renderer process: no extra process, and mouse events handled in the overlay's own JavaScript. *Process sharing and the event path: to verify in M1.*
   - Main moves the hit window over the pet only when its cursor poll (20 Hz, already needed for mileage, §7.1) sees the cursor near the pet.
   - It is hidden whenever the overlay isn't on screen, which the helper's on-screen window list tells us.
3. **The 30 Hz simulation stays in main** (§5.1). The renderer interpolates and moves the canvas, so `§5.1 "position is handled by window placement"` and §5.2's window settings change. These are spec edits to approve.

**Focus gates both A2 and B.** Both rely on a `panel` window to keep clicks from activating Bitbot (§2: "must never steal focus"). AppKit logs *"NSWindow does not support nonactivating panel styleMask 0x80"* for Electron's panel, a known Electron issue ([#35815](https://redirect.github.com/electron/electron/issues/35815)). Nobody has clicked the pet yet.

If manual check 1 fails, the fallback is a truly non-activating native `NSPanel` for the hit window, hosted by the Swift helper or a small native module. That would be an architecture change.

## Why B over A

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

## How it was measured

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

## Results (medians of 3 runs; CPU in % of one core)

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

### Window motion as the window server saw it (A only; 3 runs each)

The figures are the % of moving frames with no window update, shown as "best alignment / average over alignments". Best alignment is a lower bound. The probe can't see the display's real vsync phase.

| Variant | Walk | Synthetic | Worst alignment (0 or ≥2 updates) |
|---|---|---|---|
| A1 (deadline timer) | 0.9/2.0 · 0.8/1.7 · 0.9/3.8 | 0.6/1.7 · 0.9/1.7 · 1.8/4.2 | 14–27% |
| A1i (`setInterval`, ≈56 Hz) | 6.8/8.0 · 6.9/7.9 · 7.2/8.4 | 6.2/7.6 · 7.3/8.1 · 7.8/8.9 | 15–21% |
| A2 (renderer vsync) | 0.7/1.4 · 2.4/3.4 · 2.6/3.3 | 1.7/2.4 · 1.2/2.2 · 1.7/2.8 | 15–19% |

- **Longest gap** without a move: 36–47 ms in every A run (one or two missed frames, depending on phase).
- **A1's timer** runs at 60.000 Hz against the display's ≈60.0024 Hz, so its phase should drift through every alignment about every 7 minutes. *Derived from the rates, not observed: each probe run covered 17 s.*

## Render rate vs cost (static pet; A2 and B)

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

## Interactive properties

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

## Risk to raise now: §11's budget vs "feels alive"

§11 asks for under 3% average while roaming, and also for 30 fps idle and 60 fps moving.

- **Here:** 30 fps idle rendering alone costs ≈15% of a core, and 60 fps while moving ≈25%.
- **No clean number yet.** These come from an M4 on battery under load, while §11 targets an M1-class Mac. The two effects pull in opposite directions.
- **The real conflict is between two §2 principles.** A continuous idle bob and antenna sway (§6.4) mean continuous rendering ("Feels alive"), and that is what blows the budget ("Light on resources").

**Options**, to decide before M2 builds the animator:

- **(a)** Relax §11, for example to ≈8–10% roaming on M1-class hardware, and keep a continuous idle at ≈15 fps.
- **(b)** Keep 3%: an idle that is mostly still and animates on events (blinks, glances, small hops), rendering only when something changes. Moving at 60 fps stays expensive while it lasts.
- **(c)** Prototype the cheaper idle in M2 (event-driven frames, a lower pixel ratio, or idle loops pre-rendered to sprites the compositor plays) and decide with numbers.

**Recommendation: (c).** Re-measure on AC power with other apps closed before treating any absolute number as final.

## Follow-ups for M1 (if you approve B)

1. **Check 1 (focus) first.** If it fails, stop and redesign the hit window (native `NSPanel`).
2. **Build the hit window and measure it:**
   - process sharing via `window.open`;
   - main CPU and lag while it tracks a walking pet with the cursor near;
   - extra memory;
   - drag latency.

   Fall back to A2 if it lags or costs more than A.
3. **Make the overlay a non-panel window** and confirm macOS hides it on fullscreen Spaces and in Split View.
4. **Carry over the spike's pieces:** interpolation, device-pixel snapping and the click-through safety net.

## Manual checks

Each takes about 2 minutes. Start with:

```sh
cd ~/BitBot && npm run build
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --spike=overlay --variant=B --mode=interactive --duration=0
```

Press Ctrl+C once to stop. These checks run on **plain B**, the spike's version, so they don't cover the hit window, which doesn't exist yet. The focus result applies to any `panel` window, including the hit window.

1. **Focus (the gate).** Click into TextEdit so it is frontmost with a caret. Then click, drag and right-click the pet, and type right away: the text must land in TextEdit.
   - The terminal prints `… -> Bitbot became the active app: NO (PASS)` per interaction.
   - Repeat with `--window-type=none` to compare.
2. **Click-through:** click and scroll in the app right next to the pet; everything must reach that app.
3. **Smoothness:** run A2 and B one after the other in `--mode=walk`, `--mode=synthetic` and `--mode=follow` (move the mouse fast). Any hitches or uneven speed in either?
4. **Fullscreen:** put an app into native fullscreen and switch to its Space, then try Split View.
   - With the default panel window, the pet **stays visible**: expected, since panels join fullscreen Spaces.
   - Then repeat with `--window-type=none`: the pet should disappear.
5. **Level:** the pet stays under Spotlight (⌘Space), Notification Center, the menu bar and the Dock.
6. **Screenshot picker:** press ⌘⇧4 then Space and hover over app windows. Does the picker still select them, or does it pick Bitbot's display-sized overlay?
