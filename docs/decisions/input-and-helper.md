# Decision record: global input capture and the Swift helper (Spike B)

- **Status:** **decided 2026-10-07**, except decisions 3 and 5 in §6, which wait until M5.
  - The input source is decided: `uiohook-napi` was removed in Milestone 1. Snapshot polling and the degraded mode are decided too.
  - The manual tests (§7) are still to run. Nothing has been run against real keyboard input yet.
- **Dates:** spike 2026-10-06; decisions 2026-10-07. The spec carries dated "Decided" notes at §3, §5.1, §5.3, §7.1 and §11.
- **Spec:** §3, §5.1, §5.3, §5.4, §7.1–§7.3, §8.6, §10.4, §11, §12 (Spike B), §15.1
- **Test machine:** Apple M4 (MacBook Air), macOS 15.6, one built-in Retina display (1710×1107 pt @2x, camera housing), Electron 44.6. Intel Macs and macOS 13–14 were not tested.

## Summary

- **`uiohook-napi` does not behave as §3 and §7.1 assume** (verdict from reading its sources; it was never loaded):
  - it needs **Accessibility**, not Input Monitoring;
  - it installs an **active** event tap, holding each key press while it waits on the app's main thread;
  - it turns every key press into a character in memory.

  **Decided (2026-10-07):** capture input with a listen-only tap inside `bitbot-helper`, which needs only Input Monitoring. `uiohook-napi` was removed from the repo in Milestone 1.
- **The helper's window data matches Electron's to the point** for Bitbot's own windows. Z-order and window layers are right, and app launch and quit events arrive.
  - Not exercised: `appActivated`, fullscreen detection, and multiple displays.
  - Not inspected by eye: other apps' outlines.
- **Fullscreen detection is a blocking unknown** whenever the pet sits in a `panel` window (see §5).
- **Permission attribution:**
  - **dev builds:** the helper's *responsible process* is the terminal app that started Electron (here VS Code);
  - **the packaged app started from Finder or `open`:** Bitbot.app.

  That predicts whose name System Settings shows; test 1 confirms it.
- **Ad-hoc signed builds are expected to lose a grant whenever the app's contents change.** The signature's requirement is a content hash. Not observed, since no grant was ever given.
- **Helper CPU:**
  - 4 Hz: 0.21–0.32%.
  - 15 Hz: **0.70–0.90%**, over §11's 0.5%.
  - 15 Hz is what §5.3 asks for *whenever the pet is on a window*, which can be hours. *Needs a decision* (§6).

## 1. What `uiohook-napi` 1.5.5 actually does on macOS

From its bundled libuiohook sources (`node_modules/uiohook-napi/libuiohook/src/darwin/` of uiohook-napi 1.5.5; the package was removed in Milestone 1). The module was never loaded on this Mac: the harness only checked that it resolved inside the packaged app.

| Spec assumption (§3, §7.1) | Reality | Evidence |
|---|---|---|
| Needs Input Monitoring | Needs **Accessibility**. It calls `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt: true` (the "control this computer" prompt) and refuses to start without it (`UIOHOOK_ERROR_AXAPI_DISABLED`) | `input_helper.c` 43–72; `input_hook.c` 1272, 1407 |
| Listen-only | **Active** tap (`kCGEventTapOptionDefault`, head insert). For **every key press** the tap thread blocks on `dispatch_sync_f` to the app's main queue (Electron's main thread) to look up the character, while macOS holds the key event. A stall in Bitbot's main thread would delay every keystroke system-wide, until macOS times the tap out | `input_hook.c` 1176–1183; 270–326 (`dispatch_sync_f` at 280) |
| Key identity only | Translates every key **press** (not key-ups) to characters with `UCKeyTranslate`. uiohook-napi then drops the text before JavaScript sees it. A library constructor also opens IOHIDSystem as soon as the module loads | `input_hook.c` 206; `input_helper.c` 121–180; `system_properties.c` 450–455 |
| Scroll "ticks" | Wheel events are dispatched only when the whole-line delta is non-zero, so sub-line trackpad movement is lost. libuiohook reads `IsContinuous` (block vs unit scroll), but the JavaScript event (`UiohookWheelEvent`) exposes neither that nor momentum; momentum is never read at all | `input_hook.c` 814–843; `dist/index.d.ts` |

Nothing would be persisted either way. But the onboarding copy in §15.1 ("count how many keys you press") would come with a prompt asking to **control the computer**.

