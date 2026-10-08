import { describe, expect, it } from 'vitest'
import { Locomotion, spawnPoint, type LocomotionBehavior, type LocomotionParams } from '../src/main/sim/locomotion/locomotion'
import { arcBetween, stepFall, type FallParams } from '../src/main/sim/locomotion/physics'
import { effectiveWorkArea, petAreaFor, type DisplayGeometry } from '../src/main/sim/world/screenArea'
import { buildWorld, type World } from '../src/main/sim/world/worldModel'
import { boxAt, isPetArea, rectContainsRect, type Box, type PetArea, type Point, type Rect } from '../src/shared/geometry'
import { tuning } from '../src/shared/tuning'
import { isBehaviorState, type BehaviorState } from '../src/shared/types'
import { DISPLAY, PARAMS as WORLD_PARAMS, W1, W2, W3, win, world } from './worldFixtures'

// Locomotion (BITBOT_SPEC.md §5.1, §8.4 moves, §8.5 riding and physics, §10.1) and the pet's area on the primary
// display (§8.1, §8.7).

const DT = 1 / tuning.sim.hz
/** The production params: tuning.move must satisfy LocomotionParams as is. */
const PARAMS: LocomotionParams = tuning.move
const SNAP = PARAMS.groundSnapPt
/** Just past groundSnapPt, exactly representable so the edge cases are exact. */
const PAST_SNAP = SNAP + 1 / 64
/** M1's box: with the spike's display (1710×1107 pt, 37 pt menu bar, Dock top at 1022) it gives AREA. */
const M1_BOX: Box = { left: -50, top: -110, right: 60, bottom: 2 }
const AREA: PetArea = { minX: 50, maxX: 1650, minY: 147, groundY: 1022 }

/** A world with no windows on the spike's display, its work area reaching down to groundY (and in from the sides). */
function groundWorld(groundY = 1022, workArea: Partial<Rect> = {}): World {
  const wa = { x: 0, y: 37, width: 1710, height: groundY - 37, ...workArea }
  return buildWorld({ ...DISPLAY, workArea: wa }, M1_BOX, [], WORLD_PARAMS)
}
const GROUND = groundWorld()

const make = (start?: Point, w: World = GROUND): Locomotion => new Locomotion(w, PARAMS, start)
const where = (loco: Locomotion): { x: number; y: number; behavior: LocomotionBehavior } => ({
  x: loco.state.x,
  y: loco.state.y,
  behavior: loco.state.behavior,
})
/** Steps of a land: tuning.move.landS at the simulation's step (0.4 s at 30 Hz = 12). */
const LAND_STEPS = Math.round(PARAMS.landS / DT)
/** Steps until the pet stops falling (at most 10 s); returns the y after each step. */
function fallToRest(loco: Locomotion): number[] {
  const ys: number[] = []
  for (let i = 0; i < 300 && loco.state.behavior === 'fall'; i++) {
    loco.step(DT, null)
    ys.push(loco.state.y)
  }
  return ys
}
/** Steps until `done` (at most maxSteps); returns the behaviors it went through, each once in a row. */
function runUntil(loco: Locomotion, done: (l: Locomotion) => boolean, maxSteps = 3000): LocomotionBehavior[] {
  const seen: LocomotionBehavior[] = [loco.state.behavior]
  for (let i = 0; i < maxSteps && !done(loco); i++) {
    loco.step(DT, null)
    if (seen[seen.length - 1] !== loco.state.behavior) seen.push(loco.state.behavior)
  }
  return seen
}
const settled = (l: Locomotion): boolean => l.state.behavior === 'idle' && l.goal === null
/** Steps until it stands still with no goal; returns the behaviors on the way. */
const runToRest = (loco: Locomotion, maxSteps = 3000): LocomotionBehavior[] => runUntil(loco, settled, maxSteps)

describe('stepFall', () => {
  // dt = 1/8 s and g = 800 pt/s² keep every number exact: 100 pt/s gained per step.
  const P: FallParams = { gravity: 800, terminalVelocity: 250 }
  const dt = 0.125

  it('gains g·dt of speed per step, then moves by the new speed', () => {
    const first = stepFall(0, 0, dt, P, 1000)
    expect(first).toEqual({ y: 12.5, vy: 100, landed: false })
    expect(stepFall(first.y, first.vy, dt, P, 1000)).toEqual({ y: 37.5, vy: 200, landed: false })
  })

  it('never falls faster than terminal velocity', () => {
    const capped = stepFall(37.5, 200, dt, P, 1000)
    expect(capped).toEqual({ y: 68.75, vy: 250, landed: false })
    expect(stepFall(capped.y, capped.vy, dt, P, 1000)).toEqual({ y: 100, vy: 250, landed: false })
    expect(stepFall(0, 900, dt, P, 1000).vy).toBe(250) // already faster: slowed to terminal at once
  })

  it('lands exactly on the ground when a step reaches it', () => {
    expect(stepFall(987.5, 0, dt, P, 1000)).toEqual({ y: 1000, vy: 0, landed: true })
  })

  it('lands on the ground, never below it, when a step would pass it', () => {
    expect(stepFall(995, 0, dt, P, 1000)).toEqual({ y: 1000, vy: 0, landed: true })
    expect(stepFall(999.9, 250, dt, P, 1000)).toEqual({ y: 1000, vy: 0, landed: true })
  })

  it('lands at once when already on the ground, or puts a pet below it back on it', () => {
    expect(stepFall(1000, 0, dt, P, 1000)).toEqual({ y: 1000, vy: 0, landed: true })
    expect(stepFall(1000, 0, 0, P, 1000)).toEqual({ y: 1000, vy: 0, landed: true })
    expect(stepFall(1010, -500, dt, P, 1000)).toEqual({ y: 1000, vy: 0, landed: true })
  })

  it('rises first when moving up (a toss, later), without landing', () => {
    expect(stepFall(1000, -400, dt, P, 1000)).toEqual({ y: 962.5, vy: -300, landed: false })
  })

  it('with the real tuning, falls a height in about the time physics says, √(2h/g)', () => {
    const h = 500
    let fall = { y: 0, vy: 0, landed: false }
    let steps = 0
    while (!fall.landed && steps < 1000) {
      fall = stepFall(fall.y, fall.vy, DT, PARAMS, h)
      steps++
    }
    expect(Math.abs(steps * DT - Math.sqrt((2 * h) / PARAMS.gravity))).toBeLessThan(2 * DT)
  })
})


