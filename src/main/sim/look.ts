// Where the pet's eyes look (BITBOT_SPEC.md §6.3: "Eyes track the cursor (look-left/right/up) when the cursor is within
// ~300 pt"), as the rule on tuning.anim.look says. Main works it out once per simulation step from the cursor position
// alone (nothing else is read, nothing is kept) and sends it in pet:state's `look`; the overlay decides in which states
// the eyes use it (§6.3: while idle). Pure.
//
// The eyes sit eyeHeight of the pet box's height above the ground-contact point (the box above that point, i.e.
// −petBox.top), straight above it. Relative to them:
//   beyond radiusPt                                            → null (not looking)
//   more than upPt above, and more above than beside           → 'up'
//   more than sidePt left / right (from the viewer's side)     → 'left' / 'right'
//   anything else (on the face, or below it)                   → null (straight ahead)
// Hysteresis: every boundary is moved by hysteresisPt in favour of the previous answer, so another answer wins only
// once it is past its boundary by that much, and a cursor resting on a boundary never makes the eyes flicker.

import type { Box, Point } from '../../shared/geometry'
import type { LookDirection } from '../../shared/types'

/** tuning.anim.look satisfies this as is. */
export interface LookParams {
  radiusPt: number
  /** Eye height as a fraction of the pet box's height above the ground-contact point. */
  eyeHeight: number
  upPt: number
  sidePt: number
  hysteresisPt: number
}

/** Where the eyes are, global pt: eyeHeight of the box's height above `ground`. */
export function eyePoint(ground: Point, petBox: Box, eyeHeight: number): Point {
  return { x: ground.x, y: ground.y - eyeHeight * Math.max(0, -petBox.top) }
}

/**
 * The eyes' direction for a cursor at `cursor` and a pet standing at `ground` (its ground-contact point, global pt) with
 * box `petBox` (relative to that point). `previous`: the direction of the previous step (null: not looking, or straight
 * ahead). Any input that is not finite gives null.
 */
export function lookDirection(
  cursor: Point,
  ground: Point,
  petBox: Box,
  previous: LookDirection | null,
  params: LookParams,
): LookDirection | null {
  const eye = eyePoint(ground, petBox, params.eyeHeight)
  const dx = cursor.x - eye.x // > 0: right of the eyes, from the viewer's side
  const dy = eye.y - cursor.y // > 0: above them (screen y grows down)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null
  const h = Number.isFinite(params.hysteresisPt) ? Math.max(0, params.hysteresisPt) : 0
  // Each answer's own tests are relaxed by h when it was the previous answer, and tightened by h otherwise.
  const slack = (d: LookDirection): number => (d === previous ? h : -h)
  const looking = Math.hypot(dx, dy) <= params.radiusPt + (previous !== null ? h : -h)
  if (!looking) return null
  const up = slack('up')
  if (dy > params.upPt - up && dy - Math.abs(dx) > -up) return 'up'
  if (-dx > params.sidePt - slack('left')) return 'left'
  if (dx > params.sidePt - slack('right')) return 'right'
  return null
}
