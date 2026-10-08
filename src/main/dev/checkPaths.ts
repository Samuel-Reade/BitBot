// Deterministic motion for the dev check's phases (src/main/dev/overlayCheck.ts): the walk patrol, the chase on Spike
// A's Lissajous path, the drag patrol, the fall time of a drop, and when a still cursor enters and leaves the
// silhouette of a walking pet (the ground truth of the hover latencies). Pure: times are passed in; unit-tested
// (test/overlayCheck.test.ts). The Lissajous path and the chase step are ported from src/main/spike/overlay/sim.ts
// (spike code is never imported), so the chase is Spike A's synthetic mode, run for run.

import type { PetArea, Point, Rect } from '../../shared/geometry'
import { stepFall, type FallParams } from '../sim/locomotion/physics'

/**
 * A back-and-forth patrol's offset from its centre after `elapsedMs`: a triangle wave that starts at 0 moving toward
 * +amplitudePt (0 → +A → 0 → −A → 0 …) at speedPtS. 0 before it starts or when it can't move.
 */
export function patrolOffset(elapsedMs: number, amplitudePt: number, speedPtS: number): number {
  if (!(amplitudePt > 0) || !(speedPtS > 0) || !(elapsedMs > 0)) return 0
  const period = 4 * amplitudePt
  const u = ((elapsedMs / 1000) * speedPtS) % period
  if (u < amplitudePt) return u
  if (u < 3 * amplitudePt) return 2 * amplitudePt - u
  return u - period
}

/** A walk on the ground: back and forth ±amplitudePt around centerX at speedPtS, starting at startMs moving right. */
export interface Walk {
  centerX: number
  groundY: number
  amplitudePt: number
  speedPtS: number
  startMs: number
}

/** The walking pet's ground-contact point at time tMs (where it is before startMs: at its centre). */
export function walkAt(walk: Walk, tMs: number): Point {
  return { x: walk.centerX + patrolOffset(tMs - walk.startMs, walk.amplitudePt, walk.speedPtS), y: walk.groundY }
}

/** Spike A's area for its paths: the pet's whole canvas (edge × edge, the ground-contact point at `anchor`) inside the work area. */
export function canvasArea(workArea: Rect, edge: number, anchor: Point): PetArea {
  return {
    minX: workArea.x + anchor.x,
    maxX: workArea.x + workArea.width - (edge - anchor.x),
    minY: workArea.y + anchor.y,
    groundY: workArea.y + workArea.height,
  }
}

export interface LissajousOptions {
  /** Peak speed of the target along the path, pt/s. */
  peakSpeed: number
  freqX: number
  freqY: number
  phaseX: number
  /** Fraction of the half-extent used as amplitude (keeps the target off the very edges). */
  fill: number
}

export interface LissajousPath {
  cx: number
  cy: number
  ax: number
  ay: number
  /** Angular frequencies, rad/s. */
  wx: number
  wy: number
  phaseX: number
}

/** A Lissajous target path inside `area` whose peak speed is exactly opts.peakSpeed (Spike A's synthetic mode). */
export function makeLissajousPath(area: PetArea, opts: LissajousOptions): LissajousPath {
  const cx = (area.minX + area.maxX) / 2
  const cy = (area.minY + area.groundY) / 2
  const ax = ((area.maxX - area.minX) / 2) * opts.fill
  const ay = ((area.groundY - area.minY) / 2) * opts.fill
  // Peak speed for a base angular frequency of 1 rad/s, sampled over one full period (2π).
  let peakAtUnit = 0
  const samples = 20_000
  for (let i = 0; i < samples; i++) {
    const t = (2 * Math.PI * i) / samples
    const vx = ax * opts.freqX * Math.cos(opts.freqX * t + opts.phaseX)
    const vy = ay * opts.freqY * Math.cos(opts.freqY * t)
    peakAtUnit = Math.max(peakAtUnit, Math.hypot(vx, vy))
  }
  const w = peakAtUnit > 0 ? opts.peakSpeed / peakAtUnit : 0
  return { cx, cy, ax, ay, wx: opts.freqX * w, wy: opts.freqY * w, phaseX: opts.phaseX }
}

