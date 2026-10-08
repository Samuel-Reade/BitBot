import { describe, expect, it } from 'vitest'
import { Brain, restlessnessScales, type BrainInput, type BrainLocomotion } from '../src/main/sim/brain/brain'
import { MOVEMENT_GOALS } from '../src/main/sim/brain/stateMachine'
import { Locomotion } from '../src/main/sim/locomotion/locomotion'
import type { World } from '../src/main/sim/world/worldModel'
import { distance, type Point } from '../src/shared/geometry'
import { GOAL_KINDS, type BrainActivity, type GoalKind, type NeedLevels } from '../src/shared/life'
import { tuning } from '../src/shared/tuning'
import type { HelperWindow } from '../src/main/helper/protocol'
import { W1, W2, W3, world } from './worldFixtures'

// The brain (BITBOT_SPEC.md §10.2 utility AI, §9 needs and sleep, §10.1 priorities) with a real Locomotion and World.

const DT = 1 / tuning.sim.hz
const B = tuning.brain
const N = tuning.needs
const GROUND_Y = 1022
const HOME: Point = { x: 855, y: GROUND_Y }
/** W1's top (x 420..780 at y 700): where the frontmost app's food is. */
const FOOD: Point = { x: 600, y: 700 }
/** W3's top (x 1320..1580 at y 880): a newly launched app's window. */
const NEW_APP: Point = { x: 1450, y: 880 }

/** A seeded random in [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CALM: NeedLevels = { hunger: 10, energy: 90, fullness: 30, boredom: 10, dust: 0 }

interface Sim {
  brain: Brain
  loco: Locomotion
  t: number
  input: BrainInput
  /** The activities seen, in order (repeats collapsed). */
  seen: (BrainActivity | null)[]
  behaviors: Set<string>
}

function sim(opts: { start?: Point; windows?: HelperWindow[]; seed?: number; needs?: Partial<NeedLevels>; input?: Partial<BrainInput> } = {}): Sim {
  const w = world(opts.windows ?? [W1, W2, W3])
  const loco = new Locomotion(w, tuning.move, opts.start ?? { x: 200, y: GROUND_Y })
  const brain = new Brain(B, N, seeded(opts.seed ?? 1))
  const input: BrainInput = {
    nowS: 0,
    needs: { ...CALM, ...opts.needs },
    mood: 'content',
    stuffed: false,
    napNow: false,
    asleep: false,
    cursor: { x: 1000, y: 400 },
    home: HOME,
    foodSpot: FOOD,
    ...opts.input,
  }
  return { brain, loco, t: 0, input, seen: [null], behaviors: new Set() }
}

/** Steps for up to `seconds` (brain then locomotion, at the simulation's rate); stops early when `until` holds. */
function run(s: Sim, seconds: number, until?: () => boolean): boolean {
  const steps = Math.round(seconds / DT)
  for (let i = 0; i < steps; i++) {
    s.t += DT
    s.input.nowS = s.t
    s.brain.tick(s.input, s.loco)
    s.loco.step(DT, null)
    s.behaviors.add(s.loco.state.behavior)
    if (s.seen[s.seen.length - 1] !== s.brain.activity) s.seen.push(s.brain.activity)
    if (until?.()) return true
  }
  return false
}

const at = (s: Sim): Point => ({ x: s.loco.state.x, y: s.loco.state.y })

/** Climbs the pet onto W1's left side (x 400, y 750..972) by hand, the brain idle meanwhile. */
function onWall(s: Sim): void {
  s.loco.goTo({ x: 400, y: 900 })
  for (let i = 0; i < 30 * 30 && s.loco.goal !== null; i++) s.loco.step(DT, null)
  expect(s.loco.state.attach).not.toBe('floor')
  expect(s.loco.state.behavior).toBe('idle')
}

/** Runs until the brain has made `count` more decisions (a new scores object each); returns the goals chosen. */
function decisions(s: Sim, count: number, maxS = 600): GoalKind[] {
  const goals: GoalKind[] = []
  let last = s.brain.scores
  run(s, maxS, () => {
    if (s.brain.scores !== last) {
      last = s.brain.scores
      goals.push(s.brain.goalKind as GoalKind)
    }
    return goals.length >= count
  })
  return goals
}

