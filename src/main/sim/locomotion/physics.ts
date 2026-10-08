// Falling and jumping (BITBOT_SPEC.md §8.5 "Physics", §8.4 jumps): gravity and terminal velocity, in global screen
// points with y down. Pure. Locomotion lands a fall on the first surface crossed (locomotion.ts).

import type { Point } from '../../../shared/geometry'

/** tuning.move.gravity and tuning.move.terminalVelocity. */
export interface FallParams {
  /** Downward acceleration, pt/s². */
  gravity: number
  /** Fastest downward speed, pt/s. */
  terminalVelocity: number
}

export interface FallStep {
  y: number
  vy: number
  /** It reached the ground this step: y = groundY, vy = 0. */
  landed: boolean
}

/**
 * One step of a vertical fall onto groundY: vy += g·dt (capped at terminal), y += vy·dt; reaching/passing the ground
 * lands (y = groundY, vy = 0). Semi-implicit Euler (velocity first). A fall never ends below the ground: a pet already
 * on it lands at once unless it is moving up off it, and one below it is put back on it.
 */
export function stepFall(y: number, vy: number, dtS: number, params: FallParams, groundY: number): FallStep {
  const nextVy = Math.min(vy + params.gravity * dtS, params.terminalVelocity)
  const nextY = y + nextVy * dtS
  if (nextY >= groundY || y > groundY) return { y: groundY, vy: 0, landed: true }
  return { y: nextY, vy: nextVy, landed: false }
}

/** A ballistic arc's launch: the velocity to leave with and the time it takes to arrive. */
export interface Arc {
  /** Velocity at takeoff, pt/s (y down: negative vy rises). vx stays constant on the way. */
  vx: number
  vy: number
  durationS: number
}

/**
 * The arc from `from` to `to` that peaks apexPt above the higher of the two (y down) under `gravity`, with no
 * terminal velocity: a deliberate jump (§8.4), and with apexPt 0 from the higher end, a walk-off drop (leaves at rest,
 * falls straight down when the two share x). Arrives exactly at `to` after durationS. Same point and no apex: 0 s.
 */
export function arcBetween(from: Point, to: Point, apexPt: number, gravity: number): Arc {
  const apexY = Math.min(from.y, to.y) - Math.max(0, apexPt)
  const rise = from.y - apexY
  const sink = to.y - apexY
  const durationS = Math.sqrt((2 * rise) / gravity) + Math.sqrt((2 * sink) / gravity)
  if (!(durationS > 0)) return { vx: 0, vy: 0, durationS: 0 }
  return { vx: (to.x - from.x) / durationS, vy: -Math.sqrt(2 * gravity * rise), durationS }
}
