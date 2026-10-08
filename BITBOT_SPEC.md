# Bitbot — Implementation Spec

A macOS desktop pet that lives on your screen and is fed by how you use your computer.

This document is written for Claude Code. It describes the full product vision in phases, but **only Phase 1 is to be built now**. Phases 2–4 are described so that the architecture, data model, and character rig leave room for them. Do not implement Phase 2+ features unless asked; do design for them.

---

## 0. How to use this document

1. Read the whole doc once before writing code.
2. Start with the **technical spikes** in §12 — they de-risk the two hardest parts (the overlay window approach and global input capture) before building on top of them.
3. Build Phase 1 in the milestone order given in §13. Each milestone ends in something runnable.
4. All tunable numbers live in one file (`src/shared/tuning.ts`). Never hard-code a balance number elsewhere.
5. When this doc and your judgment conflict on a low-level detail, prefer whatever keeps the **design principles** (§2) intact, and leave a `// SPEC-DEVIATION:` comment explaining why.

---

## 1. Product summary

Bitbot is a small 3D creature shaped like a chunky little CRT monitor with a pixel-art screen face and a cable antenna. It roams freely across the macOS desktop: walking on the dock, climbing screen edges, sitting on top of app windows, riding windows when you drag them, and falling off when you close them.

It is fed by real computer activity — keystrokes, clicks, scrolling, mouse movement, opening apps, waking the computer, and taking healthy breaks. Each kind of activity is a different food/currency. The mix of what it eats (its "diet") shapes what it eventually evolves into. Once it reaches its final form, the same activity becomes spendable currency for customizing the character and buying furniture/hangout spots.

The user can let it roam, tell it to stay put, or give it a home spot ("hangout") to return to — including spots attached to a specific app's window.

**Name conventions:** the app and species are "Bitbot". Each user names their own pet at hatch (e.g. "your Bitbot, Nibs").

---

## 2. Design principles (non-negotiable)

1. **Privacy first.** Bitbot never records what is typed or clicked. Only aggregate counts are persisted. Key/button identity may be inspected transiently in memory for anti-gaming checks (§7.3) and is then discarded. No keystroke contents, window titles, URLs, or screenshots are ever read, stored, or transmitted. **The app makes zero network requests.** Onboarding must say this plainly.
2. **Never in the way.** Clicks pass through everything except the pet itself. It hides during fullscreen apps. It can be hidden or parked instantly by hotkey. It must never steal focus.
3. **Rewards a healthy rhythm, not maximum screen time.** Diminishing returns on every currency, a "stuffed" state during long unbroken sessions, and the rare currency (Sparks) is earned through breaks, returns, and streaks.
4. **Never punishes.** The pet never dies and never loses progress. Neglect makes it dusty/sleepy/sad and pauses progress; returning makes it happy immediately.
5. **Light on resources.** It runs all day. Target budgets in §11.
6. **Feels alive.** Idle animation, blinking, antenna motion, and reactions matter more than feature count.

---

## 3. Platform and stack

| Concern | Choice |
|---|---|
| Platform | macOS 13+ (Apple silicon and Intel) |
| App shell | Electron (latest stable), TypeScript strict mode |
| Build | electron-vite (or Vite + electron-builder); electron-builder for packaging |
| Rendering | three.js (latest stable, ES modules), WebGL, procedural geometry (no external model files in Phase 1) |
| Settings / onboarding UI | Plain TypeScript + lightweight UI (Preact or vanilla). No heavy framework needed. |
| Global input | `uiohook-napi` (listen-only; requires macOS **Input Monitoring** permission) |
| Window geometry, app launch events, fullscreen detection | Small bundled **Swift helper** binary (`bitbot-helper`) communicating over stdin/stdout JSON lines (§5.3) |
| Power / idle / lock | Electron `powerMonitor` (`suspend`, `resume`, `lock-screen`, `unlock-screen`, `getSystemIdleTime()`) |
| Cursor position | Electron `screen.getCursorScreenPoint()` (no permission needed) |
| Persistence | JSON file in `app.getPath('userData')`, atomic writes |
| Tests | Vitest for all pure logic (economy, anti-gaming, needs, surfaces, state machine) |

The app is an **agent app**: no Dock icon (`app.dock.hide()`), lives in the menu bar (Tray) plus the pet overlay.

> **Decided 2026-10-07:** global input (keys, clicks, scrolls) comes from a listen-only event tap inside `bitbot-helper`, which needs only Input Monitoring. `uiohook-napi` is not used: it needs Accessibility and installs an active tap. See [docs/decisions/input-and-helper.md](docs/decisions/input-and-helper.md).

---

## 4. Phased roadmap

