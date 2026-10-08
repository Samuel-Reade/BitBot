// Falling (BITBOT_SPEC.md §8.5 "Physics"): gravity and terminal velocity, in global screen points with y down. Pure.
// M1 falls are straight down onto the ground (no toss, no bounce: M4); M3 lands on the first surface crossed.

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
