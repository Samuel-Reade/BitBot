// Locomotion (BITBOT_SPEC.md §5.1): the pet's position, velocity, the surface under it and its physics, in global
// screen points (y down; x, y is the pet's ground-contact point). Pure; stepped by the simulation loop.
//
// The pet lives on a World (world/worldModel.ts): it stands on segments (the ground, window tops) and climbs walls
// (the screen's, window sides). Behaviors (each a §10.1 BehaviorState, so it goes into pet:state as is):
//   idle   still, standing on a segment or holding on to a wall (attach tells which);
//   walk   along a segment at walkSpeed; run at runSpeed while more than runDistancePt of the walk is left;
//   climb  along a wall at climbSpeed;
//   jump   a controlled arc (§8.4): a jump between segments, a mount between a segment and a wall, the fall of a
//          walk-off drop; it lands where it was aimed (or on the first segment it crosses on the way down);
//   fall   an involuntary fall (released in the air, flung, its surface gone): gravity and terminal velocity (§8.5),
//          the screen's walls stop sideways motion, the ceiling stops it rising; lands on the first segment crossed;
//   land   stands still for landS after a landing (the renderer's squash and settle, §6.4), then goes on;
//   held   follows the point where the user holds it, clamped to the area.
// A landing faster than landBounce.minSpeed first bounces straight up at restitution × that speed (§8.5).
//
// Routes (world/navigation.ts): goTo plans one from where the pet stands and follows its moves; after a landing that
// was not the planned one, or after the world changed, it plans again from where it is. Riding (§8.5) is setWorld's.
//
// The ground rule (start, release, teleport): a pet within groundSnapPt of a segment's line (window tops included)
// stands on it; anywhere else it falls, from rest.

import { clampToArea, isPetArea, isPoint, type PetArea, type Point } from '../../../shared/geometry'
import type { PetAttach, Segment } from '../../../shared/world'
import { findRoute, placeOf, pointOf, type Move, type PetPlace, type Route } from '../world/navigation'
import { segmentBelow, type World } from '../world/worldModel'
import { arcBetween, type FallParams } from './physics'

/** The behaviors the pet moves in; each is also a §10.1 BehaviorState. */
export type LocomotionBehavior = 'idle' | 'walk' | 'run' | 'climb' | 'jump' | 'fall' | 'land' | 'held'

export interface LocomotionState {
  /** Ground-contact point, global pt (on a wall: the point against the wall). */
  x: number
  y: number
  /** Velocity, pt/s (y down). */
  vx: number
  vy: number
  /** 1: faces right (the default 3/4 view), −1: left; follows horizontal motion, kept while it has none. */
  facing: 1 | -1
  behavior: LocomotionBehavior
  /** Seconds since the current behavior began. */
  behaviorTimeS: number
  /** 'floor' standing, in the air or held; 'wallLeft' / 'wallRight' on a wall on its left / right. */
  attach: PetAttach
  /** The segment or wall id it is on; null in the air or held. */
  surface: string | null
  /** The window it rides (its top or side); null on the ground, a screen wall, in the air or held. */
  windowId: number | null
}

/** tuning.move satisfies this as is. */
export interface LocomotionParams extends FallParams {
  /** A pet at most this far from a segment's line (pt) stands on it (start, release, teleport, the ground moving). */
  groundSnapPt: number
  /** How long a landing stays in land, s (0: none). */
  landS: number
  walkSpeed: number
  runSpeed: number
  climbSpeed: number
  /** A walk with more than this left runs, pt. */
  runDistancePt: number
  /** A jump's arc peaks this far above its higher end, pt. */
  jumpApexPt: number
  /** A ridden window faster than this (pt/s) flings the pet off. */
  flingThreshold: number
  /** Its speed is measured over at least this long, s. */
  flingMinIntervalS: number
  landBounce: { minSpeed: number; restitution: number }
}

/** Float tolerance on landS (not a tunable): 12 steps of 1/30 s end a 0.4 s land, whatever the rounding. */
const LAND_EPSILON_S = 1e-9

