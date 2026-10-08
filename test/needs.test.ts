import { describe, expect, it } from 'vitest'
import { freshNeedsState, Needs, sanitizeNeedsState, type NeedsParams } from '../src/main/sim/needs/needs'
import type { NeedLevels } from '../src/shared/life'
import { tuning } from '../src/shared/tuning'

// Needs (src/main/sim/needs/needs.ts, BITBOT_SPEC.md §9.1, §9.3, §14.2): rates over elapsed time while active, idle
// and asleep, the catch-up cap, energy rest after restAfterIdleMin, stuffed and breaks, fullness, boredom and
// interactions, dust per unused day and the shake-off, neglect, clamping, determinism, the state round trip.

const N: NeedsParams = tuning.needs
const ACTIVE_IDLE_S = tuning.economy.activity.activeIdleS
const MIN = 60
const HOUR = 3600
const DAY = 24 * HOUR

/** A Needs at the given levels, its life clock and day, and helpers that advance it in ticks. */
function setup(levels: Partial<NeedLevels> = {}, params: NeedsParams = N) {
  const state = { ...freshNeedsState(params), levels: { ...params.initial, ...levels } }
  const n = new Needs(params, ACTIVE_IDLE_S, state, 0)
  let now = 0
  let lastInput = 0
  let day = '2026-10-08'
  const step = (dt: number, userIdleS: number, computerAsleep = false): void => {
    now += dt
    n.advance(dt, now, { userIdleS, computerAsleep, dayKey: day })
  }
  return {
    n,
    get now() {
      return now
    },
    setDay(d: string) {
      day = d
    },
    /** The user is active for sec (input every tick). */
    active(sec: number, tick = 10) {
      for (let t = 0; t < sec; t += tick) {
        step(Math.min(tick, sec - t), 0)
        lastInput = now
      }
    },
    /** The user is away for sec, the Mac awake (the idle time grows from the last input). */
    idle(sec: number, tick = 10) {
      for (let t = 0; t < sec; t += tick) {
        const dt = Math.min(tick, sec - t)
        step(dt, now + dt - lastInput)
      }
    },
    /** Away for sec with the idle time already past everything. */
    away(sec: number, tick = 10) {
      for (let t = 0; t < sec; t += tick) step(Math.min(tick, sec - t), Math.max(HOUR, now - lastInput))
    },
    /** One idle step of sec. */
    idleStep(sec: number) {
      step(sec, now + sec - lastInput)
    },
    /** The Mac slept for sec (one step on resume). */
    asleep(sec: number) {
      step(sec, now + sec - lastInput, true)
    },
  }
}

/** The user has been away for long already (the Mac awake): a pure idle rate. */
const longIdle = (g: ReturnType<typeof setup>, sec: number, tick = 10) => g.away(sec, tick)

describe('hunger', () => {
  it('rises at activePerH while active, idlePerH while idle or asleep', () => {
    const a = setup({ hunger: 0 })
    a.active(HOUR)
    expect(a.n.levels.hunger).toBeCloseTo(N.hunger.activePerH, 6)

    const i = setup({ hunger: 0 })
    longIdle(i, HOUR)
    expect(i.n.levels.hunger).toBeCloseTo(N.hunger.idlePerH, 6)

    const s = setup({ hunger: 0 })
    s.asleep(3 * HOUR)
    expect(s.n.levels.hunger).toBeCloseTo(3 * N.hunger.idlePerH, 6)
  })

  it('a payout lowers it by perNutrition × nutrition', () => {
    const g = setup({ hunger: 50 })
    g.n.nutrition(10, 0)
    expect(g.n.levels.hunger).toBeCloseTo(50 - 10 * N.hunger.perNutrition, 6)
    g.n.nutrition(1000, 0)
    expect(g.n.levels.hunger).toBe(0)
  })

  it('ignores nonsense nutrition', () => {
    const g = setup({ hunger: 50 })
    g.n.nutrition(Number.NaN, 0)
    g.n.nutrition(-5, 0)
    g.n.nutrition(Infinity, 0)
    expect(g.n.levels.hunger).toBe(50)
    expect(g.n.state.nutritionWindow).toEqual([])
  })
})