/** A Locomotion stand-in that is always free where it stands (goTo "arrives" at once): to count decisions fast. */
class StillLoco implements BrainLocomotion {
  readonly state = { x: 200, y: GROUND_Y, behavior: 'idle', surface: 'ground', windowId: null, attach: 'floor' as const }
  readonly goal = null
  constructor(readonly world: World) {}
  goTo(): boolean {
    return true
  }
  stop(): void {}
}

describe('Brain: needs drive the goals', () => {
  it('a hungry pet goes to the food spot (the frontmost window top) and eats there', () => {
    const s = sim({ needs: { hunger: 95 } })
    expect(run(s, 30, () => s.brain.activity === 'eat')).toBe(true)
    expect(s.brain.goalKind).toBe('eat')
    expect(distance(at(s), FOOD)).toBeLessThan(2)
    // It eats for activityS.eat, then stays near the food (it's still hungry).
    const startedAt = s.t
    run(s, 10, () => s.brain.activity !== 'eat')
    expect(s.t - startedAt).toBeCloseTo(B.activityS.eat, 1)
  })

  it('with no food spot, a hungry pet eats where it is', () => {
    const s = sim({ needs: { hunger: 95 }, input: { foodSpot: null } })
    expect(run(s, 30, () => s.brain.activity === 'eat')).toBe(true)
    expect(at(s)).toEqual({ x: 200, y: GROUND_Y })
  })

  it('napNow: it naps where it is at once, until energy is back above sleepyAt', () => {
    const s = sim({ needs: { energy: N.energy.napAt }, input: { napNow: true } })
    run(s, 0.2)
    expect(s.brain.activity).toBe('sleep')
    expect(s.brain.goalKind).toBe('nap')
    expect(at(s)).toEqual({ x: 200, y: GROUND_Y })
    // napNow clears but energy isn't back yet: still asleep (hysteresis).
    s.input.napNow = false
    s.input.needs = { ...s.input.needs, energy: N.energy.sleepyAt }
    run(s, 60)
    expect(s.brain.activity).toBe('sleep')
    s.input.needs = { ...s.input.needs, energy: N.energy.sleepyAt + 1 }
    run(s, 0.1)
    expect(s.brain.activity).toBeNull()
  })

  it('napNow on a wall: down to the ground first, then sleeps', () => {
    const s = sim({ needs: { energy: 5 } })
    onWall(s)
    s.input.napNow = true
    expect(run(s, 30, () => s.brain.activity === 'sleep')).toBe(true)
    expect(s.loco.state.y).toBe(GROUND_Y)
  })

  it('sleepy: it goes home for a nap (activityS.nap), then wakes', () => {
    const s = sim({ needs: { energy: 15 }, input: { mood: 'sleepy' } })
    expect(run(s, 120, () => s.brain.activity === 'sleep')).toBe(true)
    expect(s.brain.goalKind).toBe('nap')
    expect(distance(at(s), HOME)).toBeLessThan(2)
    const start = s.t
    run(s, 200, () => s.brain.activity !== 'sleep')
    expect(s.t - start).toBeGreaterThanOrEqual(B.activityS.nap[0] - DT)
    expect(s.t - start).toBeLessThanOrEqual(B.activityS.nap[1] + DT)
  })

  it('asleep: it goes home from a window top and sleeps, nothing else meanwhile; wakes when it clears', () => {
    const s = sim({ start: { x: 1000, y: 600 }, needs: { boredom: 100, hunger: 95 }, input: { asleep: true } })
    expect(s.loco.state.windowId).toBe(2)
    expect(run(s, 60, () => s.brain.activity === 'sleep')).toBe(true)
    expect(distance(at(s), HOME)).toBeLessThan(2)
    const scores = s.brain.scores
    run(s, 120)
    expect(s.brain.activity).toBe('sleep')
    expect(s.brain.scores).toBe(scores)
    expect(distance(at(s), HOME)).toBeLessThan(2)
    s.input.asleep = false
    run(s, DT)
    expect(s.brain.activity).toBeNull()
  })

  it('asleep cleared on the way home: it stops where it is', () => {
    const s = sim({ start: { x: 200, y: GROUND_Y }, input: { asleep: true } })
    run(s, 1)
    expect(s.loco.goal).not.toBeNull()
    s.input.asleep = false
    run(s, DT)
    expect(s.loco.goal).toBeNull()
    expect(s.brain.activity).toBeNull()
  })

  it('asleep with home out of reach: the nearest ground', () => {
    const s = sim({ start: { x: 1000, y: 600 }, input: { asleep: true, home: { x: 1000, y: 100 } } })
    expect(run(s, 60, () => s.brain.activity === 'sleep')).toBe(true)
    expect(s.loco.state.y).toBe(GROUND_Y)
  })

  it('a bored pet explores, climbs, peeks and approaches the cursor', () => {
    const kinds = new Set<GoalKind>()
    for (let seed = 1; seed <= 100 && !MOVEMENT_GOALS.every((g) => kinds.has(g)); seed++) {
      const s = sim({ seed, needs: { boredom: 100 }, input: { mood: 'bored' } })
      for (const g of decisions(s, 6)) kinds.add(g)
    }
    for (const g of ['explore', 'climb', 'peek', 'approachCursor'] as const) expect(kinds).toContain(g)
  })

  /** The first seed whose first decision is `goal` for a bored pet. */
  function boredSimChoosing(goal: GoalKind, more: Parameters<typeof sim>[0] = {}): Sim {
    for (let seed = 1; seed < 500; seed++) {
      const s = sim({ seed, needs: { boredom: 100 }, input: { mood: 'bored' }, ...more })
      if (decisions(s, 1)[0] === goal) return s
    }
    throw new Error(`no seed chooses ${goal}`)
  }

  it('peek: to the end of the window top nearest the cursor, then Peek for activityS.peek', () => {
    // The cursor near W2's left end (920, 600).
    const s = boredSimChoosing('peek', { input: { mood: 'bored', cursor: { x: 880, y: 560 } } })
    expect(run(s, 40, () => s.brain.activity === 'peek')).toBe(true)
    expect(distance(at(s), { x: 920, y: 600 })).toBeLessThan(2)
    const start = s.t
    run(s, 20, () => s.brain.activity !== 'peek')
    expect(s.t - start).toBeGreaterThanOrEqual(B.activityS.peek[0] - DT)
    expect(s.t - start).toBeLessThanOrEqual(B.activityS.peek[1] + DT)
  })

  it('approachCursor: stops approachCursorGapPt short of the cursor, on its side, and idles', () => {
    const s = boredSimChoosing('approachCursor', { windows: [], input: { mood: 'bored', cursor: { x: 1200, y: 900 } } })
    expect(run(s, 30, () => s.loco.goal === null && s.loco.state.behavior === 'idle')).toBe(true)
    expect(at(s)).toEqual({ x: 1200 - B.approachCursorGapPt, y: GROUND_Y })
    expect(s.brain.activity).toBeNull()
  })

  it('climb: to the top of the nearest reachable wall or window side', () => {
    const s = boredSimChoosing('climb')
    expect(run(s, 40, () => s.loco.goal === null && s.loco.state.behavior === 'idle')).toBe(true)
    // W1's left side top (x 400, y 750).
    expect(at(s)).toEqual({ x: 400, y: 750 })
    expect(s.loco.state.attach).not.toBe('floor')
  })

  it('explore prefers window tops it has not stood on', () => {
    // Standing on W1's top; W2 and W3 are unvisited.
    let unvisited = 0
    let total = 0
    for (let seed = 1; seed <= 200 && total < 40; seed++) {
      const s = sim({ seed, start: { x: 600, y: 700 }, needs: { boredom: 100 }, input: { mood: 'bored' } })
      run(s, DT)
      if (decisions(s, 1)[0] !== 'explore') continue
      total++
      const g = s.loco.goal
      if (g && (g.y === 600 || g.y === 880)) unvisited++
    }
    expect(total).toBe(40)
    // unvisitedBias (0.75) plus 'any' landing on them sometimes.
    expect(unvisited / total).toBeGreaterThan(B.explore.unvisitedBias - 0.15)
  })

  it('sit is never chosen on a wall', () => {
    const s = sim({ needs: { boredom: 0 } })
    onWall(s)
    const goals = decisions(s, 1)
    expect(s.brain.scores?.sit).toBe(0)
    expect(goals[0]).not.toBe('sit')
  })
})