/** Where a new pet appears: on the ground, at the bottom centre of its area. */
export function spawnPoint(area: PetArea): Point {
  return { x: (area.minX + area.maxX) / 2, y: area.groundY }
}

/** A flight: a jump's arc (time-based arrival at `to`) or a free flight (fall, bounce, a jump whose target went). */
interface Flight {
  /** 'arc': exact ballistics, no terminal velocity; 'fall': stepFall's integration, terminal velocity, kept in the area. */
  mode: 'arc' | 'fall'
  /** Where an arc arrives; null: lands on the first segment crossed. */
  to: PetPlace | null
  /** Seconds until it arrives at `to`. */
  leftS: number
  /** The visible extent of the segment it took off from (y, x-range): not landed on again on the way. */
  ignore: { y: number; x0: number; x1: number } | null
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export class Locomotion {
  private readonly params: LocomotionParams
  private w: World
  private readonly s: LocomotionState = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facing: 1,
    behavior: 'idle',
    behaviorTimeS: 0,
    attach: 'floor',
    surface: null,
    windowId: null,
  }
  /** The place it stands or climbs on; null in the air or held. */
  private on: PetPlace | null = null
  private flight: Flight | null = null
  private currentRoute: Route | null = null
  private moveIndex = 0
  private target: Point | null = null
  /** The world changed while the pet could not plan (in the air, landing): plan again when it can. */
  private replanPending = false
  /** tMs of the previous setWorld (window speed for flings). */
  private lastWorldTMs: number | null = null
  /** A fresh plan is starting: a move that can't start now gives up instead of planning again (no loop). */
  private planning = false

  /**
   * `start` (default: spawnPoint(world.area); also when it is not a finite point) is clamped into the area; the pet
   * stands there if it is on a segment (within groundSnapPt), else falls from rest. Throws on an invalid world area
   * or params.
   */
  constructor(world: World, params: LocomotionParams, start?: Point) {
    this.w = checkedWorld(world)
    this.params = checkedParams(params)
    this.place(start !== undefined && isPoint(start) ? start : spawnPoint(world.area))
  }

  /** A live, read-only view of the state (copy the fields to keep a snapshot). */
  get state(): Readonly<LocomotionState> {
    return this.s
  }

  get world(): World {
    return this.w
  }

  /** The area the pet is kept in (world.area, frozen). */
  get area(): PetArea {
    return this.w.area
  }

  /**
   * y of the surface line under the pet (its contact shadow, §6.1): its segment's when it stands; the first segment
   * below it in the air or held; null on a wall (or nothing below).
   */
  get supportY(): number | null {
    const on = this.on
    if (on?.on === 'wall') return null
    if (on?.on === 'segment') return this.s.y
    return segmentBelow(this.w.segments, this.s.x, this.s.y, this.w.params.edgeInsetPt)?.y ?? null
  }

  /** The route being followed; null when going nowhere. */
  get route(): Route | null {
    return this.currentRoute
  }

  /** Where it is going; null when going nowhere. */
  get goal(): Point | null {
    return this.target
  }

