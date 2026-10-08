import { describe, expect, it } from 'vitest'
import { Economy, type EconomyState, type EconomyTuning } from '../src/main/economy/economy'
import { CURRENCIES, SPARK_SOURCES, type EconomySnapshot } from '../src/shared/economy'
import { tuning } from '../src/shared/tuning'

// The economy (src/main/economy/economy.ts, BITBOT_SPEC.md §7): activity in, currencies, sparks, diet and events out;
// the §13 acceptance item "holding a key, hammering one key, an auto-clicker, and a mouse jiggler all earn little or
// nothing"; the 4 AM rollover in a zone; the dev panel's injections; the saved state (counts only, §2).

const E = tuning.economy
const LA = 'America/Los_Angeles'
const MIN = 60_000
const HOUR = 60 * MIN
/** 2026-10-08 09:00 PDT. */
const T0 = Date.parse('2026-10-08T16:00:00Z')

class Clock {
  constructor(public t = T0) {}
  now(): number {
    return this.t
  }
}

function make(opts: { t?: number; state?: EconomyState; stuffed?: () => number; tuning?: EconomyTuning } = {}) {
  const clock = new Clock(opts.t)
  const eco = new Economy({ clock, timeZone: LA, state: opts.state, stuffedFactor: opts.stuffed, tuning: opts.tuning })
  eco.setInputCounting(true)
  return { clock, eco }
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Varied human typing: n keys, 80–330 ms apart, random codes. */
function typeHuman(clock: Clock, eco: Economy, n: number, seed = 1): void {
  const r = rng(seed)
  for (let i = 0; i < n; i++) {
    clock.t += 80 + 250 * r()
    const code = Math.floor(r() * 40)
    eco.key(code, true, false)
    eco.key(code, false, false)
  }
}

const cur = (s: EconomySnapshot, c: keyof EconomySnapshot['currencies']) => s.currencies[c]

describe('§13 acceptance: gaming earns little or nothing', () => {
  const N = 2000

  it('baseline: varied human typing credits every key', () => {
    const { clock, eco } = make()
    typeHuman(clock, eco, N)
    const c = cur(eco.snapshot(), 'crumbs')
    expect(c.raw).toBe(N)
    expect(c.credited).toBe(N)
    expect(c.earned).toBeGreaterThan(N * E.base.crumbsPerKey * 0.95)
  })

  it('holding a key earns one key', () => {
    const { clock, eco } = make()
    eco.key(0, true, false)
    for (let i = 0; i < N; i++) {
      clock.t += 33
      eco.key(0, true, true) // auto-repeat
    }
    eco.key(0, false, false)
    const c = cur(eco.snapshot(), 'crumbs')
    expect(c.raw).toBe(N + 1)
    expect(c.credited).toBe(1)
  })

  it('holding a key without the repeat flag (only keydowns, no keyup) earns one key', () => {
    const { clock, eco } = make()
    for (let i = 0; i < N; i++) {
      clock.t += 33 + (i % 7) * 20
      eco.key(0, true, false)
    }
    expect(cur(eco.snapshot(), 'crumbs').credited).toBe(1)
  })

  it('hammering one key earns little (under 15% of typing the same number of keys)', () => {
    const { clock, eco } = make()
    const r = rng(3)
    for (let i = 0; i < N; i++) {
      clock.t += 80 + 250 * r()
      eco.key(51, true, false)
      eco.key(51, false, false)
    }
    const c = cur(eco.snapshot(), 'crumbs')
    expect(c.raw).toBe(N)
    expect(c.credited).toBeLessThan(N * 0.15)
  })

  it('an auto-clicker earns almost nothing (at most the 30 clicks before its timing is known)', () => {
    const { clock, eco } = make()
    for (let i = 0; i < N; i++) {
      clock.t += 100
      eco.click(0)
    }
    const p = cur(eco.snapshot(), 'pellets')
    expect(p.raw).toBe(N)
    expect(p.credited).toBeLessThanOrEqual(30)
    expect(p.earned).toBeLessThanOrEqual(30 * E.base.pelletsPerClick)
  })

  it('an auto-clicker with a little jitter is still robotic', () => {
    const { clock, eco } = make()
    const r = rng(5)
    for (let i = 0; i < N; i++) {
      clock.t += 200 + (r() - 0.5) * 20 // ±10 ms: CV ≈ 0.03
      eco.click(0)
    }
    expect(cur(eco.snapshot(), 'pellets').credited).toBeLessThanOrEqual(30)
  })

  it('a mouse jiggler earns nothing', () => {
    const { clock, eco } = make()
    const step = 1000 / E.cursorPollHz
    for (let i = 0; i < 20 * 3600; i++) {
      clock.t += step
      eco.cursor(700 + (i % 2) * 10, 400 + (i % 3) * 6)
    }
    const m = cur(eco.snapshot(), 'mileage')
    expect(m.raw).toBeGreaterThan(50_000)
    expect(m.credited).toBe(0)
    expect(m.earned).toBe(0)
  })

  it('real mouse travel earns mileage: 5,000 pt ≈ 1', () => {
    const { clock, eco } = make()
    const step = 1000 / E.cursorPollHz
    for (let i = 1; i <= 500; i++) {
      clock.t += step
      eco.cursor(i % 100 < 50 ? (i % 50) * 20 : 1000 - (i % 50) * 20, 300)
    }
    const m = cur(eco.snapshot(), 'mileage')
    expect(m.credited).toBeGreaterThan(9000)
    expect(m.earned).toBeCloseTo(m.credited * E.base.mileagePerPt, 2)
  })
})

describe('currencies', () => {
  it('clicks and scroll ticks feed pellets', () => {
    const { clock, eco } = make()
    const r = rng(9)
    for (let i = 0; i < 10; i++) {
      clock.t += 400 + 900 * r()
      eco.click(i % 3)
    }
    clock.t += 2000
    eco.scroll({ lines: -3, px: -30, linesX: 0, pxX: 0, continuous: false, momentum: false })
    clock.t += 2000
    eco.scroll({ lines: 0, px: E.scroll.tickPt * 2, linesX: 0, pxX: 0, continuous: true, momentum: false })
    eco.scroll({ lines: 0, px: 900, linesX: 0, pxX: 0, continuous: true, momentum: true })
    const p = cur(eco.snapshot(), 'pellets')
    expect(p.raw).toBe(15)
    expect(p.credited).toBe(15)
    expect(p.earned).toBeCloseTo(10 * E.base.pelletsPerClick + 5 * E.base.pelletsPerScrollTick, 3)
  })

  it('keys, clicks and scrolls count only while input counting is on (the default is off)', () => {
    const clock = new Clock()
    const eco = new Economy({ clock, timeZone: LA })
    expect(eco.snapshot().inputCounting).toBe(false)
    typeHuman(clock, eco, 50)
    eco.click(0)
    eco.scroll({ lines: 3, px: 30, linesX: 0, pxX: 0, continuous: false, momentum: false })
    let s = eco.snapshot()
    expect(cur(s, 'crumbs').raw + cur(s, 'pellets').raw).toBe(0)
    // Mileage and treats need no permission.
    eco.appLaunched('com.example.editor')
    expect(cur(eco.snapshot(), 'treats').earned).toBe(E.base.treatsLaunchFirstEver)
    eco.setInputCounting(true)
    typeHuman(clock, eco, 50)
    s = eco.snapshot()
    expect(s.inputCounting).toBe(true)
    expect(cur(s, 'crumbs').credited).toBe(50)
  })

  it('treats: first-ever, plain, returning after 7 days; relaunches within the hour and activation flapping give nothing', () => {
    const { clock, eco } = make()
    eco.appLaunched('com.example.mail')
    expect(cur(eco.snapshot(), 'treats').earned).toBe(5)
    expect(eco.state.economy.knownBundleIds['com.example.mail']).toBe(new Date(clock.t).toISOString())
    clock.t += 10 * MIN
    eco.appLaunched('com.example.mail')
    eco.appActivated('com.example.mail')
    expect(cur(eco.snapshot(), 'treats').raw).toBe(3)
    expect(cur(eco.snapshot(), 'treats').credited).toBe(2) // the launch and the activation (10 min after the launch)
    clock.t += 2 * MIN
    eco.appActivated('com.example.mail')
    expect(cur(eco.snapshot(), 'treats').credited).toBe(2)
    clock.t += HOUR
    eco.appLaunched('com.example.mail')
    const t = cur(eco.snapshot(), 'treats')
    expect(t.credited).toBe(3)
    // A week later (a new day: today's totals are fresh), it's returning.
    clock.t += 8 * 24 * HOUR
    eco.appLaunched('com.example.mail')
    expect(cur(eco.snapshot(), 'treats').earned).toBe(E.base.treatsLaunchReturning)
  })

  it('an activation of an app never launched is credited but not recorded, so its first launch is still first-ever', () => {
    const { clock, eco } = make()
    eco.appActivated('com.example.chat')
    expect(eco.state.economy.knownBundleIds).toEqual({})
    clock.t += HOUR
    eco.appLaunched('com.example.chat')
    expect(cur(eco.snapshot(), 'treats').earned).toBeCloseTo(0.25 + 5 * (1 / (1 + (0.25 / 25) ** 2)), 9)
  })

  it('the soft cap: the multiplier falls with the day’s earnings, the stuffed factor halves it', () => {
    let stuffed = 1
    const { eco } = make({ stuffed: () => stuffed })
    expect(cur(eco.snapshot(), 'pellets').multiplier).toBe(1)
    eco.inject({ kind: 'clicks', amount: 1500 }) // 150 base
    const p = cur(eco.snapshot(), 'pellets')
    expect(p.earned).toBeLessThan(150)
    expect(p.multiplier).toBeCloseTo(1 / (1 + (p.earned / E.softCaps.pellets) ** 2), 12)
    expect(p.softCap).toBe(E.softCaps.pellets)
    stuffed = 0.5
    expect(cur(eco.snapshot(), 'pellets').multiplier).toBeCloseTo(p.multiplier / 2, 12)
    const before = cur(eco.snapshot(), 'crumbs').earned
    eco.inject({ kind: 'keys', amount: 1 })
    expect(cur(eco.snapshot(), 'crumbs').earned - before).toBeCloseTo(E.base.crumbsPerKey / 2, 12)
    // Sparks: no curve, no stuffed factor.
    expect(cur(eco.snapshot(), 'sparks')).toMatchObject({ multiplier: 1, softCap: null })
  })
})

describe('sparks and events', () => {
  it('a wake gives the morning wake and the streak once a day, as events and in the ledger', () => {
    const { clock, eco } = make()
    eco.wake()
    expect(eco.drainEvents()).toEqual([
      { kind: 'spark', source: 'morningWake', amount: 3 },
      { kind: 'spark', source: 'streak', amount: 1 },
    ])
    expect(eco.drainEvents()).toEqual([])
    clock.t += MIN
    eco.wake()
    expect(eco.drainEvents()).toEqual([])
    const s = eco.snapshot()
    expect(s.sparksToday).toEqual({ morningWake: 3, welcomeBack: 0, healthySession: 0, streak: 1, neglect: 0 })
    expect(cur(s, 'sparks')).toMatchObject({ raw: 2, credited: 4, earned: 4, lifetime: 4 })
    expect(s.nutritionLifetime).toBe(4 * E.nutritionWeights.sparks)
  })

  it('a healthy session and a break, from idle samples', () => {
    const { clock, eco } = make()
    for (let t = 0; t < 30 * MIN; t += 5000) {
      clock.t += 5000
      eco.idle(1)
    }
    for (let idle = 5; idle <= 8 * 60; idle += 5) {
      clock.t += 5000
      eco.idle(idle)
    }
    expect(eco.state.rhythm.continuousActiveMs).toBe(0)
    clock.t += 5000
    eco.idle(0.5)
    expect(eco.drainEvents()).toEqual([
      { kind: 'spark', source: 'welcomeBack', amount: 1 },
      { kind: 'spark', source: 'healthySession', amount: 1 },
    ])
  })

  it('a return after neglect: sparks and a returnAfterNeglect event for M6', () => {
    const { clock, eco } = make()
    eco.wake()
    eco.drainEvents()
    clock.t += 3 * 24 * HOUR
    eco.wake()
    const ev = eco.drainEvents()
    expect(ev).toContainEqual({ kind: 'returnAfterNeglect', days: 3 })
    expect(ev).toContainEqual({ kind: 'spark', source: 'neglect', amount: E.sparks.neglect.value })
    // A new streak (days were missed).
    expect(ev).toContainEqual({ kind: 'spark', source: 'streak', amount: 1 })
  })
})

describe('the day (4 AM rollover, local)', () => {
  it('rolls over at 4:00 AM: totals to history, today and buckets reset, sparksToday reset', () => {
    // 2026-10-08 23:00 PDT
    const { clock, eco } = make({ t: Date.parse('2026-10-09T06:00:00Z') })
    eco.wake()
    eco.inject({ kind: 'keys', amount: 100 })
    clock.t += 3 * HOUR + 30 * MIN // 02:30: still the 8th
    eco.inject({ kind: 'keys', amount: 100 })
    let s = eco.snapshot()
    expect(s.day).toBe('2026-10-08')
    expect(cur(s, 'crumbs').credited).toBe(200)
    const hourly = eco.state.economy.perCurrency.crumbs.todayHourly
    expect(hourly[23]).toBeCloseTo(2, 2)
    expect(hourly[2]).toBeGreaterThan(1.9)
    const earned = cur(s, 'crumbs').earned
    clock.t += 90 * MIN // 04:00
    s = eco.snapshot()
    expect(s.day).toBe('2026-10-09')
    expect(cur(s, 'crumbs')).toMatchObject({ raw: 0, credited: 0, earned: 0, multiplier: 1 })
    expect(cur(s, 'crumbs').lifetime).toBeCloseTo(earned, 12)
    expect(s.sparksToday).toEqual({ morningWake: 0, welcomeBack: 0, healthySession: 0, streak: 0, neglect: 0 })
    const st = eco.state
    expect(st.economy.currentDay).toBe('2026-10-09')
    expect(st.economy.perCurrency.crumbs.dailyHistory).toEqual([{ day: '2026-10-08', earned }])
    expect(st.economy.perCurrency.crumbs.todayHourly.every((x) => x === 0)).toBe(true)
    // The diet still sees yesterday.
    expect(s.diet.crumbs).toBe(1)
    // The morning wake is due again.
    eco.wake()
    expect(eco.drainEvents()).toContainEqual({ kind: 'spark', source: 'morningWake', amount: 3 })
  })

  it('the DST spring-forward night: 3:30 PDT is still the previous day, 4:00 PDT the new one', () => {
    const { clock, eco } = make({ t: Date.parse('2026-03-08T10:30:00Z') })
    expect(eco.snapshot().day).toBe('2026-03-07')
    clock.t = Date.parse('2026-03-08T11:00:00Z')
    expect(eco.snapshot().day).toBe('2026-03-08')
  })

  it('a clock moved back to an earlier day keeps booking to the current day', () => {
    const { clock, eco } = make()
    clock.t -= 24 * HOUR
    eco.inject({ kind: 'keys', amount: 10 })
    expect(eco.snapshot().day).toBe('2026-10-08')
    expect(cur(eco.snapshot(), 'crumbs').credited).toBe(10)
  })
})

describe('dev panel injections (§14.1)', () => {
  it('keys ×100, clicks ×20, scroll ×50 ticks, mileage +5,000 pt by default, all fully credited', () => {
    const { eco } = make()
    eco.inject({ kind: 'keys' })
    eco.inject({ kind: 'clicks' })
    eco.inject({ kind: 'scroll' })
    eco.inject({ kind: 'mileage' })
    const s = eco.snapshot()
    expect(cur(s, 'crumbs')).toMatchObject({ raw: 100, credited: 100 })
    expect(cur(s, 'pellets')).toMatchObject({ raw: 70, credited: 70 })
    expect(cur(s, 'mileage')).toMatchObject({ raw: 5000, credited: 5000 })
    expect(cur(s, 'mileage').earned).toBeCloseTo(1, 12)
    expect(cur(s, 'crumbs').earned).toBeCloseTo(2, 2)
    expect(cur(s, 'pellets').earned).toBeCloseTo(3, 1)
  })

  it('injections work without input counting', () => {
    const eco = new Economy({ clock: new Clock(), timeZone: LA })
    eco.inject({ kind: 'keys', amount: 5 })
    expect(cur(eco.snapshot(), 'crumbs').credited).toBe(5)
  })

  it('launchNew, launchReturning, activate: the treat values, without inventing bundle IDs', () => {
    const { eco } = make()
    eco.inject({ kind: 'launchNew' })
    expect(cur(eco.snapshot(), 'treats').earned).toBe(5)
    eco.inject({ kind: 'launchReturning' })
    eco.inject({ kind: 'activate' })
    const t = cur(eco.snapshot(), 'treats')
    expect(t.credited).toBe(3)
    expect(t.earned).toBeGreaterThan(7)
    expect(t.earned).toBeLessThan(7.25)
    expect(eco.state.economy.knownBundleIds).toEqual({})
  })

  it('wake and break', () => {
    const { clock, eco } = make()
    eco.inject({ kind: 'wake' })
    expect(eco.drainEvents().map((e) => (e.kind === 'spark' ? e.source : e.kind))).toEqual(['morningWake', 'streak'])
    for (let t = 0; t < 26 * MIN; t += 5000) {
      clock.t += 5000
      eco.idle(2)
    }
    eco.inject({ kind: 'break' }) // default length: 10 min
    expect(eco.drainEvents()).toEqual([
      { kind: 'spark', source: 'welcomeBack', amount: 1 },
      { kind: 'spark', source: 'healthySession', amount: 1 },
    ])
    eco.inject({ kind: 'break', amount: 2 }) // too short
    expect(eco.drainEvents()).toEqual([])
    eco.inject({ kind: 'break', amount: 5 * 60 }) // 5 h: past welcome back's 4 h
    expect(eco.drainEvents()).toEqual([])
  })
})

describe('the saved state (§16, §2)', () => {
  it('is plain JSON, has §16’s economy and rhythm fields, and continues where it left off', () => {
    const { clock, eco } = make()
    eco.wake()
    typeHuman(clock, eco, 300)
    eco.appLaunched('com.example.editor')
    eco.inject({ kind: 'mileage' })
    const st = eco.state
    expect(JSON.parse(JSON.stringify(st))).toEqual(st)
    expect(Object.keys(st.economy).sort()).toEqual(
      ['currentDay', 'evolutionProgress', 'knownBundleIds', 'nutritionLifetime', 'perCurrency'].sort(),
    )
    for (const c of CURRENCIES) {
      expect(Object.keys(st.economy.perCurrency[c]).sort()).toEqual(
        ['dailyHistory', 'lifetimeEarned', 'today', 'todayCredited', 'todayHourly', 'todayRaw', 'wallet'].sort(),
      )
    }
    expect(Object.keys(st.rhythm).sort()).toEqual(
      [
        'continuousActiveMs',
        'lastActiveAt',
        'lastBreakAt',
        'lastStreakDay',
        'sessionBeforeBreakMs',
        'sparksToday',
        'streakDays',
      ].sort(),
    )
    expect(Object.keys(st.rhythm.sparksToday).sort()).toEqual([...SPARK_SOURCES].sort())

    // Continue from it: same snapshot, and today's first wake already happened.
    const again = new Economy({ clock, timeZone: LA, state: st })
    again.setInputCounting(true)
    expect(again.snapshot()).toEqual(eco.snapshot())
    again.wake()
    expect(again.drainEvents()).toEqual([])
    // The state given is copied, not kept.
    again.inject({ kind: 'keys' })
    expect(st.economy.perCurrency.crumbs.todayRaw).toBe(300)
  })

  it('never contains key codes, buttons, timing traces or positions', () => {
    const { clock, eco } = make()
    const KEY = 48_611 // codes that would stand out in the JSON
    const BUTTON = 37_219
    const X = 91_234.5
    const Y = 87_654.25
    const r = rng(12)
    for (let i = 0; i < 200; i++) {
      clock.t += 80 + 250 * r()
      eco.key(KEY + (i % 3), true, false)
      eco.key(KEY + (i % 3), false, false)
      if (i % 10 === 0) eco.click(BUTTON)
      eco.cursor(X + i * 13, Y - i * 7)
    }
    eco.key(KEY + 9, true, false) // held at save time
    const json = JSON.stringify(eco.state)
    for (const needle of [KEY, KEY + 1, KEY + 2, KEY + 9, BUTTON, X, Y, Math.floor(X), Math.floor(Y)]) {
      expect(json).not.toContain(String(needle))
    }
    // No arrays but the 24 hourly buckets and the daily history.
    const arrays: string[] = []
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) arrays.push(path.replace(/\.(crumbs|pellets|treats|mileage|sparks)\./, '.*.'))
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!Array.isArray(v)) walk(x, `${path}.${k}`)
    }
    walk(eco.state, '')
    expect([...new Set(arrays)].sort()).toEqual(['.economy.perCurrency.*.dailyHistory', '.economy.perCurrency.*.todayHourly'])
  })
})

