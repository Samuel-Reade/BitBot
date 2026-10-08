import { describe, expect, it } from 'vitest'
import { addDays } from '../src/main/economy/days'
import {
  addPayout,
  addUnits,
  dietVector,
  earnedInWindow,
  freshLedger,
  rhythmScore,
  rollDay,
  type LedgerState,
} from '../src/main/economy/ledger'
import { CURRENCIES } from '../src/shared/economy'
import { tuning } from '../src/shared/tuning'

// The ledger (src/main/economy/ledger.ts, BITBOT_SPEC.md §7.5, §16): hourly buckets, the rolling 60 days, the diet
// vector, the rhythm score, nutrition weights.

const E = tuning.economy
const W = E.nutritionWeights
const D0 = '2026-10-08'

/** Rolls `ledger` forward one day at a time, n times. */
function advance(ledger: LedgerState, n: number): void {
  for (let i = 0; i < n; i++) rollDay(ledger, addDays(ledger.currentDay, 1), E.historyDays)
}

describe('freshLedger', () => {
  it('has §16’s shape: every currency, 24 hourly buckets, no history, empty wallet', () => {
    const l = freshLedger(D0)
    expect(Object.keys(l.perCurrency).sort()).toEqual([...CURRENCIES].sort())
    for (const c of CURRENCIES) {
      const p = l.perCurrency[c]
      expect(p.todayHourly).toHaveLength(24)
      expect(p.todayHourly.every((x) => x === 0)).toBe(true)
      expect(p).toMatchObject({ lifetimeEarned: 0, today: 0, dailyHistory: [], wallet: 0, todayRaw: 0, todayCredited: 0 })
    }
    expect(l).toMatchObject({ nutritionLifetime: 0, evolutionProgress: 0, knownBundleIds: {}, currentDay: D0 })
    expect(JSON.parse(JSON.stringify(l))).toEqual(l)
  })
})

describe('payouts and buckets', () => {
  it('a payout adds to today, its hour’s bucket and the lifetime total', () => {
    const l = freshLedger(D0)
    addPayout(l, 'crumbs', 2, 9, W)
    addPayout(l, 'crumbs', 3, 9, W)
    addPayout(l, 'crumbs', 1, 2, W) // 2 AM: the late night of the same day
    const p = l.perCurrency.crumbs
    expect(p.today).toBe(6)
    expect(p.lifetimeEarned).toBe(6)
    expect(p.todayHourly[9]).toBe(5)
    expect(p.todayHourly[2]).toBe(1)
    expect(p.todayHourly.reduce((a, b) => a + b, 0)).toBe(6)
  })

  it('raw and credited units are counted separately from the payout', () => {
    const l = freshLedger(D0)
    addUnits(l, 'pellets', 10, 3)
    addUnits(l, 'pellets', 1, 0)
    expect(l.perCurrency.pellets).toMatchObject({ todayRaw: 11, todayCredited: 3, today: 0 })
  })

  it('nutrition = payout × weight (sparks 4)', () => {
    const l = freshLedger(D0)
    addPayout(l, 'crumbs', 1, 0, W)
    addPayout(l, 'pellets', 1, 0, W)
    addPayout(l, 'treats', 1, 0, W)
    addPayout(l, 'mileage', 1, 0, W)
    expect(l.nutritionLifetime).toBe(4)
    addPayout(l, 'sparks', 3, 0, W)
    expect(W.sparks).toBe(4)
    expect(l.nutritionLifetime).toBe(4 + 12)
  })

  it('zero or bad payouts change nothing', () => {
    const l = freshLedger(D0)
    addPayout(l, 'crumbs', 0, 5, W)
    addPayout(l, 'crumbs', NaN, 5, W)
    addPayout(l, 'crumbs', -1, 5, W)
    expect(l).toEqual(freshLedger(D0))
  })
})