  /**
   * A new world (a new snapshot, a display change), at tMs (any monotonic clock, the same for every call). The same
   * geometry (equal hash) changes nothing. Otherwise:
   * standing or climbing on a window: the window moved → the pet moves with it (ridingMoved); faster than
   *   flingThreshold (its move ÷ the time since the previous setWorld) → it falls with the window's velocity; the
   *   window gone (closed, minimized, no longer eligible), or the pet's spot gone (resized away, covered) → it falls
   *   from rest. Then it is attached again by geometry (ids may change);
   * on the ground: the ground rule against the new ground (clamped into the new area); on a screen wall: onto the new
   *   wall at the same height (clamped);
   * held: clamped into the new area; in the air: carries on (an arc's target is found again by geometry, or it flies
   *   free).
   * A goal is planned again on the new world (at once, or when the pet can: after it lands).
   */
  setWorld(world: World, tMs: number): { ridingMoved: boolean } {
    const old = this.w
    const next = checkedWorld(world)
    const dtS = this.lastWorldTMs !== null && Number.isFinite(tMs) ? (tMs - this.lastWorldTMs) / 1000 : null
    if (Number.isFinite(tMs)) this.lastWorldTMs = tMs
    this.w = next
    if (next.hash === old.hash) return { ridingMoved: false }
    const s = this.s
    let ridingMoved = false
    if (s.behavior === 'held') {
      const p = clampToArea(s, next.area)
      s.x = p.x
      s.y = p.y
    } else if (this.flight) {
      const f = this.flight
      if (f.to) {
        const p = pointOf(old, f.to)
        const again = placeOf(next, p, next.params.occlusionTolerance)
        f.to = again && again.on === f.to.on ? again : null
      }
      if (this.target) this.replanPending = true
    } else if (this.on) {
      ridingMoved = this.reattach(old, dtS)
      if (this.target) {
        if (this.on && s.behavior !== 'land') this.replan()
        else this.replanPending = true
      }
    }
    return { ridingMoved }
  }

  /**
   * Plans a route to `target` from where the pet stands or climbs and follows it (after a landing ends). False if it
   * can't plan (held, in the air) or can get no nearer (then nothing changes). True also when it is already there.
   */
  goTo(target: Point): boolean {
    if (!isPoint(target) || !this.on || this.s.behavior === 'held') return false
    const route = findRoute(this.w, this.on, target, this.w.params)
    if (!route) return false
    if (route.moves.length === 0) {
      if (!route.reached) return false
      this.finishRoute()
      return true
    }
    this.target = { x: target.x, y: target.y }
    this.currentRoute = route
    this.moveIndex = 0
    this.replanPending = false
    if (this.s.behavior !== 'land') this.startMove()
    return true
  }

  /**
   * Drops the goal: a walking pet stops where it is, a climbing one stays on the wall (idle); a jumping or falling one
   * finishes its flight, a landing one its land. A walk-off already past its segment's end still drops.
   */
  stop(): void {
    const mv = this.move()
    if (mv?.kind === 'drop' && !this.flight && this.on?.on === 'segment') {
      const seg = this.w.segment(this.on.id)
      if (seg && (this.s.x < seg.x0 || this.s.x > seg.x1)) {
        this.target = null
        this.replanPending = false
        this.launchDrop(mv)
        this.currentRoute = null
        return
      }
    }
    this.finishRoute()
  }

  /** The user took hold of the pet (also mid-flight or landing): → held, velocity 0, no goal. Ignored while held. */
  grab(): void {
    if (this.s.behavior === 'held') return
    this.clearRoute()
    this.flight = null
    this.detach()
    this.s.vx = 0
    this.s.vy = 0
    this.begin('held')
  }

  /**
   * The user let go with the ground-contact point at `at` (clamped; not a finite point: where it is now): the ground
   * rule (M1: no toss). Ignored unless held, so a second release of the same press changes nothing.
   */
  release(at: Point): void {
    if (this.s.behavior !== 'held') return
    this.place(isPoint(at) ? at : this.s)
  }

  /**
   * Instant move (the dev check's scripted mover; §8.7's teleport later): clamped, then the ground rule; drops the
   * goal. Ignored while held (the user has it) and for a point that is not finite.
   */
  teleport(p: Point): void {
    if (this.s.behavior === 'held' || !isPoint(p)) return
    this.place(p)
  }