## 2. Recommended: listen-only tap in `bitbot-helper`

Implemented in `helper/Sources/Helper.swift` (`InputTap`) and marked `SPEC-DEVIATION` there and in `src/main/helper/protocol.ts`.

- **Tap:** `CGEvent.tapCreate(.cgSessionEventTap, .tailAppendEventTap, .listenOnly, …)` on its own thread. A listen-only tap can't delay or change events. It is re-enabled after `tapDisabledByTimeout` / `ByUserInput`.
- **Observed events:** `keyDown`/`keyUp`, `left/right/otherMouseDown` and `scrollWheel`. Nothing else: no mouse moves, no drags, no modifier-only presses.
- **What it sends to main:**
  - the key code plus the autorepeat flag, for §7.3 anti-gaming;
  - for clicks, the button and modifiers, plus a location **only on ⌥⌘-clicks** (§10.4). Other clicks carry `x: null, y: null`, so main can't tell which window a click landed in;
  - for scrolls, vertical and horizontal line and pixel deltas, plus the continuous and momentum flags.

  Never characters, and no keyboard-layout APIs anywhere. Key codes cross only the stdout pipe and are never logged.
- **Permission:** only Input Monitoring (`kTCCServiceListenEvent`). The helper checks the grant with `CGPreflightListenEventAccess` and **won't create a tap without it**, so the only prompt ever shown is onboarding's `requestInputAccess` (`CGRequestListenEventAccess`).
- **What it removed (Milestone 1):** a native Node module, its per-architecture prebuilds and its asar-unpack rule.
- **Verified:** 130 Swift checks, using synthesized events that are never posted. They cover the tap masks, the grant gate, the line shapes, and that a location is sent only with ⌥⌘.
- **Not verified:** a real tap on real input. There is no Input Monitoring grant on this Mac, and I ran nothing that could prompt. That is §7, test 1.
- **Things to know:**
  - Keys typed while macOS **Secure Input** is on (password fields, some terminals) never reach a listen-only tap. That's good for privacy, but heavy terminal users will be under-counted.
  - Input Monitoring has **no Info.plist usage string**, so the onboarding copy must explain the prompt.

## 3. Who gets the permission

The helper's `diag` reports its *responsible process* (`responsibility_get_pid_responsible_for_pid`, a private call), which is the identity macOS's permission system checks. System Settings is *expected* to show that app; no prompt or grant has been observed yet (test 1).

| How Bitbot was started | Responsible process | Evidence |
|---|---|---|
| dev: `npm run dev` / `electron .` from a terminal or IDE | the **app that launched it** (here `Visual Studio Code.app`) | diag, many runs |
| packaged, via Finder / `open` | **Bitbot.app** | diag, 4/4 runs (`…/Bitbot.app/Contents/MacOS/Bitbot`), latest with the final build |
| packaged binary run directly from a terminal | the terminal app *(expected, not observed)* | — |

**Dev warning.** Granting Input Monitoring to VS Code (or any terminal) lets *everything* that runs under it read keystrokes: every extension, terminal and agent. **Test input with the packaged app instead.** See README "Permissions in dev".

## 4. Signing and whether grants survive rebuilds

- **What is verified:** an ad-hoc signature's designated requirement is a bare **cdhash**. Two builds today with different contents had different cdhashes: `7c249bcd…` before the latest code changes, `0de0a9b5…` after.
- **What is expected (test 3 confirms):**
  - rebuilding identical sources gives the same cdhash, so a grant survives;
  - any content change gives a new cdhash, so the grant is lost.
- **Proposal:** sign dev builds with a self-signed "Bitbot Dev" certificate, so the requirement stays stable across rebuilds (about 2 minutes in Keychain Access). Developer ID signing stays in Phase 4.
- **The bundle ID `com.bitbot.desktop` is a placeholder.** macOS ties grants to it, so choose the real one before granting anything you mean to keep.
- **Electron fuses** are on in `electron-builder.yml`: RunAsNode, NODE_OPTIONS and inspect off; asar integrity on. They close Electron's own "run arbitrary code as Bitbot" switches. `open` passes the caller's environment through, and processes started by VS Code extensions inherit `ELECTRON_RUN_AS_NODE=1`.
- **Fuses are not sufficient.** Without the **hardened runtime**, dyld still honors `DYLD_*` injection, and injected code would inherit Bitbot's Input Monitoring grant. Any build that holds a real user's grant needs the hardened runtime, with no `allow-dyld-environment-variables` or `disable-library-validation` entitlements.

