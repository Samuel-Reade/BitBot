// Shared fixtures for the world tests (worldModel, navigation, locomotion, wander). Not a test file itself.

import type { HelperWindow } from '../src/main/helper/protocol'
import type { DisplayGeometry } from '../src/main/sim/world/screenArea'
import { buildWorld, worldParamsFor, type World, type WorldParams } from '../src/main/sim/world/worldModel'
import type { Box } from '../src/shared/geometry'

export const OWN_PID = 4242

/** The spikes' display: 1710×1107 pt, the work area from y 37 (menu bar) to 1022 (the Dock's top). */
export const DISPLAY: DisplayGeometry = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1710, height: 1107 },
  workArea: { x: 0, y: 37, width: 1710, height: 985 },
}

/** A symmetric pet box: area x 50..1660, minY 147, ground 1022. */
export const BOX: Box = { left: -50, top: -110, right: 50, bottom: 2 }

/** The production world params with round pet sizes: half width 50, narrowest top 100, inset 20. */
export const PARAMS: WorldParams = {
  ...worldParamsFor(96, OWN_PID),
  petHalfWidthPt: 50,
  minSegmentPt: 100,
  edgeInsetPt: 20,
}

/** An ordinary app window (eligible unless overridden). */
export function win(wid: number, x: number, y: number, w: number, h: number, more: Partial<HelperWindow> = {}): HelperWindow {
  return { wid, pid: 900 + wid, bundleId: 'com.example.app', layer: 0, x, y, w, h, onScreen: true, alpha: 1, ...more }
}

/**
 * W1: standing on the ground (bottom at 1022), top y 700 x 400..800 → segment top:1:0 x 420..780; sides climbable
 * y 750..972 (left x 400, right x 800).
 */
export const W1 = win(1, 400, 700, 400, 322)
/** W2: floating to the right of W1, top y 600 x 900..1200 → top:2:0 x 920..1180; sides y 650..750. */
export const W2 = win(2, 900, 600, 300, 200)
/** W3: low, top y 880 x 1300..1600 (within a jump of the ground) → top:3:0 x 1320..1580. */
export const W3 = win(3, 1300, 880, 300, 130)

export function world(windows: HelperWindow[] = [], params: WorldParams = PARAMS, display: DisplayGeometry = DISPLAY): World {
  return buildWorld(display, BOX, windows, params)
}