describe('Brain: scores and decisions', () => {
  it('scores are exposed, every goal scored; null before the first decision', () => {
    const s = sim()
    expect(s.brain.scores).toBeNull()
    expect(s.brain.goalKind).toBeNull()
    decisions(s, 1)
    const scores = s.brain.scores as Record<GoalKind, number>
    expect(Object.keys(scores).sort()).toEqual([...GOAL_KINDS].sort())
    expect(scores.idle).toBeCloseTo(B.weights.idle)
    expect(scores.sit).toBeCloseTo(B.weights.sit * B.contentSitScale)
    // Not hungry, not tired: eat and nap aren't candidates.
    expect(scores.eat).toBe(0)
    expect(scores.nap).toBe(0)
    expect(scores.explore).toBeCloseTo(B.weights.explore * 0.1)
  })

  it('hunger ≥ seeksFoodAt boosts eat strongly; boredom ≥ boredAt boosts the bored goals', () => {
    const below = new Brain(B, N, seeded(1))
    const above = new Brain(B, N, seeded(1))
    const w = world([W1])
    const base = sim().input
    below.tick({ ...base, needs: { ...CALM, hunger: N.hunger.seeksFoodAt - 1, boredom: N.boredom.boredAt - 1 } }, new StillLoco(w))
    above.tick({ ...base, needs: { ...CALM, hunger: N.hunger.seeksFoodAt, boredom: N.boredom.boredAt } }, new StillLoco(w))
    // Force a decision: tick past decisionS.
    below.tick({ ...base, nowS: 10, needs: { ...CALM, hunger: N.hunger.seeksFoodAt - 1, boredom: N.boredom.boredAt - 1 } }, new StillLoco(w))
    above.tick({ ...base, nowS: 10, needs: { ...CALM, hunger: N.hunger.seeksFoodAt, boredom: N.boredom.boredAt } }, new StillLoco(w))
    const b = below.scores as Record<GoalKind, number>
    const a = above.scores as Record<GoalKind, number>
    expect(a.eat - b.eat).toBeGreaterThan(B.seeksFoodBoost * B.weights.eat * 0.9)
    expect(a.explore - b.explore).toBeGreaterThan(B.boredBoost * B.weights.explore * 0.9)
  })

  it('decisions come only every decisionS while free', () => {
    const w = world([W1, W2, W3])
    const loco = new StillLoco(w)
    const brain = new Brain(B, N, seeded(5))
    const input = sim().input
    // goTo "arrives" at once and activities run their time, so a free pet decides, then waits decisionS again.
    const times: number[] = []
    let last = brain.scores
    let free = 0
    for (let t = DT; t < 600; t += DT) {
      input.nowS = t
      const wasFree = brain.activity === null
      brain.tick(input, loco)
      if (brain.scores !== last) {
        last = brain.scores
        times.push(t)
        expect(t - free).toBeGreaterThanOrEqual(B.decisionS[0] - 2 * DT)
        expect(t - free).toBeLessThanOrEqual(B.decisionS[1] + 2 * DT)
      }
      if (!wasFree || brain.activity !== null || times[times.length - 1] === t) free = t
    }
    expect(times.length).toBeGreaterThan(30)
    for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(B.decisionS[0] - 2 * DT)
  })

  it('stuffed scales the movement goals by calmScale (and over many decisions it moves much less)', () => {
    const w = world([W1, W2, W3])
    const needs: NeedLevels = { hunger: 70, energy: 80, fullness: 85, boredom: 100, dust: 0 }
    const share = (stuffed: boolean): { moving: number; scores: Record<GoalKind, number> } => {
      const brain = new Brain(B, N, seeded(11))
      const input = { ...sim().input, needs, stuffed }
      let last = brain.scores
      let moving = 0
      let count = 0
      for (let t = DT; count < 2000; t += 0.5) {
        input.nowS = t
        brain.tick(input, new StillLoco(w))
        if (brain.scores !== last) {
          last = brain.scores
          count++
          if (MOVEMENT_GOALS.includes(brain.goalKind as GoalKind) || brain.goalKind === 'eat') moving++
        }
      }
      return { moving: moving / count, scores: last as Record<GoalKind, number> }
    }
    const normal = share(false)
    const stuffed = share(true)
    for (const g of [...MOVEMENT_GOALS, 'eat'] as GoalKind[]) expect(stuffed.scores[g]).toBeCloseTo(normal.scores[g] * B.calmScale)
    for (const g of ['nap', 'idle'] as GoalKind[]) expect(stuffed.scores[g]).toBeCloseTo(normal.scores[g])
    expect(stuffed.moving).toBeLessThan(normal.moving * 0.7)
  })

  it('sleepy scales movement down too', () => {
    const w = world([W1])
    const brain = new Brain(B, N, seeded(2))
    const input = { ...sim().input, needs: { ...CALM, boredom: 50, energy: N.energy.sleepyAt } }
    brain.tick(input, new StillLoco(w))
    brain.tick({ ...input, nowS: 10 }, new StillLoco(w))
    expect(brain.scores?.explore).toBeCloseTo(B.weights.explore * 0.5 * B.calmScale)
  })
})