## 5. Helper validation (§12 Spike B checklist)

| Check | Result |
|---|---|
| Window bounds vs Electron `getBounds()` (Retina @2x) | **Δ = 0 pt** at all 7 positions (work-area corners, centre, half off the right and bottom edges); 5 dev runs and 4 packaged runs. *Bitbot's own windows only*: other apps' outlines were drawn by the debug overlay but not inspected by eye (manual test 5) |
| Displays | `CGDirectDisplayID` 1 = Electron `Display.id` 1, bounds equal. **One display only**: multi-display (§5.3 "verify on a multi-display setup anyway") is **untested** |
| Z-order | Front to back preserved; layers never increase going back |
| Window layers | Overlay 3 (`floating`) < Dock 20 < menu bar 24 < status items 25; app windows 0 |
| App events | `appLaunched` 254–303 ms after `open -g -a Calculator`; `appTerminated` 8.4–8.5 ms after SIGTERM. **`appActivated` never exercised** (`open -g` doesn't activate) |
| Fullscreen | Implemented: §5.3's window rule, plus a camera-housing variant. **Never exercised; blocking** (below) |
| CPU | `ps` cumulative CPU time, edge-aligned, spot-checked against `proc_pid_rusage` (not saved): 4 Hz **0.21–0.32%**, 15 Hz **0.70–0.90%**. Unsaved estimates from the builder's scratch runs: idle ≈0.05–0.07%, 10 Hz ≈0.56% |
| Snapshot round trip | p50 0.4–1.1 ms per run (0.35–1.26 per burst), p95 0.8–7.6 ms, max 9.2 ms (periodic 5–9 ms outliers) |
| Privacy | `kCGWindowName` never read (grep); no networking (grep plus `test/noNetwork.test.ts`); nothing about keys logged |

### Fullscreen detection: a blocking unknown

**Why it blocks.** Electron's `panel` windows always join fullscreen Spaces. Any pet window that is a panel (A2, or plain B) can therefore only be hidden by Bitbot itself, on the helper's `frontmostFullscreen` event. Any gap leaves the pet over every fullscreen app (§2).

**Gaps:**

1. **Fullscreen Spaces themselves.** §5.3's second condition, "the active Space is a fullscreen Space", has no public API and was dropped. **Split View** therefore isn't detected: each app covers only part of the display.
2. **The window rule.** It accepts only the full display bounds, or the area below the 33 pt camera housing, within ±1 pt. Where a native-fullscreen window actually sits on this notched display has never been measured.

**Mitigation in the recommended overlay design** (overlay.md): the visible overlay is *not* a panel, so macOS hides it on fullscreen Spaces by itself, Split View included. *Expected, not yet observed.*

**Test 4** records the real fullscreen window bounds. If neither rectangle matches, widen the rule: full display width, top edge no lower than the menu-bar height.

### Other differences from the spec's picture

- **Menu bar and ceiling:** the menu-bar strip is 0–38 pt, but Electron's work area starts at y = 39. The §8.1 ceiling is 38, not `workArea.y`.
- **Dock:** owns a full-display window at layer 20, and its band is 85 pt tall. The layer-0 rule already excludes that window.
- **Window Server's menu-bar window has no bundle ID,** so §8.2's exclusion has to go by process ID.
- **Camera housing:** safe-area top inset 33 pt (spec deviation in `Helper.swift`).
- **`NSScreen`** (needed for that inset) registers the helper with LaunchServices as a background app. It has no UI. No throttling was seen in a 180 s dev run (unsaved). **App Nap in the packaged app while the pet is hidden is unchecked**, and that is exactly when fullscreen-exit detection matters.
- **Other dev Electron instances** report as `com.github.Electron`. Main ignores its own process.

### Protocol v2 and v3 (additions to §5.3, reflected in `src/main/helper/protocol.ts`)

- **v3 (Milestone 1):** the unsolicited `{"type":"spaceChanged","ts":…}`, sent when the active Space changes. Main hides the pet's grab area at once (docs/decisions/overlay.md). Whether macOS delivers that notification to the helper hasn't been observed on device yet; dev builds log each one.

- **New commands:** `ping`, `displays`, `frontmost`, `appInfo`, `fullscreenState`, `diag`, `quit`, plus the input group: `inputAccess`, `requestInputAccess`, `startInputTap` (keys and mouse both false = stop), `stopInputTap`.
- **New unsolicited messages:**
  - `hello`;
  - **`input`**, in three kinds: `key` {code, down, repeat}, `mouseDown` {button, modifiers, x/y only with ⌥⌘}, `scroll` {lines, px, linesX, pxX, continuous, momentum}.
- **New fields:**
  - `appName` on app events;
  - `displayIds` on `frontmostFullscreen`;
  - `reason` on `inputTap` (`notGranted` / `tapCreateFailed`);
  - `id` on `error`;
  - `id: null` on pushed snapshots;
  - `id` on replies to `fullscreenState`.
- **Command-line flags** carry the `tuning.helper` values.
- **Client:** `HelperClient` restarts the helper with exponential backoff, re-applies the poll rate and tap after a restart, and runs a heartbeat watchdog.

## 6. Decisions (2026-10-07)

1. **Input source: decided, done.** The helper's listen-only tap replaces `uiohook-napi`, which was removed from `package.json`, the lockfile, the Spike B harness and the electron-builder rules in Milestone 1. The spec has dated notes at §3, §5.1 and §7.1; §10.4's "observed via uiohook" now means the helper's tap.
2. **Snapshot rate while the pet is on a window: decided, (d) adaptive** (built in M3). Poll at 4 Hz while attached, switch to 15 Hz on the first observed move of the attached window, and go back after about 1 s of stillness.
   - Rejected alternatives: (a) a constant 15 Hz costs 0.7–0.9%; (b) a private API; (c) 10 Hz is still over budget.
3. **Scroll ticks: decided 2026-10-08 (the user took the proposal).** Built in M5, constants in `tuning.economy.scroll`:
   - notched wheel: |lines| ticks;
   - continuous (trackpad): accumulate |px| into ticks of N pt;
   - ignore momentum and zero-delta gesture edges;
   - cap per second, like §7.3.
4. **Degraded mode without Input Monitoring: decided as recommended.**
   - No clicks or scrolls are counted through any permission-free path.
   - ⌥⌘-click send-to-point is unavailable without the grant; the "Come here" hotkey still works.
5. **Signing and bundle ID: decided 2026-10-08.** Keep `com.bitbot.desktop` as the bundle ID. Sign dev builds with a self-signed "Bitbot Dev" certificate so an Input Monitoring grant survives rebuilds (the user creates it once; steps in README "Permissions in dev").

## 7. Manual tests

Exact steps: `spikes/README-input-helper.md`. Use the packaged app, launched with `open`. **Rebuild it first with `npm run package:dir`**: the copy in `dist/` predates Milestone 1 and still contains uiohook-napi. **Don't grant VS Code Input Monitoring.**

1. **Helper tap with Input Monitoring** *(about 5 min).*
   - Does the prompt name "Bitbot"?
   - Do counts appear after granting?
   - Does an automatic helper restart pick up the grant, so no app relaunch is needed? (This decides §15.1's "Relaunch Bitbot" button.)
2. **Relaunch after the grant** *(2 min).* Also: keys, repeats, clicks, trackpad and wheel scrolling, compared against what you did.
3. **Grant survival** *(optional, 5 min):* an identical rebuild keeps the grant; a changed build loses it.
4. **Fullscreen** *(3 min).*

   ```sh
   cd ~/BitBot && npm run build && env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --spike=windows --duration=0
   ```

   - Put an app into native fullscreen and switch to its Space; leave after about 5 s. Then do the same with Split View.
   - **Judge detection only from the `fullscreen change: value=true/false … displayIds=[…]` lines.** With the default panel window the debug overlay is expected to **stay visible** (a "FAIL fullscreen visibility" line is expected). Rerun with `--window-type=none` to see macOS hide it.
   - While the app is fullscreen, run `build/tools/probe levels --all > ~/Desktop/fs.jsonl` in another terminal. It records the fullscreen window's bounds; bundle IDs and positions only, no titles.
5. **Alignment and activation** *(2 min).* During the same run:
   - check that the debug outlines hug other apps' window edges;
   - click another app and check for an `appActivated` log line.
6. **Clean up afterwards:**

   ```sh
   tccutil reset ListenEvent com.bitbot.desktop
   rm -rf ~/Library/Logs/Bitbot
   ```

   The logs list bundle IDs and positions of your open apps. `~/Library/Application Support/Bitbot` is Electron's profile and holds no personal data.