describe('arcBetween', () => {
  const g = 2000

  it('peaks apexPt above the higher end and arrives at the target after durationS', () => {
    const from = { x: 0, y: 500 }
    const to = { x: 300, y: 400 }
    const arc = arcBetween(from, to, 50, g)
    // Rises 150 (to y 350), sinks 50.
    expect(arc.vy).toBeCloseTo(-Math.sqrt(2 * g * 150))
    expect(arc.durationS).toBeCloseTo(Math.sqrt(300 / g) + Math.sqrt(100 / g))
    expect(arc.vx).toBeCloseTo(300 / arc.durationS)
    const t = arc.durationS
    expect(from.x + arc.vx * t).toBeCloseTo(300)
    expect(from.y + arc.vy * t + 0.5 * g * t * t).toBeCloseTo(400)
    const tTop = -arc.vy / g
    expect(from.y + arc.vy * tTop + 0.5 * g * tTop * tTop).toBeCloseTo(350)
  })

  it('with no apex from the higher end: leaves at rest and falls (a walk-off drop)', () => {
    const arc = arcBetween({ x: 10, y: 0 }, { x: 10, y: 400 }, 0, g)
    expect(arc).toEqual({ vx: 0, vy: -0, durationS: Math.sqrt(800 / g) })
  })

  it('the same point with no apex takes no time', () => {
    expect(arcBetween({ x: 1, y: 1 }, { x: 1, y: 1 }, 0, g)).toEqual({ vx: 0, vy: 0, durationS: 0 })
  })
})