  /** Advances by dtS seconds (ignored unless finite and > 0). `held`: where the user holds it (held only). */
  step(dtS: number, held: Point | null): void {
    if (!(Number.isFinite(dtS) && dtS > 0)) return
    const s = this.s
    s.behaviorTimeS += dtS
    switch (s.behavior) {
      case 'held': {
        if (held === null || !isPoint(held)) {
          s.vx = 0
          s.vy = 0
          return
        }
        // SPEC-DEVIATION: §8.7 lets a pet be dropped on another display and teleports it back to the primary with a
        // sparkle (M4). M1's overlay covers only the primary display, so a drag (and the drop point, see release)
        // is clamped to the pet's area there: the pet stops at the display's edge.
        const p = clampToArea(held, this.w.area)
        s.vx = (p.x - s.x) / dtS
        s.vy = (p.y - s.y) / dtS
        s.x = p.x
        s.y = p.y
        return
      }
      case 'jump':
      case 'fall':
        if (this.flight) this.stepFlight(dtS)
        else this.fallFromRest()
        return
      case 'land':
        s.vx = 0
        s.vy = 0
        if (s.behaviorTimeS >= this.params.landS - LAND_EPSILON_S) this.continueRoute()
        return
      case 'walk':
      case 'run':
        this.stepWalk(dtS)
        return
      case 'climb':
        this.stepClimb(dtS)
        return
      case 'idle':
        s.vx = 0
        s.vy = 0
        return
    }
  }

  // ───────────────────────────── routes ─────────────────────────────

  private move(): Move | null {
    return this.currentRoute?.moves[this.moveIndex] ?? null
  }

  private clearRoute(): void {
    this.currentRoute = null
    this.moveIndex = 0
    this.target = null
    this.replanPending = false
  }

  /** No goal any more; a pet moving along a surface stops there (idle). */
  private finishRoute(): void {
    this.clearRoute()
    const b = this.s.behavior
    if (b === 'walk' || b === 'run' || b === 'climb') this.becomeIdle()
  }

  private becomeIdle(): void {
    this.s.vx = 0
    this.s.vy = 0
    if (this.on?.on === 'segment') {
      const seg = this.w.segment(this.on.id)
      if (seg) this.s.x = clamp(this.s.x, seg.x0, seg.x1)
    }
    this.begin('idle')
  }

  /** Plans again from where it is to the goal; nothing to do → idle. */
  private replan(): void {
    if (this.planning) {
      // The fresh plan's first move can't start (never expected: plans come from this world): stop rather than loop.
      this.clearRoute()
      this.becomeIdle()
      return
    }
    this.replanPending = false
    const goal = this.target
    if (!goal || !this.on) {
      this.finishRoute()
      return
    }
    const route = findRoute(this.w, this.on, goal, this.w.params)
    if (!route || route.moves.length === 0) {
      this.clearRoute()
      this.becomeIdle()
      return
    }
    this.currentRoute = route
    this.moveIndex = 0
    this.planning = true
    try {
      this.startMove()
    } finally {
      this.planning = false
    }
  }

  /** After a landing (or a mount onto a wall): the next move if it landed as planned, else a new plan. */
  private continueRoute(): void {
    if (!this.target) {
      this.becomeIdle()
      return
    }
    const mv = this.move()
    const planned =
      mv?.kind === 'jump' || mv?.kind === 'drop' ? mv.segment : mv?.kind === 'mount' ? mv.to.id : null
    if (!this.replanPending && planned !== null && planned === this.on?.id) this.nextMove()
    else this.replan()
  }

  private nextMove(): void {
    this.moveIndex++
    if (!this.move()) {
      this.clearRoute()
      this.becomeIdle()
      return
    }
    this.startMove()
  }

  /** Begins the current move (a walk or climb that is already done goes on to the next). */
  private startMove(): void {
    const mv = this.move()
    const on = this.on
    if (!mv || !on) {
      this.finishRoute()
      return
    }
    switch (mv.kind) {
      case 'walk':
        if (on.on !== 'segment' || on.id !== mv.segment) return this.replan()
        if (this.s.x === mv.toX) return this.nextMove()
        this.ensure(this.walkBehavior(Math.abs(mv.toX - this.s.x)))
        return
      case 'drop':
        if (on.on !== 'segment') return this.replan()
        if (this.s.x === mv.edgeX) return this.launchDrop(mv)
        this.ensure(this.walkBehavior(Math.abs(mv.edgeX - this.s.x)))
        return
      case 'climb':
        if (on.on !== 'wall' || on.id !== mv.wall) return this.replan()
        if (this.s.y === mv.toY) return this.nextMove()
        this.ensure('climb')
        return
      case 'jump': {
        const seg = this.w.segment(mv.segment)
        if (!seg) return this.replan()
        this.launchArc({ on: 'segment', id: seg.id, x: mv.toX }, this.params.jumpApexPt)
        return
      }
      case 'mount': {
        if (!(mv.to.on === 'segment' ? this.w.segment(mv.to.id) : this.w.wall(mv.to.id))) return this.replan()
        this.launchArc(mv.to, this.params.jumpApexPt)
        return
      }
    }
  }