describe('snapshot', () => {
  it('is JSON-safe and complete before anything happens', () => {
    const { eco } = make()
    const s = eco.snapshot()
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    expect(s.day).toBe('2026-10-08')
    expect(Object.keys(s.currencies).sort()).toEqual([...CURRENCIES].sort())
    expect(s.diet).toEqual({ crumbs: 0, pellets: 0, treats: 0, mileage: 0 })
    expect(s.rhythm).toBe(0)
    for (const c of CURRENCIES) expect(s.currencies[c]).toMatchObject({ raw: 0, credited: 0, earned: 0, multiplier: 1, wallet: 0 })
  })

  it('the diet and rhythm reflect what was earned', () => {
    const { eco } = make()
    eco.wake()
    eco.inject({ kind: 'mileage', amount: 5000 })
    eco.inject({ kind: 'launchNew' })
    const s = eco.snapshot()
    expect(s.diet.mileage + s.diet.treats).toBeCloseTo(1, 12)
    expect(s.diet.treats).toBeGreaterThan(0.8)
    expect(s.rhythm).toBe(4)
  })

  it('a NaN stuffed factor never reaches the snapshot', () => {
    const { eco } = make({ stuffed: () => NaN })
    eco.inject({ kind: 'keys' })
    const s = eco.snapshot()
    expect(Number.isFinite(cur(s, 'crumbs').multiplier)).toBe(true)
    expect(Number.isFinite(cur(s, 'crumbs').earned)).toBe(true)
  })
})
