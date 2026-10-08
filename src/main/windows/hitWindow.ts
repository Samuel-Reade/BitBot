// The grab area's window in main (docs/decisions/overlay.md "Decision"): the small panel the overlay page opens with
// window.open, which main shows over the pet only while the cursor is near it and makes take the mouse only over the
// pet. ElectronHitWindow is PetInteraction's HitWindowPort: it applies PetInteraction's placement and mouse decisions
// to the window, skips native calls when nothing changed, keeps the window directly above the overlay, and counts what
// it did for the dev check. Type-only Electron imports: the windows are handed in, so it is unit-tested with fakes
// (test/hitWindow.test.ts). petWindow.ts allows the window.open and wires the window's events.
//
// Why a panel: a click on a normal window activates the app (§2 "never steal focus"); Electron's type 'panel' (a
// non-activating NSPanel; AppKit logs "NSWindow does not support nonactivating panel styleMask 0x80") is the only
// non-native option. Whether its clicks truly never activate Bitbot is the manual focus gate (docs/decisions/overlay.md
// manual check 1), which the activation monitor reports per interaction.
// SPEC-DEVIATION: §5.2 asks for setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: false}). Electron's panel ORs
// CanJoinAllSpaces | FullScreenAuxiliary into every setCollectionBehavior: call, so the panel joins fullscreen Spaces
// whatever is passed (visibleOnFullScreen: true below says so). Hence the fail-closed on-screen check: main shows the
// panel only while the helper confirms that the overlay, a normal window macOS keeps off fullscreen Spaces, is on
// screen (onScreen.ts, PetInteraction).

import type { BrowserWindowConstructorOptions, HandlerDetails, MouseInputEvent } from 'electron'
import { rectsEqual, type Rect } from '../../shared/geometry'
import { HIT_WINDOW_URL } from '../../shared/petProtocol'
import { HIT_WINDOW_HIDDEN, type HitWindowPlacement, type HitWindowPort } from './hitArea'
import type { NativeMouseEvent } from './petInteraction'

/**
 * overrideBrowserWindowOptions for the grab area's window.open (docs/decisions/overlay.md "Decision"). No preload: its
 * document is an empty about:blank page that the overlay page scripts directly (same origin, same renderer process).
 */
export const HIT_WINDOW_OPTIONS: Readonly<BrowserWindowConstructorOptions> = Object.freeze({
  type: 'panel',
  show: false,
  transparent: true,
  frame: false,
  hasShadow: false,
  resizable: false,
  movable: false,
  focusable: false,
  skipTaskbar: true,
  fullscreenable: false,
  // The first click on the inactive panel reaches the page instead of only making the window key.
  acceptFirstMouse: true,
  hiddenInMissionControl: true,
  roundedCorners: false,
  enableLargerThanScreen: true,
  width: 1,
  height: 1,
  webPreferences: Object.freeze({ sandbox: true, contextIsolation: true, backgroundThrottling: false }),
})

/**
 * The overlay page's window.open is allowed only for its grab area: about:blank under exactly the name main issued for
 * this page load (a reloaded page gets a new name; the old name would hand back the old window, its listeners gone).
 */
export function grabAreaOpenAllowed(details: Pick<HandlerDetails, 'url' | 'frameName'>, expectedName: string | null): boolean {
  return expectedName !== null && details.url === HIT_WINDOW_URL && details.frameName === expectedName
}

/**
 * The grab area webContents' before-mouse-event, as PetInteraction.handleNativeMouse takes it.
 *
 * leftButtonDown: Electron 44's before-mouse-event carries NO `modifiers` (measured: type, clickCount, movementX/Y,
 * button, x, y, globalX/Y only), so 'leftbuttondown' can't be read from it, and reading it would end every drag at its
 * first move (PetInteraction takes a move without the left button for a lost mouseup). Chromium sets a move's `button`
 * to the button actually held (LeftMouseDragged → left; a plain MouseMoved → the pressed buttons, none when nothing is
 * pressed), so on a move, button 'left' means the left button is down. `modifiers` win if a later Electron sends them.
 * Synthetic events (webContents.sendInputEvent) default their button to 'left', so they always read as held.
 */
