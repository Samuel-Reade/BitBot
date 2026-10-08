// The world model (BITBOT_SPEC.md §8): the surfaces the pet moves on, built from the primary display and a helper
// window snapshot, and the transitions between them that navigation.ts plans over (§8.4). Pure; global screen points,
// y down; Phase 1 is the primary display only (§8.7).
//
// Surfaces (src/shared/world.ts Segment, Wall):
//   ground        one segment across the pet's area (screenArea.ts petAreaFor: the Dock top or the display bottom);
//   window tops   each eligible window's top (§8.2), only where no window in front covers it (§8.3, geometry.ts);
//   screen walls  the effective work area's left and right edges, from the ground up to the ceiling (the work area's
//                 top); not covered by windows, like the ground (the pet is drawn in front of every window);
//   window sides  each eligible window's visible left and right sides (§8.3).
// A segment's x0..x1 is where its contact point may be: the visible piece inset by edgeInsetPt at both ends, kept in
// the area. A climbing pet's contact point is at the wall's x, its body outside the window (turned a quarter turn,
// world.ts boxFor); y0..y1 keeps petHalfWidthPt between it and the ends of the visible piece (the ceiling, the ground).
//
// Transitions (§8.4), each one way:
//   drop   off a segment's end: the pet walks on until its body clears the visible end (edgeX), then falls straight
//          down onto the first segment below;
//   jump   to another segment within jump reach: between neighbours (no x overlap) from end to near end; up onto a
//          top above it from beside that top (never up through the window it lands on); never down onto one below it
//          (a drop does that);
//   mount  a short hop between a segment and a wall: beside a wall that spans the segment's level, or up to / down
//          from a wall's foot hanging above the segment (within jump reach), and at a window's top corner between
//          its side's top and its top.

import { boxFor, type Segment, type Wall, type WorldLink } from '../../../shared/world'
import { tuning } from '../../../shared/tuning'
import type { Box, PetArea, Point, Rect } from '../../../shared/geometry'
import type { HelperWindow } from '../../helper/protocol'
import { visibleSidePieces, visibleTopPieces } from './geometry'
import { effectiveWorkArea, petAreaFor, type DisplayGeometry } from './screenArea'

export interface WorldParams {
  /** §8.2 (tuning.world). */
  minWindowSize: { w: number; h: number }
  minAlpha: number
  excludedBundleIds: readonly string[]
  /** §8.3 edge-coincidence tolerance, pt (tuning.world). Also how close two surfaces must line up to connect. */
  occlusionTolerance: number
  /** Bitbot's own process: its windows are never surfaces (they still hide what is behind them). */
  ownPid: number
  /** The pet's size for the world, pt (tuning.world.pet × the body height; worldParamsFor). */
  petHalfWidthPt: number
  minSegmentPt: number
  edgeInsetPt: number
  /** Jump reach, pt (tuning.move.jump) and the arcs' height above their higher end (tuning.move.jumpApexPt). */
  jump: { maxHorizontal: number; maxUp: number; maxDown: number }
  jumpApexPt: number
  /** For route costs (tuning.move). */
  walkSpeed: number
  climbSpeed: number
  gravity: number
  terminalVelocity: number
  /** tuning.world.navPenaltyS */
  navPenaltyS: { drop: number; mount: number; climb: number; jump: number }
}

/** The world's parameters from tuning, for a pet whose body is bodyHeightPt tall (tuning.render.bodyHeightPt[size]). */
export function worldParamsFor(bodyHeightPt: number, ownPid: number): WorldParams {
  const { world, move } = tuning
  return {
    minWindowSize: world.minWindowSize,
    minAlpha: world.minAlpha,
    excludedBundleIds: world.excludedBundleIds,
    occlusionTolerance: world.occlusionTolerance,
    ownPid,
    petHalfWidthPt: world.pet.halfWidthBodies * bodyHeightPt,
    minSegmentPt: world.pet.minSegmentBodies * bodyHeightPt,
    edgeInsetPt: world.pet.edgeInsetBodies * bodyHeightPt,
    jump: move.jump,
    jumpApexPt: move.jumpApexPt,
    walkSpeed: move.walkSpeed,
    climbSpeed: move.climbSpeed,
    gravity: move.gravity,
    terminalVelocity: move.terminalVelocity,
    navPenaltyS: world.navPenaltyS,
  }
}