describe('Locomotion: M1 and M2 (ground, held, fall, land)', () => {
  it('spawns standing at the bottom centre of its area, facing right, on the ground', () => {
    expect(spawnPoint(AREA)).toEqual({ x: 850, y: 1022 })
    const loco = make()
    expect(loco.state).toEqual({
      x: 850,
      y: 1022,
      vx: 0,
      vy: 0,
      facing: 1,
      behavior: 'idle',
      behaviorTimeS: 0,
      attach: 'floor',
      surface: 'ground',
      windowId: null,
    })
    expect(loco.supportY).toBe(AREA.groundY)
    expect(loco.area).toEqual(AREA)
    expect(loco.world).toBe(GROUND)
    expect(loco.route).toBeNull()
    expect(loco.goal).toBeNull()
  })

  it('starts where it is told: clamped, standing within groundSnapPt of the ground, else falling', () => {
    expect(where(make({ x: 10, y: 5000 }))).toEqual({ x: 50, y: 1022, behavior: 'idle' })
    expect(where(make({ x: 9000, y: 1022 - SNAP }))).toEqual({ x: 1650, y: 1022, behavior: 'idle' })
    expect(where(make({ x: 400, y: 1022 - PAST_SNAP }))).toEqual({ x: 400, y: 1022 - PAST_SNAP, behavior: 'fall' })
    expect(where(make({ x: 400, y: 0 }))).toEqual({ x: 400, y: 147, behavior: 'fall' })
    expect(where(make({ x: Number.NaN, y: 3 }))).toEqual({ x: 850, y: 1022, behavior: 'idle' })
    expect(make({ x: 400, y: 300 }).state).toMatchObject({ vx: 0, vy: 0, behaviorTimeS: 0, surface: null })
  })

  it('stands still on the ground while idle, counting the time (a held point is ignored)', () => {
    const loco = make()
    for (let i = 0; i < 90; i++) loco.step(DT, { x: 100, y: 300 })
    expect(loco.state).toMatchObject({ x: 850, y: 1022, vx: 0, vy: 0, behavior: 'idle' })
    expect(loco.state.behaviorTimeS).toBeCloseTo(3)
  })

  it('grab → held at rest, off its surface; it then follows the held point with the velocity of each move', () => {
    const loco = make()
    loco.step(DT, null)
    loco.grab()
    expect(loco.state).toMatchObject({ x: 850, y: 1022, vx: 0, vy: 0, behavior: 'held', behaviorTimeS: 0, surface: null })
    loco.step(DT, { x: 880, y: 1000 })
    expect(loco.state).toMatchObject({ x: 880, y: 1000, behavior: 'held' })
    expect(loco.state.vx).toBeCloseTo(30 / DT)
    expect(loco.state.vy).toBeCloseTo(-22 / DT)
    expect(loco.supportY).toBe(1022)
    loco.step(DT, null) // no held point this step: it stays put
    expect(loco.state).toMatchObject({ x: 880, y: 1000, vx: 0, vy: 0, behavior: 'held' })
    loco.grab() // already held: nothing restarts
    expect(loco.state.behaviorTimeS).toBeCloseTo(2 * DT)
  })

  it('can be caught mid-fall, and then stays where it is held', () => {
    const loco = make({ x: 400, y: 300 })
    for (let i = 0; i < 5; i++) loco.step(DT, null)
    const caughtAt = loco.state.y
    expect(loco.state.vy).toBeGreaterThan(0)
    loco.grab()
    expect(loco.state).toMatchObject({ behavior: 'held', vx: 0, vy: 0, y: caughtAt })
    loco.step(DT, null)
    expect(loco.state.y).toBe(caughtAt)
  })

  it('keeps a drag inside its area: it stops at the primary display edge (SPEC-DEVIATION §8.7)', () => {
    const loco = make()
    loco.grab()
    loco.step(DT, { x: -500, y: -500 })
    expect(where(loco)).toEqual({ x: AREA.minX, y: AREA.minY, behavior: 'held' })
    loco.step(DT, { x: 5000, y: 5000 })
    expect(where(loco)).toEqual({ x: AREA.maxX, y: AREA.groundY, behavior: 'held' })
    loco.step(DT, { x: Number.NaN, y: 400 })
    expect(where(loco)).toEqual({ x: AREA.maxX, y: AREA.groundY, behavior: 'held' })
  })

  it('released within groundSnapPt of the ground it stands on it; higher, it falls from rest', () => {
    const releasedAt = (y: number): Locomotion => {
      const loco = make()
      loco.grab()
      loco.step(DT, { x: 600, y: 900 }) // a fast move: the release must not keep its speed (no toss in M1)
      loco.release({ x: 600, y })
      return loco
    }
    expect(releasedAt(1022 - SNAP).state).toMatchObject({ x: 600, y: 1022, vx: 0, vy: 0, behavior: 'idle', behaviorTimeS: 0 })
    expect(releasedAt(1022).state).toMatchObject({ y: 1022, behavior: 'idle', surface: 'ground' })
    expect(releasedAt(1100).state).toMatchObject({ y: 1022, behavior: 'idle' })
    expect(releasedAt(1022 - PAST_SNAP).state).toMatchObject({ y: 1022 - PAST_SNAP, vx: 0, vy: 0, behavior: 'fall' })
    expect(releasedAt(300).state).toMatchObject({ x: 600, y: 300, vx: 0, vy: 0, behavior: 'fall', behaviorTimeS: 0 })
  })

  it('clamps the drop point, and lets go where it is when the drop point is not finite', () => {
    const loco = make()
    loco.grab()
    loco.step(DT, { x: 700, y: 500 })
    loco.release({ x: 99_999, y: 600 })
    expect(where(loco)).toEqual({ x: AREA.maxX, y: 600, behavior: 'fall' })
    const other = make()
    other.grab()
    other.step(DT, { x: 700, y: 500 })
    other.release({ x: Number.POSITIVE_INFINITY, y: 0 })
    expect(where(other)).toEqual({ x: 700, y: 500, behavior: 'fall' })
  })

  it('ignores a release unless held, so a second release of the same press changes nothing', () => {
    const loco = make()
    loco.grab()
    loco.step(DT, { x: 600, y: 600 })
    loco.release({ x: 600, y: 600 })
    loco.step(DT, null)
    const after = { ...loco.state }
    loco.release({ x: 100, y: 1022 })
    expect(loco.state).toEqual(after)
    const idle = make()
    idle.release({ x: 100, y: 300 })
    expect(where(idle)).toEqual({ x: 850, y: 1022, behavior: 'idle' })
  })

  it('falls under gravity onto the ground, lands, then stands there, still', () => {
    const loco = make({ x: 400, y: 722 }) // 300 pt: soft enough not to bounce
    const ys = fallToRest(loco)
    expect(loco.state).toMatchObject({ x: 400, y: 1022, vx: 0, vy: 0, facing: 1, behavior: 'land', behaviorTimeS: 0 })
    expect(loco.state.surface).toBe('ground')
    expect(ys.every((y, i) => i === 0 || y > (ys[i - 1] ?? Infinity))).toBe(true)
    expect(Math.abs(ys.length * DT - Math.sqrt((2 * 300) / PARAMS.gravity))).toBeLessThan(2 * DT)
    for (let i = 0; i < LAND_STEPS; i++) loco.step(DT, null)
    expect(loco.state).toMatchObject({ x: 400, y: 1022, vx: 0, vy: 0, facing: 1, behavior: 'idle', behaviorTimeS: 0 })
    loco.step(DT, null)
    expect(loco.state).toMatchObject({ y: 1022, behavior: 'idle' })
    expect(loco.state.behaviorTimeS).toBeCloseTo(DT)
  })

  describe('land (§10.1: a touchdown, the squash and settle)', () => {
    /** A pet that just touched down at x 400. */
    const landed = (params: LocomotionParams = PARAMS): Locomotion => {
      const loco = new Locomotion(GROUND, params, { x: 400, y: 900 })
      fallToRest(loco)
      return loco
    }

    it('lasts tuning.move.landS, still on the ground, then becomes idle', () => {
      expect(LAND_STEPS).toBe(12)
      const loco = landed()
      for (let i = 1; i < LAND_STEPS; i++) {
        loco.step(DT, { x: 100, y: 300 }) // a held point is ignored
        expect(loco.state).toMatchObject({ x: 400, y: 1022, vx: 0, vy: 0, behavior: 'land' })
      }
      expect(loco.state.behaviorTimeS).toBeCloseTo((LAND_STEPS - 1) * DT)
      loco.step(DT, null)
      expect(loco.state).toMatchObject({ x: 400, y: 1022, behavior: 'idle', behaviorTimeS: 0 })
    })

    it('with landS 0 a touchdown goes straight to idle', () => {
      expect(where(landed({ ...PARAMS, landS: 0 }))).toEqual({ x: 400, y: 1022, behavior: 'idle' })
    })

    it('is grabbed like idle', () => {
      const loco = landed()
      loco.step(DT, null)
      loco.grab()
      expect(loco.state).toMatchObject({ x: 400, y: 1022, vx: 0, vy: 0, behavior: 'held', behaviorTimeS: 0 })
    })

    it('a teleport ends it by the ground rule: idle on the ground, a fall in the air', () => {
      const onGround = landed()
      onGround.teleport({ x: 700, y: 1022 })
      expect(where(onGround)).toEqual({ x: 700, y: 1022, behavior: 'idle' })
      const inAir = landed()
      inAir.teleport({ x: 700, y: 600 })
      expect(where(inAir)).toEqual({ x: 700, y: 600, behavior: 'fall' })
    })

    it('a release never lands: on the ground it is idle at once', () => {
      const loco = make()
      loco.grab()
      loco.release({ x: 600, y: 1022 })
      expect(where(loco)).toEqual({ x: 600, y: 1022, behavior: 'idle' })
    })

    it('setWorld: a ground that moved up carries it (still landing); one that moved down makes it fall', () => {
      const up = landed()
      up.step(DT, null)
      up.setWorld(groundWorld(950), 0)
      expect(where(up)).toEqual({ x: 400, y: 950, behavior: 'land' })
      expect(up.state.behaviorTimeS).toBeCloseTo(DT)
      const down = landed()
      down.setWorld(groundWorld(1107), 0)
      expect(where(down)).toEqual({ x: 400, y: 1022, behavior: 'fall' })
    })
  })

  it('never falls faster than terminal velocity', () => {
    const tall = buildWorld(
      { id: 1, bounds: { x: 0, y: -100_000, width: 200, height: 200_000 }, workArea: { x: 0, y: -100_000, width: 200, height: 200_000 } },
      M1_BOX,
      [],
      WORLD_PARAMS,
    )
    const loco = new Locomotion(tall, PARAMS, { x: 50, y: -100_000 })
    let fastest = 0
    for (let i = 0; i < 120; i++) {
      loco.step(DT, null)
      fastest = Math.max(fastest, loco.state.vy)
    }
    expect(fastest).toBe(PARAMS.terminalVelocity)
  })

  it('teleports: clamped, the same ground rule, ignored while held or for a point that is not finite', () => {
    const loco = make()
    loco.teleport({ x: 300, y: 1022 - SNAP })
    expect(where(loco)).toEqual({ x: 300, y: 1022, behavior: 'idle' })
    loco.teleport({ x: 300, y: 600 })
    expect(loco.state).toMatchObject({ x: 300, y: 600, vx: 0, vy: 0, behavior: 'fall' })
    for (let i = 0; i < 3; i++) loco.step(DT, null)
    loco.teleport({ x: 300, y: 600 }) // a new fall from rest
    expect(loco.state).toMatchObject({ y: 600, vy: 0, behaviorTimeS: 0 })
    loco.teleport({ x: -100, y: 2000 })
    expect(loco.state).toMatchObject({ x: 50, y: 1022, vx: 0, vy: 0, behavior: 'idle' })
    loco.teleport({ x: Number.NaN, y: 0 })
    expect(where(loco)).toEqual({ x: 50, y: 1022, behavior: 'idle' })
    loco.grab()
    loco.teleport({ x: 700, y: 700 })
    expect(where(loco)).toEqual({ x: 50, y: 1022, behavior: 'held' })
  })

  it('ignores steps whose length is not finite and positive', () => {
    const loco = make({ x: 400, y: 300 })
    loco.step(0, null)
    loco.step(-DT, null)
    loco.step(Number.NaN, null)
    loco.step(Number.POSITIVE_INFINITY, null)
    expect(loco.state).toMatchObject({ y: 300, vy: 0, behavior: 'fall', behaviorTimeS: 0 })
  })

  it('moves only in §10.1 behavior states', () => {
    const behaviors: readonly LocomotionBehavior[] = ['idle', 'walk', 'run', 'climb', 'jump', 'fall', 'land', 'held']
    const asStates: readonly BehaviorState[] = behaviors // compile-time: every LocomotionBehavior is a BehaviorState
    expect(asStates.every(isBehaviorState)).toBe(true)
  })

  it('rejects an invalid world or params', () => {
    expect(() => new Locomotion({ ...GROUND, area: { ...AREA, maxX: 0 } }, PARAMS)).toThrow(RangeError)
    expect(() => new Locomotion({ ...GROUND, area: { ...AREA, groundY: 100 } }, PARAMS)).toThrow(RangeError)
    expect(() => new Locomotion({ ...GROUND, segments: [] }, PARAMS)).toThrow(RangeError)
    const bad: Partial<LocomotionParams>[] = [
      { gravity: 0 },
      { gravity: Number.NaN },
      { terminalVelocity: -1 },
      { groundSnapPt: -0.5 },
      { landS: -0.1 },
      { landS: Number.NaN },
      { walkSpeed: 0 },
      { runSpeed: -1 },
      { climbSpeed: Number.NaN },
      { runDistancePt: -1 },
      { jumpApexPt: -1 },
      { flingThreshold: 0 },
      { landBounce: { minSpeed: 100, restitution: 1 } },
      { landBounce: { minSpeed: -1, restitution: 0.2 } },
    ]
    for (const b of bad) expect(() => new Locomotion(GROUND, { ...PARAMS, ...b })).toThrow(RangeError)
  })

  describe('setWorld on the ground (display change)', () => {
    it('a ground that moved down leaves the pet falling from where it stood, onto the new ground', () => {
      const loco = make({ x: 600, y: 1022 })
      loco.setWorld(groundWorld(1107), 0) // e.g. the Dock was set to hide
      expect(loco.state).toMatchObject({ x: 600, y: 1022, vx: 0, vy: 0, behavior: 'fall', behaviorTimeS: 0 })
      expect(loco.supportY).toBe(1107)
      fallToRest(loco)
      expect(where(loco)).toEqual({ x: 600, y: 1107, behavior: 'land' })
    })

    it('a ground that moved up carries the pet up onto it, still the same idle', () => {
      const loco = make({ x: 600, y: 1022 })
      loco.step(DT, null)
      loco.setWorld(groundWorld(950), 0)
      expect(where(loco)).toEqual({ x: 600, y: 950, behavior: 'idle' })
      expect(loco.state.behaviorTimeS).toBeCloseTo(DT)
      expect(loco.supportY).toBe(950)
    })

    it('a ground that sank by at most groundSnapPt still carries it; any further and it falls', () => {
      const loco = make({ x: 600, y: 1022 })
      loco.setWorld(groundWorld(1022 + SNAP), 0)
      expect(where(loco)).toEqual({ x: 600, y: 1022 + SNAP, behavior: 'idle' })
      loco.setWorld(groundWorld(1022 + SNAP + PAST_SNAP), 1)
      expect(where(loco)).toEqual({ x: 600, y: 1022 + SNAP, behavior: 'fall' })
    })

    it('clamps x into a narrower area', () => {
      const loco = make({ x: 1600, y: 1022 })
      loco.setWorld(groundWorld(1022, { width: 1260 }), 0)
      expect(where(loco)).toEqual({ x: 1200, y: 1022, behavior: 'idle' })
    })

    it('held: stays held, clamped into the new area', () => {
      const loco = make()
      loco.grab()
      loco.step(DT, { x: 1600, y: 400 })
      loco.setWorld(groundWorld(1022, { width: 1260, y: 390, height: 632 }), 0)
      expect(loco.area).toEqual({ minX: 50, maxX: 1200, minY: 500, groundY: 1022 })
      expect(where(loco)).toEqual({ x: 1200, y: 500, behavior: 'held' })
    })

    it('fall: keeps falling with its speed, and touches down on a new ground at or above it on the next step', () => {
      const loco = make({ x: 600, y: 300 })
      for (let i = 0; i < 5; i++) loco.step(DT, null)
      const { y, vy, behaviorTimeS } = loco.state
      loco.setWorld(groundWorld(1107), 0)
      expect(loco.state).toMatchObject({ x: 600, y, vy, behavior: 'fall', behaviorTimeS })
      loco.setWorld(groundWorld(y), 1)
      loco.step(DT, null)
      expect(loco.state).toMatchObject({ x: 600, y, vx: 0, vy: 0, behavior: 'land', behaviorTimeS: 0 })
      const above = make({ x: 600, y: 300 })
      above.step(DT, null)
      above.setWorld(groundWorld(250), 0)
      above.step(DT, null)
      expect(where(above)).toEqual({ x: 600, y: 250, behavior: 'land' })
    })

    it('rejects an invalid world and keeps the old one', () => {
      const loco = make()
      expect(() => loco.setWorld({ ...GROUND, area: { minX: 10, maxX: 5, minY: 0, groundY: 100 } }, 0)).toThrow(RangeError)
      expect(() => loco.setWorld({ ...GROUND, area: { ...AREA, groundY: Number.NaN } }, 0)).toThrow(RangeError)
      expect(loco.world).toBe(GROUND)
      expect(where(loco)).toEqual({ x: 850, y: 1022, behavior: 'idle' })
    })

    it('its area is the world’s, read-only', () => {
      const loco = make()
      expect(() => {
        ;(loco.area as PetArea).groundY = 5
      }).toThrow(TypeError)
    })
  })
})

