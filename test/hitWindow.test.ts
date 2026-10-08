import type { MouseInputEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { HIT_WINDOW_HIDDEN, type HitWindowPlacement } from '../src/main/windows/hitArea'
import {
  ElectronHitWindow,
  grabAreaOpenAllowed,
  HIT_WINDOW_OPTIONS,
  toNativeMouseEvent,
  type HitWindowNative,
  type OverlayRef,
} from '../src/main/windows/hitWindow'
import { PetInteraction, type PetInteractionDeps } from '../src/main/windows/petInteraction'
import type { Box, Point, Rect } from '../src/shared/geometry'
import { hitWindowName, HIT_WINDOW_URL } from '../src/shared/petProtocol'
import { tuning } from '../src/shared/tuning'

// The grab area's window port (src/main/windows/hitWindow.ts) over fake windows: what reaches the native window and in
// which order, no-op skipping, never taking the mouse while hidden, staying above the overlay, adoption, and failures.

type Call = string

class FakeWindow implements HitWindowNative {
  readonly calls: Call[] = []
  visible = false
  destroyed = false
  ignore = false
  forward = false
  bounds: Rect = { x: 0, y: 0, width: 1, height: 1 }
  failMoveAbove = false
  failSetBounds = false

  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
  setBounds(bounds: Rect): void {
    if (this.failSetBounds) throw new Error('setBounds failed')
    this.calls.push(`setBounds ${bounds.x},${bounds.y},${bounds.width},${bounds.height}`)
    this.bounds = { ...bounds }
  }
  showInactive(): void {
    this.calls.push('showInactive')
    this.visible = true
  }
  hide(): void {
    this.calls.push('hide')
    this.visible = false
  }
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
    this.calls.push(`ignore ${ignore}${options?.forward ? ' forward' : ''}`)
    this.ignore = ignore
    this.forward = options?.forward === true
  }
  moveAbove(id: string): void {
    if (this.failMoveAbove) throw new Error('window not found')
    this.calls.push(`moveAbove ${id}`)
  }
  setAlwaysOnTop(flag: boolean, level: 'floating'): void {
    this.calls.push(`alwaysOnTop ${flag} ${level}`)
  }
  setVisibleOnAllWorkspaces(visible: boolean, o: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean }): void {
    this.calls.push(`allSpaces ${visible} fullscreen=${o.visibleOnFullScreen} skipTransform=${o.skipTransformProcessType}`)
  }
  destroy(): void {
    this.calls.push('destroy')
    this.destroyed = true
  }
  /** Takes the mouse right now: shown and not click-through. */
  get takesMouse(): boolean {
    return this.visible && !this.ignore && !this.destroyed
  }
}

const overlay = (id = 'window:42:0'): OverlayRef & { destroyed: boolean } => {
  const o = {
    destroyed: false,
    isDestroyed: () => o.destroyed,
    getMediaSourceId: () => id,
  }
  return o
}

const AT: Rect = { x: 392, y: 622, width: 216, height: 230 }
const shown = (bounds: Rect = AT): HitWindowPlacement => ({ shown: true, bounds })

function adopted(forwardMouseMoves = false): { hit: ElectronHitWindow<FakeWindow>; win: FakeWindow; logs: string[] } {
  const logs: string[] = []
  const hit = new ElectronHitWindow<FakeWindow>({ forwardMouseMoves, log: (l) => logs.push(l) })
  const win = new FakeWindow()
  hit.adopt(win, overlay())
  win.calls.length = 0
  return { hit, win, logs }
}

describe('HIT_WINDOW_OPTIONS and the window.open rule', () => {
  it('is a hidden, transparent, non-focusable panel that takes the first click, with no preload', () => {
    expect(HIT_WINDOW_OPTIONS).toMatchObject({
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
      acceptFirstMouse: true,
      hiddenInMissionControl: true,
      roundedCorners: false,
      enableLargerThanScreen: true,
      width: 1,
      height: 1,
    })
    expect(HIT_WINDOW_OPTIONS.webPreferences).toEqual({ sandbox: true, contextIsolation: true, backgroundThrottling: false })
    expect(Object.isFrozen(HIT_WINDOW_OPTIONS)).toBe(true)
  })

  it('allows only about:blank under exactly the name issued for this page load', () => {
    const name = hitWindowName(3)
    expect(grabAreaOpenAllowed({ url: HIT_WINDOW_URL, frameName: name }, name)).toBe(true)
    expect(grabAreaOpenAllowed({ url: HIT_WINDOW_URL, frameName: hitWindowName(2) }, name)).toBe(false)
    expect(grabAreaOpenAllowed({ url: 'file:///etc/passwd', frameName: name }, name)).toBe(false)
    expect(grabAreaOpenAllowed({ url: 'https://example.com/', frameName: name }, name)).toBe(false)
    expect(grabAreaOpenAllowed({ url: HIT_WINDOW_URL, frameName: '' }, name)).toBe(false)
    expect(grabAreaOpenAllowed({ url: HIT_WINDOW_URL, frameName: name }, null)).toBe(false)
  })
})

