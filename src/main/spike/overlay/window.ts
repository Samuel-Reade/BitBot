import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type { Rect } from '../../../shared/spikeOverlay'
import { preloadPath } from '../../pages'
import type { WindowTypeOption } from './options'

// The overlay window (BITBOT_SPEC.md §5.2 common settings), shared by all Spike A variants.
//
// Findings from the Electron 44 sources (shell/browser/native_window_mac.mm, ui/cocoa/electron_ns_panel.mm):
// - type 'panel' creates an ElectronNSPanel: styleMask always reports NSWindowStyleMaskNonactivatingPanel
//   (clicks do not activate the app), level = NSFloatingWindowLevel, and its setCollectionBehavior:
//   override ORs in CanJoinAllSpaces | FullScreenAuxiliary on EVERY call. So a panel can never be made
//   invisible over fullscreen apps: setVisibleOnAllWorkspaces(…, {visibleOnFullScreen: false}) is
//   ineffective whatever the call order. Hiding in fullscreen must come from the app (§8.6 helper event).
// - Without 'panel', fullscreenable:false makes the constructor ADD FullScreenAuxiliary
//   (SetFullScreenable), and setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:false}) removes it,
//   so that call must come after construction and nothing may call setFullScreenable() afterwards.
// - skipTransformProcessType:true matters: without it, visibleOnFullScreen:false calls DockShow(),
//   which would give this agent app a Dock icon.
// - hiddenInMissionControl adds NSWindowCollectionBehaviorTransient; focusable:false sets
//   disableKeyOrMainWindow (the window can never become key/main); acceptFirstMouse sets
//   acceptsFirstMouse so the first click on the inactive window reaches the page.

export interface OverlayWindowState {
  type: WindowTypeOption
  focusable: boolean
  alwaysOnTop: boolean
  visibleOnAllWorkspaces: boolean
  movable: boolean
  resizable: boolean
  contentBounds: Rect
}

export function createOverlayWindow(bounds: Rect, windowType: WindowTypeOption): BrowserWindow {
  const options: BrowserWindowConstructorOptions = {
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
    acceptFirstMouse: true,
    hiddenInMissionControl: true,
    // SPEC-DEVIATION: options beyond §5.2's list.
    //  - type 'panel' (below, unless --window-type=none) is the consequential one: it is what should
    //    keep clicks from activating Bitbot (§2 "never steal focus"; unverified, AppKit warns about it),
    //    but Electron then forces the window onto fullscreen Spaces, so §5.2's
    //    setVisibleOnAllWorkspaces(…, {visibleOnFullScreen:false}) no longer hides it and hiding in
    //    fullscreen moves to an app-level fade on the helper's frontmostFullscreen event (§8.6, not built).
    //  - acceptFirstMouse: the first click on the inactive window reaches the page (otherwise it is eaten).
    //  - hiddenInMissionControl, movable:false, skipTransformProcessType (below; without it the agent
    //    app gets a Dock icon), roundedCorners:false (no corner mask clipping the pet) and
    //    enableLargerThanScreen:true (AppKit never constrains the frame: B covers the menu-bar strip,
    //    A walks under the Dock edge). These don't change focus, level or click-through behaviour.
    roundedCorners: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  }
  if (windowType === 'panel') options.type = 'panel'
  const win = new BrowserWindow(options)
  // Order matters for windowType 'none' (see above): after construction, before show.
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  return win
}

export function describeWindow(win: BrowserWindow, type: WindowTypeOption): OverlayWindowState {
  return {
    type,
    focusable: win.isFocusable(),
    alwaysOnTop: win.isAlwaysOnTop(),
    visibleOnAllWorkspaces: win.isVisibleOnAllWorkspaces(),
    movable: win.isMovable(),
    resizable: win.isResizable(),
    contentBounds: win.getContentBounds(),
  }
}

/** CGWindowID from getMediaSourceId() ('window:<CGWindowID>:0' on macOS). */
export function windowNumber(win: BrowserWindow): number | null {
  const match = /^window:(\d+):/.exec(win.getMediaSourceId())
  return match?.[1] ? Number(match[1]) : null
}
