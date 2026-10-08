// The overlay page's session as main sees it (messages in src/shared/petProtocol.ts). Pure, so the rules are unit-tested
// (test/overlaySession.test.ts); the glue (bitbotApp.ts) feeds them.
// - PetStateSender: pet:state goes out only when the pet's x, y, facing, state or supportY changed or a snap is
//   pending, and never before the current page load's pet:ready (the first state after it is always a snap).
//   SPEC-DEVIATION: §5.1 draws this link as "pose/state @ 30 Hz"; 30 Hz is the most it sends. A still pet sends nothing,
//   so the overlay can stop drawing (§11 render on demand, decided (c) in docs/decisions/overlay.md).
// - PresentedPoint: where the overlay draws the pet's ground-contact point, as main estimates it. The overlay renders
//   one simulation step behind main's clock and interpolates (src/shared/interpolation.ts), so main does the same with
//   its two newest steps. PetInteraction places the grab area and runs the safety net with it (drawnPoint: a held pet
//   is the exception, drawn under the cursor).
// - DrawnGate: whether the pet is on its canvas for the current configuration (PetInteraction's petDrawn): pet:ready
//   counts as drawn for its configSeq (the overlay sends no pet:drawn for the configuration it started with),
//   pet:drawn reports every change after it (context lost / restored, a new configuration applied, a failed render),
//   and a new page load forgets everything until its own pet:ready.
// - recreateDelayMs: how long PetWindow waits before recreating a lost overlay, backing off while it keeps failing.

import { isPoint, type PetArea, type Point } from '../../shared/geometry'
import { interpolate, type TimedPoint } from '../../shared/interpolation'
import type { PetDrawnMsg, PetStateMsg } from '../../shared/petProtocol'
import type { BehaviorState, LookDirection, Mood } from '../../shared/types'

/** The part of the simulation's state the overlay is told about. */
export interface PetSimState {
  /** Ground-contact point, global pt. */
  x: number
  y: number
  facing: 1 | -1
  state: BehaviorState
  mood: Mood
  /** 0..1 */
  dust: number
  look: LookDirection | null
  /** The support line under the pet, global pt; null: nothing below it. */
  supportY: number | null
}

export function sameSimState(a: PetSimState, b: PetSimState): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.facing === b.facing &&
    a.state === b.state &&
    a.mood === b.mood &&
    a.dust === b.dust &&
    a.look === b.look &&
    a.supportY === b.supportY
  )
}

export class PetStateSender {
  private last: PetSimState | null = null
  private snapPending = true
  private ready = false
  private seq = 0
  private sentCount = 0

  constructor(private readonly send: (msg: PetStateMsg) => void) {}

  /** The current page load has reported pet:ready. */
  get isReady(): boolean {
    return this.ready
  }

  /** pet:state messages sent so far. */
  get sent(): number {
    return this.sentCount
  }

  get snapIsPending(): boolean {
    return this.snapPending
  }

  /**
   * true: the current page load reported pet:ready, states may go out. false: a new page load started or the page
   * went away; nothing is sent until the next ready, and the first state after it is a snap.
   */
  setReady(ready: boolean): void {
    this.ready = ready
    if (!ready) {
      this.last = null
      this.snapPending = true
    }
  }

  /**
   * The pet jumped (release, shown again, display change): the next state sent is a snap, so the overlay doesn't
   * interpolate across the jump.
   */
  requestSnap(): void {
    this.snapPending = true
  }

  /**
   * Offers the pet's state at nominal time `t` (the step's time on main's monotonic clock, ms); `sentAt` is the same
   * clock now. Sent if the load is ready and the state changed since the last one sent, or a snap is pending.
   * Returns whether it was sent. If `send` throws, nothing counts as sent (the next offer tries again) and the error
   * propagates.
   */
  offer(s: PetSimState, t: number, sentAt: number): boolean {
    if (!this.ready) return false
    const snap = this.snapPending
    if (!snap && this.last !== null && sameSimState(this.last, s)) return false
    const msg: PetStateMsg = {
      seq: this.seq + 1,
      t,
      sentAt,
      x: s.x,
      y: s.y,
      facing: s.facing,
      state: s.state,
      mood: s.mood,
      dust: s.dust,
      look: s.look,
      supportY: s.supportY,
      snap,
    }
    this.send(msg)
    this.seq = msg.seq
    this.last = { ...s }
    this.snapPending = false
    this.sentCount++
    return true
  }
}

/** Main's estimate of where the overlay draws the ground-contact point: the two newest steps, rendered one step behind. */
export class PresentedPoint {
  private prev: TimedPoint
  private curr: TimedPoint

