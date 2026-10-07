// Spike A simulation (pure; unit-tested). Owns the pet's ground-contact point in global screen
// points (y down) on the primary display, its facing and a coarse phase. Stepped at a fixed rate
// by the harness; deterministic for every mode except `follow` (cursor) and `interactive` (user).

import type { OverlayMode, OverlayPhase } from '../../../shared/spikeOverlay'

export interface Point {
  x: number
  y: number
}

/** Where the pet's ground-contact point may be. */
export interface SimArea {
  minX: number
  maxX: number
  /** Highest point (smallest y) the ground-contact point may reach: ceiling for tosses and chase targets. */
  minY: number
  /** The ground: the primary display's work-area bottom (§8.1: the Dock top when the Dock is at the bottom). */
  groundY: number
}

export interface TossParams {
  /** Fraction of vertical speed kept on a bounce. */
  restitution: number
  /** Landing speeds (pt/s) above this bounce; below it the pet lands. */
  minBounceSpeed: number
  /** Horizontal speed kept on each ground bounce. */
  groundFriction: number
  /** Horizontal speed kept when hitting a screen side. */
  wallRestitution: number
  /** Pause after landing before walking again, s. */
  landPauseS: number
}

export interface SimParams {
  walkSpeed: number
  followSpeed: number
  gravity: number
  terminalVelocity: number
  facingDeadband: number
  toss: TossParams
  /** Synthetic-mode target path (required in synthetic mode). */
  path: LissajousPath | null
}

export interface PetSimState {
  x: number
  y: number
  vx: number
  vy: number
  facing: 1 | -1
  phase: OverlayPhase
  /** Seconds spent in the current phase. */
  phaseTimeS: number
  walkDir: 1 | -1
}

export interface SimInput {
  /** Simulation time at the end of this step, s since start (drives the synthetic path). */
  tS: number
  /** Cursor in global screen points, when the mode needs it. */
  cursor: Point | null
  /** While held: where the user holds the pet's ground-contact point. */
  held: Point | null
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

export interface LissajousOptions {
  /** Peak speed of the target along the path, pt/s. */
  peakSpeed: number
  freqX: number
  freqY: number
  phaseX: number
  /** Fraction of the half-extent used as amplitude (keeps the target off the very edges). */
  fill: number
}

/** A Lissajous target path inside the area whose peak speed is exactly `peakSpeed`. */
export function makeLissajousPath(area: SimArea, opts: LissajousOptions): LissajousPath {
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

export interface TimedSample {
  /** ms */
  t: number
  x: number
  y: number
}

/**
 * Release velocity (pt/s) from cursor samples (oldest first): displacement over the trailing
 * `windowMs`, or over the last two samples when the window holds only one.
 */
export function releaseVelocity(samples: readonly TimedSample[], windowMs: number): Point {
  const last = samples[samples.length - 1]
  if (!last) return { x: 0, y: 0 }
  let first: TimedSample | undefined
  for (const s of samples) {
    if (s.t >= last.t - windowMs) {
      first = s
      break
    }
  }
  if (!first || first === last) first = samples[samples.length - 2]
  if (!first) return { x: 0, y: 0 }
  const dt = (last.t - first.t) / 1000
  if (dt < 0.001) return { x: 0, y: 0 }
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt }
}

export function clampToArea(p: Point, area: SimArea): Point {
  return {
    x: Math.min(area.maxX, Math.max(area.minX, p.x)),
    y: Math.min(area.groundY, Math.max(area.minY, p.y)),
  }
}

/** Moves `from` toward `to` by at most `maxDist`. */
function approach(from: Point, to: Point, maxDist: number): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  if (dist <= maxDist || dist === 0) return { x: to.x, y: to.y }
  return { x: from.x + (dx / dist) * maxDist, y: from.y + (dy / dist) * maxDist }
}

/** Constant-speed walk between min and max, reflecting at the ends (keeps the speed exact). */
export function walkStep(x: number, dir: 1 | -1, dist: number, min: number, max: number): { x: number; dir: 1 | -1 } {
  if (max - min < 1e-6) return { x: min, dir }
  let nx = x + dir * dist
  let nd = dir
  for (let i = 0; i < 8 && (nx > max || nx < min); i++) {
    if (nx > max) {
      nx = 2 * max - nx
      nd = -1
    } else {
      nx = 2 * min - nx
      nd = 1
    }
  }
  return { x: Math.min(max, Math.max(min, nx)), dir: nd }
}

export class OverlaySim {
  readonly state: PetSimState
  private followOffset: Point = { x: 0, y: 0 }
  private stay = false

  constructor(
    readonly mode: OverlayMode,
    private readonly area: SimArea,
    private readonly params: SimParams,
  ) {
    if (mode === 'synthetic' && !params.path) throw new Error('OverlaySim: synthetic mode needs a path')
    const start = OverlaySim.initialPoint(mode, area, params.path)
    this.state = {
      x: start.x,
      y: start.y,
      vx: 0,
      vy: 0,
      facing: 1,
      phase: mode === 'walk' || mode === 'interactive' ? 'walk' : mode === 'static' ? 'stand' : 'chase',
      phaseTimeS: 0,
      walkDir: 1,
    }
  }

  static initialPoint(mode: OverlayMode, area: SimArea, path: LissajousPath | null): Point {
    if (mode === 'synthetic' && path) return clampToArea(lissajousAt(path, 0), area)
    return { x: (area.minX + area.maxX) / 2, y: area.groundY }
  }