  private walkBehavior(remaining: number): 'walk' | 'run' {
    return remaining > this.params.runDistancePt ? 'run' : 'walk'
  }

  // ───────────────────────────── moving ─────────────────────────────

  private stepWalk(dtS: number): void {
    const mv = this.move()
    const s = this.s
    if (!mv || (mv.kind !== 'walk' && mv.kind !== 'drop')) {
      this.becomeIdle()
      return
    }
    const toX = mv.kind === 'walk' ? mv.toX : mv.edgeX
    const remaining = Math.abs(toX - s.x)
    const behavior = this.walkBehavior(remaining)
    this.ensure(behavior)
    const speed = behavior === 'run' ? this.params.runSpeed : this.params.walkSpeed
    const dir = toX >= s.x ? 1 : -1
    const stepPt = Math.min(remaining, speed * dtS)
    s.x = remaining <= speed * dtS ? toX : s.x + dir * stepPt
    s.vx = dir * speed
    s.vy = 0
    if (remaining > 0) s.facing = dir
    if (this.on?.on === 'segment') this.on = { ...this.on, x: s.x }
    if (s.x !== toX) return
    if (mv.kind === 'drop') this.launchDrop(mv)
    else this.nextMove()
  }

  private stepClimb(dtS: number): void {
    const mv = this.move()
    const s = this.s
    if (!mv || mv.kind !== 'climb') {
      this.becomeIdle()
      return
    }
    const remaining = Math.abs(mv.toY - s.y)
    const dir = mv.toY >= s.y ? 1 : -1
    const speed = this.params.climbSpeed
    s.y = remaining <= speed * dtS ? mv.toY : s.y + dir * speed * dtS
    s.vx = 0
    s.vy = dir * speed
    if (this.on?.on === 'wall') this.on = { ...this.on, y: s.y }
    if (s.y === mv.toY) this.nextMove()
  }

  /** Takeoff on an arc to `to`, peaking apexPt above its higher end. */
  private launchArc(to: PetPlace, apexPt: number): void {
    const s = this.s
    const target = pointOf(this.w, to)
    const arc = arcBetween(s, target, apexPt, this.params.gravity)
    this.flight = { mode: 'arc', to, leftS: arc.durationS, ignore: this.takeoffExtent() }
    this.detach()
    s.vx = arc.vx
    s.vy = arc.vy
    if (arc.vx !== 0) s.facing = arc.vx > 0 ? 1 : -1
    this.begin('jump')
    if (arc.durationS === 0) this.arrive(to, 0)
  }

  /** A walk-off drop: from rest at edgeX, straight down onto its segment. */
  private launchDrop(mv: Extract<Move, { kind: 'drop' }>): void {
    const seg = this.w.segment(mv.segment)
    if (!seg) {
      this.fallFromRest()
      return
    }
    this.launchArc({ on: 'segment', id: seg.id, x: clamp(this.s.x, seg.x0, seg.x1) }, 0)
  }

  /** The visible extent of the segment the pet stands on (null: not on a window top). */
  private takeoffExtent(): Flight['ignore'] {
    const on = this.on
    if (on?.on !== 'segment') return null
    const seg = this.w.segment(on.id)
    if (!seg || seg.kind === 'ground') return null
    const inset = this.w.params.edgeInsetPt
    return { y: seg.y, x0: seg.x0 - inset, x1: seg.x1 + inset }
  }

