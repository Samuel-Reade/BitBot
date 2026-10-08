# Bitbot

A macOS desktop pet that lives on your screen and is fed by how you use your computer. The spec is [`BITBOT_SPEC.md`](BITBOT_SPEC.md).

**Status:** Milestone 1 (skeleton) is built and reviewed. The manual checks on the real app ([`docs/decisions/overlay.md`](docs/decisions/overlay.md) "Manual checks") are still to run.
- Bitbot runs as a menu-bar app with no Dock icon.
- The static Mint pet stands on the Dock. You can drag it, and it drops back down.
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
  - Drag the pet to move it; let go and it falls back down. A click without dragging leaves it where it is.
  - Right-click it for **Hide**.
  - ⌥⌘B or the menu-bar icon hides and shows it.
  - **Quit Bitbot** is in the menu-bar icon's menu; Ctrl+C in the terminal also quits.
- **The helper is required for grabbing.** `bitbot-helper` tells Bitbot when its overlay is on screen, so the pet can only be grabbed while it runs. Without the built helper the pet shows but can't be grabbed, and the terminal says so.
- **Focus check in the log.** After every click, drag or right-click, the terminal prints whether Bitbot took focus: `… -> Bitbot became the active app: NO (PASS)`.
- **Profiles.** Dev runs use their own profile, `~/Library/Application Support/Bitbot-dev`, and their own single-instance lock, so a dev run and a packaged Bitbot don't block each other. The dev tools (`--snapshot`, `--spike`) use `Bitbot-dev-tools`.

## Tests

```sh
npm test            # type check, Vitest (all pure logic) and the Swift helper checks
npm run typecheck   # both tsconfigs (main/preload/shared/tests and renderer)
```

On macOS, `npm test` fails if `build/helper/bitbot-helper` is missing or older than `helper/Sources`; run `npm run build:helper` first.

## Dev tools

- **Developer panel** (dev builds only: `npm run dev` or `npm start`, not a packaged app): tray icon → **Developer…**. It forces the pet's state, mood, dust, facing, face (eyes, mouth, overlays) and idle style (continuous or event-driven), and shows live what `pet:state` says, the simulation's own state, where the eyes look, and the overlay's renders and frames per second. Closing it puts nothing back; **Reset everything** does. It is the one Bitbot window that takes focus, because you opened it.
- **Dev check of the overlay and its grab area** (Milestone 1; the pet appears and moves at the bottom of the screen while it runs, and your mouse is never touched):

  ```sh
  npm run build && env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --check=overlay
  ```

  - It prints PASS/FAIL for each functional check, then the measurement phases (CPU per process, latencies, frames), and exits 0 only if everything passes.
  - Leave the mouse alone while it runs. If the real cursor rests where the pet patrols, macOS sends the grab area buttonless mouse moves, which end the check's synthetic drags (a drag phase then reads "not measured").
  - `--no-measure` skips the measurements. The other options are in the header of [`src/main/dev/overlayCheck.ts`](src/main/dev/overlayCheck.ts).
  - Results go to `spike-results/` (gitignored).
- **Render the pet to a PNG** (no permissions needed):

  ```sh
  env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --snapshot=out.png --palette=mint --bg=checker
  ```

  See [`src/main/dev/snapshot.ts`](src/main/dev/snapshot.ts) for the options.
- **Spike harnesses:**
  - Spike A (overlay window): [`spikes/README-overlay.md`](spikes/README-overlay.md).
  - Spike B (input capture, helper): [`spikes/README-input-helper.md`](spikes/README-input-helper.md), including the permission tests on the packaged app (`npm run package:dir`).

## Permissions in dev

macOS charges a permission to the app that *launched* the process.

- **Electron started from a terminal:** your terminal app (or VS Code) is what would need Input Monitoring.
- **The packaged app opened from Finder or with `open`:** Bitbot.app itself.

**Don't grant your terminal or VS Code Input Monitoring.** Everything running under it (extensions, agents, shells) could then read keystrokes. Test input with the packaged app instead (`npm run package:dir`, then `open dist/mac-arm64/Bitbot.app --args …`). Milestone 1 itself asks for no permission at all.

Ad-hoc signed builds are expected to lose a grant whenever the app's contents change. Details: [`docs/decisions/input-and-helper.md`](docs/decisions/input-and-helper.md).

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

- **`~/Library/Application Support/Bitbot`** (packaged app), **`Bitbot-dev`** (dev runs) **and `Bitbot-dev-tools`** (dev snapshot and spike runs): Electron's profile; no personal data.
- **`~/Library/Application Support/Bitbot-check`:** the dev check's profile; no personal data, safe to delete.
- **`~/Library/Logs/Bitbot`:** written by packaged spike runs. Those logs list bundle IDs and window positions of open apps, so delete them after testing.
