// The overlay window (docs/decisions/overlay.md "Decision": approach B, hardened): one transparent window over the
// primary display's full bounds where the overlay page draws the pet on a small canvas it moves itself. It never takes
// mouse input; the grab area (hitWindow.ts) does. This is the ONE factory for every (re)creation, so the settings and
// their order can't drift. Type-only Electron imports: the BrowserWindow constructor is passed in, so the options and
// the call order are unit-tested (test/overlayWindow.test.ts).
//
// Findings from the Electron 44 sources (Spike A, src/main/spike/overlay/window.ts):
// - type 'panel' creates an ElectronNSPanel whose setCollectionBehavior: override ORs in CanJoinAllSpaces |
//   FullScreenAuxiliary on every call, so a panel can never be kept off fullscreen Spaces. The overlay is therefore
//   NOT a panel (no `type`): as a normal window, setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: false}) keeps it
//   off fullscreen Spaces, which macOS should also apply to Split View (docs/decisions/overlay.md manual check 4).
// - Without 'panel', fullscreenable: false makes the constructor ADD FullScreenAuxiliary (SetFullScreenable), and
//   setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: false}) removes it again. So that call comes after
//   construction, and NOTHING may call setFullScreenable() or setResizable() on the overlay afterwards: both re-add
//   FullScreenAuxiliary, and the pet would then show on fullscreen Spaces. (setBounds is fine.)
// - skipTransformProcessType: true matters: without it, visibleOnFullScreen: false calls DockShow(), which would give
//   this agent app a Dock icon.
// - hiddenInMissionControl adds NSWindowCollectionBehaviorTransient; focusable: false sets disableKeyOrMainWindow (it
//   can never become key or main). Never call focus() or show() on it (show() activates the app): only showInactive().
// - enableLargerThanScreen: true keeps AppKit from constraining the frame (it covers the menu-bar strip);
//   roundedCorners: false leaves no corner mask clipping the pet.
//
// SPEC-DEVIATION: §5.2 makes the overlay click-through with forwarded mouse moves (setIgnoreMouseEvents(true,
// {forward: true})) and toggles it off over the pet. Approach B, hardened never lets the display-sized overlay take
// input (a stalled main thread could then swallow clicks anywhere on the display): setIgnoreMouseEvents(true) once,
// with no forwarding, ever; only the small grab area takes the pet's clicks.
// SPEC-DEVIATION: §5.1 "position is handled by window placement": this window never moves with the pet; the overlay
// page moves the pet's canvas with a compositor transform (docs/decisions/overlay.md: moving a window stutters and
// costs main 6–8 points of CPU).

import type { BrowserWindowConstructorOptions } from 'electron'
import type { Rect } from '../../shared/geometry'

/** The constructor options (no `type`: not a panel). `preload`: the preload script's path (pages.ts preloadPath()). */
export function overlayWindowOptions(bounds: Rect, preload: string): BrowserWindowConstructorOptions {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    fullscreenable: false,
    hiddenInMissionControl: true,
    roundedCorners: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  }
}

/** The calls the factory makes after construction (BrowserWindow has them all). */
export interface OverlayWindowSetup {
  setAlwaysOnTop(flag: boolean, level: 'floating'): void
  setVisibleOnAllWorkspaces(visible: boolean, options: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean }): void
  setIgnoreMouseEvents(ignore: boolean): void
}

/**
 * Creates the overlay over `bounds` (global pt), hidden: show it with showInactive(), never show() or focus(). After
 * construction and before it is ever shown, in this order: level 'floating' (above app windows, below the Dock, the
 * menu bar and system UI), every Space but no fullscreen ones (removes the FullScreenAuxiliary the constructor added),
 * click-through without forwarding.
 */
export function createOverlayWindow<W extends OverlayWindowSetup>(
  bounds: Rect,
  preload: string,
  construct: (options: BrowserWindowConstructorOptions) => W,
): W {
  const win = construct(overlayWindowOptions(bounds, preload))
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true })
  win.setIgnoreMouseEvents(true)
  return win
}
