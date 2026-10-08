// The pet's area on a display (BITBOT_SPEC.md §8.1 ground and walls, §8.7: Phase 1 lives on the primary display).
// Pure: the glue passes Electron's primary Display (its id, bounds and workArea fit DisplayGeometry) and the pet's
// measured box from pet:ready.
//
// §8.1: the ground is the bottom of the work area: the Dock's top when the Dock is at the bottom, the display's bottom
// when it is at a side, where it is a wall the pet stands beside (the work area already stops at it). An auto-hidden
// Dock still keeps a thin strip of the display out of the work area, so a work-area edge that close to the display
// edge counts as the display edge: the ground is then the display bottom, as §8.1 asks. The top edge (the menu bar)
// never does. Locomotion keeps the pet in the area, which is where M1 clamps a drag (SPEC-DEVIATION in locomotion.ts).

import { tuning } from '../../../shared/tuning'
import type { Box, PetArea, Rect } from '../../../shared/geometry'

/** The part of Electron's Display this needs, global pt. */
export interface DisplayGeometry {
  id: number
  bounds: Rect
  workArea: Rect
}

/** tuning.world satisfies this as is. */
export interface ScreenAreaTuning {
  /** A left, right or bottom work-area edge at most this many pt inside the display edge counts as the display edge. */
  dockHiddenInsetPt: number
}

/**
 * The work area with each of its left, right and bottom edges moved out to the display's edge when it lies at most
 * dockHiddenInsetPt inside it (an auto-hidden Dock's strip). The top never moves. Also pulls in an edge reported
 * outside the display (never seen from Electron), so the pet can never be placed off its overlay.
 */
export function effectiveWorkArea(display: DisplayGeometry, dockHiddenInsetPt: number): Rect {
  const { bounds: b, workArea: w } = display
  const snaps = (inset: number): boolean => inset <= dockHiddenInsetPt
  const left = snaps(w.x - b.x) ? b.x : w.x
  const right = snaps(b.x + b.width - (w.x + w.width)) ? b.x + b.width : w.x + w.width
  const bottom = snaps(b.y + b.height - (w.y + w.height)) ? b.y + b.height : w.y + w.height
  return { x: left, y: w.y, width: Math.max(0, right - left), height: Math.max(0, bottom - w.y) }
}

/**
 * Limits for the ground-contact point so the pet's box (relative to that point) stays inside the effective work area:
 * left, right and top inside it, standing on its bottom edge (the ground line; what of the box lies below the contact
 * point, the feet's front edge, overlaps the Dock or the display bottom as feet on a floor do). A work area narrower
 * than the box pins x to the centre that centres the box in it; one shorter than the box allows no lifting
 * (minY = groundY).
 */
export function petAreaFor(display: DisplayGeometry, petBox: Box, settings: ScreenAreaTuning = tuning.world): PetArea {
  const ewa = effectiveWorkArea(display, settings.dockHiddenInsetPt)
  let minX = ewa.x - petBox.left
  let maxX = ewa.x + ewa.width - petBox.right
  if (maxX < minX) {
    const centre = (minX + maxX) / 2
    minX = centre
    maxX = centre
  }
  const groundY = ewa.y + ewa.height
  const minY = Math.min(ewa.y - petBox.top, groundY)
  return { minX, maxX, minY, groundY }
}