export function toNativeMouseEvent(input: MouseInputEvent): NativeMouseEvent {
  const { globalX, globalY } = input
  const located = typeof globalX === 'number' && typeof globalY === 'number' && Number.isFinite(globalX) && Number.isFinite(globalY)
  const modifiers: unknown = input.modifiers
  const leftButtonDown = Array.isArray(modifiers)
    ? modifiers.includes('leftbuttondown')
    : input.type !== 'mouseUp' && input.button === 'left'
  return {
    type: input.type,
    button: input.button ?? null,
    leftButtonDown,
    screen: located ? { x: globalX, y: globalY } : null,
  }
}

/** The part of BrowserWindow the grab area uses (fakes implement it in tests). */
export interface HitWindowNative {
  isDestroyed(): boolean
  isVisible(): boolean
  setBounds(bounds: Rect): void
  showInactive(): void
  hide(): void
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  /** Throws if the source is not a window or that window doesn't exist. */
  moveAbove(mediaSourceId: string): void
  setAlwaysOnTop(flag: boolean, level: 'floating'): void
  setVisibleOnAllWorkspaces(visible: boolean, options: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean }): void
  destroy(): void
}

/** The overlay window, which the grab area is kept directly above. */
export interface OverlayRef {
  isDestroyed(): boolean
  getMediaSourceId(): string
}

/** What the grab area's window was told to do, for the dev check. */
export interface HitWindowCounters {
  /** Windows adopted (one per overlay page load). */
  adopted: number
  /** setBounds calls. */
  moves: number
  /** showInactive calls. */
  shows: number
  /** hide calls. */
  hides: number
  /** setIgnoreMouseEvents calls (click-through on or off). */
  mouseToggles: number
  moveAboves: number
  moveAboveFailures: number
  /** The window's visibility differed from what was last set (AppKit hid or showed it) and was set again. */
  resyncs: number
  /** place() / setMouseEnabled() calls that needed no native call. */
  skipped: number
}

export interface ElectronHitWindowOptions {
  /** tuning.hitArea.forwardMouseMoves */
  forwardMouseMoves: boolean
  log(line: string): void
}

/**
 * PetInteraction's grab-area port over the panel the overlay page opened. Without a window (none adopted yet, or it
 * closed) every call is a no-op that is remembered, and adopt() applies the newest placement and mouse state to the
 * next window. Native call failures propagate (PetInteraction then fails closed), except moveAbove's, which only
 * cost the ordering.
 */
export class ElectronHitWindow<W extends HitWindowNative = HitWindowNative> implements HitWindowPort {
  private win: W | null = null
  private overlay: OverlayRef | null = null
  /** What PetInteraction asked for. */
  private wanted: HitWindowPlacement = HIT_WINDOW_HIDDEN
  private wantMouse = false
  /** What the window was last set to; null = unknown (set on the next call). */
  private nativeShown: boolean | null = null
  private nativeBounds: Rect | null = null
  private nativeIgnore: boolean | null = null
  private moveAboveFailing = false
  private readonly count: HitWindowCounters = {
    adopted: 0,
    moves: 0,
    shows: 0,
    hides: 0,
    mouseToggles: 0,
    moveAboves: 0,
    moveAboveFailures: 0,
    resyncs: 0,
    skipped: 0,
  }

  constructor(private readonly opts: ElectronHitWindowOptions) {}

  /** The current window (null: none, or it was destroyed). */
  get window(): W | null {
    return this.live()
  }

  isCurrent(win: unknown): boolean {
    return win !== null && win === this.win
  }

  /** Shown on screen as far as this port knows. */
  get shown(): boolean {
    return this.live() !== null && this.nativeShown === true
  }

  /** The window takes the mouse (click-through off) as far as this port knows. */
  get takesMouse(): boolean {
    return this.shown && this.nativeIgnore === false
  }

  get counters(): HitWindowCounters {
    return { ...this.count }
  }

  /**
   * A new grab-area window (did-create-window): any previous one is destroyed; this one is set up (level 'floating',
   * every Space, click-through) and gets the newest placement and mouse state. `overlay`: the window it stays above.
   */
  adopt(win: W, overlay: OverlayRef): void {
    const previous = this.win
    if (previous && previous !== win) this.destroyQuietly(previous)
    this.win = win
    this.overlay = overlay
    this.forgetNative()
    this.count.adopted++
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    this.setClickThrough(win)
    this.apply()
  }

