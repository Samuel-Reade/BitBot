# Bitbot

A macOS desktop pet that lives on your screen and is fed by how you use your computer. The spec is [`BITBOT_SPEC.md`](BITBOT_SPEC.md).

**Status:** the automated parts of the §12 technical spikes are done. The decision records, with the manual checks still pending, are in [`docs/decisions/`](docs/decisions/). Milestone 1 has not started, and the app's entry point only runs dev tools and spike harnesses.

Code kept from the spikes for the milestones:

- the §6 character rig ([`src/renderer/pet/character/`](src/renderer/pet/character/));
- `bitbot-helper` with its TypeScript client and protocol;
- the network lockdown;
- the PNG snapshot tool.

Everything under `src/main/spike/`, `src/renderer/spike/` and `spikes/` is throwaway.

## Setup

Requirements: macOS 13+, Node 22.12+ (developed on Node 26), and Xcode Command Line Tools (`xcode-select --install`) for `swiftc`.

```sh
npm install
node node_modules/electron/install.js   # Electron 44 downloads its binary lazily; do it once up front
bash helper/build-helper.sh             # builds build/helper/bitbot-helper (universal, ad-hoc signed)
npm run build
```

**Running Electron from a VS Code terminal or an extension host.** Some VS Code processes export `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node. The npm scripts strip it. When you launch Electron by hand, use `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . …`.

## Tests

```sh
npm test            # Vitest (all pure logic) + the Swift helper checks
npm run typecheck   # both tsconfigs (main/preload/shared/tests and renderer)
```

## Dev tools and spike harnesses

- **Render the pet to a PNG** (no permissions needed):

  ```sh
  env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --snapshot=out.png --palette=mint --bg=checker
  ```

  See [`src/main/dev/snapshot.ts`](src/main/dev/snapshot.ts) for the options.
- **Spike A (overlay window):** [`spikes/README-overlay.md`](spikes/README-overlay.md), including the interactive checklist.
- **Spike B (input capture, helper):** [`spikes/README-input-helper.md`](spikes/README-input-helper.md), including the permission tests on the packaged app (`npm run package:dir`).

## Permissions in dev

macOS charges a permission to the app that *launched* the process.

- **Electron started from a terminal:** your terminal app (or VS Code) is what would need Input Monitoring.
- **The packaged app opened from Finder or with `open`:** Bitbot.app itself.

**Don't grant your terminal or VS Code Input Monitoring.** Everything running under it (extensions, agents, shells) could then read keystrokes. Test input with the packaged app instead (`npm run package:dir`, then `open dist/mac-arm64/Bitbot.app --args …`).

Ad-hoc signed builds are expected to lose a grant whenever the app's contents change. Details: [`docs/decisions/input-and-helper.md`](docs/decisions/input-and-helper.md).

## Where things live

- **Tunable numbers:** every balance and behavior number is in [`src/shared/tuning.ts`](src/shared/tuning.ts).
- **Swift helper:** [`helper/`](helper/). Its protocol is mirrored in [`src/main/helper/protocol.ts`](src/main/helper/protocol.ts).
- **Character rig:** [`src/renderer/pet/character/`](src/renderer/pet/character/). Renders are in [`docs/images/`](docs/images/).

## Privacy

Bitbot contains no network code:

- non-local requests from its web pages are cancelled by a session filter;
- `npm test` scans `src/`, `helper/`, `spikes/` and `scripts/` for network APIs (see [`test/noNetwork.test.ts`](test/noNetwork.test.ts)).

It never stores or logs keys, characters, window titles, URLs or screenshots.

Files written outside the repo:

- **`~/Library/Application Support/Bitbot`:** Electron's profile; no personal data.
- **`~/Library/Logs/Bitbot`:** written by packaged spike runs. Those logs list bundle IDs and window positions of open apps, so delete them after testing.