describe('energy', () => {
  it('falls at activeDropPerH while the user is active', () => {
    const g = setup({ energy: 80 })
    g.active(2 * HOUR)
    expect(g.n.levels.energy).toBeCloseTo(80 - 2 * N.energy.activeDropPerH, 6)
  })

  it('rests only once idle for restAfterIdleMin', () => {
    const g = setup({ energy: 50 })
    g.active(MIN)
    const before = g.n.levels.energy
    // The first activeIdleS of the absence still counts as active (a small drop), then no rest until restAfterIdleMin.
    g.idle(N.energy.restAfterIdleMin * MIN)
    const activeTail = (N.energy.activeDropPerH * (ACTIVE_IDLE_S - 10)) / HOUR
    expect(g.n.levels.energy).toBeCloseTo(before - activeTail, 6)
    g.idle(HOUR)
    expect(g.n.levels.energy).toBeCloseTo(before - activeTail + N.energy.restPerH, 6)
  })

  it('one big idle step rests only for the part past restAfterIdleMin', () => {
    const g = setup({ energy: 0 })
    g.active(MIN)
    const before = g.n.levels.energy
    g.idleStep(HOUR)
    const restS = HOUR - N.energy.restAfterIdleMin * MIN
    expect(g.n.levels.energy).toBeCloseTo(before + (N.energy.restPerH * restS) / HOUR, 6)
  })

  it('rests for the whole of a sleep, however short', () => {
    const g = setup({ energy: 10 })
    g.active(MIN)
    const before = g.n.levels.energy
    g.asleep(2 * MIN)
    expect(g.n.levels.energy).toBeCloseTo(before + (N.energy.restPerH * 2) / 60, 6)
  })

  it('sleepy at sleepyAt, naps at napAt', () => {
    expect(setup({ energy: N.energy.sleepyAt + 1 }).n.sleepy).toBe(false)
    expect(setup({ energy: N.energy.sleepyAt }).n.sleepy).toBe(true)
    expect(setup({ energy: N.energy.napAt + 1 }).n.napNow).toBe(false)
    expect(setup({ energy: N.energy.napAt }).n.napNow).toBe(true)
  })
})

describe('sleep and wake jumps', () => {
  it('a resume applies the whole sleep in one step', () => {
    const g = setup({ hunger: 0, energy: 0, boredom: 0 })
    g.asleep(2 * HOUR)
    expect(g.n.levels).toMatchObject({ hunger: 2 * N.hunger.idlePerH, energy: 2 * N.energy.restPerH, boredom: 2 * N.boredom.perH })
  })

  it('caps the catch-up at maxCatchUpH', () => {
    const params: NeedsParams = { ...N, hunger: { ...N.hunger, idlePerH: 1 }, maxCatchUpH: 72 }
    const a = setup({ hunger: 0 }, params)
    a.asleep(48 * HOUR)
    expect(a.n.levels.hunger).toBeCloseTo(48, 6)
    const b = setup({ hunger: 0 }, params)
    b.asleep(10 * DAY)
    expect(b.n.levels.hunger).toBeCloseTo(72, 6)
  })

  it('ignores a non-finite or negative step', () => {
    const g = setup({ hunger: 10 })
    const before = g.n.state
    g.n.advance(Number.NaN, 1, { userIdleS: 0, computerAsleep: false, dayKey: '2026-10-08' })
    g.n.advance(-50, 1, { userIdleS: 0, computerAsleep: false, dayKey: '2026-10-08' })
    expect(g.n.levels).toEqual(before.levels)
  })
})

describe('stuffed and breaks', () => {
  it('stuffed after continuousMin of activity; a break clears it', () => {
    const g = setup()
    g.active((N.stuffed.continuousMin - 1) * MIN)
    expect(g.n.stuffed).toBe(false)
    g.active(MIN)
    expect(g.n.continuousActiveMin).toBeCloseTo(N.stuffed.continuousMin, 6)
    expect(g.n.stuffed).toBe(true)
    g.idle(N.breakMin * MIN)
    expect(g.n.continuousActiveMin).toBe(0)
    expect(g.n.stuffed).toBe(false)
  })

  it('a pause shorter than breakMin is not a break', () => {
    const g = setup()
    g.active(60 * MIN)
    g.idle((N.breakMin - 1) * MIN)
    g.active(30 * MIN)
    expect(g.n.stuffed).toBe(true)
  })

  it('a sleep of breakMin or more is a break; a shorter one is not', () => {
    const a = setup()
    a.active(60 * MIN)
    a.asleep(N.breakMin * MIN)
    expect(a.n.continuousActiveMin).toBe(0)
    const b = setup()
    b.active(60 * MIN)
    b.asleep(MIN)
    expect(b.n.continuousActiveMin).toBeCloseTo(60, 6)
  })

  it('stuffed when fullness ≥ stuffedAt', () => {
    expect(setup({ fullness: N.fullness.stuffedAt - 0.1 }).n.stuffed).toBe(false)
    expect(setup({ fullness: N.fullness.stuffedAt }).n.stuffed).toBe(true)
  })
})

