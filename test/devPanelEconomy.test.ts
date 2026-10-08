import { describe, expect, it } from 'vitest'
import { CURRENCIES, DEV_INJECTS, isDevInject, type EconomySnapshot } from '../src/shared/economy'
import {
  breakInject,
  ECONOMY_COLUMNS,
  ECONOMY_INJECTS,
  economyDetails,
  economyRows,
  formatNumber,
  INPUT_OFF_TEXT,
  isEconomySnapshot,
  NONE,
} from '../src/renderer/devpanel/economyView'

// The developer panel's Economy section (src/renderer/devpanel/economyView.ts): what it accepts from main, the text of
// the currency table and the status lines, and the injects its buttons send.

const today = (over: Partial<EconomySnapshot['currencies']['crumbs']> = {}): EconomySnapshot['currencies']['crumbs'] => ({
  raw: 0,
  credited: 0,
  earned: 0,
  multiplier: 1,
  softCap: 100,
  lifetime: 0,
  wallet: 0,
  ...over,
})

const SNAPSHOT: EconomySnapshot = {
  day: '2026-10-08',
  currencies: {
    crumbs: today({ raw: 12_345, credited: 12_001.25, earned: 240.02, multiplier: 0.73529, softCap: 400, lifetime: 12_345.678 }),
    pellets: today({ raw: 310, credited: 300, earned: 30, multiplier: 0.9615, softCap: 150 }),
    treats: today({ raw: 7, credited: 6, earned: 6.25, softCap: 25 }),
    mileage: today({ raw: 110_000, credited: 100_000, earned: 20, softCap: 60 }),
    sparks: today({ raw: 4, credited: 4, earned: 4, softCap: null, lifetime: 9 }),
  },
  sparksToday: { morningWake: 3, welcomeBack: 1, healthySession: 0, streak: 0, neglect: 0 },
  diet: { crumbs: 0.4, pellets: 0.3, treats: 0.1, mileage: 0.2 },
  rhythm: 2.5,
  nutritionLifetime: 1234.56,
  inputCounting: true,
}

describe('isEconomySnapshot', () => {
  it('accepts a whole snapshot (also one round-tripped through JSON, as IPC does)', () => {
    expect(isEconomySnapshot(SNAPSHOT)).toBe(true)
    expect(isEconomySnapshot(JSON.parse(JSON.stringify(SNAPSHOT)))).toBe(true)
  })

  it('rejects a missing currency, spark source or diet share', () => {
    const { treats: _t, ...currencies } = SNAPSHOT.currencies
    expect(isEconomySnapshot({ ...SNAPSHOT, currencies })).toBe(false)
    const { streak: _s, ...sparksToday } = SNAPSHOT.sparksToday
    expect(isEconomySnapshot({ ...SNAPSHOT, sparksToday })).toBe(false)
    const { mileage: _m, ...diet } = SNAPSHOT.diet
    expect(isEconomySnapshot({ ...SNAPSHOT, diet })).toBe(false)
  })

  it('rejects bad numbers and fields', () => {
    const bad = (currency: Partial<EconomySnapshot['currencies']['crumbs']>): unknown => ({
      ...SNAPSHOT,
      currencies: { ...SNAPSHOT.currencies, crumbs: { ...SNAPSHOT.currencies.crumbs, ...currency } },
    })
    expect(isEconomySnapshot(bad({ raw: -1 }))).toBe(false)
    expect(isEconomySnapshot(bad({ earned: Number.NaN }))).toBe(false)
    expect(isEconomySnapshot(bad({ softCap: 0 }))).toBe(false)
    expect(isEconomySnapshot({ ...SNAPSHOT, diet: { ...SNAPSHOT.diet, crumbs: 1.5 } })).toBe(false)
    expect(isEconomySnapshot({ ...SNAPSHOT, inputCounting: 'yes' })).toBe(false)
    expect(isEconomySnapshot({ ...SNAPSHOT, day: 20261008 })).toBe(false)
    for (const value of [null, undefined, [], 'economy', 3]) expect(isEconomySnapshot(value)).toBe(false)
  })
})