describe('toNativeMouseEvent', () => {
  // Regression: Electron 44.6's before-mouse-event, exactly as logged during a drag (no `modifiers` field at all).
  // Reading 'leftbuttondown' from modifiers made every drag end at its first move.
  const ELECTRON_44_DRAG_MOVE = {
    type: 'mouseMove',
    clickCount: 0,
    movementX: 0,
    movementY: 0,
    button: 'left',
    globalX: 840,
    globalY: 927.5858154296875,
    x: 119,
    y: 114.58580017089844,
  } as MouseInputEvent

  it('a move with the left button held (Electron 44: no modifiers, button left) is a drag move', () => {
    expect(toNativeMouseEvent(ELECTRON_44_DRAG_MOVE)).toEqual({
      type: 'mouseMove',
      button: 'left',
      leftButtonDown: true,
      screen: { x: 840, y: 927.5858154296875 },
    })
  })

  it('a move with no button held (Chromium: kNoButton) is not: PetInteraction reads it as the lost mouseup', () => {
    const { button: _held, ...plain } = ELECTRON_44_DRAG_MOVE
    expect(toNativeMouseEvent(plain as MouseInputEvent).leftButtonDown).toBe(false)
    expect(toNativeMouseEvent({ ...plain, button: 'right' } as MouseInputEvent).leftButtonDown).toBe(false)
    expect(toNativeMouseEvent({ ...plain, button: 'none' } as unknown as MouseInputEvent).leftButtonDown).toBe(false)
  })

  it('PetInteraction keeps a drag held through Electron 44 drag moves and releases on the mouseUp', async () => {
    let released = 0
    let now = 1000
    const pi = new PetInteraction({
      hitWindow: { place: () => undefined, setMouseEnabled: () => undefined },
      locomotion: { grab: () => undefined, release: () => released++ },
      tuning: tuning.hitArea,
      now: () => now,
      cursor: () => ({ x: 855, y: 947 }),
      displayedPoint: () => ({ x: 855, y: 1022 }),
      petBox: () => ({ left: -86, top: -160, right: 86, bottom: 12 }),
      overlayShown: () => true,
      petDrawn: () => true,
      frontmostFullscreen: () => false,
      checkOverlayOnScreen: async () => true,
      popupMenu: () => undefined,
      closeMenu: () => undefined,
      onSnap: () => undefined,
      sendHoverReset: () => undefined,
      sendCursor: () => undefined,
      log: () => undefined,
    })
    pi.tick(now) // near: asks whether the overlay is on screen
    await new Promise((r) => setImmediate(r))
    pi.tick((now += 33)) // on screen: the grab area is shown
    expect(pi.placement.shown).toBe(true)
    pi.handlePointer({ kind: 'down', button: 0, screenX: 855, screenY: 947, groundX: 855, groundY: 1022, epoch: pi.epoch })
    expect(pi.held).toBe(true)
    for (let k = 0; k < 5; k++) pi.handleNativeMouse(toNativeMouseEvent({ ...ELECTRON_44_DRAG_MOVE, globalX: 840 - 10 * k }))
    expect(pi.held).toBe(true)
    pi.handleNativeMouse(toNativeMouseEvent({ ...ELECTRON_44_DRAG_MOVE, type: 'mouseUp', clickCount: 1 }))
    expect(pi.held).toBe(false)
    expect(released).toBe(1)
  })

  it('modifiers win when Electron sends them', () => {
    const drag = { type: 'mouseMove', x: 5, y: 6, globalX: 500, globalY: 700, modifiers: ['leftbuttondown'] } as MouseInputEvent
    expect(toNativeMouseEvent(drag)).toEqual({ type: 'mouseMove', button: null, leftButtonDown: true, screen: { x: 500, y: 700 } })
    const noButton = { ...drag, button: 'left', modifiers: [] } as MouseInputEvent
    expect(toNativeMouseEvent(noButton).leftButtonDown).toBe(false)
  })

  it('a mouseUp never counts as the button held', () => {
    const up = { type: 'mouseUp', button: 'left', x: 1, y: 2, globalX: 10, globalY: 20 } as MouseInputEvent
    expect(toNativeMouseEvent(up)).toEqual({ type: 'mouseUp', button: 'left', leftButtonDown: false, screen: { x: 10, y: 20 } })
  })

  it('no global point when Electron gives none (or a non-finite one)', () => {
    expect(toNativeMouseEvent({ type: 'mouseMove', x: 1, y: 2 } as MouseInputEvent).screen).toBeNull()
    expect(toNativeMouseEvent({ type: 'mouseMove', x: 1, y: 2, globalX: Number.NaN, globalY: 3 } as MouseInputEvent).screen).toBeNull()
  })
})