/** Where the pet is on the world: on a segment at x (its contact point at (x, segment.y)) or on a wall at y. */
export type PetPlace = { on: 'segment'; id: string; x: number } | { on: 'wall'; id: string; y: number }

/** One way between two surfaces (see the file comment). */
export interface Transition {
  kind: 'drop' | 'jump' | 'mount'
  from: PetPlace
  to: PetPlace
  /** drop only: where the pet leaves the segment (its contact point, past the end), falling straight down from there. */
  edgeX?: number
}

export interface World {
  /** Equal for equal geometry: the windows that matter (eligible ones, and what is in front of them), display, params. */
  readonly hash: string
  /** petAreaFor(display, petBox): the ground line, x limits, min y. */
  readonly area: PetArea
  /** The work area's top (§8.1 ceiling). */
  readonly ceilingY: number
  /** segments[0] is the ground ('ground'). */
  readonly segments: readonly Segment[]
  readonly walls: readonly Wall[]
  /** The transitions as lines, for the debug view. */
  readonly links: readonly WorldLink[]
  /** Eligible windows (§8.2) by CGWindowID, for riding (whether or not any of their edges is a surface). */
  readonly windows: ReadonlyMap<number, Rect>
  /** The nav graph's transitions (navigation.ts). */
  readonly transitions: readonly Transition[]
  /** What the world was built with. */
  readonly params: WorldParams
  segment(id: string): Segment | undefined
  wall(id: string): Wall | undefined
}

/** The contact point for a place (a place whose surface is not in `world`: its coordinate on a 0 line). */
export function placePoint(world: World, place: PetPlace): Point {
  if (place.on === 'segment') return { x: place.x, y: world.segment(place.id)?.y ?? 0 }
  return { x: world.wall(place.id)?.x ?? 0, y: place.y }
}

/**
 * The first segment at or below y whose x-range, widened by slackPt at both ends, contains x (the highest such); null
 * if none.
 */
