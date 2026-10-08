import { describe, expect, it } from 'vitest'
import { tuning } from '../src/shared/tuning'
import type { PetReactionKind } from '../src/shared/types'
import { PetLife } from '../src/main/petLife'
import { Brain } from '../src/main/sim/brain/brain'
import { LifeClock } from '../src/main/sim/lifeClock'
import { Locomotion } from '../src/main/sim/locomotion/locomotion'
import { Needs } from '../src/main/sim/needs/needs'
import { W1, world } from './worldFixtures'

// The pet's inner life as the app keeps it (src/main/petLife.ts), with the real needs model and brain and fake
// economy, clocks and idle time.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function setup() {
  let realMs = 1_000_000_000
  let idleS = 0
  let nutrition = 0
  const reactions: PetReactionKind[] = []
  const clock = new LifeClock(() => realMs)
  const needs = new Needs(tuning.needs, tuning.economy.activity.activeIdleS, undefined, clock.now())
  const brain = new Brain(tuning.brain, tuning.needs, mulberry32(3))
  const life = new PetLife({
    clock,
    needs,
    brain,
    nutritionLifetime: () => nutrition,
    dayKey: () => '2026-10-08',
    systemIdleS: () => idleS,
    wallNowMs: () => realMs,
    react: (k) => reactions.push(k),
  })
  const w = world([W1])
  const loco = new Locomotion(w, tuning.move, { x: 300, y: w.area.groundY })
  const extras = { cursor: { x: 900, y: 500 }, home: { x: 855, y: w.area.groundY }, foodSpot: null, enabled: true }
  return {
    life,
    needs,
    brain,
    loco,
    reactions,
    extras,
    /** Real time passes (the life clock follows at its scale). */
    pass: (ms: number) => (realMs += ms),
    setIdle: (s: number) => (idleS = s),
    eat: (n: number) => (nutrition += n),
  }
}