  /** An involuntary fall from where it is, with velocity (vx, vy). */
  private fallWith(vx: number, vy: number): void {
    this.detach()
    this.flight = { mode: 'fall', to: null, leftS: 0, ignore: null }
    this.s.vx = vx
    this.s.vy = vy
    this.begin('fall')
  }

  private fallFromRest(): void {
    this.fallWith(0, 0)
  }

  private stepFlight(dtS: number): void {
    const f = this.flight as Flight
    const s = this.s
    const area = this.w.area
    const arriving = f.to !== null && f.leftS <= dtS
    const dt = arriving ? f.leftS : dtS
    let { x, y, vx, vy } = s
    const x0 = x
    const y0 = y
    const vy0 = vy
    if (f.mode === 'arc') {
      // SPEC-DEVIATION (§8.5 terminal velocity): an arc is exact ballistics so it arrives where it was aimed; only a
      // drop of more than ~930 pt would pass terminal velocity (a jump falls at most maxDown + jumpApexPt).
      x += vx * dt
      y += vy * dt + 0.5 * this.params.gravity * dt * dt
      vy += this.params.gravity * dt
    } else {
      // stepFall's integration (semi-implicit Euler), kept inside the area: the screen's walls stop it sideways and
      // the ceiling stops it rising.
      vy = Math.min(vy + this.params.gravity * dt, this.params.terminalVelocity)
      y += vy * dt
      x += vx * dt
      if (x < area.minX || x > area.maxX) {
        x = clamp(x, area.minX, area.maxX)
        vx = 0
      }
      if (y < area.minY) {
        y = area.minY
        vy = Math.max(0, vy)
      }
    }
    // The first segment crossed on the way down (the ground is never passed).
    const hit = y > y0 ? this.crossing(x0, y0, x, y, f.ignore) : null
    if (hit) {
      const frac = y === y0 ? 1 : (hit.seg.y - y0) / (y - y0)
      const impact = vy0 + frac * (vy - vy0)
      const planned = f.to?.on === 'segment' && f.to.id === hit.seg.id ? f.to.x : hit.x
      this.touchDown(hit.seg, planned, impact)
      return
    }
    s.x = x
    s.y = y
    s.vx = vx
    s.vy = vy
    if (vx !== 0) s.facing = vx > 0 ? 1 : -1
    if (arriving && f.to) {
      this.arrive(f.to, vy)
      return
    }
    f.leftS -= dt
  }

  /** The highest segment whose line the move (x0, y0) → (x1, y1) crosses on the way down, and where. */
  private crossing(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    ignore: Flight['ignore'],
  ): { seg: Segment; x: number } | null {
    const slack = this.w.params.edgeInsetPt
    const tol = this.w.params.occlusionTolerance
    let best: { seg: Segment; x: number } | null = null
    for (const seg of this.w.segments) {
      const ground = seg.kind === 'ground'
      if (!(y0 < seg.y && seg.y <= y1) && !(ground && y1 >= seg.y)) continue
      const frac = y1 === y0 ? 1 : clamp((seg.y - y0) / (y1 - y0), 0, 1)
      const x = x0 + frac * (x1 - x0)
      if (!ground) {
        if (x < seg.x0 - slack || x > seg.x1 + slack) continue
        if (ignore && Math.abs(seg.y - ignore.y) <= tol && x >= ignore.x0 && x <= ignore.x1) continue
      }
      if (best === null || seg.y < best.seg.y) best = { seg, x }
    }
    return best
  }

  /** An arc reached its target at time: lands on its segment or takes hold of its wall; gone → flies on, free. */
  private arrive(to: PetPlace, vy: number): void {
    const s = this.s
    if (to.on === 'segment') {
      const seg = this.w.segment(to.id)
      if (seg) {
        this.touchDown(seg, to.x, vy)
        return
      }
    } else {
      const wall = this.w.wall(to.id)
      if (wall) {
        this.flight = null
        s.x = wall.x
        s.y = clamp(to.y, wall.y0, wall.y1)
        s.vx = 0
        s.vy = 0
        this.attachTo({ on: 'wall', id: wall.id, y: s.y })
        this.begin('idle')
        this.continueRoute()
        return
      }
    }
    const f = this.flight as Flight
    f.to = null
  }

