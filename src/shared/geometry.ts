// 2D geometry in global screen points (top-left origin, y down — Electron's `screen` coordinates and CG global
// coordinates, BITBOT_SPEC.md §5.3). Pure; shared by main (simulation, grab area) and the overlay renderer.

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A box relative to a reference point (for the pet: its ground-contact point), pt. Usually left, top ≤ 0 ≤ right, bottom. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Where the pet's ground-contact point may be (Phase 1: on the primary display, §8.7), global pt.
 * groundY is the surface line it stands on (§8.1); minY is the highest it may be lifted (its box stays below the ceiling).
 */
export interface PetArea {
  minX: number
  maxX: number
  minY: number
  groundY: number
}

/** `box` placed at `p`, as a rect. */
export function boxAt(p: Point, box: Box): Rect {
  return { x: p.x + box.left, y: p.y + box.top, width: box.right - box.left, height: box.bottom - box.top }
}

/** `r` grown by `by` on every side (negative shrinks; never below zero size). */
export function inflateRect(r: Rect, by: number): Rect {
  const width = Math.max(0, r.width + 2 * by)
  const height = Math.max(0, r.height + 2 * by)
  return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height }
}

/** Edges inclusive. */
export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/** True if `inner` lies entirely inside `outer` (shared edges count as inside). */
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/** The smallest rect on whole points that covers `r` (window bounds must be integral). */
export function roundRectOutward(r: Rect): Rect {
  const x = Math.floor(r.x)
  const y = Math.floor(r.y)
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y }
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** `p` clamped into the area (x into [minX, maxX], y into [minY, groundY]). */
export function clampToArea(p: Point, area: PetArea): Point {
  return {
    x: Math.min(area.maxX, Math.max(area.minX, p.x)),
    y: Math.min(area.groundY, Math.max(area.minY, p.y)),
  }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isPoint(value: unknown): value is Point {
  return isRecord(value) && isFiniteNumber(value['x']) && isFiniteNumber(value['y'])
}

export function isRect(value: unknown): value is Rect {
  return (
    isRecord(value) &&
    isFiniteNumber(value['x']) &&
    isFiniteNumber(value['y']) &&
    isFiniteNumber(value['width']) &&
    isFiniteNumber(value['height']) &&
    value['width'] >= 0 &&
    value['height'] >= 0
  )
}

export function isBox(value: unknown): value is Box {
  return (
    isRecord(value) &&
    isFiniteNumber(value['left']) &&
    isFiniteNumber(value['top']) &&
    isFiniteNumber(value['right']) &&
    isFiniteNumber(value['bottom']) &&
    value['right'] >= value['left'] &&
    value['bottom'] >= value['top']
  )
}

export function isPetArea(value: unknown): value is PetArea {
  return (
    isRecord(value) &&
    isFiniteNumber(value['minX']) &&
    isFiniteNumber(value['maxX']) &&
    isFiniteNumber(value['minY']) &&
    isFiniteNumber(value['groundY']) &&
    value['maxX'] >= value['minX'] &&
    value['groundY'] >= value['minY']
  )
}