describe('ElectronHitWindow', () => {
  it('adopt: floating level, every Space (a panel joins fullscreen ones anyway), click-through, hidden', () => {
    const hit = new ElectronHitWindow<FakeWindow>({ forwardMouseMoves: false, log: () => undefined })
    const win = new FakeWindow()
    hit.adopt(win, overlay())
    expect(win.calls).toEqual([
      'alwaysOnTop true floating',
      'allSpaces true fullscreen=true skipTransform=true',
      'ignore true',
      'hide',
    ])
    expect(hit.counters.adopted).toBe(1)
    expect(win.takesMouse).toBe(false)
  })

  it('shows at the bounds, then moves directly above the overlay; skips everything when nothing changed', () => {
    const { hit, win } = adopted()
    hit.place(shown())
    expect(win.calls).toEqual(['setBounds 392,622,216,230', 'showInactive', 'moveAbove window:42:0'])
    win.calls.length = 0
    for (let i = 0; i < 5; i++) hit.place(shown())
    expect(win.calls).toEqual([])
    expect(hit.counters).toMatchObject({ moves: 1, shows: 1, moveAboves: 1, skipped: 5 })
    hit.place(shown({ ...AT, x: 400 }))
    expect(win.calls).toEqual(['setBounds 400,622,216,230']) // moving doesn't change the ordering
    expect(hit.shown).toBe(true)
  })

  it('takes the mouse only while shown, after ordering itself above the overlay', () => {
    const { hit, win } = adopted()
    hit.setMouseEnabled(true) // hidden: stays click-through
    expect(win.calls).toEqual([])
    expect(win.takesMouse).toBe(false)
    hit.place(shown())
    expect(win.calls).toEqual(['setBounds 392,622,216,230', 'showInactive', 'moveAbove window:42:0', 'ignore false'])
    expect(win.takesMouse).toBe(true)
    expect(hit.takesMouse).toBe(true)
    win.calls.length = 0
    hit.setMouseEnabled(true)
    expect(win.calls).toEqual([])
    hit.setMouseEnabled(false)
    expect(win.calls).toEqual(['ignore true'])
  })

  it('hiding: click-through first, then hide; a hidden window never takes the mouse', () => {
    const { hit, win } = adopted()
    hit.place(shown())
    hit.setMouseEnabled(true)
    win.calls.length = 0
    hit.place(HIT_WINDOW_HIDDEN)
    expect(win.calls).toEqual(['ignore true', 'hide'])
    expect(win.takesMouse).toBe(false)
    win.calls.length = 0
    hit.place(HIT_WINDOW_HIDDEN)
    expect(win.calls).toEqual([])
  })

  it('forwardMouseMoves: click-through forwards mouse moves', () => {
    const { hit, win } = adopted(true)
    hit.place(shown())
    hit.setMouseEnabled(true)
    hit.setMouseEnabled(false)
    expect(win.calls.at(-1)).toBe('ignore true forward')
    expect(win.forward).toBe(true)
  })

  it('re-syncs when AppKit hid or showed the window behind its back', () => {
    const { hit, win } = adopted()
    hit.place(shown())
    win.visible = false // e.g. hidden with the app
    win.calls.length = 0
    hit.place(shown())
    expect(win.calls).toEqual(['showInactive', 'moveAbove window:42:0'])
    hit.place(HIT_WINDOW_HIDDEN)
    win.visible = true // e.g. restored when the app was unhidden
    win.calls.length = 0
    hit.place(HIT_WINDOW_HIDDEN)
    expect(win.calls).toEqual(['hide'])
    expect(hit.counters.resyncs).toBe(2)
  })

  it('a moveAbove failure only costs the ordering: counted, logged once per streak', () => {
    const { hit, win, logs } = adopted()
    win.failMoveAbove = true
    hit.place(shown())
    hit.setMouseEnabled(true)
    expect(win.takesMouse).toBe(true)
    expect(hit.counters.moveAboveFailures).toBe(2)
    expect(win.calls.filter((c) => c.startsWith('ignore'))).toEqual(['ignore false'])
    expect(logs).toHaveLength(1)
    hit.setMouseEnabled(false)
    win.failMoveAbove = false
    hit.setMouseEnabled(true)
    expect(hit.counters.moveAboves).toBe(1)
    win.failMoveAbove = true
    hit.setMouseEnabled(false)
    hit.setMouseEnabled(true)
    expect(logs).toHaveLength(2)
  })

  it('a destroyed overlay counts as a moveAbove failure, not a throw', () => {
    const logs: string[] = []
    const hit = new ElectronHitWindow<FakeWindow>({ forwardMouseMoves: false, log: (l) => logs.push(l) })
    const win = new FakeWindow()
    const o = overlay()
    hit.adopt(win, o)
    o.destroyed = true
    expect(() => hit.place(shown())).not.toThrow()
    expect(hit.counters.moveAboveFailures).toBe(1)
  })

  it('other native failures propagate (PetInteraction fails closed) and are retried on the next call', () => {
    const { hit, win } = adopted()
    win.failSetBounds = true
    expect(() => hit.place(shown())).toThrow('setBounds failed')
    win.failSetBounds = false
    win.calls.length = 0
    hit.place(shown())
    expect(win.calls).toEqual(['setBounds 392,622,216,230', 'showInactive', 'moveAbove window:42:0'])
  })

  it('without a window everything is a remembered no-op; the next window gets the newest placement and mouse state', () => {
    const hit = new ElectronHitWindow<FakeWindow>({ forwardMouseMoves: false, log: () => undefined })
    hit.place(shown())
    hit.setMouseEnabled(true)
    expect(hit.window).toBeNull()
    expect(hit.shown).toBe(false)
    const win = new FakeWindow()
    hit.adopt(win, overlay())
    expect(win.calls).toEqual([
      'alwaysOnTop true floating',
      'allSpaces true fullscreen=true skipTransform=true',
      'ignore true',
      'setBounds 392,622,216,230',
      'showInactive',
      'moveAbove window:42:0',
      'ignore false',
    ])
    expect(win.takesMouse).toBe(true)
  })

  it('adopting a new window destroys the previous one; a destroyed window is forgotten and never touched', () => {
    const { hit, win } = adopted()
    const next = new FakeWindow()
    hit.adopt(next, overlay())
    expect(win.calls).toEqual(['destroy'])
    expect(hit.isCurrent(next)).toBe(true)
    expect(hit.isCurrent(win)).toBe(false)
    next.destroyed = true
    next.calls.length = 0
    hit.place(shown())
    hit.setMouseEnabled(true)
    expect(next.calls).toEqual([])
    expect(hit.window).toBeNull()
  })

  it('release (it closed by itself) forgets the window without touching it; destroy() destroys it', () => {
    const { hit, win } = adopted()
    hit.release(new FakeWindow()) // not the current one: ignored
    expect(hit.window).toBe(win)
    hit.release(win)
    expect(hit.window).toBeNull()
    expect(win.calls).toEqual([])
    const { hit: hit2, win: win2 } = adopted()
    hit2.destroy()
    expect(win2.calls).toEqual(['destroy'])
    expect(hit2.window).toBeNull()
    hit2.destroy()
    expect(win2.calls).toEqual(['destroy'])
  })
})