describe('Brain: app launch (§10.2 run to eat)', () => {
  it('runs to the new window once it appears, and eats there', () => {
    const s = sim({ needs: { boredom: 100 } })
    run(s, 1)
    s.brain.appLaunched(s.t, null)
    expect(s.brain.goalKind).toBe('eat')
    // Waiting for the window: stands still, no decisions.
    const scores = s.brain.scores
    const here = at(s)
    run(s, B.appLaunch.windowWaitS * 0.5)
    expect(s.loco.goal).toBeNull()
    expect(s.brain.scores).toBe(scores)
    expect(s.brain.activity).toBeNull()
    expect(at(s)).toEqual(here)
    s.brain.setEatTarget(NEW_APP)
    expect(run(s, 30, () => s.brain.activity === 'eat')).toBe(true)
    expect(distance(at(s), NEW_APP)).toBeLessThan(2)
    expect(s.behaviors).toContain('run')
    run(s, B.activityS.eat + DT)
    expect(s.brain.activity).toBeNull()
    // The launch is done: no second eat at once.
    run(s, B.decisionS[0] - 2 * DT)
    expect(s.brain.activity).toBeNull()
  })

  it('a target known at the launch: runs at once', () => {
    const s = sim()
    s.brain.appLaunched(0, NEW_APP)
    run(s, DT * 2)
    expect(s.loco.goal).toEqual(NEW_APP)
  })

  it('no window within windowWaitS: eats where it is (a late window is ignored)', () => {
    const s = sim()
    s.brain.appLaunched(0, null)
    run(s, B.appLaunch.windowWaitS - 0.1)
    expect(s.brain.activity).toBeNull()
    run(s, 0.2)
    expect(s.brain.activity).toBe('eat')
    expect(at(s)).toEqual({ x: 200, y: GROUND_Y })
    s.brain.setEatTarget(NEW_APP)
    run(s, DT)
    expect(s.loco.goal).toBeNull()
  })

  it('preempts sitting, napping and walking; waits for a greet', () => {
    const s = sim({ input: { napNow: true }, needs: { energy: 5 } })
    run(s, 0.2)
    expect(s.brain.activity).toBe('sleep')
    s.brain.appLaunched(s.t, NEW_APP)
    run(s, DT * 2)
    expect(s.brain.activity).toBeNull()
    expect(s.loco.goal).toEqual(NEW_APP)

    const g = sim()
    g.brain.greet(0)
    g.brain.appLaunched(0, NEW_APP)
    run(g, B.activityS.greet - 0.1)
    expect(g.brain.activity).toBe('greet')
    expect(g.loco.goal).toBeNull()
    run(g, 0.2)
    expect(g.loco.goal).toEqual(NEW_APP)
  })

  it('not while held: it runs once let go', () => {
    const s = sim()
    s.loco.grab()
    s.brain.appLaunched(0, NEW_APP)
    run(s, 0.5)
    expect(s.loco.goal).toBeNull()
    s.loco.release(at(s), 'drop')
    run(s, 0.5)
    expect(s.loco.goal).toEqual(NEW_APP)
  })

  it('asleep beats it', () => {
    const s = sim({ input: { asleep: true } })
    s.brain.appLaunched(0, NEW_APP)
    expect(run(s, 30, () => s.brain.activity === 'sleep')).toBe(true)
    expect(distance(at(s), HOME)).toBeLessThan(2)
  })
})

