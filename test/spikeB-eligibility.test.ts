import { describe, expect, it } from 'vitest'
import type { HelperWindow } from '../src/main/helper/protocol'
import {
  buildScene,
  electronRect,
  globalToLocal,
  helperRect,
  isExcludedBundle,
  windowEligibility,
  type EligibilityRules,
} from '../src/main/spike/windows/eligibility'
import {
  isDebugCursorMsg,
  isDebugReadyMsg,
  isDebugSceneMsg,
  isDebugStatusMsg,
  placeLabel,
  rectsOverlap,
  windowLabel,
} from '../src/shared/spikeWindows'
import { tuning } from '../src/shared/tuning'

const OWN_PID = 4242
const WINDOW_SERVER_PID = 382

const RULES: EligibilityRules = {
  minSize: tuning.world.minWindowSize,
  excludedBundleIds: tuning.world.excludedBundleIds,
  windowServerPids: [WINDOW_SERVER_PID],
  ownPids: [OWN_PID],
  minAlpha: tuning.spikeWindows.eligibleMinAlpha,
}

function win(overrides: Partial<HelperWindow> = {}): HelperWindow {
  return {
    wid: 100,
    pid: 900,
    bundleId: 'com.apple.Safari',
    layer: 0,
    x: 100,
    y: 80,
    w: 1200,
    h: 800,
    onScreen: true,
    alpha: 1,
    ...overrides,
  }
}

describe('windowEligibility (§8.2)', () => {
  it('accepts an ordinary layer-0 app window', () => {
    expect(windowEligibility(win(), RULES)).toEqual({ eligible: true, reasons: [] })
  })

  it('rejects every rule separately, with its reason', () => {
    expect(windowEligibility(win({ layer: 3 }), RULES).reasons).toEqual(['layer'])
    expect(windowEligibility(win({ layer: -1 }), RULES).reasons).toEqual(['layer'])
    expect(windowEligibility(win({ onScreen: false }), RULES).reasons).toEqual(['offscreen'])
    expect(windowEligibility(win({ alpha: 0.5 }), RULES).reasons).toEqual(['alpha'])
    expect(windowEligibility(win({ pid: OWN_PID }), RULES).reasons).toEqual(['own'])
    expect(windowEligibility(win({ bundleId: 'com.apple.dock' }), RULES).reasons).toEqual(['excluded'])
  })

  it('uses the size limits inclusively (160×120 is a surface, 159 or 119 is not)', () => {
    expect(windowEligibility(win({ w: 160, h: 120 }), RULES).eligible).toBe(true)
    expect(windowEligibility(win({ w: 159, h: 120 }), RULES).reasons).toEqual(['small'])
    expect(windowEligibility(win({ w: 160, h: 119 }), RULES).reasons).toEqual(['small'])
  })

  it('needs alpha strictly above the threshold', () => {
    expect(windowEligibility(win({ alpha: 0.51 }), RULES).eligible).toBe(true)
    expect(windowEligibility(win({ alpha: 0 }), RULES).reasons).toEqual(['alpha'])
  })

  it('lists every failing rule, in §8.2 order', () => {
    const verdict = windowEligibility(
      win({ layer: 20, onScreen: false, alpha: 0, w: 10, h: 10, pid: OWN_PID, bundleId: 'com.apple.dock' }),
      RULES,
    )
    expect(verdict).toEqual({ eligible: false, reasons: ['layer', 'offscreen', 'alpha', 'small', 'own', 'excluded'] })
  })

  it('excludes Window Server windows by pid (the helper reports them without a bundle id)', () => {
    expect(windowEligibility(win({ pid: WINDOW_SERVER_PID, bundleId: null }), RULES).reasons).toEqual(['excluded'])
    // The menu bar strip: excluded twice over.
    expect(windowEligibility(win({ pid: WINDOW_SERVER_PID, bundleId: null, layer: 24, w: 1710, h: 38 }), RULES).reasons).toEqual([
      'layer',
      'small',
      'excluded',
    ])
  })

  it('treats any other window without a bundle id as not excluded (the rest of the rules still apply)', () => {
    expect(windowEligibility(win({ bundleId: null }), RULES).eligible).toBe(true)
    expect(windowEligibility(win({ bundleId: null, layer: 24 }), RULES).reasons).toEqual(['layer'])
    // Window Server pid unknown: only the other rules can exclude its windows (SPEC-DEVIATION fallback).
    const unknown = { ...RULES, windowServerPids: [] }
    expect(windowEligibility(win({ pid: WINDOW_SERVER_PID, bundleId: null }), unknown).eligible).toBe(true)
  })

  it('matches excluded bundle ids case-insensitively', () => {
    expect(isExcludedBundle('com.apple.spotlight', ['com.apple.Spotlight'])).toBe(true)
    expect(isExcludedBundle('COM.APPLE.DOCK', ['com.apple.dock'])).toBe(true)
    expect(isExcludedBundle('com.apple.dockextra', ['com.apple.dock'])).toBe(false)
    expect(windowEligibility(win({ bundleId: 'com.apple.WindowManager' }), RULES).reasons).toEqual(['excluded'])
  })
})