export function lissajousAt(path: LissajousPath, tS: number): Point {
  return {
    x: path.cx + path.ax * Math.sin(path.wx * tS + path.phaseX),
    y: path.cy + path.ay * Math.sin(path.wy * tS),
  }
}

/** `from` moved toward `to` by at most maxDist. */
export function approach(from: Point, to: Point, maxDist: number): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  if (dist <= maxDist || dist === 0) return { x: to.x, y: to.y }
  return { x: from.x + (dx / dist) * maxDist, y: from.y + (dy / dist) * maxDist }
}

/**
 * The chase: once per simulation step the pet moves toward the Lissajous target by at most speedPtS × the step. It
 * starts on the target (as Spike A's synthetic mode does). The target's time counts from startMs.
 */
export class Chase {
  private pos: Point | null = null

  constructor(
    private readonly path: LissajousPath,
    private readonly speedPtS: number,
    private readonly startMs: number,
  ) {}

  /** The pet's point for the step at tMs, dtS long. */
  step(tMs: number, dtS: number): Point {
    const target = lissajousAt(this.path, Math.max(0, tMs - this.startMs) / 1000)
    this.pos = this.pos === null ? target : approach(this.pos, target, this.speedPtS * dtS)
    return { x: this.pos.x, y: this.pos.y }
  }
}

/** The drag patrol: from `start` (the press) straight up liftPt, then back and forth ±amplitudePt around start.x, at speedPtS. */
export interface DragPatrol {
  start: Point
  liftPt: number
  amplitudePt: number
  speedPtS: number
}

/** How long the lift takes, ms. */
export function dragLiftMs(d: DragPatrol): number {
  return d.speedPtS > 0 ? (Math.max(0, d.liftPt) / d.speedPtS) * 1000 : 0
}

/** Where the cursor is `elapsedMs` after the press. */
export function dragPatrolAt(d: DragPatrol, elapsedMs: number): Point {
  const liftMs = dragLiftMs(d)
  if (elapsedMs < liftMs) return { x: d.start.x, y: d.start.y - (Math.max(0, elapsedMs) / 1000) * d.speedPtS }
  return { x: d.start.x + patrolOffset(elapsedMs - liftMs, d.amplitudePt, d.speedPtS), y: d.start.y - d.liftPt }
}

/** How long a pet let go heightPt above the ground falls before it lands, stepping the simulation's physics every stepMs. */
export function fallTimeMs(heightPt: number, params: FallParams, stepMs: number): number {
  if (!(heightPt > 0)) return 0
  const groundY = heightPt
  let y = 0
  let vy = 0
  for (let steps = 1; steps <= 10_000; steps++) {
    const next = stepFall(y, vy, stepMs / 1000, params, groundY)
    if (next.landed) return steps * stepMs
    y = next.y
    vy = next.vy
  }
  return Number.POSITIVE_INFINITY
}

export interface Crossing {
  tMs: number
  /** enter: the still point came inside the span; leave: it left it. */
  kind: 'enter' | 'leave'
}

/**
 * When a still point (x = pointX) enters and leaves the span [x + left, x + right] of a pet drawn at x = drawnX(t),
 * between fromMs and toMs, sampled every resolutionMs (a crossing is timed at the first sample on its far side).
 */
export function spanCrossings(
  drawnX: (tMs: number) => number,
  pointX: number,
  span: { left: number; right: number },
  fromMs: number,
  toMs: number,
  resolutionMs: number,
): Crossing[] {
  const out: Crossing[] = []
  if (!(resolutionMs > 0) || !(toMs > fromMs)) return out
  const inside = (t: number): boolean => {
    const d = pointX - drawnX(t)
    return d >= span.left && d <= span.right
  }
  let was = inside(fromMs)
  for (let t = fromMs + resolutionMs; t <= toMs; t += resolutionMs) {
    const now = inside(t)
    if (now !== was) out.push({ tMs: t, kind: now ? 'enter' : 'leave' })
    was = now
  }
  return out
}