  /** The window closed or crashed by itself: forget it without touching it. */
  release(win: W): void {
    if (win !== this.win) return
    this.win = null
    this.forgetNative()
  }

  /** Destroys the current window (page reload or crash, quit). Requests are still remembered for the next one. */
  destroy(): void {
    const win = this.win
    this.win = null
    this.forgetNative()
    if (win) this.destroyQuietly(win)
  }

  place(placement: HitWindowPlacement): void {
    this.wanted = placement.shown ? { shown: true, bounds: { ...placement.bounds } } : HIT_WINDOW_HIDDEN
    this.apply()
  }

  /** On: only while shown (moved directly above the overlay first). Off: click-through, with forwarded moves if tuned so. */
  setMouseEnabled(on: boolean): void {
    this.wantMouse = on
    const win = this.live()
    if (!win) return
    if (!this.applyMouse(win)) this.count.skipped++
  }

  private apply(): void {
    const win = this.live()
    if (!win) return
    let changed = false
    const wanted = this.wanted
    if (!wanted.shown) {
      // Click-through before the window goes away.
      changed = this.setClickThrough(win) || changed
      const visible = win.isVisible()
      if (this.nativeShown !== false || visible) {
        if (this.nativeShown === false) this.count.resyncs++
        win.hide()
        this.nativeShown = false
        this.count.hides++
        changed = true
      }
      if (!changed) this.count.skipped++
      return
    }
    if (this.nativeBounds === null || !rectsEqual(this.nativeBounds, wanted.bounds)) {
      win.setBounds(wanted.bounds)
      this.nativeBounds = { ...wanted.bounds }
      this.count.moves++
      changed = true
    }
    let ordered = false
    if (this.nativeShown !== true || !win.isVisible()) {
      if (this.nativeShown === true) this.count.resyncs++
      win.showInactive()
      this.nativeShown = true
      this.count.shows++
      // Directly above the overlay: above it, but below other apps' floating panels shown since.
      this.moveAboveOverlay(win)
      ordered = true
      changed = true
    }
    changed = this.applyMouse(win, ordered) || changed
    if (!changed) this.count.skipped++
  }

  /**
   * Makes the native mouse state match the wanted one; true if it made a native call. Before taking the mouse the
   * window is ordered directly above the overlay (unless `ordered`: that just happened).
   */
  private applyMouse(win: W, ordered = false): boolean {
    const enable = this.wantMouse && this.wanted.shown && this.nativeShown === true
    if (!enable) return this.setClickThrough(win)
    if (this.nativeIgnore === false) return false
    if (!ordered) this.moveAboveOverlay(win)
    win.setIgnoreMouseEvents(false)
    this.nativeIgnore = false
    this.count.mouseToggles++
    return true
  }

  private setClickThrough(win: W): boolean {
    if (this.nativeIgnore === true) return false
    if (this.opts.forwardMouseMoves) win.setIgnoreMouseEvents(true, { forward: true })
    else win.setIgnoreMouseEvents(true)
    this.nativeIgnore = true
    this.count.mouseToggles++
    return true
  }

  private moveAboveOverlay(win: W): void {
    try {
      const overlay = this.overlay
      if (!overlay || overlay.isDestroyed()) throw new Error('the overlay window is gone')
      win.moveAbove(overlay.getMediaSourceId())
      this.count.moveAboves++
      this.moveAboveFailing = false
    } catch (err) {
      this.count.moveAboveFailures++
      if (!this.moveAboveFailing) {
        this.moveAboveFailing = true
        const why = err instanceof Error ? err.message : String(err)
        this.log(`grab area: could not order it directly above the overlay (${why}); it may sit above other apps' floating panels`)
      }
    }
  }

  /** The window, unless there is none or it was destroyed (then it is forgotten). */
  private live(): W | null {
    const win = this.win
    if (!win) return null
    if (win.isDestroyed()) {
      this.win = null
      this.forgetNative()
      return null
    }
    return win
  }

  private forgetNative(): void {
    this.nativeShown = null
    this.nativeBounds = null
    this.nativeIgnore = null
  }

  private destroyQuietly(win: W): void {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      // Already gone.
    }
  }

  private log(line: string): void {
    try {
      this.opts.log(line)
    } catch {
      // Nowhere left to report it.
    }
  }
}