describe('Locomotion: moving through the world (§8.4)', () => {
  const WORLD = world([W1, W2, W3])
  const at = (p: Point): Locomotion => new Locomotion(WORLD, PARAMS, p)

  it('walks along the ground at walkSpeed, facing the way it goes, and stops exactly at the target', () => {
    const loco = at({ x: 1000, y: 1022 })
    expect(loco.goTo({ x: 800, y: 1022 })).toBe(true)
    expect(loco.goal).toEqual({ x: 800, y: 1022 })
    expect(loco.route?.moves).toEqual([{ kind: 'walk', segment: 'ground', toX: 800 }])
    expect(loco.state).toMatchObject({ behavior: 'walk', behaviorTimeS: 0 })
    for (let i = 0; i < 30; i++) loco.step(DT, null)
    expect(loco.state).toMatchObject({ y: 1022, vx: -PARAMS.walkSpeed, facing: -1, behavior: 'walk', surface: 'ground' })
    expect(loco.state.x).toBeCloseTo(1000 - PARAMS.walkSpeed)
    expect(runToRest(loco)).toEqual(['walk', 'idle'])
    expect(loco.state).toMatchObject({ x: 800, y: 1022, vx: 0, facing: -1, behavior: 'idle' })
    expect(loco.goal).toBeNull()
    expect(loco.route).toBeNull()
  })

  it('runs while more than runDistancePt is left, then walks the rest', () => {
    const loco = at({ x: 1600, y: 1022 })
    loco.goTo({ x: 200, y: 1022 })
    loco.step(DT, null)
    expect(loco.state).toMatchObject({ behavior: 'run', vx: -PARAMS.runSpeed })
    expect(loco.state.x).toBeCloseTo(1600 - PARAMS.runSpeed * DT)
    const seen = runUntil(loco, (l) => l.state.behavior === 'walk')
    expect(seen).toEqual(['run', 'walk'])
    expect(loco.state.x - 200).toBeLessThanOrEqual(PARAMS.runDistancePt)
    expect(loco.state.x - 200).toBeGreaterThan(PARAMS.runDistancePt - PARAMS.runSpeed * DT)
    runToRest(loco)
    expect(where(loco)).toEqual({ x: 200, y: 1022, behavior: 'idle' })
  })

  it('climbs a window side onto its top: walk, hop on, climb, hop over the corner, land, walk', () => {
    const loco = at({ x: 1000, y: 1022 })
    expect(loco.goTo({ x: 600, y: 700 })).toBe(true)
    const attaches = new Set<string>()
    const seen = runUntil(loco, (l) => {
      if (l.state.behavior === 'climb') {
        attaches.add(l.state.attach)
        expect(l.state).toMatchObject({ x: 800, surface: 'side:1:right:0', windowId: 1, vx: 0 })
        expect(l.supportY).toBeNull()
      }
      return settled(l)
    })
    expect(seen).toEqual(['walk', 'jump', 'climb', 'jump', 'land', 'walk', 'idle'])
    expect([...attaches]).toEqual(['wallLeft']) // W1's right side is on its left
    expect(loco.state).toMatchObject({ x: 600, y: 700, attach: 'floor', surface: 'top:1:0', windowId: 1, facing: -1 })
    expect(loco.supportY).toBe(700)
  })

  it('climbs from a top down a window side and holds on there', () => {
    const loco = at({ x: 600, y: 700 })
    expect(loco.state.surface).toBe('top:1:0')
    expect(loco.goTo({ x: 800, y: 900 })).toBe(true)
    expect(runToRest(loco)).toEqual(['walk', 'jump', 'climb', 'idle'])
    expect(loco.state).toMatchObject({ x: 800, y: 900, attach: 'wallLeft', surface: 'side:1:right:0', behavior: 'idle' })
    expect(loco.supportY).toBeNull()
    // …and back down to the ground from there.
    expect(loco.goTo({ x: 1000, y: 1022 })).toBe(true)
    expect(runToRest(loco)).toEqual(['climb', 'jump', 'land', 'walk', 'idle'])
    expect(loco.state).toMatchObject({ x: 1000, y: 1022, attach: 'floor', surface: 'ground' })
  })

  it('climbs the screen wall and stops at the top (the ceiling, §8.1)', () => {
    const loco = at({ x: 200, y: 1022 })
    loco.goTo({ x: 0, y: 0 })
    expect(runToRest(loco)).toEqual(['walk', 'jump', 'climb', 'idle'])
    expect(loco.state).toMatchObject({ x: 0, y: WORLD.ceilingY + WORLD_PARAMS.petHalfWidthPt, attach: 'wallLeft' })
    expect(loco.state.surface).toBe('wall:left')
    expect(loco.state.windowId).toBeNull()
  })

  it('drops off a top onto a lower one: walks off past the end, falls straight down, lands', () => {
    const stacked = world([win(6, 500, 500, 300, 200), win(4, 300, 800, 700, 222)])
    const loco = new Locomotion(stacked, PARAMS, { x: 650, y: 500 })
    expect(loco.goTo({ x: 400, y: 800 })).toBe(true)
    expect(loco.route?.moves).toEqual([
      { kind: 'walk', segment: 'top:6:0', toX: 520 },
      { kind: 'drop', edgeX: 450, segment: 'top:4:0' },
      { kind: 'walk', segment: 'top:4:0', toX: 400 },
    ])
    const seen = runUntil(loco, (l) => {
      if (l.state.behavior === 'jump') expect(l.state.x).toBe(450)
      return settled(l)
    })
    expect(seen).toEqual(['walk', 'jump', 'land', 'walk', 'idle'])
    expect(loco.state).toMatchObject({ x: 400, y: 800, surface: 'top:4:0', windowId: 4 })
  })

  it('jumps between window tops in an arc peaking jumpApexPt above the higher end', () => {
    const loco = at({ x: 700, y: 700 })
    loco.goTo({ x: 1000, y: 600 })
    let highest = Infinity
    const seen = runUntil(loco, (l) => {
      if (l.state.behavior === 'jump') {
        highest = Math.min(highest, l.state.y)
        expect(l.state.facing).toBe(1)
      }
      if (l.state.behavior === 'land') expect(l.state).toMatchObject({ x: 920, y: 600 })
      return settled(l)
    })
    expect(seen).toEqual(['walk', 'jump', 'land', 'walk', 'idle'])
    expect(highest).toBeGreaterThanOrEqual(600 - PARAMS.jumpApexPt)
    expect(highest).toBeLessThan(600 - PARAMS.jumpApexPt + 5)
    expect(where(loco)).toEqual({ x: 1000, y: 600, behavior: 'idle' })
  })

  it('jumps up onto a low top from beside it', () => {
    const loco = at({ x: 1100, y: 1022 })
    loco.goTo({ x: 1450, y: 880 })
    expect(runToRest(loco)).toEqual(['walk', 'jump', 'land', 'walk', 'idle'])
    expect(loco.state).toMatchObject({ x: 1450, y: 880, surface: 'top:3:0' })
  })

  it('a fall lands on the first window top it crosses, not the ground', () => {
    const loco = at({ x: 600, y: 400 })
    expect(loco.state.behavior).toBe('fall')
    expect(loco.supportY).toBe(700)
    fallToRest(loco)
    expect(loco.state).toMatchObject({ x: 600, y: 700, behavior: 'land', surface: 'top:1:0', windowId: 1 })
  })

  it('a fall lands on a top whose visible end it is over (within edgeInsetPt), kept inside the top', () => {
    const loco = at({ x: 790, y: 400 })
    fallToRest(loco)
    expect(loco.state).toMatchObject({ x: 780, y: 700, surface: 'top:1:0' })
    const past = at({ x: 805, y: 400 })
    fallToRest(past)
    expect(past.state).toMatchObject({ x: 805, y: 1022, surface: 'ground' })
  })

  it('a release or teleport just above a top stands on it', () => {
    const loco = at({ x: 1000, y: 1022 })
    loco.grab()
    loco.release({ x: 600, y: 700 - SNAP })
    expect(loco.state).toMatchObject({ x: 600, y: 700, behavior: 'idle', surface: 'top:1:0' })
    loco.teleport({ x: 1000, y: 600 })
    expect(loco.state).toMatchObject({ x: 1000, y: 600, behavior: 'idle', surface: 'top:2:0', windowId: 2 })
  })

  it('a hard landing bounces a little first (§8.5), then lands', () => {
    const loco = at({ x: 300, y: 147 }) // 875 pt above the ground, nothing in between
    let touched = false
    let rose = false
    const seen = runUntil(loco, (l) => {
      if (l.state.y === 1022 && l.state.behavior === 'fall') touched = true
      if (touched && l.state.y < 1022) rose = true
      return l.state.behavior === 'land'
    })
    expect(seen).toEqual(['fall', 'land'])
    expect(touched && rose).toBe(true)
    expect(loco.state).toMatchObject({ x: 300, y: 1022, vx: 0, vy: 0 })
    // A soft one does not.
    const soft = at({ x: 300, y: 822 })
    soft.step(DT, null)
    fallToRest(soft)
    expect(soft.state.behavior).toBe('land')
  })

  it('the bounce goes up at restitution × the landing speed', () => {
    const loco = at({ x: 300, y: 147 })
    let before = 0
    for (let i = 0; i < 300 && loco.state.y < 1022; i++) {
      before = loco.state.vy
      loco.step(DT, null)
    }
    expect(loco.state.y).toBe(1022)
    expect(loco.state.vy).toBeLessThan(0)
    // The impact speed lies between the speed before the step and one step's gain after it.
    expect(-loco.state.vy).toBeGreaterThan(PARAMS.landBounce.restitution * before)
    expect(-loco.state.vy).toBeLessThanOrEqual(PARAMS.landBounce.restitution * (before + PARAMS.gravity * DT))
  })

  it('stop: a walking pet stops where it is; a climbing one holds on to its wall', () => {
    const walker = at({ x: 1000, y: 1022 })
    walker.goTo({ x: 300, y: 1022 })
    for (let i = 0; i < 10; i++) walker.step(DT, null)
    const x = walker.state.x
    walker.stop()
    expect(walker.state).toMatchObject({ x, behavior: 'idle', vx: 0 })
    expect(walker.goal).toBeNull()
    walker.step(DT, null)
    expect(walker.state.x).toBe(x)

    const climber = at({ x: 1000, y: 1022 })
    climber.goTo({ x: 600, y: 700 })
    runUntil(climber, (l) => l.state.behavior === 'climb')
    for (let i = 0; i < 10; i++) climber.step(DT, null)
    const y = climber.state.y
    climber.stop()
    expect(climber.state).toMatchObject({ x: 800, y, behavior: 'idle', attach: 'wallLeft', vy: 0 })
    climber.step(DT, null)
    expect(climber.state.y).toBe(y)
  })

  it('stop: a jump finishes, and then it stays where it landed', () => {
    const loco = at({ x: 780, y: 700 })
    loco.goTo({ x: 1100, y: 600 })
    runUntil(loco, (l) => l.state.behavior === 'jump')
    loco.stop()
    expect(loco.state.behavior).toBe('jump')
    expect(runToRest(loco)).toEqual(['jump', 'land', 'idle'])
    expect(loco.state).toMatchObject({ x: 920, y: 600 })
  })

  it('goTo: false while held or in the air, or when it can get no nearer; true when already there', () => {
    const held = at({ x: 1000, y: 1022 })
    held.grab()
    expect(held.goTo({ x: 600, y: 1022 })).toBe(false)
    const falling = at({ x: 1000, y: 300 })
    expect(falling.goTo({ x: 600, y: 1022 })).toBe(false)
    const here = at({ x: 1000, y: 1022 })
    expect(here.goTo({ x: 1000, y: 1022 })).toBe(true)
    expect(here.goal).toBeNull()
    expect(here.goTo({ x: 1000, y: 1100 })).toBe(false) // below the ground: it is already as near as it gets
    expect(here.goTo({ x: Number.NaN, y: 0 })).toBe(false)
  })

  it('goTo during a land waits for the land to end', () => {
    const loco = at({ x: 1000, y: 900 })
    fallToRest(loco)
    expect(loco.goTo({ x: 1100, y: 1022 })).toBe(true)
    expect(loco.state.behavior).toBe('land')
    for (let i = 0; i < LAND_STEPS; i++) loco.step(DT, null)
    expect(loco.state.behavior).toBe('walk')
    runToRest(loco)
    expect(loco.state.x).toBe(1100)
  })

  it('grab drops the goal', () => {
    const loco = at({ x: 1000, y: 1022 })
    loco.goTo({ x: 300, y: 1022 })
    loco.grab()
    expect(loco.goal).toBeNull()
    loco.release({ x: 900, y: 1022 })
    loco.step(DT, null)
    expect(where(loco)).toEqual({ x: 900, y: 1022, behavior: 'idle' })
  })
})

