// Locomotion (BITBOT_SPEC.md §5.1): the pet's position, velocity, the surface under it and its physics, in global
// screen points (y down; x, y is the pet's ground-contact point). Pure; stepped by the simulation loop.
//
// M1 subset, on the primary display's ground (§8.1, §8.7):
//   idle  stands on the ground, still;
//   held  follows the point where the user holds it, clamped to the area;
//   fall  straight down under gravity (§8.5) until it lands on the ground, then idle.
// Walking, turning and window surfaces (M3), tosses, bounces and petting (M4) come later; facing stays +1 until then.
//
// The ground rule (start, release, teleport, and the ground moving under a standing pet): a pet at most groundSnapPt
// above the ground stands on it; anything higher falls, from rest.

import { clampToArea, isPetArea, isPoint, type PetArea, type Point } from '../../../shared/geometry'
import { stepFall, type FallParams } from './physics'

/** The behaviors M1 moves in; each is also a §10.1 BehaviorState, so it goes into pet:state as is. */
export type LocomotionBehavior = 'idle' | 'held' | 'fall'

export interface LocomotionState {
  /** Ground-contact point, global pt. */
  x: number
  y: number
  /** Velocity, pt/s (y down). */
  vx: number
  vy: number
  /** 1: faces right (the default 3/4 view), −1: left. M1: always 1. */
  facing: 1 | -1
  behavior: LocomotionBehavior
  /** Seconds since the current behavior began. */
  behaviorTimeS: number
}

/** tuning.move satisfies this as is. */
export interface LocomotionParams extends FallParams {
  /** A pet at most this far above the ground (pt) stands on it. */
  groundSnapPt: number
}

/** Where a new pet appears: on the ground, at the bottom centre of its area. */
export function spawnPoint(area: PetArea): Point {
  return { x: (area.minX + area.maxX) / 2, y: area.groundY }
}

export class Locomotion {
  private readonly params: LocomotionParams
  private current: PetArea
  private readonly s: LocomotionState = { x: 0, y: 0, vx: 0, vy: 0, facing: 1, behavior: 'idle', behaviorTimeS: 0 }

  /**
   * `start` (default: spawnPoint(area); also when it is not a finite point) is clamped into the area; the pet stands
   * there if it is on the ground (within groundSnapPt), else falls from rest. Throws on an invalid area or params.
   */
  constructor(area: PetArea, params: LocomotionParams, start?: Point) {
    this.current = checkedArea(area)
    this.params = checkedParams(params)
    this.place(start !== undefined && isPoint(start) ? start : spawnPoint(this.current))
  }

  /** A live, read-only view of the state (copy the fields to keep a snapshot). */
  get state(): Readonly<LocomotionState> {
    return this.s
  }

  /** The area the pet is kept in (a frozen copy of the one passed in). */
  get area(): PetArea {
    return this.current
  }

  /** y of the surface line under the pet (its contact shadow, §6.1). M1: always area.groundY. */
  get supportY(): number | null {
    return this.current.groundY
  }

  /**
   * A new area (display change; throws if it is invalid). The pet is clamped into it, then:
   * idle — the ground moved up: it stands on the new ground; moved down: it falls from where it stood (by at most
   *   groundSnapPt: it stands on the new ground);
   * held — it stays held, clamped;
   * fall — it keeps falling, and lands if the new ground is at or above it.
   * behaviorTimeS carries on unless the behavior changes.
   */
  setArea(area: PetArea): void {
    const next = checkedArea(area)
    this.current = next
    const s = this.s
    const p = clampToArea(s, next)
    s.x = p.x
    switch (s.behavior) {
      case 'idle':
        if (this.onGround(p.y)) {
          s.y = next.groundY
        } else {
          s.y = p.y
          this.begin('fall') // from rest: idle velocity is 0
        }
        return
      case 'held':
        s.y = p.y
        return
      case 'fall':
        s.y = p.y
        if (p.y >= next.groundY) this.land()
        return
    }
  }

  /** The user took hold of the pet (also mid-fall): → held, velocity 0. Ignored while already held. */
  grab(): void {
    if (this.s.behavior === 'held') return
    this.s.vx = 0
    this.s.vy = 0
    this.begin('held')
  }

  /**
   * The user let go with the ground-contact point at `at` (clamped; not a finite point: where it is now). Within
   * groundSnapPt of the ground it stands on it, else it falls from rest (M1: no toss). Ignored unless held, so a
   * second release of the same press (native mouseUp and the renderer's 'up') changes nothing.
   */
  release(at: Point): void {
    if (this.s.behavior !== 'held') return
    this.place(isPoint(at) ? at : this.s)
  }

  /**
   * Instant move (the dev check's scripted mover; §8.7's teleport later): clamped, then the same ground rule as
   * release. Ignored while held (the user has it) and for a point that is not finite.
   */
  teleport(p: Point): void {
    if (this.s.behavior === 'held' || !isPoint(p)) return
    this.place(p)
  }

  /**
   * Advances by dtS seconds (ignored unless finite and > 0). held: moves to `held` (clamped) with the velocity of that
   * move, or stays put when `held` is null; fall: one stepFall, landing → idle; idle: stays on the ground, still.
   */
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
        const p = clampToArea(held, this.current)
        s.vx = (p.x - s.x) / dtS
        s.vy = (p.y - s.y) / dtS
        s.x = p.x
        s.y = p.y
        return
      }
      case 'fall': {
        const next = stepFall(s.y, s.vy, dtS, this.params, this.current.groundY)
        if (next.landed) {
          this.land()
          return
        }
        s.y = next.y
        s.vx = 0
        s.vy = next.vy
        return
      }
      case 'idle':
        s.y = this.current.groundY
        s.vx = 0
        s.vy = 0
        return
    }
  }

  /** Puts the pet at `p` (clamped), at rest: standing if it is on the ground, else falling. */
  private place(p: Point): void {
    const s = this.s
    const c = clampToArea(p, this.current)
    s.x = c.x
    s.vx = 0
    s.vy = 0
    if (this.onGround(c.y)) {
      s.y = this.current.groundY
      this.begin('idle')
    } else {
      s.y = c.y
      this.begin('fall')
    }
  }

  private land(): void {
    this.s.y = this.current.groundY
    this.s.vx = 0
    this.s.vy = 0
    this.begin('idle')
  }

  private onGround(y: number): boolean {
    return this.current.groundY - y <= this.params.groundSnapPt
  }

  private begin(behavior: LocomotionBehavior): void {
    this.s.behavior = behavior
    this.s.behaviorTimeS = 0
  }
}

function checkedArea(area: PetArea): PetArea {
  if (!isPetArea(area)) throw new RangeError(`Locomotion: invalid area ${JSON.stringify(area)}`)
  return Object.freeze({ minX: area.minX, maxX: area.maxX, minY: area.minY, groundY: area.groundY })
}

function checkedParams(params: LocomotionParams): LocomotionParams {
  const { gravity, terminalVelocity, groundSnapPt } = params
  const valid =
    Number.isFinite(gravity) &&
    gravity > 0 &&
    Number.isFinite(terminalVelocity) &&
    terminalVelocity > 0 &&
    Number.isFinite(groundSnapPt) &&
    groundSnapPt >= 0
  if (!valid) throw new RangeError(`Locomotion: invalid params ${JSON.stringify({ gravity, terminalVelocity, groundSnapPt })}`)
  return { gravity, terminalVelocity, groundSnapPt }
}