describe('fullness', () => {
  /** Active for sec, a payout every minute at perHour nutrition per hour. */
  const eat = (g: ReturnType<typeof setup>, perHour: number, sec: number) => {
    for (let t = 0; t < sec; t += MIN) {
      g.active(MIN)
      g.n.nutrition(perHour / 60, g.now)
    }
  }

  it('an ordinary pace sits near 40; twice it is stuffed', () => {
    const ordinary = setup()
    eat(ordinary, 72, HOUR)
    expect(ordinary.n.levels.fullness).toBeGreaterThan(36)
    expect(ordinary.n.levels.fullness).toBeLessThan(44)
    expect(ordinary.n.stuffed).toBe(false)

    const heavy = setup()
    eat(heavy, 146, HOUR)
    expect(heavy.n.levels.fullness).toBeGreaterThanOrEqual(N.fullness.stuffedAt)
    expect(heavy.n.stuffed).toBe(true)
  })

  it('rises with the trailing window, not with the lifetime total', () => {
    const g = setup()
    eat(g, 72, 4 * HOUR)
    expect(g.n.levels.fullness).toBeLessThan(44)
    expect(g.n.state.nutritionWindow.length).toBeLessThanOrEqual(N.fullness.windowMin * MIN / N.fullness.bucketS + 1)
  })

  it('never falls faster than decayPerH once the eating stops', () => {
    const g = setup()
    eat(g, 146, HOUR)
    let prev = g.n.levels.fullness
    for (let i = 0; i < 6 * 60; i++) {
      g.active(MIN)
      const f = g.n.levels.fullness
      expect(prev - f).toBeLessThanOrEqual(N.fullness.decayPerH / 60 + 1e-9)
      prev = f
    }
    expect(prev).toBe(0)
  })

  it('a long sleep empties the window and decays at most maxCatchUpH × decayPerH', () => {
    const g = setup()
    eat(g, 146, HOUR)
    g.asleep(HOUR)
    expect(g.n.state.nutritionWindow).toEqual([])
    expect(g.n.levels.fullness).toBeGreaterThan(N.fullness.stuffedAt - N.fullness.decayPerH - 1)
  })
})

describe('boredom and interactions', () => {
  it('rises at perH; an interaction takes off `interaction`, never below 0', () => {
    const g = setup({ boredom: 0 })
    g.active(3 * HOUR)
    expect(g.n.levels.boredom).toBeCloseTo(3 * N.boredom.perH, 6)
    g.n.interaction(g.now)
    expect(g.n.levels.boredom).toBeCloseTo(3 * N.boredom.perH - N.boredom.interaction, 6)
    g.n.interaction(g.now)
    expect(g.n.levels.boredom).toBe(0)
  })
})

describe('dust', () => {
  it('a day without any use adds perDay when it ends; a used day adds nothing', () => {
    const g = setup({ dust: 0 })
    g.active(MIN) // 10-08 used
    g.setDay('2026-10-09')
    g.asleep(HOUR)
    expect(g.n.levels.dust).toBe(0)
    longIdle(g, HOUR) // 10-09: awake but never used
    g.setDay('2026-10-10')
    g.asleep(HOUR)
    expect(g.n.levels.dust).toBe(N.dust.perDay)
    g.active(MIN) // 10-10 used
    g.setDay('2026-10-11')
    g.asleep(HOUR)
    expect(g.n.levels.dust).toBe(N.dust.perDay)
  })

  it('a long sleep spanning several days adds perDay for each day skipped', () => {
    const g = setup({ dust: 0 })
    g.active(MIN) // 10-08 used
    g.setDay('2026-10-12') // 10-09, 10, 11 skipped
    g.asleep(4 * DAY)
    expect(g.n.levels.dust).toBe(3 * N.dust.perDay)
    expect(g.n.levels.dust).toBeGreaterThanOrEqual(N.dust.visibleAt)
  })

  it('clamps at 100 after a long absence', () => {
    const g = setup({ dust: 0 })
    g.active(MIN)
    g.setDay('2026-12-01')
    g.asleep(HOUR)
    expect(g.n.levels.dust).toBe(100)
  })

  it('the first interaction after a dusty return shakes it all off, once', () => {
    const g = setup({ dust: 0 })
    g.active(MIN)
    g.setDay('2026-10-12')
    g.asleep(4 * DAY)
    g.active(MIN)
    expect(g.n.levels.dust).toBe(3 * N.dust.perDay) // typing alone doesn't shake it off
    expect(g.n.interaction(g.now)).toEqual({ shakeOff: true })
    expect(g.n.levels.dust).toBe(0)
    expect(g.n.interaction(g.now)).toEqual({ shakeOff: false })
  })

  it('dust below visibleAt comes off without a shake-off', () => {
    const g = setup({ dust: N.dust.visibleAt - 1 })
    expect(g.n.interaction(0)).toEqual({ shakeOff: false })
    expect(g.n.levels.dust).toBe(0)
  })

  it('a day going backwards (the clock set back) adds nothing', () => {
    const g = setup({ dust: 0 })
    g.active(MIN)
    g.setDay('2026-10-01')
    g.asleep(HOUR)
    expect(g.n.levels.dust).toBe(0)
  })
})