describe('ElectronHitWindow driven by PetInteraction', () => {
  // The pet's box at GROUND spans x 440..560, y 670..804.
  const BOX: Box = { left: -60, top: -130, right: 60, bottom: 4 }
  const GROUND: Point = { x: 500, y: 800 }
  const ON_PET: Point = { x: 500, y: 740 }
  const FAR: Point = { x: 1200, y: 300 }

  it('near: shown click-through; hover: takes the mouse; away: click-through before hiding', async () => {
    const win = new FakeWindow()
    const hit = new ElectronHitWindow<FakeWindow>({ forwardMouseMoves: false, log: () => undefined })
    hit.adopt(win, overlay())
    const world = { now: 1000, cursor: { ...FAR } }
    const deps: PetInteractionDeps = {
      hitWindow: hit,
      locomotion: { grab: () => undefined, release: () => undefined },
      tuning: tuning.hitArea,
      now: () => world.now,
      cursor: () => world.cursor,
      displayedPoint: () => GROUND,
      petBox: () => BOX,
      overlayShown: () => true,
      petDrawn: () => true,
      frontmostFullscreen: () => false,
      checkOverlayOnScreen: async () => true,
      popupMenu: () => undefined,
      closeMenu: () => undefined,
      onSnap: () => undefined,
      sendHoverReset: () => undefined,
      sendCursor: () => undefined,
      log: () => undefined,
    }
    const pi = new PetInteraction(deps)
    const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
    pi.tick(world.now)
    expect(win.visible).toBe(false)
    world.cursor = { ...ON_PET }
    pi.tick((world.now += 33)) // near: asks the helper first (fail closed on entry)
    expect(win.visible).toBe(false)
    await flush()
    pi.tick((world.now += 33))
    expect(win.visible).toBe(true)
    expect(win.takesMouse).toBe(false)
    pi.handleHover({ over: true, epoch: pi.epoch })
    expect(win.takesMouse).toBe(true)
    win.calls.length = 0
    world.cursor = { ...FAR }
    pi.tick((world.now += 33))
    expect(win.calls).toEqual(['ignore true', 'hide'])
    expect(win.takesMouse).toBe(false)
  })
})