export function segmentBelow(segments: readonly Segment[], x: number, y: number, slackPt = 0): Segment | null {
  let best: Segment | null = null
  for (const s of segments) {
    if (s.y < y || x < s.x0 - slackPt || x > s.x1 + slackPt) continue
    if (best === null || s.y < best.y) best = s
  }
  return best
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function rectOf(w: HelperWindow): Rect {
  return { x: w.x, y: w.y, width: w.w, height: w.h }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function excluded(bundleId: string | null, list: readonly string[]): boolean {
  if (bundleId === null) return false
  const id = bundleId.toLowerCase()
  return list.some((entry) => entry.toLowerCase() === id)
}

/** cyrb53: a fast 53-bit string hash, as 14 hex digits. */
function hashString(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/**
 * The world for `display` (the primary display, §8.7) and a helper snapshot (front to back). §8.2 eligibility: layer
 * 0, on screen, alpha > minAlpha, at least minWindowSize, not Bitbot's own, not an excluded bundle, and overlapping the
 * display. What hides an edge (§8.3): any window in front of it that is layer 0, on screen and alpha > minAlpha, of
 * any size, Bitbot's own included (not the Dock's or the menu bar's full-display windows, which are higher layers).
 */
export function buildWorld(display: DisplayGeometry, petBox: Box, windows: readonly HelperWindow[], params: WorldParams): World {
  const p = params
  const ewa = effectiveWorkArea(display, tuning.world.dockHiddenInsetPt)
  const area = Object.freeze(petAreaFor(display, petBox))
  const ceilingY = display.workArea.y
  const half = p.petHalfWidthPt
  const inset = p.edgeInsetPt
  const tol = p.occlusionTolerance

  // §8.2 and the occluders, in z order (front first).
  const occluders: Rect[] = []
  const eligible: { wid: number; rect: Rect; inFront: Rect[] }[] = []
  const hashed: (string | number)[] = []
  let hashedUpTo = 0
  for (const w of windows) {
    const visible = w.layer === 0 && w.onScreen && w.alpha > p.minAlpha && w.w > 0 && w.h > 0
    const rect = rectOf(w)
    if (!visible || !overlaps(rect, display.bounds)) continue
    const isEligible =
      w.w >= p.minWindowSize.w && w.h >= p.minWindowSize.h && w.pid !== p.ownPid && !excluded(w.bundleId, p.excludedBundleIds)
    if (isEligible) eligible.push({ wid: w.wid, rect, inFront: occluders.slice() })
    occluders.push(rect)
    hashed.push(w.wid, w.x, w.y, w.w, w.h, isEligible ? 1 : 0)
    if (isEligible) hashedUpTo = hashed.length // what is behind the last eligible window hides nothing that matters
  }
  const hash = hashString(
    JSON.stringify([display.bounds, display.workArea, petBox, params, hashed.slice(0, hashedUpTo)]),
  )

  // Surfaces.
  const segments: Segment[] = [
    { id: 'ground', kind: 'ground', windowId: null, y: area.groundY, x0: area.minX, x1: area.maxX },
  ]
  const walls: Wall[] = []
  const wallTop = ceilingY + half
  const wallBottom = area.groundY - half
  if (wallBottom >= wallTop) {
    walls.push({ id: 'wall:left', kind: 'screenWall', windowId: null, x: ewa.x, y0: wallTop, y1: wallBottom, wallOn: 'left' })
    walls.push({
      id: 'wall:right',
      kind: 'screenWall',
      windowId: null,
      x: ewa.x + ewa.width,
      y0: wallTop,
      y1: wallBottom,
      wallOn: 'right',
    })
  }
  const windowMap = new Map<number, Rect>()
  for (const { wid, rect, inFront } of eligible) {
    windowMap.set(wid, Object.freeze({ ...rect }))
    // The top: walkable only where the pet fits under the ceiling and above the ground.
    if (rect.y >= area.minY && rect.y < area.groundY) {
      let n = 0
      for (const piece of visibleTopPieces(rect, inFront, tol, p.minSegmentPt)) {
        const lo = Math.max(piece.lo, ewa.x)
        const hi = Math.min(piece.hi, ewa.x + ewa.width)
        if (hi - lo < p.minSegmentPt) continue
        const x0 = Math.max(lo + inset, area.minX)
        const x1 = Math.min(hi - inset, area.maxX)
        if (x1 < x0) continue
        segments.push({ id: `top:${wid}:${n++}`, kind: 'windowTop', windowId: wid, y: rect.y, x0, x1 })
      }
    }
    // The sides: the pet climbs outside the window, so its turned body must fit on the work area beside it.
    for (const side of ['left', 'right'] as const) {
      const x = side === 'left' ? rect.x : rect.x + rect.width
      const wallOn = side === 'left' ? 'right' : 'left'
      const body = boxFor(petBox, wallOn === 'right' ? 'wallRight' : 'wallLeft')
      if (x + body.left < ewa.x || x + body.right > ewa.x + ewa.width) continue
      let n = 0
      for (const piece of visibleSidePieces(rect, side, inFront, tol, p.minSegmentPt)) {
        const y0 = Math.max(piece.lo, ceilingY) + half
        const y1 = Math.min(piece.hi, area.groundY) - half
        if (y1 < y0) continue
        walls.push({ id: `side:${wid}:${side}:${n++}`, kind: 'windowSide', windowId: wid, x, y0, y1, wallOn })
      }
    }
  }

  const transitions = buildTransitions(segments, walls, area, p)
  const segmentById = new Map(segments.map((s) => [s.id, Object.freeze(s)]))
  const wallById = new Map(walls.map((w) => [w.id, Object.freeze(w)]))
  const world: World = {
    hash,
    area,
    ceilingY,
    segments: Object.freeze(segments),
    walls: Object.freeze(walls),
    links: [],
    windows: windowMap,
    transitions: Object.freeze(transitions),
    params,
    segment: (id) => segmentById.get(id),
    wall: (id) => wallById.get(id),
  }
  const links: WorldLink[] = transitions.map((t) => ({
    kind: t.kind,
    from: placePoint(world, t.from),
    to: placePoint(world, t.to),
  }))
  return Object.freeze({ ...world, links: Object.freeze(links) })
}

function buildTransitions(segments: readonly Segment[], walls: readonly Wall[], area: PetArea, p: WorldParams): Transition[] {
  const out: Transition[] = []
  const seen = new Set<string>()
  const add = (t: Transition): void => {
    const key = JSON.stringify(t)
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }
  const half = p.petHalfWidthPt
  const inset = p.edgeInsetPt
  const tol = p.occlusionTolerance
  const { maxHorizontal, maxUp, maxDown } = p.jump
  /** The first segment strictly below y under x (within the landing slack, as a fall lands). */
  const below = (x: number, y: number): Segment | null => {
    let best: Segment | null = null
    for (const s of segments) {
      if (s.y <= y || x < s.x0 - inset || x > s.x1 + inset) continue
      if (best === null || s.y < best.y) best = s
    }
    return best
  }
  const onSeg = (s: Segment, x: number): PetPlace => ({ on: 'segment', id: s.id, x: clamp(x, s.x0, s.x1) })

  // Drops: off each end, once the body clears the visible end, straight down onto the first segment below.
  for (const s of segments) {
    for (const [end, edgeX] of [
      [s.x0, s.x0 - inset - half],
      [s.x1, s.x1 + inset + half],
    ] as const) {
      if (edgeX < area.minX || edgeX > area.maxX) continue
      const target = below(edgeX, s.y)
      if (target) add({ kind: 'drop', from: onSeg(s, end), to: onSeg(target, edgeX), edgeX })
    }
  }

  // Jumps.
  for (const a of segments) {
    for (const b of segments) {
      if (a === b) continue
      const rise = a.y - b.y // > 0: b is higher
      if (rise > maxUp || -rise > maxDown) continue
      if (b.x0 > a.x1 || b.x1 < a.x0) {
        // Neighbours: from the near end to the near end.
        const fromX = b.x0 > a.x1 ? a.x1 : a.x0
        const toX = b.x0 > a.x1 ? b.x0 : b.x1
        if (Math.abs(toX - fromX) <= maxHorizontal) add({ kind: 'jump', from: onSeg(a, fromX), to: onSeg(b, toX) })
      } else if (rise > tol) {
        // b overlaps a from above: up from beside b's visible ends, landing on that end.
        for (const [fromX, toX] of [
          [b.x0 - inset - half, b.x0],
          [b.x1 + inset + half, b.x1],
        ] as const) {
          if (fromX >= a.x0 && fromX <= a.x1) add({ kind: 'jump', from: onSeg(a, fromX), to: onSeg(b, toX) })
        }
      }
    }
  }

  // Mounts beside a wall: the pet stands half its width from the wall, on the wall's side away from what it climbs.
  for (const w of walls) {
    const besideX = w.wallOn === 'right' ? w.x - half : w.x + half
    for (const s of segments) {
      const x = clamp(besideX, s.x0, s.x1)
      if (Math.abs(x - besideX) > half) continue
      const level = s.y - half // the wall contact y of a pet standing beside the wall
      const onSegment: PetPlace = { on: 'segment', id: s.id, x }
      if (level >= w.y0 - tol && level <= w.y1 + tol) {
        const onWall: PetPlace = { on: 'wall', id: w.id, y: clamp(level, w.y0, w.y1) }
        add({ kind: 'mount', from: onSegment, to: onWall })
        add({ kind: 'mount', from: onWall, to: onSegment })
      } else if (level > w.y1 && below(x, w.y1 + half - tol) === s) {
        // The wall's foot hangs above this segment, the first one under it.
        const gap = level - w.y1
        const foot: PetPlace = { on: 'wall', id: w.id, y: w.y1 }
        if (gap <= maxUp) add({ kind: 'mount', from: onSegment, to: foot })
        if (gap <= maxDown) add({ kind: 'mount', from: foot, to: onSegment })
      }
    }
  }

  // Mounts at a window's top corner: the top of its side ↔ the end of its top.
  for (const w of walls) {
    if (w.kind !== 'windowSide') continue
    for (const s of segments) {
      if (s.windowId !== w.windowId || Math.abs(w.y0 - half - s.y) > tol) continue
      const endX = w.wallOn === 'right' ? s.x0 : s.x1
      const cornerX = w.wallOn === 'right' ? w.x + inset : w.x - inset
      if (Math.abs(endX - cornerX) > tol) continue
      const top: PetPlace = { on: 'wall', id: w.id, y: w.y0 }
      const end: PetPlace = { on: 'segment', id: s.id, x: endX }
      add({ kind: 'mount', from: top, to: end })
      add({ kind: 'mount', from: end, to: top })
    }
  }
  return out
}
