# Bitbot

A macOS desktop pet that lives on your screen and is fed by how you use your computer. The spec is [`BITBOT_SPEC.md`](BITBOT_SPEC.md).

**Status:** Milestone 9 (performance pass) is done: Phase 1's milestones are all built. The manual checks on the real app ([`docs/decisions/overlay.md`](docs/decisions/overlay.md) "Manual checks") are still to run.
- Bitbot runs as a menu-bar app with no Dock icon.
- The Mint pet is alive: it blinks, looks at the cursor, stirs now and then, swings when you drag it, and squashes when it lands.
- It lives on your screen: it walks along the Dock, climbs the screen's edges and your windows' sides, jumps and drops between window tops, rides a window you move, and falls when you close or fling it.
- It has needs (§9: hunger, energy, fullness, boredom, dust) and moods, and a brain (§10.2) that picks what to do from them: go eat on the front window, nap, explore, climb, sit, peek, come look at your cursor. Open an app and it runs over to eat. Leave the computer idle for 10 minutes and it goes home to sleep; come back and it stretches, yawns and greets you. Long sessions without a break make it stuffed (slower, earns half).
- Modes (§10.3): Roam (the default), Stay (it stays put; ⌥⌘S toggles it), and Hang out at a spot: right-click the pet and choose Hang out here, or, on an app's window, Hang out on <App> (it follows that app's window, and waits on the Dock while the app has none). The menu-bar menu's Mode ▸ switches modes and spots. 
- You can direct it: throw it, pet it, call it with Come here (⌥⌘C), send it home (⌥⌘H: its hangout spot, else the middle of the Dock), or ⌥⌘-click anywhere to send it there (needs Input Monitoring).
- It is fed by how you use your Mac (§7): crumbs from keys, pellets from clicks and scrolls, treats from opening apps, mileage from moving the mouse, sparks from breaks and healthy habits. Only counts are kept, never what you type or click. The menu-bar menu shows today's totals.
- First launch walks through a short welcome (privacy, the Input Monitoring permission, a name and a colour) and the egg hatches. Settings… (menu bar or right-click) changes the name, colour, size, how restless it is, the hangout spots, the hotkeys and more. Everything is saved and comes back after a restart. Once a day it tells you about yesterday in a little speech bubble. It fades out while a fullscreen app is in front and while the screen is locked.
- Every §6.4 state and mood and every §6.3 face can be shown from the developer panel (dev builds), which also draws the world it sees.
- The tray menu and ⌥⌘B hide and show it.

Decisions so far, with what is measured and what is still to check by hand, are in [`docs/decisions/`](docs/decisions/). The overlay approach is B, hardened.

Code under `src/main/spike/`, `src/renderer/spike/` and `spikes/` is from the §12 spikes. It is kept for reference and the Spike B manual tests, and is not used by the app.

## Setup

Requirements: macOS 13+, Node 22.12+ (developed on Node 26), and Xcode Command Line Tools (`xcode-select --install`) for `swiftc`.

```sh
npm install
node node_modules/electron/install.js   # Electron 44 downloads its binary lazily; do it once up front
bash helper/build-helper.sh             # builds build/helper/bitbot-helper (universal, ad-hoc signed); rerun after helper changes
npm run build
```

