// Where the speech bubble goes (BITBOT_SPEC.md §9.4): above the pet, its tail pointing at it, flipped below when there
// is no room above, and kept inside the display. Shared and pure: the overlay draws the bubble with it
// (src/renderer/pet/placement.ts, bubble.ts) and main sizes the grab area with it (src/main/summaryBubble.ts →
// PetInteraction's bubbleBox), from the same inputs (the pet's drawn ground point, its box, the bubble's measured size,
// the overlay's bounds), so the clickable area is exactly where the bubble is drawn without a round trip per frame.

import type { Box, Point, Rect } from './geometry'
import { tuning } from './tuning'

export interface BubbleSize {
  width: number
  height: number
}

export interface BubbleLayoutTuning {
  tailPt: number
  gapPt: number
  screenMarginPt: number
  topInsetPt: number
  tailInsetPt: number
}

export interface BubbleLayout {
  /** The bubble's body (the tail is outside it, toward the pet), global pt. */
  rect: Rect
  /** Below the pet (no room above): the tail is on the bubble's top edge instead of its bottom. */
  below: boolean
  /** Where the tail's tip is along the bubble's width, pt from rect.x. */
  tailX: number
}

/**
 * The bubble of `size` for a pet whose ground-contact point is drawn at `ground` (global pt), with `petBox` relative
 * to it (turned for its attach, boxFor), inside `overlay` (the overlay window's bounds, global pt):
 * - centred over the box's middle, its tail gapPt above the box; below the box if that would cross
 *   overlay.y + topInsetPt and there is room below;
 * - then moved inside the overlay (screenMarginPt from the sides and bottom, topInsetPt from the top);
 * - the tail points at the box's middle, at least tailInsetPt from the bubble's sides.
 * Null if any input is not finite or the size is not positive.
 */
export function layoutBubble(
  ground: Point,
  petBox: Box,
  size: BubbleSize,
  overlay: Rect,
  t: BubbleLayoutTuning = tuning.ui.bubble,
): BubbleLayout | null {
  const numbers = [ground.x, ground.y, petBox.left, petBox.top, petBox.right, petBox.bottom, size.width, size.height]
  numbers.push(overlay.x, overlay.y, overlay.width, overlay.height)
  if (!numbers.every(Number.isFinite) || !(size.width > 0) || !(size.height > 0)) return null
  const { width: w, height: h } = size
  const centerX = ground.x + (petBox.left + petBox.right) / 2
  const minY = overlay.y + t.topInsetPt
  const maxY = overlay.y + overlay.height - t.screenMarginPt - h
  const aboveY = ground.y + petBox.top - t.gapPt - t.tailPt - h
  const belowY = ground.y + petBox.bottom + t.gapPt + t.tailPt
  const below = aboveY < minY && belowY <= maxY
  const y = clamp(below ? belowY : aboveY, minY, maxY)
  const minX = overlay.x + t.screenMarginPt
  const maxX = overlay.x + overlay.width - t.screenMarginPt - w
  const x = clamp(centerX - w / 2, minX, maxX)
  const tailX = w >= 2 * t.tailInsetPt ? clamp(centerX - x, t.tailInsetPt, w - t.tailInsetPt) : w / 2
  return { rect: { x, y, width: w, height: h }, below, tailX }
}

/** The bubble's body relative to the ground-contact point `ground` (the shape PetInteraction's boxes have). */
export function bubbleBoxRelative(layout: BubbleLayout, ground: Point): Box {
  const r = layout.rect
  return { left: r.x - ground.x, top: r.y - ground.y, right: r.x + r.width - ground.x, bottom: r.y + r.height - ground.y }
}

/** `value` within [min, max]; min wins if the range is empty (a bubble wider than the display starts at its left). */
function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value))
}