  /** Touchdown on `seg` at x with downward speed vy: a bounce if hard, else land (or straight on with landS 0). */
  private touchDown(seg: Segment, x: number, vy: number): void {
    const s = this.s
    s.x = clamp(x, seg.x0, seg.x1)
    s.y = seg.y
    const bounce = this.params.landBounce
    if (vy > bounce.minSpeed && bounce.restitution > 0) {
      this.flight = { mode: this.flight?.mode ?? 'fall', to: null, leftS: 0, ignore: null }
      s.vx = 0
      s.vy = -bounce.restitution * vy
      return
    }
    this.flight = null
    s.vx = 0
    s.vy = 0
    this.attachTo({ on: 'segment', id: seg.id, x: s.x })
    if (this.params.landS > 0) this.begin('land')
    else {
      this.begin('idle')
      this.continueRoute()
    }
  }

  // ───────────────────────────── surfaces ─────────────────────────────

  private attachTo(place: PetPlace): void {
    const s = this.s
    this.on = place
    s.surface = place.id
    if (place.on === 'segment') {
      s.attach = 'floor'
      s.windowId = this.w.segment(place.id)?.windowId ?? null
    } else {
      const wall = this.w.wall(place.id)
      s.attach = wall?.wallOn === 'left' ? 'wallLeft' : 'wallRight'
      s.windowId = wall?.windowId ?? null
    }
  }

  private detach(): void {
    this.on = null
    this.s.attach = 'floor'
    this.s.surface = null
    this.s.windowId = null
  }

  /** Puts the pet at `p` (clamped), at rest, with no goal: standing if it is on a segment, else falling. */
  private place(p: Point): void {
    const s = this.s
    this.clearRoute()
    this.flight = null
    const c = clampToArea(p, this.w.area)
    s.x = c.x
    s.y = c.y
    s.vx = 0
    s.vy = 0
    const place = this.standingPlace(c)
    if (place) {
      s.x = place.x
      s.y = this.w.segment(place.id)?.y ?? c.y
      this.attachTo(place)
      this.begin('idle')
    } else {
      this.fallFromRest()
    }
  }

  /** The segment a point stands on by the ground rule (walls never: a pet let go beside one falls). */
  private standingPlace(p: Point): Extract<PetPlace, { on: 'segment' }> | null {
    let best: Extract<PetPlace, { on: 'segment' }> | null = null
    let bestD = Infinity
    for (const seg of this.w.segments) {
      const d = Math.abs(seg.y - p.y)
      if (d > this.params.groundSnapPt || p.x < seg.x0 || p.x > seg.x1) continue
      if (d < bestD) {
        bestD = d
        best = { on: 'segment', id: seg.id, x: p.x }
      }
    }
    return best
  }