describe('Brain: interrupt, greet, celebrate, modes', () => {
  it('interrupt drops the activity and the goal choice, and waits decisionS before choosing again', () => {
    const s = sim({ needs: { hunger: 95 } })
    expect(run(s, 30, () => s.loco.goal !== null)).toBe(true)
    // The user grabs it mid-walk and drops it; it doesn't go on eating.
    s.loco.grab()
    s.brain.interrupt()
    s.loco.release(at(s), 'drop')
    const scores = s.brain.scores
    const t0 = s.t
    run(s, 30, () => s.brain.scores !== scores)
    expect(s.t - t0).toBeGreaterThanOrEqual(B.decisionS[0] - DT)
    expect(s.brain.activity).toBeNull()
  })

  it('interrupt then a command: the brain leaves the command alone and does nothing on arrival', () => {
    const s = sim({ needs: { hunger: 95 } })
    expect(run(s, 30, () => s.loco.goal !== null)).toBe(true)
    s.brain.interrupt()
    s.loco.goTo({ x: 1500, y: GROUND_Y })
    expect(run(s, 30, () => s.loco.goal === null)).toBe(true)
    expect(at(s)).toEqual({ x: 1500, y: GROUND_Y })
    expect(s.brain.activity).toBeNull()
  })

  it('interrupt wakes a napping pet; napNow puts it back to sleep only after decisionS', () => {
    const s = sim({ input: { napNow: true }, needs: { energy: 5 } })
    run(s, 0.2)
    expect(s.brain.activity).toBe('sleep')
    s.brain.interrupt()
    run(s, B.decisionS[0] - 0.1)
    expect(s.brain.activity).toBeNull()
    run(s, B.decisionS[1])
    expect(s.brain.activity).toBe('sleep')
  })

  it('greet plays at once wherever it is (stopping its own walk), then it carries on', () => {
    const s = sim({ needs: { hunger: 95 } })
    expect(run(s, 30, () => s.loco.goal !== null)).toBe(true)
    s.brain.greet(s.t)
    run(s, DT)
    expect(s.brain.activity).toBe('greet')
    expect(s.loco.goal).toBeNull()
    run(s, B.activityS.greet)
    expect(s.brain.activity).toBeNull()
    expect(run(s, 30, () => s.brain.activity === 'eat')).toBe(true)
  })

  it('celebrate plays for activityS.celebrate; after a greet when both come', () => {
    const s = sim()
    s.brain.celebrate(0)
    run(s, DT)
    expect(s.brain.activity).toBe('celebrate')
    run(s, B.activityS.celebrate)
    expect(s.brain.activity).toBeNull()

    const g = sim()
    g.brain.greet(0)
    g.brain.celebrate(0)
    run(g, B.activityS.greet + B.activityS.celebrate + 0.5)
    expect(g.seen).toEqual([null, 'greet', 'celebrate', null])
  })

  it('an in-place activity ends when the pet is moved off its spot', () => {
    const s = sim({ input: { napNow: true }, needs: { energy: 5 } })
    run(s, 0.2)
    expect(s.brain.activity).toBe('sleep')
    s.loco.grab()
    run(s, DT)
    expect(s.brain.activity).toBeNull()
  })

  it('Stay refuses movement goals: a bored pet never leaves its spot; eats and sleeps in place', () => {
    const s = sim({ needs: { boredom: 100 }, input: { mode: 'stay', mood: 'bored' } })
    const goals = decisions(s, 30, 3000)
    expect(goals.length).toBe(30)
    for (const g of goals) expect(MOVEMENT_GOALS).not.toContain(g)
    for (const g of MOVEMENT_GOALS) expect(s.brain.scores?.[g]).toBe(0)
    expect(at(s)).toEqual({ x: 200, y: GROUND_Y })

    const hungry = sim({ needs: { hunger: 95 }, input: { mode: 'stay' } })
    expect(run(hungry, 30, () => hungry.brain.activity === 'eat')).toBe(true)
    expect(at(hungry)).toEqual({ x: 200, y: GROUND_Y })

    const launch = sim({ input: { mode: 'stay' } })
    launch.brain.appLaunched(0, NEW_APP)
    run(launch, DT * 2)
    expect(launch.brain.activity).toBe('eat')
    expect(launch.loco.goal).toBeNull()

    const asleep = sim({ input: { mode: 'stay', asleep: true } })
    run(asleep, DT * 2)
    expect(asleep.brain.activity).toBe('sleep')
    expect(at(asleep)).toEqual({ x: 200, y: GROUND_Y })
  })

  it('deterministic: the same seed, the same life', () => {
    const a = sim({ seed: 9, needs: { boredom: 80, hunger: 50 } })
    const b = sim({ seed: 9, needs: { boredom: 80, hunger: 50 } })
    run(a, 120)
    run(b, 120)
    expect(at(a)).toEqual(at(b))
    expect(a.seen).toEqual(b.seen)
  })
})