  constructor(
    private readonly stepMs: number,
    start: TimedPoint,
  ) {
    this.curr = { t: start.t, x: start.x, y: start.y }
    this.prev = { t: start.t - stepMs, x: start.x, y: start.y }
  }

  /** A step produced the pet's position at nominal time `t`. Non-finite input is ignored. */
  push(t: number, p: Point): void {
    if (!Number.isFinite(t) || !isPoint(p)) return
    this.prev = this.curr
    this.curr = { t, x: p.x, y: p.y }
  }

  /** The pet jumped to `p` at `t` (a snap): nothing is interpolated from before it. Non-finite input is ignored. */
  restart(t: number, p: Point): void {
    if (!Number.isFinite(t) || !isPoint(p)) return
    this.curr = { t, x: p.x, y: p.y }
    this.prev = { t: t - this.stepMs, x: p.x, y: p.y }
  }

  /** Where the overlay draws the ground-contact point at `nowMs` (main's clock); always a finite point. */
  at(nowMs: number): Point {
    const r = interpolate(this.prev, this.curr, nowMs - this.stepMs)
    return Number.isFinite(r.x) && Number.isFinite(r.y) ? { x: r.x, y: r.y } : { x: this.curr.x, y: this.curr.y }
  }

  /** The newest step's state. */
  get latest(): TimedPoint {
    return { ...this.curr }
  }
}

/**
 * Where the overlay draws the ground-contact point at `nowMs` (PetInteraction's displayedPoint): a held pet under the
 * cursor, i.e. at `held`, the newest step's held point (the overlay draws a held pet at its newest grab-area move,
 * which that step followed); anything else one step behind, as `presented` estimates it. Without the held rule the
 * grab area trails a dragged pet by more than a step, and a cancelled drag drops the pet a step back (found by the
 * dev check, src/main/dev/overlayCheck.ts).
 */
export function drawnPoint(presented: PresentedPoint, nowMs: number, held: Point | null): Point {
  return held !== null && isPoint(held) ? { x: held.x, y: held.y } : presented.at(nowMs)
}

export class DrawnGate {
  private readySeen = false
  private drawnSeq: number | null = null
  private ok = false

  /** A new page load started (or the page went away): nothing is drawn until its pet:ready. */
  reset(): void {
    this.readySeen = false
    this.drawnSeq = null
    this.ok = false
  }

  /** pet:ready: the first frame was drawn with configuration `configSeq`. */
  ready(configSeq: number): void {
    this.readySeen = true
    this.mark(configSeq)
  }

  /** pet:drawn. drawn:false (context lost, a render failed) always counts, whatever its configSeq: fail closed. */
  drawn(msg: PetDrawnMsg): void {
    if (msg.drawn) this.mark(msg.configSeq)
    else this.ok = false
  }

  /**
   * The pet is drawn for configuration `configSeq` (the current one): this load's ready came, and the newest report is
   * "drawn" for exactly it.
   */
  isDrawn(configSeq: number): boolean {
    return this.readySeen && this.ok && this.drawnSeq === configSeq
  }

  /** The configuration last reported drawn (null: none, or the newest report was drawn:false). */
  get seq(): number | null {
    return this.ok ? this.drawnSeq : null
  }

  private mark(configSeq: number): void {
    // Reports arrive in order; an older configuration's "drawn" can't make a newer one count as drawn.
    if (this.drawnSeq !== null && configSeq < this.drawnSeq) return
    this.drawnSeq = configSeq
    this.ok = true
  }
}

/**
 * The wait before recreating the overlay after `failures` losses in a row with no pet:ready in between (1 = the first):
 * baseMs, doubling each time, capped at maxMs. A page that can never load (no WebGL) then costs a window and a renderer
 * every few minutes, not every ~20 s for the rest of the day.
 */
export function recreateDelayMs(failures: number, baseMs: number, maxMs: number): number {
  const doublings = Number.isFinite(failures) ? Math.min(Math.max(Math.floor(failures) - 1, 0), 30) : 0
  return Math.min(baseMs * 2 ** doublings, maxMs)
}

/**
 * The helper's frontmostFullscreen push, for the display the pet lives on: the frontmost app covers it. (A push with
 * no display list while fullscreen can't be placed on a display, so it counts: fail closed.)
 */
export function fullscreenOnDisplay(msg: { value: boolean; displayIds: readonly number[] }, displayId: number): boolean {
  return msg.value && (msg.displayIds.length === 0 || msg.displayIds.includes(displayId))
}

export function sameArea(a: PetArea | null, b: PetArea | null): boolean {
  if (a === null || b === null) return a === b
  return a.minX === b.minX && a.maxX === b.maxX && a.minY === b.minY && a.groundY === b.groundY
}
