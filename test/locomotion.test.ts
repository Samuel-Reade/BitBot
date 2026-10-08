import { describe, expect, it } from 'vitest'
import { Locomotion, spawnPoint, type LocomotionBehavior, type LocomotionParams } from '../src/main/sim/locomotion/locomotion'
import { stepFall, type FallParams } from '../src/main/sim/locomotion/physics'
import { effectiveWorkArea, petAreaFor, type DisplayGeometry } from '../src/main/sim/world/screenArea'
import { boxAt, isPetArea, rectContainsRect, type Box, type PetArea, type Point, type Rect } from '../src/shared/geometry'
import { tuning } from '../src/shared/tuning'
import { isBehaviorState, type BehaviorState } from '../src/shared/types'

// Locomotion's M1 subset (BITBOT_SPEC.md §5.1, §8.5 physics) and the pet's area on the primary display (§8.1, §8.7).

const DT = 1 / tuning.sim.hz
/** The production params: tuning.move must satisfy LocomotionParams as is. */
const PARAMS: LocomotionParams = tuning.move
const SNAP = PARAMS.groundSnapPt
/** Just past groundSnapPt, exactly representable so the edge cases are exact. */
const PAST_SNAP = SNAP + 1 / 64
/** The spike's primary-display area: 1710×1107 pt display, 37 pt menu bar, Dock top at 1022. */
const AREA: PetArea = { minX: 50, maxX: 1650, minY: 147, groundY: 1022 }

const make = (start?: Point, area: PetArea = AREA): Locomotion => new Locomotion(area, PARAMS, start)
const where = (loco: Locomotion): { x: number; y: number; behavior: LocomotionBehavior } => ({
  x: loco.state.x,
  y: loco.state.y,
  behavior: loco.state.behavior,
})
/** Steps until the pet stops falling (at most 10 s); returns the y after each step. */
function fallToRest(loco: Locomotion): number[] {
  const ys: number[] = []
  for (let i = 0; i < 300 && loco.state.behavior === 'fall'; i++) {
    loco.step(DT, null)
    ys.push(loco.state.y)
  }
  return ys
}

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

