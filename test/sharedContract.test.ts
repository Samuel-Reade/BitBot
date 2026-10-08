import { describe, expect, it } from 'vitest'
import {
  boxAt,
  clampToArea,
  distance,
  inflateRect,
  isBox,
  isPetArea,
  isPoint,
  isRect,
  rectContainsPoint,
  rectContainsRect,
  rectsEqual,
  roundRectOutward,
  type PetArea,
} from '../src/shared/geometry'
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS } from '../src/shared/hotkeys'
import { interpolate, pushTimed, sampleBuffer, type TimedPoint } from '../src/shared/interpolation'
import { IPC, isAllowedChannel } from '../src/shared/ipc'
import {
  HIT_WINDOW_NAME_PREFIX,
  HIT_WINDOW_URL,
  hitWindowName,
  isHitWindowName,
  isOverlayStatsMsg,
  isPetConfig,
  isPetCursorMsg,
  isPetDrawnMsg,
  isPetHoverMsg,
  isPetHoverResetMsg,
  isPetLogMsg,
  isPetPointerMsg,
  isPetReadyMsg,
  isPetStateMsg,
  isPetVisibleMsg,
  type OverlayStatsMsg,
  type PetConfig,
  type PetReadyMsg,
  type PetStateMsg,
} from '../src/shared/petProtocol'
import { BEHAVIOR_STATES, isBehaviorState } from '../src/shared/types'

// The shared M1 contract: geometry, interpolation, the overlay's IPC payloads and hotkey defaults.

describe('geometry', () => {
  const box = { left: -50, top: -110, right: 60, bottom: 2 }

  it('places a box at a point', () => {
    expect(boxAt({ x: 100, y: 200 }, box)).toEqual({ x: 50, y: 90, width: 110, height: 112 })
  })

  it('inflates and deflates rects, never below zero size', () => {
    expect(inflateRect({ x: 10, y: 20, width: 30, height: 40 }, 5)).toEqual({ x: 5, y: 15, width: 40, height: 50 })
    expect(inflateRect({ x: 10, y: 20, width: 30, height: 40 }, -5)).toEqual({ x: 15, y: 25, width: 20, height: 30 })
    const collapsed = inflateRect({ x: 10, y: 20, width: 4, height: 40 }, -5)
    expect(collapsed.width).toBe(0)
    expect(collapsed.x).toBe(12) // stays centered
    expect(collapsed.height).toBe(30)
  })

  it('contains points and rects with inclusive edges', () => {
    const r = { x: 0, y: 0, width: 10, height: 10 }
    expect(rectContainsPoint(r, { x: 0, y: 10 })).toBe(true)
    expect(rectContainsPoint(r, { x: 10.01, y: 5 })).toBe(false)
    expect(rectContainsRect(r, { x: 0, y: 0, width: 10, height: 10 })).toBe(true)
    expect(rectContainsRect(r, { x: 1, y: 1, width: 10, height: 2 })).toBe(false)
  })

  it('rounds rects outward onto whole points', () => {
    expect(roundRectOutward({ x: 10.4, y: -3.2, width: 5.2, height: 1 })).toEqual({ x: 10, y: -4, width: 6, height: 2 })
    expect(roundRectOutward({ x: 2, y: 3, width: 4, height: 5 })).toEqual({ x: 2, y: 3, width: 4, height: 5 })
  })

  it('compares rects and measures distance', () => {
    expect(rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true)
    expect(rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 })).toBe(false)
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })

  it('clamps a point into the pet area', () => {
    const area: PetArea = { minX: 100, maxX: 900, minY: 150, groundY: 1000 }
    expect(clampToArea({ x: 50, y: 1200 }, area)).toEqual({ x: 100, y: 1000 })
    expect(clampToArea({ x: 950, y: 0 }, area)).toEqual({ x: 900, y: 150 })
    expect(clampToArea({ x: 500, y: 600 }, area)).toEqual({ x: 500, y: 600 })
  })

  it('validates shapes', () => {
    expect(isPoint({ x: 1, y: 2 })).toBe(true)
    expect(isPoint({ x: 1, y: Number.NaN })).toBe(false)
    expect(isRect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true)
    expect(isRect({ x: 0, y: 0, width: -1, height: 1 })).toBe(false)
    expect(isBox(box)).toBe(true)
    expect(isBox({ left: 1, top: 0, right: 0, bottom: 1 })).toBe(false)
    expect(isPetArea({ minX: 0, maxX: 10, minY: 0, groundY: 10 })).toBe(true)
    expect(isPetArea({ minX: 0, maxX: -1, minY: 0, groundY: 10 })).toBe(false)
    expect(isPetArea(null)).toBe(false)
  })
})