describe('rollDay', () => {
  it('moves today into the history and resets today, the buckets and the unit counts', () => {
    const l = freshLedger(D0)
    addPayout(l, 'treats', 5, 10, W)
    addUnits(l, 'treats', 2, 1)
    rollDay(l, '2026-10-09', E.historyDays)
    const p = l.perCurrency.treats
    expect(l.currentDay).toBe('2026-10-09')
    expect(p.dailyHistory).toEqual([{ day: D0, earned: 5 }])
    expect(p).toMatchObject({ today: 0, todayRaw: 0, todayCredited: 0, lifetimeEarned: 5 })
    expect(p.todayHourly).toEqual(new Array(24).fill(0))
    expect(l.nutritionLifetime).toBe(5)
    // Every currency gets its entry, zero or not.
    expect(l.perCurrency.crumbs.dailyHistory).toEqual([{ day: D0, earned: 0 }])
  })

  it('keeps a rolling 60 days', () => {
    const l = freshLedger(D0)
    for (let i = 0; i < 75; i++) {
      addPayout(l, 'mileage', i + 1, 12, W)
      advance(l, 1)
    }
    const h = l.perCurrency.mileage.dailyHistory
    expect(h).toHaveLength(E.historyDays)
    expect(h[h.length - 1]).toEqual({ day: addDays(l.currentDay, -1), earned: 75 })
    expect(h[0]).toEqual({ day: addDays(l.currentDay, -E.historyDays), earned: 16 })
    expect(l.perCurrency.mileage.lifetimeEarned).toBe((75 * 76) / 2)
  })

  it('a gap of days drops what fell out of the window by date (days not run have no entry)', () => {
    const l = freshLedger(D0)
    addPayout(l, 'crumbs', 7, 12, W)
    rollDay(l, addDays(D0, 1), E.historyDays)
    addPayout(l, 'crumbs', 8, 12, W)
    rollDay(l, addDays(D0, 50), E.historyDays)
    expect(l.perCurrency.crumbs.dailyHistory.map((e) => e.day)).toEqual([D0, addDays(D0, 1)])
    rollDay(l, addDays(D0, 61), E.historyDays)
    // D0 is now 61 days back; D0+1 is 60: kept; D0+50 (zero) kept.
    expect(l.perCurrency.crumbs.dailyHistory.map((e) => e.day)).toEqual([addDays(D0, 1), addDays(D0, 50)])
  })
})

describe('diet vector', () => {
  it('is all 0 before anything is earned', () => {
    expect(dietVector(freshLedger(D0), E.diet.windowDays, W)).toEqual({ crumbs: 0, pellets: 0, treats: 0, mileage: 0 })
  })

  it('is each currency’s share of nutrition over the trailing 14 days, summing to 1 (sparks excluded)', () => {
    const l = freshLedger(D0)
    addPayout(l, 'crumbs', 30, 9, W)
    addPayout(l, 'pellets', 10, 9, W)
    advance(l, 1)
    addPayout(l, 'treats', 5, 9, W)
    addPayout(l, 'mileage', 5, 9, W)
    addPayout(l, 'sparks', 100, 9, W)
    const d = dietVector(l, E.diet.windowDays, W)
    expect(d.crumbs).toBeCloseTo(0.6, 12)
    expect(d.pellets).toBeCloseTo(0.2, 12)
    expect(d.treats).toBeCloseTo(0.1, 12)
    expect(d.mileage).toBeCloseTo(0.1, 12)
    expect(d.crumbs + d.pellets + d.treats + d.mileage).toBeCloseTo(1, 12)
  })

  it('days 14 or more back drop out of the window', () => {
    const l = freshLedger(D0)
    addPayout(l, 'crumbs', 100, 9, W)
    advance(l, 13)
    addPayout(l, 'pellets', 100, 9, W)
    expect(earnedInWindow(l, 'crumbs', 14)).toBe(100) // 13 days back: still in
    expect(dietVector(l, 14, W).crumbs).toBeCloseTo(0.5, 12)
    advance(l, 1)
    expect(earnedInWindow(l, 'crumbs', 14)).toBe(0)
    expect(dietVector(l, 14, W)).toEqual({ crumbs: 0, pellets: 1, treats: 0, mileage: 0 })
  })

  it('weights nutrition by the currency weights', () => {
    const l = freshLedger(D0)
    addPayout(l, 'crumbs', 10, 9, W)
    addPayout(l, 'pellets', 10, 9, W)
    const d = dietVector(l, 14, { ...W, crumbs: 3 })
    expect(d.crumbs).toBeCloseTo(0.75, 12)
  })
})

describe('rhythm score', () => {
  it('is sparks per day, over the days since the ledger began (at most the window)', () => {
    const l = freshLedger(D0)
    expect(rhythmScore(l, 14)).toBe(0)
    addPayout(l, 'sparks', 6, 9, W)
    expect(rhythmScore(l, 14)).toBe(6)
    advance(l, 1)
    addPayout(l, 'sparks', 2, 9, W)
    expect(rhythmScore(l, 14)).toBe(4)
    // Three days away (no entries) still count as days.
    rollDay(l, addDays(l.currentDay, 4), E.historyDays)
    expect(rhythmScore(l, 14)).toBeCloseTo(8 / 6, 12)
    advance(l, 30)
    expect(rhythmScore(l, 14)).toBe(0)
  })
})