  /**
   * setWorld for a pet on a surface: rides its window, then finds its surface again in the new world (see setWorld).
   * Returns whether the ridden window moved.
   */
  private reattach(old: World, dtS: number | null): boolean {
    const s = this.s
    const on = this.on as PetPlace
    const w = this.w
    const wid = s.windowId
    let moved = false
    if (wid !== null) {
      const now = w.windows.get(wid)
      if (!now) {
        this.fallFromRest() // closed, minimized, hidden, or no longer a surface
        return false
      }
      const was = old.windows.get(wid)
      const dx = was ? now.x - was.x : 0
      const dy = was ? now.y - was.y : 0
      moved = dx !== 0 || dy !== 0
      s.x += dx
      s.y += dy
      if (moved && dtS !== null && dtS > 0) {
        const span = Math.max(dtS, this.params.flingMinIntervalS)
        if (Math.hypot(dx, dy) / span > this.params.flingThreshold) {
          this.fallWith(dx / span, dy / span)
          return true
        }
      }
    }
    const tol = w.params.occlusionTolerance
    if (on.on === 'segment') {
      if (wid === null) {
        // The ground (the display changed): the ground rule against the new one.
        const ground = w.segments[0] as Segment
        s.x = clamp(s.x, ground.x0, ground.x1)
        if (ground.y - s.y <= this.params.groundSnapPt) {
          s.y = ground.y
          this.attachTo({ on: 'segment', id: ground.id, x: s.x })
        } else {
          this.fallFromRest()
        }
        return moved
      }
      const slack = w.params.edgeInsetPt
      const seg = w.segments.find(
        (g) => g.windowId === wid && Math.abs(g.y - s.y) <= tol && s.x >= g.x0 - slack && s.x <= g.x1 + slack,
      )
      if (!seg) {
        this.fallFromRest() // its spot is covered or resized away
        return moved
      }
      // A walk-off past the end keeps its x until it drops.
      const walkingOff = this.move()?.kind === 'drop'
      if (!walkingOff) s.x = clamp(s.x, seg.x0, seg.x1)
      s.y = seg.y
      this.attachTo({ on: 'segment', id: seg.id, x: s.x })
      return moved
    }
    const wallOn = s.attach === 'wallLeft' ? 'left' : 'right'
    const slack = w.params.petHalfWidthPt
    const wall =
      wid === null
        ? w.wall(on.id)
        : w.walls.find(
            (g) =>
              g.windowId === wid &&
              g.wallOn === wallOn &&
              Math.abs(g.x - s.x) <= tol &&
              s.y >= g.y0 - slack &&
              s.y <= g.y1 + slack,
          )
    if (!wall) {
      this.fallFromRest()
      return moved
    }
    s.x = wall.x
    s.y = clamp(s.y, wall.y0, wall.y1)
    this.attachTo({ on: 'wall', id: wall.id, y: s.y })
    return moved
  }

  /** Begins `behavior` (its time from 0). */
  private begin(behavior: LocomotionBehavior): void {
    this.s.behavior = behavior
    this.s.behaviorTimeS = 0
  }

  /** Begins `behavior` unless already in it (a walk going on to the next walk keeps its time). */
  private ensure(behavior: LocomotionBehavior): void {
    if (this.s.behavior !== behavior) this.begin(behavior)
  }
}

function checkedWorld(world: World): World {
  if (!isPetArea(world.area) || world.segments[0]?.kind !== 'ground') {
    throw new RangeError(`Locomotion: invalid world (area ${JSON.stringify(world.area)})`)
  }
  return world
}

function checkedParams(params: LocomotionParams): LocomotionParams {
  const p = params
  const positive = (v: number): boolean => Number.isFinite(v) && v > 0
  const nonNegative = (v: number): boolean => Number.isFinite(v) && v >= 0
  const valid =
    positive(p.gravity) &&
    positive(p.terminalVelocity) &&
    nonNegative(p.groundSnapPt) &&
    nonNegative(p.landS) &&
    positive(p.walkSpeed) &&
    positive(p.runSpeed) &&
    positive(p.climbSpeed) &&
    nonNegative(p.runDistancePt) &&
    nonNegative(p.jumpApexPt) &&
    positive(p.flingThreshold) &&
    nonNegative(p.flingMinIntervalS) &&
    nonNegative(p.landBounce?.minSpeed) &&
    Number.isFinite(p.landBounce?.restitution) &&
    p.landBounce.restitution >= 0 &&
    p.landBounce.restitution < 1
  if (!valid) throw new RangeError(`Locomotion: invalid params ${JSON.stringify(p)}`)
  return {
    gravity: p.gravity,
    terminalVelocity: p.terminalVelocity,
    groundSnapPt: p.groundSnapPt,
    landS: p.landS,
    walkSpeed: p.walkSpeed,
    runSpeed: p.runSpeed,
    climbSpeed: p.climbSpeed,
    runDistancePt: p.runDistancePt,
    jumpApexPt: p.jumpApexPt,
    flingThreshold: p.flingThreshold,
    flingMinIntervalS: p.flingMinIntervalS,
    landBounce: { minSpeed: p.landBounce.minSpeed, restitution: p.landBounce.restitution },
  }
}