describe('interpolation', () => {
  const a: TimedPoint = { t: 0, x: 0, y: 0 }
  const b: TimedPoint = { t: 100, x: 10, y: -20 }

  it('interpolates linearly and clamps to the pair', () => {
    expect(interpolate(a, b, 50)).toEqual({ x: 5, y: -10, starved: false })
    expect(interpolate(a, b, -5)).toEqual({ x: 0, y: 0, starved: false })
    expect(interpolate(a, b, 100)).toEqual({ x: 10, y: -20, starved: false })
    expect(interpolate(a, b, 101)).toEqual({ x: 10, y: -20, starved: true })
  })

  it('samples a buffer', () => {
    const buf: TimedPoint[] = [a, b, { t: 200, x: 30, y: -20 }]
    expect(sampleBuffer([], 10)).toBeNull()
    expect(sampleBuffer(buf, 150)).toEqual({ x: 20, y: -20, starved: false })
    expect(sampleBuffer(buf, -1)).toEqual({ x: 0, y: 0, starved: false })
    expect(sampleBuffer(buf, 250)?.starved).toBe(true)
  })

  it('pushTimed appends in order and caps the buffer', () => {
    const buf: TimedPoint[] = []
    for (let i = 0; i < 6; i++) pushTimed(buf, { t: i * 10, x: i, y: 0 }, 10, 4)
    expect(buf.map((p) => p.t)).toEqual([20, 30, 40, 50])
  })

  it('pushTimed inserts a hold point after a gap, so the pet starts moving from where it stood', () => {
    const buf: TimedPoint[] = [{ t: 0, x: 5, y: 5 }]
    pushTimed(buf, { t: 1000, x: 15, y: 5 }, 10, 8)
    expect(buf).toEqual([
      { t: 0, x: 5, y: 5 },
      { t: 990, x: 5, y: 5 },
      { t: 1000, x: 15, y: 5 },
    ])
    // Rendering in the gap holds the old position; the move takes exactly the last step.
    expect(sampleBuffer(buf, 500)).toEqual({ x: 5, y: 5, starved: false })
    expect(sampleBuffer(buf, 995)?.x).toBeCloseTo(10)
  })

  it('pushTimed adds no hold point for consecutive steps', () => {
    const buf: TimedPoint[] = [{ t: 0, x: 0, y: 0 }]
    pushTimed(buf, { t: 10, x: 1, y: 0 }, 10, 8)
    pushTimed(buf, { t: 25, x: 2, y: 0 }, 10, 8) // 1.5 steps: still no gap
    expect(buf.map((p) => p.t)).toEqual([0, 10, 25])
  })

  it('pushTimed replaces states that are not newer than the new one', () => {
    const buf: TimedPoint[] = [
      { t: 0, x: 0, y: 0 },
      { t: 10, x: 1, y: 0 },
      { t: 20, x: 2, y: 0 },
    ]
    pushTimed(buf, { t: 10, x: 9, y: 9 }, 10, 8)
    expect(buf).toEqual([
      { t: 0, x: 0, y: 0 },
      { t: 10, x: 9, y: 9 },
    ])
  })
})