  /** Follow mode aims at cursor + offset (e.g. so the pet's head stays just below the cursor). */
  setFollowOffset(offset: Point): void {
    this.followOffset = { ...offset }
  }

  /** Interactive "Stay here": stop walking (falls and drags still work). */
  setStay(stay: boolean): void {
    this.stay = stay
  }

  get staying(): boolean {
    return this.stay
  }

  get bounds(): Readonly<SimArea> {
    return this.area
  }

  /** The user grabbed the pet (interactive mode). */
  grab(): void {
    this.setPhase('held')
    this.state.vx = 0
    this.state.vy = 0
  }

  /**
   * The user let go at `at` with cursor velocity `velocity` (pt/s). A press that barely moved
   * (`petClick`) on the ground just resumes; anything else is tossed.
   */
  release(at: Point, velocity: Point, petClick: boolean): void {
    const s = this.state
    s.x = Math.min(this.area.maxX, Math.max(this.area.minX, at.x))
    s.y = Math.min(this.area.groundY, at.y)
    if (petClick && s.y >= this.area.groundY - 0.5) {
      s.y = this.area.groundY
      s.vx = 0
      s.vy = 0
      this.setPhase(this.stay ? 'stand' : 'walk')
      return
    }
    const speed = Math.hypot(velocity.x, velocity.y)
    const cap = this.params.terminalVelocity
    const k = petClick ? 0 : speed > cap ? cap / speed : 1
    s.vx = velocity.x * k
    s.vy = velocity.y * k
    this.updateFacing(s.vx)
    this.setPhase('fall')
  }

  step(dtS: number, input: SimInput): void {
    const s = this.state
    s.phaseTimeS += dtS
    switch (s.phase) {
      case 'held':
        this.stepHeld(dtS, input.held)
        return
      case 'fall':
        this.stepFall(dtS)
        return
      case 'land':
        s.vx = 0
        s.vy = 0
        if (s.phaseTimeS >= this.params.toss.landPauseS) {
          s.walkDir = s.facing
          this.setPhase(this.stay ? 'stand' : 'walk')
        }
        return
      default:
        break
    }
    switch (this.mode) {
      case 'static':
        s.vx = 0
        s.vy = 0
        return
      case 'walk':
      case 'interactive':
        if (this.stay) {
          s.vx = 0
          s.vy = 0
          if (s.phase !== 'stand') this.setPhase('stand')
          return
        }
        if (s.phase !== 'walk') this.setPhase('walk')
        this.stepWalk(dtS)
        return
      case 'synthetic':
        if (!this.params.path) return
        this.stepChase(dtS, clampToArea(lissajousAt(this.params.path, input.tS), this.area))
        return
      case 'follow':
        if (!input.cursor) return
        this.stepChase(
          dtS,
          clampToArea({ x: input.cursor.x + this.followOffset.x, y: input.cursor.y + this.followOffset.y }, this.area),
        )
        return
    }
  }

  private setPhase(phase: OverlayPhase): void {
    this.state.phase = phase
    this.state.phaseTimeS = 0
  }

  private updateFacing(vx: number): void {
    if (Math.abs(vx) > this.params.facingDeadband) this.state.facing = vx > 0 ? 1 : -1
  }

  private stepWalk(dtS: number): void {
    const s = this.state
    const prevX = s.x
    // The walk lives on the ground; snap back if something left the pet elsewhere.
    s.y = this.area.groundY
    const next = walkStep(s.x, s.walkDir, this.params.walkSpeed * dtS, this.area.minX, this.area.maxX)
    s.x = next.x
    s.walkDir = next.dir
    s.vx = (s.x - prevX) / dtS
    s.vy = 0
    s.facing = s.walkDir
  }

  private stepChase(dtS: number, target: Point): void {
    const s = this.state
    const next = approach(s, target, this.params.followSpeed * dtS)
    s.vx = (next.x - s.x) / dtS
    s.vy = (next.y - s.y) / dtS
    s.x = next.x
    s.y = next.y
    this.updateFacing(s.vx)
    if (s.phase !== 'chase') this.setPhase('chase')
  }

  private stepHeld(dtS: number, held: Point | null): void {
    const s = this.state
    if (!held) return
    s.vx = (held.x - s.x) / dtS
    s.vy = (held.y - s.y) / dtS
    s.x = held.x
    s.y = held.y
    this.updateFacing(s.vx)
  }

  private stepFall(dtS: number): void {
    const s = this.state
    const { gravity, terminalVelocity, toss } = this.params
    s.vy = Math.min(s.vy + gravity * dtS, terminalVelocity)
    s.x += s.vx * dtS
    s.y += s.vy * dtS
    if (s.x < this.area.minX) {
      s.x = Math.min(this.area.maxX, 2 * this.area.minX - s.x)
      s.vx = -s.vx * toss.wallRestitution
    } else if (s.x > this.area.maxX) {
      s.x = Math.max(this.area.minX, 2 * this.area.maxX - s.x)
      s.vx = -s.vx * toss.wallRestitution
    }
    if (s.y < this.area.minY) {
      s.y = this.area.minY
      if (s.vy < 0) s.vy = -s.vy * toss.restitution
    }
    if (s.y >= this.area.groundY) {
      s.y = this.area.groundY
      if (s.vy > toss.minBounceSpeed) {
        s.vy = -s.vy * toss.restitution
        s.vx *= toss.groundFriction
      } else {
        s.vx = 0
        s.vy = 0
        this.setPhase('land')
      }
    }
  }
}