### Phase 1 — Core companion (BUILD NOW)
- Onboarding: welcome, privacy explanation, Input Monitoring permission request, choose name + color palette, short egg-hatch animation → pet appears in **base form**.
- The 3D base character (§6) with full idle animation set and pixel-face moods.
- Overlay window with click-through except on the pet.
- World model: dock/ground, screen edges, window top edges and sides (§8).
- Movement: walk, run, climb, sit, jump/drop between surfaces, ride moving windows, fall when a window closes or is flung.
- Drag-and-drop the pet; toss with simple physics.
- Activity ingestion for all five currencies with anti-gaming (§7).
- Ledger tracking of all currencies and diet ratios from day one (even though the shop isn't built yet).
- Needs model: hunger, energy, fullness, boredom, dust → mood (§9).
- Healthy-rhythm rules: stuffed state, breaks, sleep (§9.3).
- Modes: Roam (default), Stay, Hangout — with saved hangout spots, including app-anchored spots (§10).
- Directing: "come here", modifier-click to send, send home.
- Reacts to app launches: runs to the new app's window to eat.
- Hides during fullscreen apps; manual hide hotkey.
- Menu bar menu, right-click menu on pet, settings window.
- Daily summary speech bubble.
- Save/load with schema versioning.
- Developer panel for simulating events and time (§14).

### Phase 2 — Growth (design for, don't build)
- Full lifecycle: Egg → Hatchling → Base → Final. New users start at Egg/Hatchling; Phase 1 users already at Base keep their pet.
- Final form chosen by diet vector (§7.5). Four final forms: **Typist** (keyboard-heavy), **Navigator** (clicks/scroll/mileage-heavy), **Hopper** (app-launch-heavy), **Keeper** (balanced + high Sparks).
- Evolution ceremony animation.
- Stats window with daily/weekly history charts.

### Phase 3 — Economy and customization (design for, don't build)
- Unlocks when the pet reaches final form: activity pays out as spendable wallet balances in each currency.
- Shop with items priced in currency **mixes**; rotating daily items.
- Item categories: colors/patterns, hats & accessories (attach points, §6.5), screen-face themes, emotes/animations, hangout furniture (bed, chair on window edge, hammock between two windows, tiny desk on the dock), companion items.
- Diet-themed items.

### Phase 4 — Polish and distribution (design for, don't build)
- Optional sound effects (off by default).
- Multi-display support (walk across displays).
- Rebirth: retire a final-form pet to a collection shelf, hatch a new egg (possibly a new species), keep some items.
- Multiple simultaneous pets.
- Code signing, notarization, auto-update, launch-at-login polish.

---

## 5. Architecture

### 5.1 Processes

```
┌─────────────────────────── Electron main process ───────────────────────────┐
│  Simulation (fixed 30 Hz tick)                                               │
│   ├─ ActivityIngest  ← uiohook-napi, powerMonitor, cursor poll, helper events│
│   ├─ AntiGaming      → credited events                                       │
│   ├─ Economy/Ledger  → currencies, diet, daily curves                        │
│   ├─ Needs           → hunger/energy/fullness/boredom/dust → mood            │
│   ├─ WorldModel      ← helper window snapshots → surfaces                    │
│   ├─ Brain           → behavior selection (utility AI) + mode rules          │
│   ├─ Locomotion      → position, velocity, current surface, physics          │
│   └─ Persistence     → save file                                             │
│  PetWindowController → positions the overlay window, toggles click-through   │
│  Tray / Menus / Hotkeys / Settings & Onboarding windows                      │
└──────────────┬───────────────────────────────────────────────┬──────────────┘
               │ IPC (pose/state @ 30 Hz)                      │ stdin/stdout JSON lines
     ┌─────────▼─────────┐                            ┌────────▼─────────┐
     │ Pet renderer      │                            │ bitbot-helper    │
     │ (three.js)        │                            │ (Swift)          │
     │ renders pose,     │                            │ window list,     │
     │ face, animation;  │                            │ app launches,    │
     │ hit-testing       │                            │ frontmost app,   │
     └───────────────────┘                            │ fullscreen state │
                                                      └──────────────────┘
```

**The simulation is authoritative and lives in the main process.** The renderer is a view: it receives a compact state message (position is handled by window placement; renderer gets facing direction, animation state, mood, face state, need levels for cosmetic cues, and events like "eat" or "land") and renders/animates it. All game logic must be pure TypeScript modules with no Electron imports so they can be unit-tested.

> **Decided 2026-10-07 (approach B, hardened):** the overlay window never moves. The renderer moves the pet's small canvas itself, interpolating main's 30 Hz states, so "position is handled by window placement" no longer applies. Input from `bitbot-helper` replaces uiohook-napi in ActivityIngest. See [docs/decisions/overlay.md](docs/decisions/overlay.md) and [docs/decisions/input-and-helper.md](docs/decisions/input-and-helper.md).

### 5.2 Overlay window approach

Two candidate approaches — **evaluate in Spike A (§12)** and pick one:

- **A. Small moving window (preferred if smooth).** A transparent, frameless, non-focusable `BrowserWindow` about 2.5× the pet's on-screen size (e.g. 240×240 pt for a ~96 pt pet), moved with `setBounds`/`setPosition` each tick to follow the pet. Lowest GPU/compositing cost.
- **B. Fullscreen overlay.** One transparent window covering the display's full bounds; the canvas renders only the pet. Smoothest motion but higher compositing cost.

Common window settings either way:
- `transparent: true, frame: false, hasShadow: false, resizable: false, focusable: false, skipTaskbar: true, fullscreenable: false`
- `setAlwaysOnTop(true, 'floating')` (verify it sits above normal windows but below system UI; try `'pop-up-menu'` if needed)
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })`
- `setIgnoreMouseEvents(true, { forward: true })` by default. The renderer hit-tests the pet (raycast against a simplified collision mesh or the rendered alpha) on forwarded mousemove and asks main to toggle `setIgnoreMouseEvents(false)` while the cursor is over the pet, and back to `true` when it leaves.
- Never call `focus()` on the overlay. Dragging the pet must not activate Bitbot or change the frontmost app.

> **Decided 2026-10-07: approach B, hardened.** One display-sized transparent overlay (a normal window, not a panel) draws the pet and never takes mouse input: `setIgnoreMouseEvents(true)` without forwarding. A small invisible "grab area" window (a non-activating panel opened from the overlay's page, sharing its renderer process) takes the pet's clicks. It is shown only while the cursor is near the pet and the overlay is on screen. See [docs/decisions/overlay.md](docs/decisions/overlay.md).

### 5.3 Swift helper protocol

`bitbot-helper` is a small Swift command-line program compiled by a build script (`swiftc`) and bundled via electron-builder `extraResources`. Main spawns it at startup and restarts it if it exits.

Messages are newline-delimited JSON.

**Main → helper**
```json
{"type":"snapshot","id":42}
{"type":"setPollRate","hz":4}
```

**Helper → main**
```json
{"type":"snapshot","id":42,"ts":1730000000.123,"windows":[
  {"wid":1234,"pid":567,"bundleId":"com.apple.Safari","layer":0,
   "x":100,"y":80,"w":1200,"h":800,"onScreen":true,"alpha":1}
]}
{"type":"appLaunched","bundleId":"com.spotify.client","pid":890,"ts":...}
{"type":"appActivated","bundleId":"com.apple.Safari","pid":567,"ts":...}
{"type":"appTerminated","bundleId":"...","pid":...,"ts":...}
{"type":"frontmostFullscreen","value":true,"bundleId":"..."}
```

Implementation notes:
- Windows from `CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)`. The array is **front-to-back z-order** — preserve it. Use only bounds, layer, owner PID, owner bundle ID (via `NSRunningApplication(processIdentifier:)`), alpha, and window number. **Do not read `kCGWindowName`** (it requires Screen Recording permission and is not needed).
- Coordinates: CG global coordinates are top-left origin in points, matching Electron's `screen` coordinates. Verify on a multi-display setup anyway.
- App events from `NSWorkspace.shared.notificationCenter` (`didLaunchApplicationNotification`, `didActivateApplicationNotification`, `didTerminateApplicationNotification`). Requires a running RunLoop.
- Fullscreen heuristic: frontmost app has a layer-0 window whose bounds equal its display's full bounds (not just the visible frame), or the active Space is a fullscreen Space. Emit changes only.
- The helper may also push snapshots on its own at the requested poll rate; main will request **4 Hz normally, 15 Hz while the pet is standing on or climbing a window**, and 1 Hz while the pet is asleep.

> **Decided 2026-10-07:** while the pet is on a window, poll at 4 Hz and switch to 15 Hz only while that window is actually moving, back after about 1 s of stillness (15 Hz all the time costs the helper 0.7–0.9% CPU). The helper also pushes `spaceChanged` when the active Space changes (protocol 3). See [docs/decisions/input-and-helper.md](docs/decisions/input-and-helper.md).

### 5.4 Suggested repo layout

```
bitbot/
  package.json
  electron.vite.config.ts
  electron-builder.yml
  helper/
    Sources/main.swift          # bitbot-helper
    build-helper.sh
  src/
    shared/
      tuning.ts                 # ALL balance + behavior constants
      types.ts                  # save schema, IPC messages, enums
      ipc.ts                    # channel names + typed payloads
    main/
      index.ts                  # app lifecycle, agent mode, tray
      sim/
        loop.ts                 # fixed-step 30 Hz simulation loop
        activity/ingest.ts      # uiohook, powerMonitor, cursor polling
        activity/antiGaming.ts
        economy/ledger.ts
        economy/curves.ts
        needs/needs.ts
        needs/mood.ts
        world/worldModel.ts     # windows → surfaces graph
        world/geometry.ts       # visible-segment math, occlusion
        brain/brain.ts          # utility AI + mode rules
        brain/stateMachine.ts
        locomotion/locomotion.ts
        locomotion/physics.ts
      helper/helperClient.ts
      windows/petWindow.ts
      windows/settingsWindow.ts
      windows/onboardingWindow.ts
      menus/tray.ts
      menus/petContextMenu.ts
      hotkeys.ts
      persistence/save.ts
      persistence/migrations.ts
      permissions.ts
      dev/devPanel.ts
    renderer/
      pet/
        main.ts                 # three.js scene, render loop, IPC
        character/buildBitbot.ts
        character/face.ts       # 128x96 pixel face canvas
        character/animator.ts   # procedural animation per state
        character/attachPoints.ts
        hitTest.ts
        bubble.ts               # speech bubble (HTML overlay in pet window)
      settings/
      onboarding/
      devpanel/
  test/