describe('pet overlay protocol', () => {
  const config: PetConfig = {
    configSeq: 3,
    overlay: { x: 0, y: 0, width: 1710, height: 1107 },
    area: { minX: 60, maxX: 1650, minY: 150, groundY: 1022 },
    stepMs: 1000 / 30,
    size: 'M',
    paletteId: 'mint',
    hitWindowName: hitWindowName(1),
    epoch: 0,
    debug: false,
  }
  const state: PetStateMsg = { seq: 1, t: 10, sentAt: 11, x: 855, y: 1022, facing: 1, state: 'idle', supportY: 1022, snap: true }
  const ready: PetReadyMsg = {
    configSeq: 3,
    anchor: { x: 120, y: 180 },
    petBox: { left: -60, top: -130, right: 60, bottom: 3 },
    edge: 240,
    devicePixelRatio: 2,
    glRenderer: null,
    hitWindowOpened: true,
  }
  const stats: OverlayStatsMsg = {
    at: 1,
    frames: 2,
    renders: 1,
    starvedFrames: 0,
    longFrames: 0,
    rafIntervalsMs: [16.7],
    inputToFrameMs: [],
    cursorMsgs: 0,
    cursorMsgsIgnored: 0,
    hitTests: 3,
    hoverMsgs: 1,
    pointerMsgs: 0,
    contextLosses: 0,
    truncated: false,
  }

  it('accepts well-formed payloads', () => {
    expect(isPetConfig(config)).toBe(true)
    expect(isPetConfig({ ...config, area: null })).toBe(true)
    expect(isPetStateMsg(state)).toBe(true)
    expect(isPetStateMsg({ ...state, supportY: null })).toBe(true)
    expect(isPetReadyMsg(ready)).toBe(true)
    expect(isPetDrawnMsg({ drawn: false, configSeq: 3 })).toBe(true)
    expect(isPetCursorMsg({ x: 1, y: 2 })).toBe(true)
    expect(isPetHoverResetMsg({ epoch: 4 })).toBe(true)
    expect(isPetVisibleMsg({ visible: false, epoch: 4 })).toBe(true)
    expect(isPetLogMsg({ level: 'warning', message: 'x' })).toBe(true)
    expect(isPetHoverMsg({ over: true, epoch: 0 })).toBe(true)
    expect(isPetPointerMsg({ kind: 'down', button: 0, screenX: 1, screenY: 2, groundX: 3, groundY: 4, epoch: 1 })).toBe(true)
    expect(isPetPointerMsg({ kind: 'up', button: 0, screenX: 1, screenY: 2, epoch: 1 })).toBe(true)
    expect(isPetPointerMsg({ kind: 'contextmenu', screenX: 1, screenY: 2, epoch: 1 })).toBe(true)
    expect(isOverlayStatsMsg(stats)).toBe(true)
  })

  it('rejects malformed payloads', () => {
    expect(isPetConfig({ ...config, stepMs: 0 })).toBe(false)
    expect(isPetConfig({ ...config, paletteId: 'pink' })).toBe(false)
    expect(isPetConfig({ ...config, size: 'XL' })).toBe(false)
    expect(isPetConfig({ ...config, hitWindowName: 'other' })).toBe(false)
    expect(isPetConfig({ ...config, epoch: -1 })).toBe(false)
    expect(isPetConfig({ ...config, debug: 'no' })).toBe(false)
    expect(isPetStateMsg({ ...state, facing: 0 })).toBe(false)
    expect(isPetStateMsg({ ...state, state: 'dance' })).toBe(false)
    expect(isPetStateMsg({ ...state, x: Number.POSITIVE_INFINITY })).toBe(false)
    const { supportY: _omitted, ...noSupport } = state
    expect(isPetStateMsg(noSupport)).toBe(false)
    expect(isPetReadyMsg({ ...ready, edge: 0 })).toBe(false)
    expect(isPetReadyMsg({ ...ready, petBox: { left: 1, top: 0, right: 0, bottom: 1 } })).toBe(false)
    expect(isPetReadyMsg({ ...ready, hitWindowOpened: 'yes' })).toBe(false)
    expect(isPetDrawnMsg({ drawn: true })).toBe(false)
    expect(isPetCursorMsg({ x: 1 })).toBe(false)
    expect(isPetHoverResetMsg({})).toBe(false)
    expect(isPetVisibleMsg({ visible: true })).toBe(false)
    expect(isPetLogMsg({ level: 'debug', message: 'x' })).toBe(false)
    expect(isPetHoverMsg({ over: true })).toBe(false)
    expect(isPetHoverMsg(null)).toBe(false)
    expect(isPetPointerMsg({ kind: 'down', button: 0, screenX: 1, screenY: 2, epoch: 1 })).toBe(false) // no ground point
    expect(isPetPointerMsg({ kind: 'up', button: 0, screenX: 1, screenY: 2 })).toBe(false) // no epoch
    expect(isPetPointerMsg({ kind: 'drag', button: 0, screenX: 1, screenY: 2, epoch: 1 })).toBe(false)
    expect(isOverlayStatsMsg({ ...stats, frames: 1.5 })).toBe(false)
    expect(isOverlayStatsMsg({ ...stats, rafIntervalsMs: ['x'] })).toBe(false)
  })

  it('every channel passes the preload allowlist', () => {
    for (const channel of Object.values(IPC)) expect(isAllowedChannel(channel), channel).toBe(true)
  })

  it('the preload allowlist rejects everything without a listed prefix', () => {
    for (const channel of ['', 'pet', 'PET:ready', ' pet:ready', 'xpet:ready', 'ELECTRON_BROWSER_REQUIRE', 'ELECTRON_BROWSER_WINDOW_ALERT']) {
      expect(isAllowedChannel(channel), JSON.stringify(channel)).toBe(false)
    }
  })

  it('names one grab-area window per page load', () => {
    expect(HIT_WINDOW_URL).toBe('about:blank')
    expect(hitWindowName(1)).toBe(`${HIT_WINDOW_NAME_PREFIX}-1`)
    expect(hitWindowName(12)).not.toBe(hitWindowName(1))
    expect(isHitWindowName(hitWindowName(7))).toBe(true)
    expect(isHitWindowName('bitbot-hit')).toBe(false)
    expect(isHitWindowName('bitbot-hit-0')).toBe(false)
    expect(isHitWindowName('_blank')).toBe(false)
  })
})

describe('behavior states and hotkeys', () => {
  it('lists the §10.1 states', () => {
    expect(BEHAVIOR_STATES).toHaveLength(14)
    expect(isBehaviorState('held')).toBe(true)
    expect(isBehaviorState('Held')).toBe(false)
  })

  it('has the §10.5 defaults, all distinct', () => {
    expect(DEFAULT_HOTKEYS.toggleVisible).toBe('Alt+Command+B')
    expect(DEFAULT_HOTKEYS.comeHere).toBe('Alt+Command+C')
    expect(DEFAULT_HOTKEYS.goHome).toBe('Alt+Command+H')
    expect(DEFAULT_HOTKEYS.toggleStay).toBe('Alt+Command+S')
    expect(new Set(HOTKEY_ACTIONS.map((a) => DEFAULT_HOTKEYS[a])).size).toBe(HOTKEY_ACTIONS.length)
  })
})