describe('formatNumber', () => {
  it('separates thousands and shows exactly the decimals asked for', () => {
    expect(formatNumber(12_345.678, 2)).toBe('12,345.68')
    expect(formatNumber(12_345.678, 0)).toBe('12,346')
    expect(formatNumber(0.5, 1)).toBe('0.5')
    expect(formatNumber(3, 2)).toBe('3.00')
  })

  it('never shows "-0", and NONE for a non-number', () => {
    expect(formatNumber(-0.0001, 2)).toBe('0.00')
    expect(formatNumber(-0, 0)).toBe('0')
    expect(formatNumber(Number.NaN, 2)).toBe(NONE)
    expect(formatNumber(Number.POSITIVE_INFINITY, 0)).toBe(NONE)
  })
})

describe('economyRows', () => {
  it('one row per currency in CURRENCIES order, one cell per column', () => {
    const rows = economyRows(SNAPSHOT)
    expect(rows.map((r) => r.currency)).toEqual([...CURRENCIES])
    for (const row of rows) expect(row.cells).toHaveLength(ECONOMY_COLUMNS.length)
  })

  it('raw, credited, earned, ×multiplier (2 decimals), soft-cap progress, lifetime, wallet', () => {
    const [crumbs, , , , sparks] = economyRows(SNAPSHOT)
    expect(crumbs?.cells).toEqual(['12,345', '12,001.3', '240.02', '×0.74', '60%', '12,345.68', '0.00'])
    // Sparks have no soft cap.
    expect(sparks?.cells).toEqual(['4', '4.0', '4.00', '×1.00', NONE, '9.00', '0.00'])
  })

  it('every cell NONE before the economy starts', () => {
    const rows = economyRows(null)
    expect(rows.map((r) => r.currency)).toEqual([...CURRENCIES])
    for (const row of rows) expect(row.cells).toEqual(ECONOMY_COLUMNS.map(() => NONE))
  })
})

describe('economyDetails', () => {
  it('diet shares as %, rhythm, nutrition, sparks today per source', () => {
    const d = economyDetails(SNAPSHOT)
    expect(d.day).toBe('2026-10-08')
    expect(d.diet).toBe('crumbs 40% · pellets 30% · treats 10% · mileage 20%')
    expect(d.rhythm).toBe('2.50 sparks/day')
    expect(d.nutrition).toBe('1,234.6 lifetime')
    expect(d.sparks).toBe('morning wake 3 · welcome back 1 · healthy session 0 · streak 0 · after neglect 0')
    expect(d.inputOff).toBe(false)
  })

  it("says keys, clicks and scrolls aren't counted without Input Monitoring", () => {
    const d = economyDetails({ ...SNAPSHOT, inputCounting: false })
    expect(d.input).toBe(INPUT_OFF_TEXT)
    expect(d.inputOff).toBe(true)
  })

  it('NONE everywhere before the economy starts', () => {
    expect(economyDetails(null)).toEqual({ day: NONE, diet: NONE, rhythm: NONE, nutrition: NONE, sparks: NONE, input: NONE, inputOff: false })
  })
})

describe('the inject buttons', () => {
  it('send a valid DevInject for every kind but break, with the default amount', () => {
    for (const [, inject] of ECONOMY_INJECTS) {
      expect(isDevInject(inject)).toBe(true)
      expect(inject.amount).toBeUndefined()
    }
    expect(ECONOMY_INJECTS.map(([, inject]) => inject.kind)).toEqual(DEV_INJECTS.filter((k) => k !== 'break'))
    expect(new Set(ECONOMY_INJECTS.map(([id]) => id)).size).toBe(ECONOMY_INJECTS.length)
  })

  it('Break sends its minutes; nothing for a length main would refuse', () => {
    expect(breakInject(10)).toEqual({ kind: 'break', amount: 10 })
    expect(breakInject(2.5)).toEqual({ kind: 'break', amount: 2.5 })
    for (const minutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000]) expect(breakInject(minutes)).toBeNull()
  })
})