describe('Locomotion: riding and falling (§8.5)', () => {
  const WORLD = world([W1, W2, W3])
  /** A pet standing on W1's top at x 600, the world first seen at t 0 ms. */
  const onW1 = (): Locomotion => {
    const loco = new Locomotion(WORLD, PARAMS, { x: 600, y: 700 })
    loco.setWorld(WORLD, 0)
    return loco
  }
  const moved = (dx: number, dy: number, more: ReturnType<typeof win>[] = [W2, W3]): World =>
    world([{ ...W1, x: W1.x + dx, y: W1.y + dy }, ...more])

  it('the same geometry changes nothing', () => {
    const loco = onW1()
    const before = { ...loco.state }
    expect(loco.setWorld(world([W1, W2, W3]), 250)).toEqual({ ridingMoved: false })
    expect(loco.state).toEqual(before)
  })

  it('rides a window that moves: the same delta, still standing on its top', () => {
    const loco = onW1()
    expect(loco.setWorld(moved(30, -20), 250)).toEqual({ ridingMoved: true })
    expect(loco.state).toMatchObject({ x: 630, y: 680, behavior: 'idle', surface: 'top:1:0', windowId: 1 })
    expect(loco.supportY).toBe(680)
  })

  it('rides a window side while climbing it', () => {
    const loco = new Locomotion(WORLD, PARAMS, { x: 1000, y: 1022 })
    loco.setWorld(WORLD, 0)
    loco.goTo({ x: 800, y: 850 })
    runToRest(loco)
    expect(loco.state).toMatchObject({ x: 800, y: 850, surface: 'side:1:right:0' })
    expect(loco.setWorld(moved(-40, -10), 500)).toEqual({ ridingMoved: true })
    expect(loco.state).toMatchObject({ x: 760, y: 840, behavior: 'idle', attach: 'wallLeft', surface: 'side:1:right:0' })
  })

  it('a window flung faster than flingThreshold throws the pet off with its velocity', () => {
    const loco = onW1()
    // 500 pt in 250 ms: 2000 pt/s.
    expect(loco.setWorld(moved(500, 0, []), 250)).toEqual({ ridingMoved: true })
    expect(loco.state).toMatchObject({ x: 1100, y: 700, vx: 2000, vy: 0, behavior: 'fall', surface: null, windowId: null })
    // Just under the threshold it rides.
    const slow = onW1()
    slow.setWorld(moved(400, 0, []), 250) // 1600 pt/s
    expect(slow.state).toMatchObject({ x: 1000, behavior: 'idle', surface: 'top:1:0' })
  })

  it('a flung pet flies sideways until a screen wall stops it, and lands', () => {
    const loco = onW1()
    loco.setWorld(moved(500, 0, []), 250)
    let maxX = 0
    runUntil(loco, (l) => {
      maxX = Math.max(maxX, l.state.x)
      return l.state.behavior === 'land'
    })
    expect(maxX).toBe(loco.area.maxX)
    expect(loco.state).toMatchObject({ x: loco.area.maxX, y: 1022, surface: 'ground' })
  })

  it('a window that closes drops the pet: it falls onto what is below', () => {
    const loco = onW1()
    loco.setWorld(world([W2, W3]), 250)
    expect(loco.state).toMatchObject({ x: 600, y: 700, vx: 0, vy: 0, behavior: 'fall', surface: null })
    fallToRest(loco)
    expect(loco.state).toMatchObject({ x: 600, y: 1022, surface: 'ground' })
  })

  it('a window that covers the pet’s spot drops it; one covering another part of the top does not', () => {
    const covered = onW1()
    covered.setWorld(world([win(8, 500, 600, 200, 200), W1, W2, W3]), 250)
    expect(covered.state.behavior).toBe('fall')
    const beside = onW1()
    beside.setWorld(world([win(8, 300, 600, 200, 200), W1, W2, W3]), 250)
    expect(beside.state).toMatchObject({ x: 600, behavior: 'idle', surface: 'top:1:0' })
    expect(beside.world.segment('top:1:0')?.x0).toBe(520) // what is left of the top
  })

  it('a resize that takes away its spot drops it; one that keeps it does not', () => {
    const loco = onW1()
    loco.setWorld(world([{ ...W1, w: 150 }, W2, W3]), 250) // the top is 400..550: x 600 is gone
    expect(loco.state.behavior).toBe('fall')
    const kept = onW1()
    kept.setWorld(world([{ ...W1, w: 300 }, W2, W3]), 250)
    expect(kept.state).toMatchObject({ x: 600, behavior: 'idle', surface: 'top:1:0' })
  })

  it('a pet on the ground does not ride windows', () => {
    const loco = new Locomotion(WORLD, PARAMS, { x: 600, y: 1022 })
    loco.setWorld(WORLD, 0)
    expect(loco.setWorld(moved(100, 0), 250)).toEqual({ ridingMoved: false })
    expect(where(loco)).toEqual({ x: 600, y: 1022, behavior: 'idle' })
  })

  it('a ridden window moving under a walking pet carries it and its walk goes on', () => {
    const loco = onW1()
    loco.goTo({ x: 500, y: 700 })
    for (let i = 0; i < 5; i++) loco.step(DT, null)
    const x = loco.state.x
    loco.setWorld(moved(50, 0), 250)
    expect(loco.state).toMatchObject({ x: x + 50, behavior: 'walk' })
    expect(loco.route?.moves).toEqual([{ kind: 'walk', segment: 'top:1:0', toX: 500 }])
    runToRest(loco)
    expect(where(loco)).toEqual({ x: 500, y: 700, behavior: 'idle' })
  })

  it('plans again when the world changes mid-route', () => {
    const loco = new Locomotion(WORLD, PARAMS, { x: 1000, y: 1022 })
    loco.setWorld(WORLD, 0)
    loco.goTo({ x: 600, y: 700 })
    expect(loco.route?.moves[0]).toEqual({ kind: 'walk', segment: 'ground', toX: 850 })
    for (let i = 0; i < 10; i++) loco.step(DT, null)
    // W1 moves 100 right (W2 and W3 are gone): its right side is now beside x 950.
    loco.setWorld(world([{ ...W1, x: 500 }]), 250)
    expect(loco.route?.moves[0]).toEqual({ kind: 'walk', segment: 'ground', toX: 950 })
    expect(loco.goal).toEqual({ x: 600, y: 700 })
    runToRest(loco)
    expect(loco.state).toMatchObject({ x: 600, y: 700, surface: 'top:1:0' })
  })

  it('a window gone mid-route: falls, lands, and plans again to the goal from there', () => {
    const loco = onW1()
    loco.goTo({ x: 1000, y: 600 }) // walk to W1's end, jump to W2
    for (let i = 0; i < 5; i++) loco.step(DT, null)
    loco.setWorld(world([W2, W3]), 250)
    expect(loco.state.behavior).toBe('fall')
    expect(loco.goal).toEqual({ x: 1000, y: 600 })
    const seen = runToRest(loco, 5000)
    expect(seen[0]).toBe('fall')
    expect(seen).toContain('land')
    // W2 is out of reach from the ground (its sides end too high): the nearest reachable place is the ground below.
    expect(loco.state).toMatchObject({ y: 1022, surface: 'ground' })
    expect(loco.goal).toBeNull()
  })

  it('an arc whose target moves away flies on and lands on what it crosses', () => {
    const loco = new Locomotion(WORLD, PARAMS, { x: 780, y: 700 })
    loco.setWorld(WORLD, 0)
    loco.goTo({ x: 1000, y: 600 })
    loco.step(DT, null)
    expect(loco.state.behavior).toBe('jump')
    loco.setWorld(world([W1, { ...W2, y: 300 }, W3]), 250) // W2 jumps up out of the way
    runToRest(loco, 5000)
    expect(loco.state.surface).not.toBe(null)
    expect(loco.state.behavior).toBe('idle')
  })
})