describe('coordinates', () => {
  it('converts global points to window-local points', () => {
    expect(globalToLocal({ x: 100, y: 80, w: 50, h: 40 }, { x: 0, y: 0 })).toEqual({ x: 100, y: 80, w: 50, h: 40 })
    // A window on a display left of the main one has negative global x.
    expect(globalToLocal({ x: -1200, y: 300, w: 50, h: 40 }, { x: -1920, y: 0 })).toEqual({ x: 720, y: 300, w: 50, h: 40 })
    expect(globalToLocal({ x: 10, y: 10, w: 5, h: 5 }, { x: 0, y: 39 })).toEqual({ x: 10, y: -29, w: 5, h: 5 })
  })

  it('converts helper and Electron rectangles to one shape', () => {
    expect(helperRect(win())).toEqual({ x: 100, y: 80, w: 1200, h: 800 })
    expect(electronRect({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })
})

describe('buildScene', () => {
  const windows = [
    win({ wid: 1, pid: 600, bundleId: 'com.apple.controlcenter', layer: 25, x: 1500, y: 0, w: 40, h: 38 }),
    win({ wid: 2, pid: OWN_PID, bundleId: 'com.github.Electron', layer: 3, x: 0, y: 0, w: 1710, h: 1107 }),
    win({ wid: 3, pid: 700, bundleId: 'com.microsoft.VSCode', layer: 0, x: 200, y: 100, w: 1000, h: 700 }),
  ]
  const scene = buildScene(windows, 1_791_337_451.5, {
    seq: 7,
    source: 'push',
    origin: { x: 0, y: 0 },
    rules: RULES,
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1710, height: 1107 }, workArea: { x: 0, y: 39, width: 1710, height: 983 }, scaleFactor: 2 }],
    primaryDisplayId: 1,
  })

  it('keeps the snapshot order as the z-index (0 = frontmost)', () => {
    expect(scene.windows.map((w) => [w.z, w.wid])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
  })

  it('marks eligibility, reasons and our own windows', () => {
    expect(scene.windows.map((w) => [w.wid, w.eligible, w.reasons, w.own])).toEqual([
      [1, false, ['layer', 'small', 'excluded'], false],
      [2, false, ['layer', 'own'], true],
      [3, true, [], false],
    ])
  })

  it('carries local and global rectangles and the displays', () => {
    expect(scene.windows[2]?.rect).toEqual({ x: 200, y: 100, w: 1000, h: 700 })
    expect(scene.windows[2]?.global).toEqual({ x: 200, y: 100, w: 1000, h: 700 })
    expect(scene.displays).toEqual([
      {
        id: 1,
        primary: true,
        scaleFactor: 2,
        bounds: { x: 0, y: 0, w: 1710, h: 1107 },
        workArea: { x: 0, y: 39, w: 1710, h: 983 },
        globalBounds: { x: 0, y: 0, w: 1710, h: 1107 },
        globalWorkArea: { x: 0, y: 39, w: 1710, h: 983 },
      },
    ])
    expect(scene).toMatchObject({ seq: 7, source: 'push', ts: 1_791_337_451.5 })
  })

  it('offsets everything by the overlay origin', () => {
    const shifted = buildScene([windows[2] as HelperWindow], 1, {
      seq: 1,
      source: 'request',
      origin: { x: 1710, y: -200 },
      rules: RULES,
      displays: [],
      primaryDisplayId: 1,
    })
    expect(shifted.windows[0]?.rect).toEqual({ x: 200 - 1710, y: 300, w: 1000, h: 700 })
    expect(shifted.windows[0]?.global).toEqual({ x: 200, y: 100, w: 1000, h: 700 })
  })

  it('produces a message the renderer accepts', () => {
    expect(isDebugSceneMsg(scene)).toBe(true)
    expect(isDebugSceneMsg(JSON.parse(JSON.stringify(scene)))).toBe(true)
  })
})

describe('debug overlay messages', () => {
  it('rejects malformed scenes', () => {
    expect(isDebugSceneMsg(null)).toBe(false)
    expect(isDebugSceneMsg({ seq: 1, ts: 1, source: 'push', windows: [{}], displays: [] })).toBe(false)
    expect(isDebugSceneMsg({ seq: 1, ts: 1, source: 'other', windows: [], displays: [] })).toBe(false)
    expect(
      isDebugSceneMsg({
        seq: 1,
        ts: 1,
        source: 'push',
        displays: [],
        windows: [
          {
            z: 0,
            wid: 1,
            pid: 1,
            layer: 0,
            bundleId: null,
            rect: { x: 0, y: 0, w: 1, h: 1 },
            global: { x: 0, y: 0, w: 1, h: 1 },
            eligible: false,
            reasons: ['title'],
            own: false,
          },
        ],
      }),
    ).toBe(false)
  })

  it('validates the small messages', () => {
    expect(isDebugCursorMsg({ x: 1, y: 2, gx: 1, gy: 41 })).toBe(true)
    expect(isDebugCursorMsg({ x: 1, y: 2 })).toBe(false)
    expect(isDebugStatusMsg({ lines: ['a', 'b'] })).toBe(true)
    expect(isDebugStatusMsg({ lines: ['a', 2] })).toBe(false)
    expect(isDebugReadyMsg({ role: 'overlay', dpr: 2, width: 1710, height: 1107 })).toBe(true)
    expect(isDebugReadyMsg({ role: 'pet', dpr: 2, width: 1, height: 1 })).toBe(false)
  })
})

describe('labels', () => {
  it('names a window by z, wid, layer, bundle id and size, never anything else', () => {
    const item = { z: 3, wid: 5729, layer: 0, bundleId: 'com.microsoft.VSCode', global: { x: 0, y: 0, w: 1024, h: 698 }, reasons: [], own: false }
    expect(windowLabel(item)).toBe('#3 wid 5729 L0 com.microsoft.VSCode 1024×698')
    expect(windowLabel({ ...item, bundleId: null, layer: 24, reasons: ['layer'] })).toBe('#3 wid 5729 L24 (no bundle id) 1024×698 ✕ layer')
    expect(windowLabel({ ...item, bundleId: 'com.github.Electron', own: true, reasons: ['own'] })).toBe(
      '#3 wid 5729 L0 Bitbot com.github.Electron 1024×698 ✕ own',
    )
  })

  it('places a label at its preferred spot when free', () => {
    const area = { x: 0, y: 39, w: 1710, h: 983 }
    expect(placeLabel({ x: 100, y: 100 }, { w: 80, h: 17 }, [], area, 6)).toEqual({ x: 100, y: 100, w: 80, h: 17 })
  })

  it('clamps into the area and moves down past collisions', () => {
    const area = { x: 0, y: 39, w: 1710, h: 983 }
    // Preferred above the work area (a full-display window): clamped to its top.
    expect(placeLabel({ x: 2, y: 2 }, { w: 80, h: 17 }, [], area, 6)).toEqual({ x: 2, y: 39, w: 80, h: 17 })
    const taken = [{ x: 0, y: 39, w: 200, h: 17 }]
    expect(placeLabel({ x: 2, y: 2 }, { w: 80, h: 17 }, taken, area, 6)).toEqual({ x: 2, y: 57, w: 80, h: 17 })
    // Right edge: pulled back inside.
    expect(placeLabel({ x: 1700, y: 500 }, { w: 80, h: 17 }, [], area, 6).x).toBe(1630)
  })

  it('gives up after maxShifts and keeps the last slot', () => {
    const area = { x: 0, y: 0, w: 100, h: 100 }
    const wall = [{ x: 0, y: 0, w: 100, h: 100 }]
    const box = placeLabel({ x: 0, y: 0 }, { w: 10, h: 10 }, wall, area, 3)
    expect(rectsOverlap(box, wall[0] as { x: number; y: number; w: number; h: number })).toBe(true)
  })

  it('treats touching rectangles as not overlapping', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false)
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 })).toBe(true)
  })
})
