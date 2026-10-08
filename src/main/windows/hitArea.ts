// Where the grab area goes (BITBOT_SPEC.md §2, §5.2; docs/decisions/overlay.md "approach B, hardened"). Pure.
//
// The grab area (hit window) is a small invisible panel that takes the pet's clicks; the overlay itself never takes
// mouse input. It exists only while the cursor is near the pet and the overlay is known to be on screen (a panel joins
// fullscreen Spaces, the overlay doesn't), covers the pet's box plus some slack, and moves only once the pet comes
// close to its edge, so a moving pet doesn't move a window every frame. PetInteraction decides with these functions on
// every simulation wake; ElectronHitWindow (the HitWindowPort) applies the result. When in doubt: hidden.

import {
  boxAt,
  inflateRect,
  isRect,
  rectContainsPoint,
  rectContainsRect,
  type Box,
  type Point,
  type Rect,
} from '../../shared/geometry'

export type HitWindowPlacement = { shown: false } | { shown: true; bounds: Rect }

/** The hidden placement (shared, frozen). */
export const HIT_WINDOW_HIDDEN: HitWindowPlacement = Object.freeze({ shown: false as const })

/** What PetInteraction drives; ElectronHitWindow (glue, next phase) implements it and skips no-op native calls. */
export interface HitWindowPort {
  /** Shows the grab area at `bounds` (global pt, integral) or hides it. Called on every simulation wake with the current decision. */
  place(placement: HitWindowPlacement): void
  /** true: the grab area takes the mouse (while shown); false: clicks pass through it to the apps underneath. */
  setMouseEnabled(on: boolean): void
}

export interface HitAreaTuning {
  /** The grab area appears when the cursor comes within this many pt of the pet's box. */
  nearMarginPt: number
  /** …and stays until the cursor is farther than this, pt (hysteresis: > nearMarginPt). */
  farMarginPt: number
  /** Its window is the pet's box grown by this much on each side, pt. */
  slackPt: number
  /** It moves once the pet's box comes within this many pt of its edge. */
  innerMarginPt: number
}

export interface HitAreaInput {
  /** Global pt. */
  cursor: Point
  /** Where the overlay draws the pet's ground-contact point, global pt. */
  pet: Point
  /** The pet's box relative to its ground-contact point (pet:ready); null until the overlay has measured it. */
  petBox: Box | null
  /** Not hidden by the user. */
  overlayShown: boolean
  /** The helper lists the overlay on screen: true, false, or null (unknown, e.g. no answer yet). */
  overlayOnScreen: boolean | null
  /** The overlay has drawn the pet for the current configuration (and has not lost its WebGL context). */
  petDrawn: boolean
  /** A press or the context menu is in progress: the grab area must not go away under it. */
  engaged: boolean
  /** The current placement (hysteresis, and the bounds kept while the pet stays well inside them). */
  current: HitWindowPlacement
}

/**
 * The grab area's placement for this wake:
 * - hidden without a pet box, while the overlay is hidden or the pet not drawn;
 * - engaged: shown unless the overlay is known to be off screen (an unknown answer doesn't end a drag; PetInteraction
 *   cancels the interaction when it becomes false);
 * - otherwise shown only when the overlay is known to be on screen and the cursor is near the pet: within nearMarginPt
 *   to appear, within farMarginPt to stay;
 * - shown, it keeps its bounds while the pet's box (+ innerMarginPt) stays inside them, else it is re-placed around the
 *   box + slackPt on whole points, always at the same size (grabAreaBounds).
 */
export function decideHitWindow(input: HitAreaInput, tuning: HitAreaTuning): HitWindowPlacement {
  const { petBox, current } = input
  if (!petBox || !input.overlayShown || !input.petDrawn) return HIT_WINDOW_HIDDEN
  if (input.engaged) {
    if (input.overlayOnScreen === false) return HIT_WINDOW_HIDDEN
  } else {
    if (input.overlayOnScreen !== true) return HIT_WINDOW_HIDDEN
    const margin = current.shown ? tuning.farMarginPt : tuning.nearMarginPt
    if (!cursorNearPet(input.cursor, input.pet, petBox, margin)) return HIT_WINDOW_HIDDEN
  }
  const box = boxAt(input.pet, petBox)
  // (A non-finite box is never inside anything, so it always gets here and is caught below.)
  if (current.shown && rectContainsRect(current.bounds, inflateRect(box, tuning.innerMarginPt))) return current
  const bounds = grabAreaBounds(box, tuning.slackPt)
  // NaN or infinite bounds must never reach the window server: such a pet can't be covered.
  const finite = isRect(bounds) && Number.isFinite(bounds.x + bounds.width) && Number.isFinite(bounds.y + bounds.height)
  return finite ? { shown: true, bounds } : HIT_WINDOW_HIDDEN
}

/**
 * The grab area around the pet's `box` (global pt): the box grown by slackPt on each side, on whole points, and the
 * same size wherever the box is (the position rounded down, the size rounded up plus the point a fractional position
 * may need). Rounding the grown box outward instead gives a size that depends on the pet's fractional position, so
 * most moves would also resize the window, which costs main, the renderer and the GPU process work (the dev check
 * measured about 2 points of main CPU and 1 of GPU in a 600 pt/s chase, src/main/dev/overlayCheck.ts).
 */
export function grabAreaBounds(box: Rect, slackPt: number): Rect {
  const r = inflateRect(box, slackPt)
  return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width) + 1, height: Math.ceil(r.height) + 1 }
}

/**
 * True if `cursor` is within `marginPt` of the pet's box on both axes, i.e. inside the box (placed at `pet`) grown by
 * marginPt; edges count. A non-finite cursor or pet is never near.
 */
export function cursorNearPet(cursor: Point, pet: Point, petBox: Box, marginPt: number): boolean {
  return rectContainsPoint(inflateRect(boxAt(pet, petBox), marginPt), cursor)
}

/**
 * The safety net: the grab area takes the mouse, nothing is engaged, and the cursor is outside the pet's box grown by
 * `marginPt` → click-through must be forced back on (the overlay's hover-off was lost or late, or the pet moved away
 * from a still cursor). A non-finite cursor counts as outside. Without a box it can't tell (the grab area is hidden
 * then anyway).
 */
export function shouldForceClickThrough(i: {
  mouseEnabled: boolean
  engaged: boolean
  cursor: Point
  pet: Point
  petBox: Box | null
  marginPt: number
}): boolean {
  return i.mouseEnabled && !i.engaged && i.petBox !== null && !cursorNearPet(i.cursor, i.pet, i.petBox, i.marginPt)
}