describe('Brain: Hangout mode (§10.3)', () => {
  const SPOT: Point = { x: 1450, y: GROUND_Y }
  const hangout = { centre: SPOT, radiusPt: B.hangoutRadiusPt }

  it('a bored pet’s outings stay within the radius of its spot', () => {
    const s = sim({ start: SPOT, needs: { boredom: 95 }, seed: 5, input: { mode: 'hangout', hangout, home: SPOT } })
    let farthest = 0
    run(s, 300, () => {
      farthest = Math.max(farthest, distance(at(s), SPOT))
      return false
    })
    expect(s.behaviors.has('walk') || s.behaviors.has('run') || s.behaviors.has('climb')).toBe(true)
    // Within the radius, plus a pet's step of slack (routes may swing a little past their ends).
    expect(farthest).toBeLessThanOrEqual(B.hangoutRadiusPt + 60)
  })

  it('found far from its spot (after eating elsewhere, a toss…), it walks back and sits there', () => {
    const s = sim({ start: { x: 300, y: GROUND_Y }, input: { mode: 'hangout', hangout, home: SPOT } })
    expect(run(s, 60, () => s.brain.activity === 'sit')).toBe(true)
    expect(distance(at(s), SPOT)).toBeLessThanOrEqual(B.hangoutSitPt + 1)
  })

  it('sleeps at its spot when the computer is idle', () => {
    const s = sim({ start: { x: 900, y: GROUND_Y }, input: { mode: 'hangout', hangout, home: SPOT, asleep: true } })
    expect(run(s, 60, () => s.brain.activity === 'sleep')).toBe(true)
    expect(distance(at(s), SPOT)).toBeLessThan(5)
  })

  it('Roam ignores the spot', () => {
    const s = sim({ start: SPOT, needs: { boredom: 95 }, seed: 5, input: { mode: 'roam', hangout } })
    let farthest = 0
    run(s, 300, () => {
      farthest = Math.max(farthest, distance(at(s), SPOT))
      return false
    })
    expect(farthest).toBeGreaterThan(B.hangoutRadiusPt + 60)
  })
})