describe('neglect', () => {
  it('neglected after neglectDays without activity; activity ends it', () => {
    const g = setup()
    g.active(MIN)
    g.asleep(N.neglectDays * DAY - HOUR)
    expect(g.n.neglected).toBe(false)
    g.asleep(HOUR)
    expect(g.n.neglected).toBe(true)
    g.active(10)
    expect(g.n.neglected).toBe(false)
  })

  it('idle time with the Mac awake counts too, and nothing is lost', () => {
    const g = setup({ hunger: 0 })
    longIdle(g, N.neglectDays * DAY, 600)
    expect(g.n.neglected).toBe(true)
    expect(g.n.levels.hunger).toBeCloseTo(Math.min(100, N.neglectDays * 24 * N.hunger.idlePerH), 6)
  })
})

describe('clamping', () => {
  it('every level stays within 0..100', () => {
    const g = setup({ hunger: 90, energy: 5, boredom: 95 })
    g.active(20 * HOUR, 600)
    expect(g.n.levels).toMatchObject({ hunger: 100, energy: 0, boredom: 100 })
    for (let i = 0; i < 20; i++) g.n.nutrition(1000, g.now)
    expect(g.n.levels.fullness).toBe(100)
    expect(g.n.levels.hunger).toBe(0)
    g.asleep(30 * HOUR)
    expect(g.n.levels.energy).toBe(100)
  })
})

describe('determinism and state', () => {
  const script = (g: ReturnType<typeof setup>) => {
    g.active(40 * MIN)
    g.n.nutrition(12, g.now)
    g.idle(20 * MIN)
    g.n.interaction(g.now)
    g.setDay('2026-10-11')
    g.asleep(3 * DAY)
    g.active(5 * MIN)
  }

  it('the same inputs give the same state', () => {
    const a = setup()
    const b = setup()
    script(a)
    script(b)
    expect(a.n.state).toEqual(b.n.state)
  })

  it('round-trips through JSON', () => {
    const a = setup()
    script(a)
    const saved = JSON.parse(JSON.stringify(a.n.state))
    const b = new Needs(N, ACTIVE_IDLE_S, saved, 0)
    expect(b.state).toEqual(a.n.state)
    // ...and carries on the same way.
    const input = { userIdleS: 0, computerAsleep: false, dayKey: '2026-10-11' }
    a.n.advance(MIN, a.now + MIN, input)
    b.advance(MIN, MIN, input)
    expect(b.state).toEqual(a.n.state)
  })

  it('state is a copy', () => {
    const g = setup({ hunger: 10 })
    const s = g.n.state
    s.levels.hunger = 99
    expect(g.n.levels.hunger).toBe(10)
  })

  it('a fresh pet starts at the initial levels', () => {
    expect(new Needs(N, ACTIVE_IDLE_S).levels).toEqual(N.initial)
  })

  it('a corrupt save falls back field by field', () => {
    const s = sanitizeNeedsState(
      {
        levels: { hunger: 150, energy: 'x', fullness: -3, boredom: Number.NaN },
        continuousActiveMs: -5,
        sinceInteractionS: 'soon',
        dayKey: 'yesterday',
        nutritionWindow: [{ ageS: 10, amount: 4 }, null, { ageS: 99_999, amount: 1 }, { ageS: 5, amount: -1 }],
      },
      N,
    )
    expect(s.levels).toEqual({ hunger: 100, energy: N.initial.energy, fullness: 0, boredom: N.initial.boredom, dust: N.initial.dust })
    expect(s.continuousActiveMs).toBe(0)
    expect(s.sinceInteractionS).toBeNull()
    expect(s.dayKey).toBeNull()
    expect(s.nutritionWindow).toEqual([{ ageS: 10, amount: 4 }])
    expect(sanitizeNeedsState(null, N)).toEqual(freshNeedsState(N))
  })
})
