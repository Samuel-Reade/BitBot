// Presentation interpolation (BITBOT_SPEC.md §5.1): main's 30 Hz simulation produces timed states; whoever draws
// the pet (the overlay renderer, and main for its own idea of where the pet is drawn) renders one step behind real
// time and interpolates between the two states around the render time. Pure; ported from the Spike A harness.

export interface TimedPoint {
  /** Nominal time, ms. */
  t: number
  x: number
  y: number
}

export interface InterpolationResult {
  x: number
  y: number
  /** The render time was past the newest state (nothing newer to interpolate toward). */
  starved: boolean
}

/** Linear interpolation between two timed states at `renderT`, clamped to [prev, curr]. */
export function interpolate(prev: TimedPoint, curr: TimedPoint, renderT: number, starveToleranceMs = 0.5): InterpolationResult {
  const span = curr.t - prev.t
  if (span <= 0 || renderT >= curr.t) return { x: curr.x, y: curr.y, starved: renderT > curr.t + starveToleranceMs }
  if (renderT <= prev.t) return { x: prev.x, y: prev.y, starved: false }
  const a = (renderT - prev.t) / span
  return { x: prev.x + (curr.x - prev.x) * a, y: prev.y + (curr.y - prev.y) * a, starved: false }
}

/** Interpolates inside a time-ordered buffer (oldest first); null when the buffer is empty. */
export function sampleBuffer(buffer: readonly TimedPoint[], renderT: number, starveToleranceMs = 0.5): InterpolationResult | null {
  const last = buffer[buffer.length - 1]
  if (!last) return null
  if (renderT >= last.t) return { x: last.x, y: last.y, starved: renderT > last.t + starveToleranceMs }
  for (let i = buffer.length - 1; i > 0; i--) {
    const a = buffer[i - 1]
    const b = buffer[i]
    if (a && b && renderT >= a.t) return interpolate(a, b, renderT, starveToleranceMs)
  }
  const first = buffer[0] ?? last
  return { x: first.x, y: first.y, starved: false }
}

/**
 * Appends `state` to a time-ordered buffer, keeping at most `cap` entries (oldest dropped).
 *
 * Main sends a state only when something changed, so after the pet stood still the next state can be seconds newer
 * than the previous one. Interpolating across that gap would slide the pet over it; instead, when the gap is longer
 * than `gapSteps` steps, a hold point (a copy of the newest state, re-timed to one step before `state`) is inserted
 * first, so the pet starts moving from where it stood exactly one step before the new state — as if every step had
 * been sent. A state that is not newer than the newest one replaces the tail from its time on (late duplicates).
 */
export function pushTimed<T extends TimedPoint>(buffer: T[], state: T, stepMs: number, cap: number, gapSteps = 1.5): void {
  while (buffer.length > 0 && (buffer[buffer.length - 1]?.t ?? Number.NEGATIVE_INFINITY) >= state.t) buffer.pop()
  const newest = buffer[buffer.length - 1]
  if (newest && state.t - newest.t > gapSteps * stepMs) buffer.push({ ...newest, t: state.t - stepMs })
  buffer.push(state)
  while (buffer.length > Math.max(1, cap)) buffer.shift()
}