describe('petAreaFor', () => {
  // The spikes' display: 1710×1107 pt, a 37 pt menu bar. The pet's box around its ground-contact point.
  const BOUNDS: Rect = { x: 0, y: 0, width: 1710, height: 1107 }
  const BOX: Box = { left: -50, top: -110, right: 60, bottom: 2 }
  const display = (workArea: Rect, bounds: Rect = BOUNDS): DisplayGeometry => ({ id: 1, bounds, workArea })

  it('Dock at the bottom: the ground is the Dock top; the box stays beside the screen edges and under the menu bar', () => {
    expect(petAreaFor(display({ x: 0, y: 37, width: 1710, height: 985 }), BOX)).toEqual(AREA)
  })

  it('Dock at the left: the Dock is a wall; the ground is the display bottom', () => {
    const area = petAreaFor(display({ x: 80, y: 37, width: 1630, height: 1070 }), BOX)
    expect(area).toEqual({ minX: 130, maxX: 1650, minY: 147, groundY: 1107 })
  })

  it('Dock at the right: the Dock is a wall; the ground is the display bottom', () => {
    const area = petAreaFor(display({ x: 0, y: 37, width: 1630, height: 1070 }), BOX)
    expect(area).toEqual({ minX: 50, maxX: 1570, minY: 147, groundY: 1107 })
  })

  it('an auto-hidden Dock: its 4 pt strip counts as the display edge, a 6 pt inset does not', () => {
    const bottom = (inset: number): number => petAreaFor(display({ x: 0, y: 37, width: 1710, height: 1070 - inset }), BOX).groundY
    expect(bottom(4)).toBe(1107)
    expect(bottom(tuning.world.dockHiddenInsetPt)).toBe(1107)
    expect(bottom(6)).toBe(1101)
    const left = (inset: number): number => petAreaFor(display({ x: inset, y: 37, width: 1710 - inset, height: 1070 }), BOX).minX
    expect(left(4)).toBe(50)
    expect(left(6)).toBe(56)
    const right = (inset: number): number => petAreaFor(display({ x: 0, y: 37, width: 1710 - inset, height: 1070 }), BOX).maxX
    expect(right(4)).toBe(1650)
    expect(right(6)).toBe(1644)
  })

  it('never moves the top edge (the menu bar), however close it is to the display top', () => {
    expect(petAreaFor(display({ x: 0, y: 3, width: 1710, height: 1104 }), BOX).minY).toBe(113)
    expect(petAreaFor(display({ x: 0, y: 0, width: 1710, height: 1107 }), BOX).minY).toBe(110)
  })

  it('a work area narrower than the box pins x to the centre; one shorter than it allows no lifting', () => {
    const area = petAreaFor(display({ x: 300, y: 37, width: 100, height: 50 }), BOX)
    expect(area).toEqual({ minX: 345, maxX: 345, minY: 87, groundY: 87 })
    expect(isPetArea(area)).toBe(true)
    const r = boxAt({ x: area.minX, y: area.groundY }, BOX)
    expect(r.x + r.width / 2).toBe(350) // the box is centred in the work area
  })

  it('works in global coordinates on a display away from the origin', () => {
    const bounds: Rect = { x: -1440, y: -900, width: 1440, height: 900 }
    const area = petAreaFor(display({ x: -1440, y: -875, width: 1440, height: 821 }, bounds), BOX)
    expect(area).toEqual({ minX: -1390, maxX: -60, minY: -765, groundY: -54 })
  })

  it('takes dockHiddenInsetPt from tuning.world by default', () => {
    const autoHidden = display({ x: 0, y: 37, width: 1710, height: 1066 })
    expect(petAreaFor(autoHidden, BOX)).toEqual(petAreaFor(autoHidden, BOX, tuning.world))
    expect(petAreaFor(autoHidden, BOX).groundY).toBe(1107)
    expect(petAreaFor(autoHidden, BOX, { dockHiddenInsetPt: 0 }).groundY).toBe(1103)
  })

  it('keeps the box inside the effective work area at every corner, standing on its bottom edge', () => {
    const cases = [
      display({ x: 0, y: 37, width: 1710, height: 985 }),
      display({ x: 80, y: 37, width: 1630, height: 1070 }),
      display({ x: 0, y: 37, width: 1706, height: 1066 }),
      display({ x: -1440, y: -875, width: 1440, height: 821 }, { x: -1440, y: -900, width: 1440, height: 900 }),
    ]
    const aboveGround: Box = { ...BOX, bottom: 0 } // the part of the box at or above the ground-contact point
    for (const d of cases) {
      const ewa = effectiveWorkArea(d, tuning.world.dockHiddenInsetPt)
      const area = petAreaFor(d, BOX)
      expect(area.groundY).toBe(ewa.y + ewa.height)
      for (const x of [area.minX, area.maxX]) {
        for (const y of [area.minY, area.groundY]) expect(rectContainsRect(ewa, boxAt({ x, y }, aboveGround))).toBe(true)
      }
      // One step further out on either side would leave it.
      expect(rectContainsRect(ewa, boxAt({ x: area.minX - 1, y: area.groundY }, aboveGround))).toBe(false)
      expect(rectContainsRect(ewa, boxAt({ x: area.maxX + 1, y: area.groundY }, aboveGround))).toBe(false)
      expect(rectContainsRect(ewa, boxAt({ x: area.minX, y: area.minY - 1 }, aboveGround))).toBe(false)
    }
  })

  it('pulls in a work-area edge reported outside the display, so the pet stays on its overlay', () => {
    const ewa = effectiveWorkArea(display({ x: -20, y: 37, width: 1750, height: 1100 }), tuning.world.dockHiddenInsetPt)
    expect(ewa).toEqual({ x: 0, y: 37, width: 1710, height: 1070 })
  })
})