```

---

## 6. The character

The base form must match the approved concept render. It is built procedurally in three.js. Units below are scene units; the whole pet is ~2.4 units tall including antenna and is scaled so the body is **~96 pt tall on screen at the default "Medium" size** (Small ≈ 64 pt, Large ≈ 128 pt).

### 6.1 Construction (base form)

All rounded boxes are made by extruding a rounded-rectangle `Shape` with `ExtrudeGeometry` (bevel enabled, `bevelSegments: 8`, `curveSegments: 16`), then `geometry.center()`.

| Part | Geometry | Size / position | Material |
|---|---|---|---|
| Body | rounded box | w 1.6, h 1.3, corner r 0.32, depth 0.9, bevel 0.14; at origin | primary color, `MeshStandardMaterial` roughness 0.42, metalness 0.05 |
| Rear casing (CRT back) | rounded box | w 1.05, h 0.85, r 0.28, depth 0.45, bevel 0.12; z = −0.72 | secondary color, roughness 0.5 |
| Side vents | 4 thin boxes per side | 0.03 × 0.06 × 0.5; x = ±0.94; y from 0.2 down in steps of 0.13; z = −0.05 | outline color |
| Screen bezel | rounded box | w 1.22, h 0.94, r 0.18, depth 0.04, bevel 0.03; (0, 0.1, 0.6) | outline color |
| Screen | `PlaneGeometry` 1.06 × 0.79, 12×12 segments, vertices pushed so z = 0.06 − (x²+y²)·0.08 (slight CRT bulge) | (0, 0.1, 0.6) | `MeshBasicMaterial` with face `CanvasTexture` (unlit so it reads as a glowing screen) |
| Belly lights | 2 short cylinders r 0.045, rotated to face forward | (−0.55, −0.48, 0.62) "power" green-mint; (−0.40, −0.48, 0.62) amber | emissive |
| Belly keys | 3 small rounded boxes 0.13 × 0.07 | x = 0.25, 0.43, 0.61; y −0.48; z 0.6 | outline color |
| Antenna base | cylinder r 0.09–0.11, h 0.08 | group at (0.15, 0.78, −0.05) | outline color |
| Antenna cable | `TubeGeometry` r 0.035 along Catmull-Rom curve (0,0,0) → (0.02,0.3,0) → (0.12,0.55,0.05) → (0.35,0.66,0.1) | in antenna group | outline color |
| Antenna tip | sphere r 0.1 | (0.38, 0.66, 0.1) in antenna group | accent color, emissive (intensity animated) |
| Arms | capsule = cylinder r 0.11 h 0.3 + two spheres r 0.11 | (±1.0, −0.1, 0.15), base rotation z ∓0.5 | primary color |
| Feet | sphere r 0.22 scaled (1, 0.55, 1.3) | (±0.42, −0.84, 0.12) | secondary color |
| Contact shadow | circle r 1.1, scaled (1, 0.6), black at 12% opacity | y = −0.95, flat | only rendered when standing on a surface; fades with height when falling |

Feet are parented to the root (not the bobbing body) so the body can bob and squash above planted feet.

> **Decided 2026-10-07:** the arms hang down at rest. The base rotation sign is flipped (x = ±1 → z ±0.5), with the same size, centre and tilt magnitude (`BASE_FORM.arms.rotZ = −0.5`; renders in `docs/images/`).

Lighting: hemisphere light (sky white, ground #88aaa5, 0.75), key directional light from upper-right-front (0.9), cool rim light from back-left (#bff5ee, 0.6). Renderer: `alpha: true`, `antialias: true`, sRGB output, pixel ratio capped at 2.

Camera: perspective, FOV 32°, slight top-down angle (camera at y +0.5 relative to target). The pet faces 3/4 toward the viewer by default and turns to face its walking direction (rotate root around Y, eased).

### 6.2 Color palettes (chosen at hatch)

Each palette defines primary, secondary, outline, accent, and screen glow. Ship 6:

| Name | Primary | Secondary | Outline | Accent | Screen glow |
|---|---|---|---|---|---|
| Mint (default, matches concept) | #7FD1C7 | #5FB8AD | #2C5F5A | #F2A65A | #9BF2D8 |
| Peach | #F4B49A | #E2957A | #6B3A2C | #7FD1C7 | #FFE2B8 |
| Lilac | #B9A8EC | #9C88DC | #3F3474 | #F2D25A | #E3DBFF |
| Lemon | #F2D76B | #DDBE4A | #5E4A12 | #6BB6F2 | #FFF4B0 |
| Graphite | #8A8F98 | #6D727B | #25282D | #F25A7A | #B8F2C8 |
| Beige Classic (90s PC) | #E4DCC8 | #CFC5AD | #5C5446 | #5AA0F2 | #A8F0A0 |

Screen background is always near-black (#10201F tinted toward the glow color).

### 6.3 Pixel face

A 128×96 `<canvas>` texture with `NearestFilter` (crisp pixels), redrawn only when the face state changes or animates (not every frame when static). Faint horizontal scanlines every 3 px at ~6% opacity. All face elements drawn in the palette's screen-glow color unless noted.

Face elements are composed from: **eyes** state × **mouth** state × **overlay**.

- Eyes: `open` (14×18 blocks with a 4×4 white highlight), `blink` (16×4 lines), `closed` (lines), `happy` (upside-down-U arcs), `sad` (shorter, top-clipped blocks with slanted brows), `wide` (surprised, larger), `look-left/right/up` (pupil highlight shifted), `dizzy` (spirals/X), `heart`.
- Mouth: `smile` (pixel U), `flat`, `wavy` (hungry), `open-chew-A/B` (alternating at ~12 Hz while eating), `o` (surprised), `yawn`.
- Overlays: `blush` (accent-color pixels on cheeks when happy/petted), `zzz` (floating pixel z's when asleep), `loading` (small spinner while digesting), `static` (noise when annoyed/grumpy), `dust` (grey pixel specks when dusty), `heart-pop`.

Blink: random interval 2–5 s, 120 ms. Eyes track the cursor (look-left/right/up) when the cursor is within ~300 pt and the pet is idle.

### 6.4 Animation (procedural, in `animator.ts`)

Each animation state blends over 150–250 ms. All amplitudes and speeds in `tuning.ts`.

| State | Body | Arms | Antenna | Face |
|---|---|---|---|---|
| Idle | sine bob (2.4 rad/s, amp 0.045) + subtle squash/stretch (±1.2%) | gentle swing ±0.12 rad | sway ±0.12 rad, slow wobble | open, blinking, cursor tracking |
| Walk | bob at step frequency, slight forward lean, feet alternate stepping (lift + forward) | swing opposite to feet | lags behind motion (spring) | open |
| Run | faster, bigger lean, little hops | pumping | streams back | wide/open |
| Climb | body rotated so feet face the wall, alternating arm/foot reach | reaching | hangs with gravity | determined (flat mouth) |
| Sit | body lowered, feet forward and dangling when on an edge (feet swing) | rest on body | relaxed | happy/open |
| Sleep | slow bob (0.9 rad/s, amp 0.02), slumped | limp | droops (−0.5 rad) | closed + zzz; belly power light dims |
| Eat | rapid small bounces | pump inward | perks up | chew A/B; antenna tip flashes |
| Fall | tumble/spin, arms flail | flail | whips | wide/o |
| Land | squash (0.75 y) then overshoot stretch, settle | out | boing | wide → open |
| Held (dragged) | dangles from grab point, swings with drag velocity (pendulum) | dangle | dangles | o or happy (randomized), dizzy if shaken hard |
| Celebrate | jump with spin | up | wiggles fast | happy + heart-pop |
| Peek | half hidden behind a window edge, leans out | one arm on edge | visible | look toward cursor |

> **Decided 2026-10-08:** the pet idles calmly by default: still between short events (a blink, a glance, a breath, an antenna wiggle), about a third of the CPU of the continuous idle in the table above. A way to make Bitbot "busy" comes later. See [docs/decisions/overlay.md](docs/decisions/overlay.md) "M2 measurements".

**Mood cues independent of state** (layered on top):
- Hungry: antenna droops (−0.9 rad), amber light blinks at 3 Hz, wavy mouth when idle.
- Stuffed: slower movement (×0.6), occasional burp face, digest "loading" overlay.
- Sleepy: slower bob, frequent long blinks, yawns.
- Dusty: grey speck overlay on body (decal or vertex color noise) proportional to dust level; face dust overlay.
- Happy/high mood: occasional spontaneous hop or wiggle, blush.

### 6.5 Attach points (for Phase 3 cosmetics)

Define named `Object3D` anchors in the rig now, even though nothing attaches in Phase 1: `head_top`, `head_side_L`, `head_side_R`, `face_screen` (for face themes), `back_casing`, `antenna_tip`, `hand_L`, `hand_R`, `belly`, `foot_L`, `foot_R`. Cosmetic items will be small procedural meshes or GLB files parented to these.

Also design `buildBitbot.ts` to take a `CharacterSpec` (form id, palette, parts list) so Phase 2 final forms can reuse the rig and swap/add parts (e.g. Typist gets long key-cap fingers, Navigator gets a mouse-like cable tail, Hopper gets extra mini-screens on the casing, Keeper gets a rounder body with a little lamp antenna).

---

## 7. Activity, anti-gaming, and economy

### 7.1 Raw activity sources

| Source | How | Permission |
|---|---|---|
| Key down | `uiohook-napi` `keydown` | Input Monitoring |
| Mouse click | `uiohook-napi` `mousedown` | Input Monitoring |
| Scroll | `uiohook-napi` `wheel` (aggregate to "scroll ticks") | Input Monitoring |
| Mouse movement | poll `screen.getCursorScreenPoint()` at 20 Hz, sum distance | none |
| App launch / activation | helper `appLaunched` / `appActivated` | none |
| Wake / unlock / session | `powerMonitor` `resume`, `unlock-screen`; idle from `getSystemIdleTime()` | none |

**If Input Monitoring is not granted**, the app still works in a degraded mode: mileage, treats, and sparks still flow; crumbs and pellets don't. Show a gentle reminder in the tray menu and settings, never a nag popup.

> **Decided 2026-10-07:** keys, clicks and scrolls come from `bitbot-helper`'s listen-only tap (Input Monitoring), not uiohook-napi. Without Input Monitoring, nothing is counted from keys, clicks or scrolls, and ⌥⌘-click send-to-point is unavailable (the Come here hotkey still works). Scroll-tick rules for trackpads are in [docs/decisions/input-and-helper.md](docs/decisions/input-and-helper.md) §6.

> **Decided 2026-10-08:** scroll ticks: a notched wheel counts its lines; a trackpad counts every N pt of scrolling; momentum (the coast after lifting the fingers) and zero-delta gesture edges count nothing; capped per second. The bundle ID stays `com.bitbot.desktop`; dev builds are signed with a self-signed "Bitbot Dev" certificate so the Input Monitoring grant survives rebuilds. See [docs/decisions/input-and-helper.md](docs/decisions/input-and-helper.md) §6.

### 7.2 The five currencies

| Currency | Earned from | Base value per unit | Notes |
|---|---|---|---|
| **Crumbs** | key presses | 0.02 per credited key | most plentiful, least valuable each |
| **Pellets** | clicks; scroll ticks | 0.1 per click; 0.02 per scroll tick | navigation side of computer use |
| **Treats** | app launches/activations | 1 per launch; 2 if not opened in ≥7 days; 5 first-ever launch of that bundle ID | activation (switching to an already running app) = 0.25, max once per app per 10 min |
| **Mileage** | mouse travel | 1 per 5,000 pt moved | ambient, steady |
| **Sparks** | rhythm events | see below | rare |

**Sparks sources:**
- Morning wake (first resume/unlock of the local day): 3
- Welcome back after a break (≥5 min idle, ≤4 h): 1 — max 6 per day
- Healthy session (active ≥25 min followed by a break ≥5 min): 1 — max 4 per day
- Daily streak: +1 per day of streak, capped at +5, awarded at the day's first wake
- Coming back after neglect (≥2 days away): 2 + celebration

"Day" boundaries use local time with a 4:00 AM rollover (late-night work counts as the previous day).

### 7.3 Anti-gaming (credited vs raw)

All checks happen in memory over sliding windows. **No key codes, button identities, or timing traces are persisted.** Only the resulting credited counts are.

- **Auto-repeat:** keydown for a key already held down is ignored. Track held keys in a transient `Set<number>`, cleared on keyup.
- **Same-key hammering:** if the same key code accounts for >60% of the last 40 keydowns, credit those keys at 10%.
- **Robotic timing:** for clicks and keys separately, keep the last 30 inter-event intervals. If the coefficient of variation is < 0.08 (machine-like regularity), credit 0. Humans are irregular.
- **Burst ceiling:** credit at most 15 keys/sec and 8 clicks/sec; anything above is ignored.
- **Mouse jiggle:** mileage only counts movement where the cursor's 2-second bounding box exceeds 40×40 pt (tiny oscillation earns nothing).
- **App flapping:** treats for the same bundle ID at most once per 10 min for activations; relaunching the same app repeatedly within an hour gives only the first launch.

### 7.4 Daily diminishing returns

Each currency has a daily soft cap `S` (tuned so an ordinary full workday lands near it). For each credited event:

```
multiplier = 1 / (1 + (earnedToday / S)^2)
payout = baseValue × multiplier × stuffedFactor
```

Starting soft caps (per local day): Crumbs 400, Pellets 150, Treats 25, Mileage 60, Sparks — no curve (already rate-limited by rules). `stuffedFactor` is from §9.3.

### 7.5 Ledger and diet

The ledger stores, per currency:
- `lifetimeEarned`
- `today` and an hourly bucket array for today (24 entries, for the daily summary and Phase 2 charts)
- daily totals for the last 60 days (rolling)
- `wallet` balance (exists in the schema from Phase 1 but only accrues after final form in Phase 3)

**Diet vector** = share of nutrition from each of Crumbs, Pellets, Treats, Mileage over the trailing 14 days (normalized to sum 1), plus the Sparks rate as a separate "rhythm" score. Compute and display (dev panel only in Phase 1). Phase 2 uses it to pick the final form:
- Typist if Crumbs share ≥ 0.45
- Navigator if (Pellets + Mileage) share ≥ 0.5
- Hopper if Treats share ≥ 0.3
- Keeper if no share exceeds 0.4 and rhythm score is in the top band
- Ties/edge cases: highest share wins; fall back to Keeper.

**Nutrition:** every payout also adds to `nutrition` (used for hunger in Phase 1 and evolution progress in Phase 2) with weights: Crumbs 1, Pellets 1, Treats 1, Mileage 1, Sparks 4.

### 7.6 Phase 3 shop pricing (for schema design only)

Items will cost a mix, e.g. `{ crumbs: 300, sparks: 2 }` or `{ treats: 20, mileage: 40, pellets: 80 }`. Premium items need all five. Target: an ordinary workday affords a small item every day or two. Keep `Price` as `Partial<Record<Currency, number>>` in `types.ts`.

---

## 8. World model

The pet moves through a 2D world of **surfaces** derived from the screen and its windows (positions in global screen points, y down).

### 8.1 Surface types

- **Ground:** the top of the Dock if the Dock is at the bottom and visible; otherwise the bottom of the display's work area. Dock top = `display.workArea` bottom edge (when Dock is at bottom). Handle left/right Dock positions (Dock becomes a wall the pet can sit beside). If the Dock auto-hides, the ground is the display bottom.
- **Screen walls:** left and right edges of the work area. Climbable.
- **Ceiling:** the menu bar bottom. Not walkable; the pet can hang from it briefly at the top of a climb (Phase 1: just stop climbing there).
- **Window tops:** the top edge of each eligible window, as a horizontal walkable segment.
- **Window sides:** left/right edges of eligible windows. Climbable.

### 8.2 Eligible windows

Include a window from the helper snapshot only if: `layer == 0`, `onScreen`, `alpha > 0.5`, width ≥ 160 pt and height ≥ 120 pt, not owned by Bitbot's own PID, and not owned by an excluded bundle (Dock, Window Server, Control Center, Notification Center, Spotlight, screenshot UI — list in `tuning.ts`).

### 8.3 Occlusion (visible segments)

A window-top segment is only walkable where it is **not covered by a window in front of it** (earlier in the z-ordered list). Compute visible sub-segments by subtracting the x-ranges of every in-front window whose rectangle contains that top edge's y (with ~2 pt tolerance). Same for climbable sides (subtract y-ranges). Drop sub-segments shorter than the pet's width. This logic lives in `world/geometry.ts` and needs thorough unit tests (overlapping windows, nested, fully covered, touching edges).

### 8.4 Surface graph and navigation

- Build a graph whose nodes are visible segments and whose edges are possible transitions: **walk-off drop** (from a segment end straight down to the first surface below), **jump** (to another segment within max jump distance: 220 pt horizontal, 160 pt up, any distance down within 600 pt), **climb** (from a segment end to an adjacent wall/side and up/down it).
- Navigation: A* over the graph with costs by transition type (walk < drop < climb < jump). Recompute the graph on each snapshot only if the window set or geometry changed (hash the snapshot).
- If a target is unreachable, go to the reachable point nearest to it.
- Keep it simple. A pet that occasionally takes a silly route is fine and even charming; a pet that freezes or clips through windows is not.

### 8.5 Riding and falling

The pet stores `attachedSurface = { kind, windowId, offsetAlong }`.
- On each snapshot, if the attached window moved, apply the delta to the pet (it rides along). While attached to a window, request 15 Hz snapshots.
- If the window's velocity exceeds a fling threshold (e.g. > 1,800 pt/s), or the window resized so the pet's spot no longer exists: detach and enter **Fall** with inherited velocity (wobble/tumble).
- If the window disappears (closed/minimized/hidden) or becomes occluded under the pet: detach and **Fall**.
- Physics: gravity 2,600 pt/s², terminal velocity 2,200 pt/s, land on the first surface crossed. Small bounce on hard landings.

### 8.6 Fullscreen and hiding

When the helper reports `frontmostFullscreen: true`, fade the pet out (300 ms) and pause rendering. Fade back in when fullscreen ends. Also hide while the screen is locked. The manual hide hotkey toggles visibility at any time. While hidden, the simulation continues at low rate (needs and economy still tick), but no rendering occurs.

### 8.7 Multi-display (Phase 1 behavior)

Phase 1: the pet lives on the display containing the menu bar (primary). Windows on other displays are ignored. If a dragged pet is dropped onto another display, move it back to the primary with a short "teleport" sparkle. Phase 4 adds walking between displays — keep `displayId` in the pet's position state so that's an additive change.

---

## 9. Needs, mood, and the healthy rhythm

All values 0–100 unless noted. Updated every simulation tick using real elapsed time (so they stay correct across sleep/wake; on resume, apply the elapsed time in one step, capped sensibly).

### 9.1 Needs

| Need | Rises/falls | Effect |
|---|---|---|
| **Hunger** | +6/hour while awake & computer active, +2/hour while computer idle/asleep; −(nutrition × 0.8) on each payout | ≥ 60 → hungry cues; ≥ 85 → seeks food (moves toward active app window, looks at cursor) |
| **Energy** | −8/hour while the user is continuously active; +25/hour while the computer is idle ≥ 5 min or asleep | ≤ 25 → sleepy; ≤ 10 → naps wherever it is |
| **Fullness** | rises with the rate of nutrition over the trailing 30 min; decays −20/hour | ≥ 80 → **stuffed** (see 9.3) |
| **Boredom** | +10/hour without any direct interaction (pet/drag/command) or app launch; −30 on interaction | ≥ 70 → explores, climbs, comes to poke the cursor, peeks |
| **Dust** | +15/day while the user hasn't used the computer at all that day; −all on the first interaction after return (with a "shake off" animation) | visual only; ≥ 30 → visible specks |

### 9.2 Mood

`mood = f(hunger, energy, boredom, dust, recent interactions)` → one of `happy`, `content`, `hungry`, `sleepy`, `stuffed`, `bored`, `lonely` (dust high). Mood selects face defaults and layered cues (§6.4). Pick the most pressing need; break ties by a priority list in `tuning.ts`.

### 9.3 Healthy-rhythm rules

- **Stuffed:** when continuous activity exceeds 90 min without a ≥5 min break, or fullness ≥ 80, the pet is stuffed: `stuffedFactor = 0.5` on all payouts, movement speed ×0.6, occasional burp animation. It never scolds or shows text about screen time.
- **Breaks:** a ≥5 min idle period resets the continuous-activity timer, clears stuffed, and on return triggers the "welcome back" greeting and Spark (§7.2).
- **Sleep:** if the computer is idle ≥10 min, the pet walks to its bed/home spot (or the nearest ground) and sleeps. Computer sleep/lock: it's asleep when the user returns, wakes up with a stretch and yawn, then greets.
- **Neglect:** progress (nutrition toward evolution, Phase 2) pauses after 2 full days with no activity; it never reverses. On return after ≥2 days: dust shake-off, extra-happy greeting, Spark bonus.

### 9.4 Daily summary bubble

Once per day, on the first wake/unlock after the 4:00 AM rollover, the pet shows a small speech bubble summarizing yesterday in its voice, e.g. *"Yesterday I ate 11,240 crumbs, 830 pellets, 9 treats, 41 miles, and 6 sparks. Best day this week!"* (pick from a set of templates; never guilt-trippy). Click the bubble to dismiss; it also auto-dismisses after 12 s. The bubble is an HTML element in the pet window (or a tiny separate window if approach A's window is too small).

---

## 10. Behavior, modes, and directing

### 10.1 Behavior state machine

States: `Idle, Walk, Run, Jump, Climb, Sit, Sleep, Eat, Fall, Land, Held, Celebrate, Peek, Greet`. Transitions are owned by `brain/stateMachine.ts`; locomotion executes paths. Interruption priorities: `Held > Fall > Land > Greet > Eat > (everything else)`.

### 10.2 Utility AI (Roam mode)

Every ~2–6 s (randomized) while not busy, score candidate goals and pick one with weighted randomness (softmax with temperature in `tuning.ts`) so it doesn't feel robotic:

- **Go eat** at the frontmost app's window top (score ∝ hunger; strong immediate boost on `appLaunched` → the pet runs to the new app's window and plays Eat to "eat" the Treat).
- **Nap** at home/bed spot or nearest ground (∝ 1 − energy).
- **Explore**: random reachable segment, prefer unvisited windows (∝ boredom).
- **Climb** a wall or window side for fun (∝ boredom, lower weight).
- **Sit** and dangle feet on current edge (base weight, higher when content).
- **Peek** from behind a window edge near the cursor (∝ boredom, low weight).
- **Approach cursor** and look up at it (∝ boredom + lonely).
- **Idle** in place (base weight).

When stuffed or sleepy, scale down all movement goals. Respect mode constraints (10.3).

### 10.3 Modes

- **Roam** (default): full utility AI.
- **Stay**: the pet stays exactly where it is. It still idles, blinks, eats (plays Eat in place when food arrives), sleeps in place, and reacts to the cursor. If its surface disappears it falls, then stays where it lands.
- **Hangout**: the pet has a home spot. It wanders only within ~300 pt along connected surfaces of the spot and returns there to sit/sleep. It still runs to eat on app launch, then returns.

Hangout spots are saved, named, and selectable from menus:
- **Screen spot:** fixed point snapped to a surface (e.g. "Dock, left side", "Bottom-right corner").
- **App-anchored spot:** `{ bundleId, relativeX (0–1 along the window top) }`. The pet sits on that app's frontmost visible window, follows it as it moves, and when the app has no visible window, goes to a fallback screen spot (the default home), returning when the app's window reappears.

Create a hangout spot by: dragging the pet onto a place and choosing **"Hang out here"** from its right-click menu. If dropped on a window, offer both "Hang out here (this spot)" and "Hang out on <App Name>" (app name from `NSRunningApplication.localizedName` via the helper — app names are fine; window titles are not read).

### 10.4 Directing

- **Drag & drop:** grab the pet (it enters Held and dangles), drop anywhere. Released with velocity → tossed with physics; it lands, maybe dizzy if thrown hard, then continues in the current mode. In Stay mode, the drop location becomes the new stay location.
- **Come here** (hotkey and menu): walks/climbs to the reachable point nearest the cursor.
- **Send to cursor:** ⌥⌘-click anywhere (observed via uiohook; **never intercept or block the click**) sends the pet to that point.
- **Go home** (hotkey and menu): goes to the current hangout spot or default home.
- **Pet it:** clicking (without dragging) on the pet = petting: blush, happy wiggle, boredom −30.
- **Feed it a treat by hand:** not in Phase 1.

### 10.5 Hotkeys (defaults, rebindable in settings)

| Action | Default |
|---|---|
| Show / hide Bitbot | ⌥⌘B |
| Come here | ⌥⌘C |
| Go home | ⌥⌘H |
| Toggle Stay / previous mode | ⌥⌘S |

Register with Electron `globalShortcut`. If a shortcut fails to register (conflict), surface that in settings.

---

## 11. Performance budgets

Measure with Activity Monitor and `process.getCPUUsage()` in the dev panel. Targets on an M1-class Mac:

- **CPU:** < 3% average across all Bitbot processes while roaming; < 1% while asleep or hidden.
- **Memory:** < 300 MB total.
- **Render rate:** 60 fps while moving/being dragged, 30 fps idle, 10 fps asleep, 0 when hidden or fully idle off-screen. Implement an adaptive render loop (render on demand; animate only when something changes).
- **Snapshot polling:** 4 Hz default, 15 Hz attached to a window, 1 Hz asleep. Helper must be cheap (< 0.5% CPU).
  > **Decided 2026-10-07:** adaptive, 15 Hz only while the ridden window moves (see §5.3).
- **Battery:** pause the cursor-distance poll and drop to sleep rates when on battery and the pet is asleep.
- The face canvas only redraws when its state changes or during animated faces.

---

## 12. Technical spikes (do these first)

**Spike A — Overlay approach.** Build a minimal app showing the static Bitbot mesh. Implement approach A (small moving window) and make it walk back and forth along the bottom of the screen at 120 pt/s and follow the cursor at 600 pt/s. Check: smoothness (no visible stutter), click-through outside the pet, clickable/draggable on the pet, never steals focus, stays above normal windows and below system UI, hidden in fullscreen Spaces. If approach A stutters, implement approach B and compare CPU/GPU. Document the decision in `docs/decisions/overlay.md`.

**Spike B — Input + helper.** Confirm `uiohook-napi` works in a packaged app with Input Monitoring granted (and how macOS attributes the permission in dev vs packaged builds). Confirm the Swift helper returns correct window bounds and z-order on a Retina display and that coordinates line up with Electron's `screen` API (draw debug rectangles over windows). Confirm app launch notifications arrive.

---

## 13. Phase 1 milestones and acceptance criteria

Build in this order; each milestone must run.

1. **Skeleton** — agent app, tray icon, overlay window, static Bitbot rendered exactly per §6.1 with Mint palette. Spike A done.
2. **Character alive** — full animation set (§6.4) and pixel face (§6.3), driven by a dev-panel state picker.
3. **World** — helper integrated; debug overlay draws surfaces/visible segments; pet walks the ground, drops, climbs walls and window sides, jumps between window tops, rides moving windows, falls when windows close or are flung.
4. **Directing** — drag/drop/toss, Come here, Send to cursor, Go home, petting.
5. **Activity & economy** — all five currencies with anti-gaming and daily curves; ledger; dev panel shows live counts, multipliers, diet vector.
6. **Needs & brain** — needs, mood, healthy-rhythm rules, utility AI; app-launch "run to eat".
7. **Modes** — Roam/Stay/Hangout, saved screen and app-anchored spots, context menus.
8. **Onboarding, settings, persistence** — full onboarding flow, settings window, save/load with migration scaffold, daily summary bubble, hide in fullscreen/locked.
9. **Performance pass** — meet §11 budgets.

**Phase 1 is done when:**
- [ ] A fresh install goes through onboarding (privacy explained, permission requested, name + palette chosen, egg hatches) in under a minute.
- [ ] Bitbot roams for a full workday without freezing, clipping through windows, getting stuck, or stealing focus.
- [ ] It sits on, rides, and falls off windows correctly, including with overlapping windows.
- [ ] Opening an app makes it run over and eat.
- [ ] All five currencies accrue; holding a key, hammering one key, an auto-clicker, and a mouse jiggler all earn little or nothing (covered by unit tests).
- [ ] Long unbroken use triggers stuffed; a 5-min break clears it and awards a Spark.
- [ ] It sleeps when the computer is idle and greets the user on return; daily summary appears once per day.
- [ ] Stay and Hangout modes work, including an app-anchored spot that follows the app's window.
- [ ] Hidden in fullscreen apps and when locked; hide hotkey works.
- [ ] Quitting and relaunching restores name, palette, mode, spots, needs, and ledger.
- [ ] No network requests (verify: no `fetch`/`http` usage; optionally block via session `webRequest` and assert).
- [ ] Performance budgets in §11 are met.
- [ ] All logic modules have unit tests; `npm test` passes.

---

## 14. Developer tools and testing

### 14.1 Dev panel (dev builds only, opened from tray → "Developer…")

- Live view: needs, mood, current state, mode, attached surface, fps, CPU, snapshot rate.
- Currency table: raw vs credited counts today, multipliers, soft-cap progress, wallet, diet vector.
- Buttons to inject events: keys ×100, clicks ×20, scroll ×50, mileage +5,000 pt, app launch (first-ever / returning), wake, break of N minutes, simulate fullscreen.
- **Time scale** slider (1×, 10×, 60×, 600×) applied to the simulation clock so a "day" can be tested in minutes.
- Force state / face / mood pickers; palette picker.
- Toggle debug overlay: surfaces, visible segments, nav graph edges, current path, pet hitbox.
- "Reset save" and "Load fixture save" (fixtures in `test/fixtures/`).

### 14.2 Tests (Vitest)

Required unit-test coverage for pure modules:
- `antiGaming`: auto-repeat, same-key hammering, robotic timing (CV), burst ceilings, jiggle, app flapping.
- `curves`: soft-cap multiplier math, stuffed factor, day rollover at 4:00 AM, DST edge.
- `ledger`: buckets, rolling 60 days, diet vector, nutrition weights.
- `needs`/`mood`: rates over elapsed time, sleep/wake jumps, neglect pause.
- `geometry`: visible segments under occlusion, edge cases.
- `worldModel`: graph building, A* reachability, nearest reachable point.
- `stateMachine`: interruption priorities, mode constraints.
- `save`/`migrations`: round-trip, unknown fields preserved, version upgrade path.

Inject a `Clock` interface everywhere instead of calling `Date.now()` directly so tests and time scaling work.

---

## 15. User-facing surfaces

### 15.1 Onboarding (window, ~520×600, shown on first launch)

1. **Welcome** — Bitbot egg wobbling. "Bitbot is a little creature that lives on your screen and gets fed when you use your computer."
2. **Privacy** — plain-language: "Bitbot counts how many keys you press and clicks you make. It never sees what you type, never reads your windows, and never connects to the internet. Everything stays on this Mac."
3. **Permission** — explain why Input Monitoring is needed (to count keys and clicks), button that triggers the system prompt and/or opens `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`. Detect when granted (poll) and advance. "Skip for now" is allowed (degraded mode, §7.1). Note that macOS may require relaunching after granting — handle with a "Relaunch Bitbot" button.
4. **Name & color** — name field (default suggestion "Nibs"; 1–20 chars) and the six palette swatches with a live rotating preview of the 3D pet.
5. **Hatch** — egg cracks, pet pops out onto the screen near the bottom center with a celebrate animation. Onboarding window closes.

### 15.2 Tray menu

```
<Pet name> — <mood word>          (disabled header)
Today: 🍞 1,240  ⚪ 310  🎁 6  🧭 22  ✨ 3    (or text labels if emoji render poorly)
──────────
Mode ▸  ● Roam   ○ Stay   ○ Hang out ▸ <spots…>, Manage spots…
Come here               ⌥⌘C
Go home                 ⌥⌘H
Hide Bitbot             ⌥⌘B
──────────
Input Monitoring is off — Turn on…   (only when not granted)
Settings…
Developer…              (dev builds only)
Quit Bitbot
```

Tray icon: a tiny monochrome template image of the CRT silhouette; optionally reflects mood (sleeping variant).

### 15.3 Pet right-click menu

Native context menu (`Menu.popup`) at the cursor: **Pet**, **Stay here / Roam**, **Hang out here**, **Hang out on <App>** (if on a window), **Go home**, **Hide**, **Settings…**. Must not activate Bitbot's app focus in a way that disrupts the user's frontmost app more than a native context menu inherently does.

### 15.4 Settings window

Tabs or sections:
- **Pet:** name, palette, size (S/M/L), reset position.
- **Behavior:** default mode, restlessness slider (scales utility AI timing/temperature), hangout spots manager (rename, delete, set default home), "Hide during fullscreen apps" (on), "Hide when screen sharing" (Phase 4; show disabled with "coming later").
- **Controls:** hotkey rebinding, ⌥⌘-click send toggle.
- **Privacy:** what's counted and what isn't, permission status with button, "Erase all Bitbot data".
- **General:** launch at login (`app.setLoginItemSettings`), sound (Phase 4, disabled).
- **About:** version.

---

## 16. Persistence

File: `~/Library/Application Support/Bitbot/save.json`. Write atomically (write temp file, then rename). Autosave every 60 s, on mode/settings change, on `suspend`, and on quit. Keep the last 3 saves as `save.json.bak1..3`. On a corrupt file, load the newest valid backup.

```ts
interface SaveFile {
  schemaVersion: 1;
  createdAt: string;            // ISO
  pet: {
    name: string;
    paletteId: PaletteId;
    size: 'S' | 'M' | 'L';
    stage: 'egg' | 'hatchling' | 'base' | 'final';   // Phase 1 always 'base' after onboarding
    formId: 'base' | 'typist' | 'navigator' | 'hopper' | 'keeper';
    cosmetics: { equipped: Partial<Record<AttachPoint, ItemId>>; owned: ItemId[] }; // Phase 3
    position: { displayId: number; x: number; y: number; facing: 1 | -1 };
  };
  needs: { hunger: number; energy: number; fullness: number; boredom: number; dust: number };
  rhythm: {
    continuousActiveMs: number;
    lastActiveAt: string;
    lastBreakAt: string | null;
    streakDays: number;
    lastStreakDay: string | null;           // 'YYYY-MM-DD' (4am rollover)
    sparksToday: Record<SparkSource, number>;
  };
  economy: {
    perCurrency: Record<Currency, {
      lifetimeEarned: number;
      today: number;
      todayHourly: number[];                // 24
      dailyHistory: { day: string; earned: number }[];  // last 60
      wallet: number;                       // accrues only after final form (Phase 3)
    }>;
    nutritionLifetime: number;
    evolutionProgress: number;              // Phase 2
    knownBundleIds: Record<string, string>; // bundleId -> last opened ISO (for treat bonuses)
    currentDay: string;
  };
  behavior: {
    mode: 'roam' | 'stay' | 'hangout';
    stayPoint: { x: number; y: number } | null;
    activeHangoutId: string | null;
    defaultHomeId: string | null;
    hangouts: HangoutSpot[];
  };
  settings: {
    hotkeys: Record<HotkeyAction, string>;
    altCmdClickSend: boolean;
    hideInFullscreen: boolean;
    restlessness: number;                   // 0..1
    launchAtLogin: boolean;
    sound: boolean;                         // Phase 4
  };
  meta: { lastSummaryShownDay: string | null; onboardingComplete: boolean };
}