describe('Locomotion', () => {
  it('spawns standing at the bottom centre of its area, facing right', () => {
    expect(spawnPoint(AREA)).toEqual({ x: 850, y: 1022 })
    const loco = make()
    expect(loco.state).toEqual({ x: 850, y: 1022, vx: 0, vy: 0, facing: 1, behavior: 'idle', behaviorTimeS: 0 })
    expect(loco.supportY).toBe(AREA.groundY)
    expect(loco.area).toEqual(AREA)
  })

  it('starts where it is told: clamped, standing within groundSnapPt of the ground, else falling', () => {
    expect(where(make({ x: 10, y: 5000 }))).toEqual({ x: 50, y: 1022, behavior: 'idle' })
    expect(where(make({ x: 9000, y: 1022 - SNAP }))).toEqual({ x: 1650, y: 1022, behavior: 'idle' })
    expect(where(make({ x: 400, y: 1022 - PAST_SNAP }))).toEqual({ x: 400, y: 1022 - PAST_SNAP, behavior: 'fall' })
    expect(where(make({ x: 400, y: 0 }))).toEqual({ x: 400, y: 147, behavior: 'fall' })
    expect(where(make({ x: Number.NaN, y: 3 }))).toEqual({ x: 850, y: 1022, behavior: 'idle' })
    expect(make({ x: 400, y: 300 }).state).toMatchObject({ vx: 0, vy: 0, behaviorTimeS: 0 })
  })

  it('stands still on the ground while idle, counting the time (a held point is ignored)', () => {
    const loco = make()
    for (let i = 0; i < 90; i++) loco.step(DT, { x: 100, y: 300 })
    expect(loco.state).toMatchObject({ x: 850, y: 1022, vx: 0, vy: 0, behavior: 'idle' })
    expect(loco.state.behaviorTimeS).toBeCloseTo(3)
  })

  it('grab → held at rest; it then follows the held point with the velocity of each move', () => {
    const loco = make()
    loco.step(DT, null)
    loco.grab()
    expect(loco.state).toMatchObject({ x: 850, y: 1022, vx: 0, vy: 0, behavior: 'held', behaviorTimeS: 0 })
    loco.step(DT, { x: 880, y: 1000 })
    expect(loco.state).toMatchObject({ x: 880, y: 1000, behavior: 'held' })
    expect(loco.state.vx).toBeCloseTo(30 / DT)
    expect(loco.state.vy).toBeCloseTo(-22 / DT)
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
    expect(releasedAt(1022).state).toMatchObject({ y: 1022, behavior: 'idle' })
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

  it('falls under gravity onto the ground and then stands there, still', () => {
    const loco = make({ x: 400, y: 522 })
    const ys = fallToRest(loco)
    expect(loco.state).toEqual({ x: 400, y: 1022, vx: 0, vy: 0, facing: 1, behavior: 'idle', behaviorTimeS: 0 })
    expect(ys.every((y, i) => i === 0 || y > (ys[i - 1] ?? Infinity))).toBe(true)
    expect(Math.abs(ys.length * DT - Math.sqrt((2 * 500) / PARAMS.gravity))).toBeLessThan(2 * DT)
    loco.step(DT, null)
    expect(loco.state).toMatchObject({ y: 1022, behavior: 'idle' })
    expect(loco.state.behaviorTimeS).toBeCloseTo(DT)
  })

  it('never falls faster than terminal velocity', () => {
    const tall: PetArea = { minX: 0, maxX: 100, minY: -100_000, groundY: 100_000 }
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

  it('moves only in §10.1 behavior states and keeps facing right throughout (no turning until M3)', () => {
    const behaviors: readonly LocomotionBehavior[] = ['idle', 'held', 'fall']
    const asStates: readonly BehaviorState[] = behaviors // compile-time: every LocomotionBehavior is a BehaviorState
    expect(asStates.every(isBehaviorState)).toBe(true)
    const loco = make()
    loco.grab()
    loco.step(DT, { x: 200, y: 500 }) // dragged left
    loco.release({ x: 200, y: 500 })
    fallToRest(loco)
    expect(loco.state.facing).toBe(1)
  })

  it('rejects an invalid area or params', () => {
    expect(() => new Locomotion({ ...AREA, maxX: 0 }, PARAMS)).toThrow(RangeError)
    expect(() => new Locomotion({ ...AREA, groundY: 100 }, PARAMS)).toThrow(RangeError)
    expect(() => new Locomotion(AREA, { ...PARAMS, gravity: 0 })).toThrow(RangeError)
    expect(() => new Locomotion(AREA, { ...PARAMS, gravity: Number.NaN })).toThrow(RangeError)
    expect(() => new Locomotion(AREA, { ...PARAMS, terminalVelocity: -1 })).toThrow(RangeError)
    expect(() => new Locomotion(AREA, { ...PARAMS, groundSnapPt: -0.5 })).toThrow(RangeError)
  })

  describe('setArea (display change)', () => {
    it('idle: a ground that moved down leaves the pet falling from where it stood, onto the new ground', () => {
      const loco = make({ x: 600, y: 1022 })
      loco.setArea({ ...AREA, groundY: 1107 }) // e.g. the Dock was set to hide
      expect(loco.state).toMatchObject({ x: 600, y: 1022, vx: 0, vy: 0, behavior: 'fall', behaviorTimeS: 0 })
      expect(loco.supportY).toBe(1107)
      fallToRest(loco)
      expect(where(loco)).toEqual({ x: 600, y: 1107, behavior: 'idle' })
    })

    it('idle: a ground that moved up carries the pet up onto it, still the same idle', () => {
      const loco = make({ x: 600, y: 1022 })
      loco.step(DT, null)
      loco.setArea({ ...AREA, groundY: 950 })
      expect(where(loco)).toEqual({ x: 600, y: 950, behavior: 'idle' })
      expect(loco.state.behaviorTimeS).toBeCloseTo(DT)
      expect(loco.supportY).toBe(950)
    })

    it('idle: a ground that sank by at most groundSnapPt still carries it; any further and it falls', () => {
      const loco = make({ x: 600, y: 1022 })
      loco.setArea({ ...AREA, groundY: 1022 + SNAP })
      expect(where(loco)).toEqual({ x: 600, y: 1022 + SNAP, behavior: 'idle' })
      loco.setArea({ ...AREA, groundY: 1022 + SNAP + PAST_SNAP })
      expect(where(loco)).toEqual({ x: 600, y: 1022 + SNAP, behavior: 'fall' })
    })

    it('idle: clamps x into a narrower area', () => {
      const loco = make({ x: 1600, y: 1022 })
      loco.setArea({ ...AREA, maxX: 1200 })
      expect(where(loco)).toEqual({ x: 1200, y: 1022, behavior: 'idle' })
    })

    it('held: stays held, clamped into the new area', () => {
      const loco = make()
      loco.grab()
      loco.step(DT, { x: 1600, y: 400 })
      loco.setArea({ minX: 50, maxX: 1200, minY: 500, groundY: 1022 })
      expect(where(loco)).toEqual({ x: 1200, y: 500, behavior: 'held' })
    })

    it('fall: keeps falling with its speed, and lands when the new ground is at or above it', () => {
      const loco = make({ x: 600, y: 300 })
      for (let i = 0; i < 5; i++) loco.step(DT, null)
      const { y, vy, behaviorTimeS } = loco.state
      loco.setArea({ ...AREA, groundY: 1107 })
      expect(loco.state).toMatchObject({ x: 600, y, vy, behavior: 'fall', behaviorTimeS })
      loco.setArea({ ...AREA, groundY: y })
      expect(loco.state).toMatchObject({ x: 600, y, vx: 0, vy: 0, behavior: 'idle', behaviorTimeS: 0 })
      const above = make({ x: 600, y: 300 })
      above.step(DT, null)
      above.setArea({ ...AREA, groundY: 250 })
      expect(where(above)).toEqual({ x: 600, y: 250, behavior: 'idle' })
    })

    it('rejects an invalid area and keeps the old one', () => {
      const loco = make()
      expect(() => loco.setArea({ minX: 10, maxX: 5, minY: 0, groundY: 100 })).toThrow(RangeError)
      expect(() => loco.setArea({ ...AREA, groundY: Number.NaN })).toThrow(RangeError)
      expect(loco.area).toEqual(AREA)
      expect(where(loco)).toEqual({ x: 850, y: 1022, behavior: 'idle' })
    })

    it('keeps its own read-only copy of the area', () => {
      const area = { ...AREA }
      const loco = new Locomotion(area, PARAMS)
      area.groundY = 0
      expect(loco.supportY).toBe(1022)
      expect(() => {
        loco.area.groundY = 5
      }).toThrow(TypeError)
    })
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
