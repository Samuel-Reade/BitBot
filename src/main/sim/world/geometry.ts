// Visible pieces of window edges (BITBOT_SPEC.md §8.3): a window's top edge is walkable, and its sides climbable, only
// where no window in front of it (earlier in the helper's front-to-back list) covers them. Pure; global screen points,
// y down. worldModel.ts turns the pieces into segments and walls.

import type { Rect } from '../../../shared/geometry'

/** A closed 1D interval lo..hi (lo ≤ hi), pt. */
export interface Range {
  lo: number
  hi: number
}

/**
 * `base` minus every range in `cuts`: what is left, in order, left to right. A cut that only touches an end (shares
 * one point) removes nothing; a cut covering all of base leaves nothing.
 */
export function subtractRanges(base: Range, cuts: readonly Range[]): Range[] {
  let pieces: Range[] = base.hi >= base.lo ? [{ lo: base.lo, hi: base.hi }] : []
  for (const cut of cuts) {
    if (!(cut.hi > cut.lo)) continue // an empty cut (or a single point) hides nothing
    const next: Range[] = []
    for (const p of pieces) {
      if (cut.hi <= p.lo || cut.lo >= p.hi) {
        next.push(p) // no overlap (touching counts as none)
        continue
      }
      if (cut.lo > p.lo) next.push({ lo: p.lo, hi: cut.lo })
      if (cut.hi < p.hi) next.push({ lo: cut.hi, hi: p.hi })
    }
    pieces = next
    if (pieces.length === 0) break
  }
  return pieces
}

/** Pieces at least minLength long (§8.3 "drop sub-segments shorter than the pet's width"). */
function longEnough(pieces: readonly Range[], minLength: number): Range[] {
  return pieces.filter((p) => p.hi - p.lo >= minLength)
}

/**
 * The visible x-ranges of `win`'s top edge (y = win.y, x from win.x to its right edge): minus the x-range of every
 * window in `inFront` whose rectangle contains that y, give or take `tolerance` (an in-front window whose bottom or
 * top edge lies within tolerance of the line covers it too). Pieces shorter than minLength are dropped.
 */
export function visibleTopPieces(win: Rect, inFront: readonly Rect[], tolerance: number, minLength: number): Range[] {
  const y = win.y
  const cuts: Range[] = []
  for (const r of inFront) {
    if (y >= r.y - tolerance && y <= r.y + r.height + tolerance) cuts.push({ lo: r.x, hi: r.x + r.width })
  }
  return longEnough(subtractRanges({ lo: win.x, hi: win.x + win.width }, cuts), minLength)
}

/**
 * The visible y-ranges (top..bottom) of `win`'s left or right side (x = win.x or its right edge): minus the y-range of
 * every window in `inFront` whose rectangle contains that x, give or take `tolerance`. Pieces shorter than minLength
 * are dropped.
 */
export function visibleSidePieces(
  win: Rect,
  side: 'left' | 'right',
  inFront: readonly Rect[],
  tolerance: number,
  minLength: number,
): Range[] {
  const x = side === 'left' ? win.x : win.x + win.width
  const cuts: Range[] = []
  for (const r of inFront) {
    if (x >= r.x - tolerance && x <= r.x + r.width + tolerance) cuts.push({ lo: r.y, hi: r.y + r.height })
  }
  return longEnough(subtractRanges({ lo: win.y, hi: win.y + win.height }, cuts), minLength)
}
