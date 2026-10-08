import { describe, expect, it } from 'vitest'
import { payout, safeStuffedFactor, softCapMultiplier } from '../src/main/economy/curves'
import { tuning } from '../src/shared/tuning'

// Daily diminishing returns (src/main/economy/curves.ts, BITBOT_SPEC.md §7.4) and the stuffed factor (§9.3). Day
// rollover and the DST edge are in economyDays.test.ts (and the ledger's rollover in ledger.test.ts / economy.test.ts).

const S = tuning.economy.softCaps

describe('softCapMultiplier', () => {
  it('is 1 / (1 + (earnedToday / S)²)', () => {
    expect(softCapMultiplier(0, 400)).toBe(1)
    expect(softCapMultiplier(400, 400)).toBeCloseTo(0.5, 12)
    expect(softCapMultiplier(800, 400)).toBeCloseTo(0.2, 12)
    expect(softCapMultiplier(200, 400)).toBeCloseTo(0.8, 12)
    expect(softCapMultiplier(1200, 400)).toBeCloseTo(0.1, 12)
  })

  it('falls monotonically as the day goes on', () => {
    let prev = 2
    for (let e = 0; e <= 1000; e += 25) {
      const m = softCapMultiplier(e, S.pellets)
      expect(m).toBeLessThan(prev)
      expect(m).toBeGreaterThan(0)
      prev = m
    }
  })

  it('is 1 without a soft cap (sparks)', () => {
    expect(softCapMultiplier(1000, null)).toBe(1)
  })
})

describe('payout', () => {
  it('base × units × multiplier × stuffedFactor', () => {
    expect(payout(0.02, 1, 0, S.crumbs, 1)).toBeCloseTo(0.02, 12)
    expect(payout(0.1, 3, 150, 150, 1)).toBeCloseTo(0.15, 12)
    expect(payout(1, 1, 0, 25, 1)).toBe(1)
  })

  it('the stuffed factor halves every payout (§9.3)', () => {
    expect(payout(0.02, 1, 0, S.crumbs, 0.5)).toBeCloseTo(0.01, 12)
    expect(payout(5, 1, 25, 25, 0.5)).toBeCloseTo(1.25, 12)
  })

  it('a bad stuffed factor counts as 1 (never NaN or more than the full payout)', () => {
    expect(safeStuffedFactor(NaN)).toBe(1)
    expect(safeStuffedFactor(2)).toBe(1)
    expect(safeStuffedFactor(-1)).toBe(1)
    expect(safeStuffedFactor(0.5)).toBe(0.5)
    expect(payout(1, 1, 0, 25, NaN)).toBe(1)
  })

  it('a day of steady work lands near the soft cap, and twice the work earns much less than twice as much', () => {
    // Pay one key at a time, as Economy does.
    const day = (keys: number): number => {
      let earned = 0
      for (let i = 0; i < keys; i++) earned += payout(tuning.economy.base.crumbsPerKey, 1, earned, S.crumbs, 1)
      return earned
    }
    const ordinary = day(25_000) // 500 crumbs of base value
    const double = day(50_000)
    expect(ordinary).toBeGreaterThan(S.crumbs * 0.75)
    expect(ordinary).toBeLessThan(S.crumbs * 1.25)
    expect(double / ordinary).toBeLessThan(1.6)
    // The continuous solution of dE/du = b / (1 + (E/S)²): E + E³ / 3S² = b·u.
    const e = ordinary
    expect(e + (e * e * e) / (3 * S.crumbs * S.crumbs)).toBeCloseTo(500, 0)
  })
})