describe('Brain: restlessness (§15.4)', () => {
  const R = B.restlessness

  it('the scales: exactly 1 at asTuned (and when absent or not a number), the tuned ends at 0 and 1, clamped', () => {
    for (const r of [R.asTuned, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(restlessnessScales(r, R)).toEqual({ pause: 1, temperature: 1, movement: 1 })
    }
    const ends = { pause: R.pauseScale, temperature: R.temperatureScale, movement: R.movementScale }
    for (const [r, i] of [[0, 0], [-1, 0], [1, 1], [2, 1]] as const) {
      const s = restlessnessScales(r, R)
      expect(s.pause).toBeCloseTo(ends.pause[i])
      expect(s.temperature).toBeCloseTo(ends.temperature[i])
      expect(s.movement).toBeCloseTo(ends.movement[i])
    }
    // Monotonic: more restless = shorter pauses, more randomness, more moving about.
    let prev = restlessnessScales(0, R)
    for (let r = 0.1; r <= 1.0001; r += 0.1) {
      const s = restlessnessScales(r, R)
      expect(s.pause).toBeLessThan(prev.pause)
      expect(s.temperature).toBeGreaterThan(prev.temperature)
      expect(s.movement).toBeGreaterThan(prev.movement)
      prev = s
    }
  })

  it('0.5 is exactly today’s brain: the same seed lives the same life with or without it', () => {
    for (const [seed, needs] of [
      [9, { boredom: 80, hunger: 50 }],
      [4, { boredom: 30, energy: 40 }],
      [21, { boredom: 100, hunger: 75, energy: 20 }],
    ] as const) {
      const a = sim({ seed, needs })
      const b = sim({ seed, needs, input: { restlessness: 0.5 } })
      const scoresA: (Record<GoalKind, number> | null)[] = []
      const scoresB: (Record<GoalKind, number> | null)[] = []
      for (let i = 0; i < 60; i++) {
        run(a, 10)
        run(b, 10)
        scoresA.push(a.brain.scores)
        scoresB.push(b.brain.scores)
        expect(at(b)).toEqual(at(a))
      }
      expect(b.seen).toEqual(a.seen)
      expect(scoresB).toEqual(scoresA)
      expect(b.brain.goalKind).toBe(a.brain.goalKind)
    }
  })

  /** Movement-goal decisions over a simulated hour (a fairly bored, rested, fed pet). */
  function movementInAnHour(restlessness: number, seed: number): { moving: number; decisions: number } {
    const s = sim({ seed, needs: { boredom: 50 }, input: { restlessness } })
    let last = s.brain.scores
    let moving = 0
    let decisions = 0
    run(s, 3600, () => {
      if (s.brain.scores !== last) {
        last = s.brain.scores
        decisions++
        if (MOVEMENT_GOALS.includes(s.brain.goalKind as GoalKind)) moving++
      }
      return false
    })
    return { moving, decisions }
  }

  it('1 chooses movement goals more often than 0 over a simulated hour (and decides more often)', () => {
    for (const seed of [1, 2, 3]) {
      const calm = movementInAnHour(0, seed)
      const restless = movementInAnHour(1, seed)
      expect(restless.moving).toBeGreaterThan(calm.moving * 1.5)
      expect(restless.decisions).toBeGreaterThan(calm.decisions)
      expect(calm.moving).toBeGreaterThan(0) // calm, not frozen
    }
  })

  it('scales the movement weights and the pauses, never eat, nap, sit or idle', () => {
    const w = world([W1, W2, W3])
    const needs: NeedLevels = { hunger: 70, energy: 30, fullness: 30, boredom: 60, dust: 0 }
    const scoresAt = (restlessness: number): Record<GoalKind, number> => {
      const brain = new Brain(B, N, seeded(3))
      const input = { ...sim().input, needs, restlessness }
      for (let t = DT; brain.scores === null; t += DT) brain.tick({ ...input, nowS: t }, new StillLoco(w))
      return brain.scores as Record<GoalKind, number>
    }
    const mid = scoresAt(0.5)
    for (const r of [0, 1]) {
      const s = scoresAt(r)
      const m = restlessnessScales(r, R).movement
      for (const g of MOVEMENT_GOALS) expect(s[g]).toBeCloseTo(mid[g] * m)
      for (const g of ['eat', 'nap', 'sit', 'idle'] as GoalKind[]) expect(s[g]).toBe(mid[g])
    }
    // The first decision comes decisionS × pause after the pet is free.
    const firstDecisionAt = (restlessness: number): number => {
      const brain = new Brain(B, N, () => 0.999)
      const input = { ...sim().input, restlessness }
      let t = DT
      for (; brain.scores === null; t += DT) brain.tick({ ...input, nowS: t }, new StillLoco(w))
      return t
    }
    expect(firstDecisionAt(1)).toBeCloseTo(B.decisionS[1] * R.pauseScale[1], 0)
    expect(firstDecisionAt(0)).toBeCloseTo(B.decisionS[1] * R.pauseScale[0], 0)
  })

  it('0 still eats and sleeps normally', () => {
    const hungry = sim({ needs: { hunger: 95 }, input: { restlessness: 0 } })
    expect(run(hungry, 30, () => hungry.brain.activity === 'eat')).toBe(true)
    expect(distance(at(hungry), FOOD)).toBeLessThan(2)
    const start = hungry.t
    run(hungry, 10, () => hungry.brain.activity !== 'eat')
    expect(hungry.t - start).toBeCloseTo(B.activityS.eat, 1)

    const sleepy = sim({ needs: { energy: 15 }, input: { mood: 'sleepy', restlessness: 0 } })
    expect(run(sleepy, 120, () => sleepy.brain.activity === 'sleep')).toBe(true)
    expect(distance(at(sleepy), HOME)).toBeLessThan(2)
    const napStart = sleepy.t
    run(sleepy, 200, () => sleepy.brain.activity !== 'sleep')
    expect(sleepy.t - napStart).toBeGreaterThanOrEqual(B.activityS.nap[0] - DT)
    expect(sleepy.t - napStart).toBeLessThanOrEqual(B.activityS.nap[1] + DT)

    const asleep = sim({ start: { x: 1000, y: 600 }, input: { asleep: true, restlessness: 0 } })
    expect(run(asleep, 60, () => asleep.brain.activity === 'sleep')).toBe(true)
    expect(distance(at(asleep), HOME)).toBeLessThan(2)

    const napNow = sim({ needs: { energy: N.energy.napAt }, input: { napNow: true, restlessness: 0 } })
    run(napNow, 0.2)
    expect(napNow.brain.activity).toBe('sleep')
  })
})