type Currency = 'crumbs' | 'pellets' | 'treats' | 'mileage' | 'sparks';
type HangoutSpot =
  | { id: string; name: string; kind: 'screen'; displayId: number; x: number; y: number }
  | { id: string; name: string; kind: 'app'; bundleId: string; appName: string; relativeX: number; fallbackId: string | null };
```

`knownBundleIds` stores app bundle IDs and last-open dates only — it is a list of which apps were opened, which is acceptable under the privacy principle but must be listed in the Privacy settings section and erased with "Erase all Bitbot data". No window titles, no document names, no URLs.

Migrations: `migrations.ts` exports an ordered list of `(save) => save` upgraders keyed by version. Unknown fields are preserved.

---

## 17. `tuning.ts` contents (outline)

Group constants by system with comments describing what they feel like when raised/lowered:

- `render`: fps targets, pixel ratio cap, sizes S/M/L.
- `anim`: bob speeds/amplitudes, blink range, chew rate, blend times, antenna spring.
- `move`: walk 120 pt/s, run 320 pt/s, climb 70 pt/s, jump limits, gravity, terminal velocity, fling threshold, toss damping, stuffed speed factor.
- `world`: min window size, excluded bundle IDs, occlusion tolerance, snapshot rates.
- `economy`: base values, soft caps, anti-gaming thresholds, treat rules, spark rules, day rollover hour.
- `needs`: rates, thresholds, stuffed/break durations, neglect days.
- `brain`: decision interval range, goal weights, softmax temperature, hangout radius.
- `ui`: bubble duration, summary templates.

---

## 18. Out of scope for Phase 1 (do not build)

Evolution beyond base form, final forms, shop and wallet spending, cosmetics, furniture, sound, multi-display walking, multiple pets, rebirth, screen-sharing detection, cloud sync, analytics/telemetry of any kind, Windows/Linux support, notarization and auto-update.

## 19. Notes for the implementer

- Keep the pet charming over clever. If something is ambiguous, choose the version that looks most alive and least intrusive.
- macOS permission behavior differs between running from a terminal in dev (the terminal or Electron binary gets the permission) and the packaged `.app`. Document the dev setup in the README.
- Never add network code, crash reporters, or analytics SDKs.
- Write a short `README.md` covering: setup, building the Swift helper, granting permissions in dev, running tests, the dev panel, and where tuning lives.