**Running Electron from a VS Code terminal or an extension host.** Some VS Code processes export `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node. The npm scripts strip it. When you launch Electron by hand, use `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . …`.

## Running Bitbot

```sh
npm start        # builds, then runs the built app
npm run dev      # the same with hot reload of the pet page
```

- **What you see.** The pet stands on the Dock at the bottom centre of the main display, and a small monitor icon appears in the menu bar.
  - If the menu bar is too full (a notch hides items), use ⌥⌘B instead of the icon.
- **Using it.**
  - Drag the pet to move it: it dangles and swings, and gets dizzy if shaken. Let go and it falls onto the first surface below (a window top or the Dock) and lands. Let go while moving and it is thrown: it flies on, bounces off the screen's sides, and lands dizzy after a hard throw.
  - Click it without dragging to pet it: it blushes and wiggles happily, and stays where it was (on a wall too).
  - **Come here** (⌥⌘C, or the menu-bar menu) sends it to the cursor, or the nearest place it can reach; **Go home** (⌥⌘H) sends it to the middle of the Dock.
  - ⌥⌘-click anywhere sends it there. The click itself still goes to whatever you clicked; Bitbot only listens. It needs Input Monitoring, which dev runs from a terminal don't have (see "Permissions in dev"); the terminal says whether it is on.
  - Right-click it for **Pet**, **Go home** and **Hide**.
  - ⌥⌘B or the menu-bar icon hides and shows it.
  - **Quit Bitbot** is in the menu-bar icon's menu; Ctrl+C in the terminal also quits.
- **The helper is required for grabbing.** `bitbot-helper` tells Bitbot when its overlay is on screen, so the pet can only be grabbed while it runs. Without the built helper the pet shows but can't be grabbed, and the terminal says so.
- **What it sees.** Windows come from `bitbot-helper` (positions, sizes and owners only; never titles). Without the helper the pet stays on the Dock and the screen edges.
- **Movement in the log** (dev builds): a line whenever the pet's behavior, surface or goal changes, e.g. `pet: climb on side:5729:left:0 → 776,280 at 471,920`.
- **Focus check in the log.** After every click, drag or right-click, the terminal prints whether Bitbot took focus: `… -> Bitbot became the active app: NO (PASS)`.
- **Profiles.** Dev runs use their own profile (and save file), `~/Library/Application Support/Bitbot-dev`, and their own single-instance lock, so a dev run and a packaged Bitbot don't block each other. The dev tools (`--snapshot`, `--spike`) use `Bitbot-dev-tools`.

## Tests

```sh
npm test            # type check, Vitest (all pure logic) and the Swift helper checks
npm run typecheck   # both tsconfigs (main/preload/shared/tests and renderer)
```

On macOS, `npm test` fails if `build/helper/bitbot-helper` is missing or older than `helper/Sources`; run `npm run build:helper` first.

## Dev tools

- **Developer panel** (dev builds only: `npm run dev` or `npm start`, not a packaged app): tray icon → **Developer…**. It forces the pet's state, mood, dust, facing, face (eyes, mouth, overlays) and idle style (continuous or event-driven), and shows live what `pet:state` says, the simulation's own state, where the eyes look, and the overlay's renders and frames per second. Closing it puts nothing back; **Reset everything** does. It is the one Bitbot window that takes focus, because you opened it.
- **Dev check of the overlay and its grab area** (the pet appears and moves at the bottom of the screen while it runs, and your mouse is never touched):

  ```sh
  npm run build && env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --check=overlay
  ```

  - It prints PASS/FAIL for each functional check, then the measurement phases (CPU per process, latencies, frames; the idle and asleep cost of each idle style), and exits 0 only if everything passes.
  - Leave the mouse alone while it runs. If the real cursor rests where the pet patrols, macOS sends the grab area buttonless mouse moves, which end the check's synthetic drags (a drag phase then reads "not measured"). The check says so at the end ("WARNING your mouse was over the pet's grab area during …").
  - `--no-measure` skips the measurements. The other options are in the header of [`src/main/dev/overlayCheck.ts`](src/main/dev/overlayCheck.ts).
  - Results go to `spike-results/` (gitignored).
- **Render the pet to a PNG** (no permissions needed):

  ```sh
  env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --snapshot=out.png --palette=mint --bg=checker
  ```

  See [`src/main/dev/snapshot.ts`](src/main/dev/snapshot.ts) for the options; `--state=…` poses the pet, e.g. `--state=sleep --mood=sleepy` or `--state=greet --t=0.6`.
- **Face contact sheet:** `npm run face-sheet` draws every §6.3 face state into [`docs/images/face-sheet.png`](docs/images/face-sheet.png) (layout in [`scripts/face-sheet.mts`](scripts/face-sheet.mts)).
- **Spike harnesses:**
  - Spike A (overlay window): [`spikes/README-overlay.md`](spikes/README-overlay.md).
  - Spike B (input capture, helper): [`spikes/README-input-helper.md`](spikes/README-input-helper.md), including the permission tests on the packaged app (`npm run package:dir`).

## Permissions in dev

macOS charges a permission to the app that *launched* the process.

- **Electron started from a terminal:** your terminal app (or VS Code) is what would need Input Monitoring.
- **The packaged app opened from Finder or with `open`:** Bitbot.app itself.

**Don't grant your terminal or VS Code Input Monitoring.** Everything running under it (extensions, agents, shells) could then read keystrokes. Test input with the packaged app instead (`npm run package:dir`, then `open dist/mac-arm64/Bitbot.app --args …`). Milestone 1 itself asks for no permission at all.

Ad-hoc signed builds lose a grant whenever the app's contents change, so sign dev builds with a "Bitbot Dev" certificate (decided 2026-10-08). Create it once:

1. Open **Keychain Access** (in Applications → Utilities).
2. Menu **Keychain Access → Certificate Assistant → Create a Certificate…**
3. Name: `Bitbot Dev`. Identity Type: **Self Signed Root**. Certificate Type: **Code Signing**. Click **Create**, then **Done**.

From then on `npm run package:dir` signs with it (and the hardened runtime); without it, it signs ad-hoc and says so. Details: [`docs/decisions/input-and-helper.md`](docs/decisions/input-and-helper.md).

**Testing counting with the packaged app:**

```sh
npm run package:dir
open dist/mac-arm64/Bitbot.app
```

Then menu-bar icon → **Input Monitoring is off — Turn on…** → switch **Bitbot** on in System Settings. Counting starts by itself within a few seconds (the menu's "Today:" line starts moving). Quit the dev copy first if one runs: they share nothing, but both draw a pet.

## Where things live

- **Tunable numbers:** every balance and behavior number is in [`src/shared/tuning.ts`](src/shared/tuning.ts).
- **The app (main process):**
  - [`src/main/bitbotApp.ts`](src/main/bitbotApp.ts) wires everything together.
  - [`src/main/sim/`](src/main/sim/): the fixed-step loop, locomotion and the screen area.
  - [`src/main/windows/`](src/main/windows/): the overlay window, the grab area and its safety logic in `petInteraction.ts` and `hitArea.ts`.
  - [`src/main/menus/`](src/main/menus/): the tray icon and menus.
  - [`src/main/hotkeys.ts`](src/main/hotkeys.ts) and [`src/main/activationMonitor.ts`](src/main/activationMonitor.ts).
- **The pet page (renderer):**
  - [`src/renderer/pet/overlay.ts`](src/renderer/pet/overlay.ts) draws and moves the pet and handles the grab area's mouse events.
  - [`src/renderer/pet/character/`](src/renderer/pet/character/) is the §6 character rig. Renders are in [`docs/images/`](docs/images/).
- **Shared contract:** [`src/shared/petProtocol.ts`](src/shared/petProtocol.ts) (overlay messages), `geometry.ts`, `interpolation.ts`, `ipc.ts`.
- **Swift helper:** [`helper/`](helper/). Its protocol (version 3) is mirrored in [`src/main/helper/protocol.ts`](src/main/helper/protocol.ts).

## Privacy

Bitbot contains no network code:

- non-local requests from its web pages are cancelled by a session filter;
- `npm test` scans `src/`, `helper/`, `spikes/` and `scripts/` for network APIs (see [`test/noNetwork.test.ts`](test/noNetwork.test.ts)).

It never stores or logs keys, characters, window titles, URLs or screenshots.

Files written outside the repo:

- **`~/Library/Application Support/Bitbot`** (packaged app), **`Bitbot-dev`** (dev runs) **and `Bitbot-dev-tools`** (dev snapshot and spike runs): Electron's profile, plus `save.json` and its backups `save.json.bak1..3` (§16: the pet's name, colour, settings, modes, needs and daily counts; the bundle IDs of apps opened, for treats; never what you type, window titles or URLs). Settings → Privacy → "Erase all Bitbot data" removes them.
- **`~/Library/Application Support/Bitbot-check`:** the dev check's profile; no personal data, safe to delete.
- **`~/Library/Logs/Bitbot`:** written by packaged spike runs. Those logs list bundle IDs and window positions of open apps, so delete them after testing.