describe('PetLife', () => {
  it('feeds each payout’s nutrition to the needs (hunger falls)', () => {
    const t = setup()
    t.pass(3_600_000) // an active hour: hungrier
    t.life.advance()
    const hungry = t.needs.levels.hunger
    t.eat(20)
    t.pass(1000)
    t.life.advance()
    expect(t.needs.levels.hunger).toBeLessThan(hungry - 10)
  })

  it('falls asleep when the computer is idle long enough, and wakes with a stretch, then greets once', () => {
    const t = setup()
    t.setIdle(tuning.needs.sleepAfterIdleMin * 60)
    t.life.advance()
    expect(t.life.asleep).toBe(true)
    t.setIdle(1)
    t.life.advance()
    expect(t.life.asleep).toBe(false)
    expect(t.reactions).toEqual(['wakeUp'])
    // The greeting comes once the stretch is done, even if the economy's welcome back arrives meanwhile.
    t.life.economyEvent({ kind: 'spark', source: 'welcomeBack', amount: 1 })
    t.life.tickBrain(t.loco, t.extras)
    expect(t.brain.activity).not.toBe('greet')
    t.pass(tuning.brain.activityS.wakeUp * 1000 + 10)
    t.life.tickBrain(t.loco, t.extras)
    expect(t.brain.activity).toBe('greet')
  })

  it('the Mac’s sleep counts in one step on resume, and the pet wakes up', () => {
    const t = setup()
    const energy = t.needs.levels.energy
    t.life.suspend()
    expect(t.life.asleep).toBe(true)
    t.pass(4 * 3_600_000)
    t.life.resume()
    expect(t.life.asleep).toBe(false)
    expect(t.needs.levels.energy).toBeGreaterThan(energy) // rested while asleep
    expect(t.reactions).toEqual(['wakeUp'])
  })

  it('a relaunch counts the time Bitbot was quit like a sleep, and the pet wakes up', () => {
    const t = setup()
    const energy = t.needs.levels.energy
    const savedAt = 1_000_000_000
    t.pass(6 * 3_600_000)
    t.life.restoredAfter(savedAt)
    expect(t.needs.levels.energy).toBeGreaterThan(energy)
    expect(t.reactions).toEqual(['wakeUp'])
    // A save from the future (a clock change) counts nothing.
    t.life.restoredAfter(Number.MAX_SAFE_INTEGER)
    expect(t.reactions).toEqual(['wakeUp'])
  })

  it('an interaction lowers boredom; the first after a dusty return shakes the dust off', () => {
    const t = setup()
    t.pass(3 * 3_600_000)
    t.life.advance()
    const bored = t.needs.levels.boredom
    t.life.interaction('pet')
    expect(t.needs.levels.boredom).toBeLessThan(bored)
    const dusty = setup()
    // Three days without use.
    for (const day of ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']) {
      dusty.setIdle(10_000_000)
      ;(dusty.life as unknown as { deps: { dayKey: () => string } }).deps.dayKey = () => day
      dusty.pass(24 * 3_600_000)
      dusty.life.advance()
    }
    expect(dusty.needs.levels.dust).toBeGreaterThanOrEqual(tuning.needs.dust.visibleAt)
    dusty.life.interaction('pet')
    expect(dusty.reactions).toContain('shakeOff')
    expect(dusty.needs.levels.dust).toBe(0)
  })

  it('an app launch runs to eat; its window may come a little later', () => {
    const t = setup()
    t.life.appLaunched('com.apple.Notes', null)
    expect(t.life.pendingLaunch).toBe('com.apple.Notes')
    t.life.launchTarget({ x: 600, y: W1.y })
    expect(t.life.pendingLaunch).toBeNull()
    for (let i = 0; i < 30 * 20 && t.brain.activity !== 'eat'; i++) {
      t.pass(33)
      t.life.tickBrain(t.loco, t.extras)
      t.loco.step(1 / 30, null)
    }
    expect(t.brain.activity).toBe('eat')
    expect(t.loco.state.surface).toMatch(/^top:1:/)
  })

  it('a launch with no window gives up waiting after windowWaitS', () => {
    const t = setup()
    t.life.appLaunched('com.apple.Notes', null)
    t.pass(tuning.brain.appLaunch.windowWaitS * 1000 + 10)
    expect(t.life.pendingLaunch).toBeNull()
  })

  it('a return after neglect celebrates', () => {
    const t = setup()
    t.life.economyEvent({ kind: 'returnAfterNeglect', days: 3 })
    t.life.tickBrain(t.loco, t.extras)
    expect(t.brain.activity).toBe('celebrate')
  })

  it('what pet:state shows: movement wins over the activity, the forced state only when idle', () => {
    const t = setup()
    expect(t.life.stateFor('idle', 'sleep')).toBe('sleep')
    expect(t.life.stateFor('walk', 'sleep')).toBe('walk')
    expect(t.life.stateFor('held', null)).toBe('held')
  })

  it('a snapshot for the developer panel', () => {
    const t = setup()
    t.life.advance()
    const s = t.life.snapshot(60)
    expect(s.timeScale).toBe(60)
    expect(Object.keys(s.needs).sort()).toEqual(['boredom', 'dust', 'energy', 'fullness', 'hunger'])
    expect(s.asleep).toBe(false)
  })

  it('passes the restlessness setting to the brain (restless: the first choice comes sooner; absent: as tuned)', () => {
    /** Life-clock seconds until the brain's first decision. */
    const firstDecisionS = (restlessness: number | undefined): number => {
      const t = setup()
      const extras = restlessness === undefined ? t.extras : { ...t.extras, restlessness }
      let ms = 0
      while (t.brain.scores === null && ms < 60_000) {
        t.pass(33)
        ms += 33
        t.life.tickBrain(t.loco, extras)
      }
      return ms / 1000
    }
    const calm = firstDecisionS(0)
    const asTuned = firstDecisionS(undefined)
    const restless = firstDecisionS(1)
    expect(firstDecisionS(tuning.brain.restlessness.asTuned)).toBe(asTuned)
    expect(restless).toBeLessThan(asTuned)
    expect(asTuned).toBeLessThan(calm)
  })
})
