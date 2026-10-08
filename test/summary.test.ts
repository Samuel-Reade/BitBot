import { describe, expect, it } from 'vitest'
import { localDay } from '../src/main/economy/days'
import { addPayout, freshLedger, rollDay } from '../src/main/economy/ledger'
import {
  allTemplates,
  countPhrase,
  earnedPhrases,
  fillTemplate,
  joinList,
  ledgerDays,
  shouldShowSummary,
  summaryFor,
  summaryKind,
  type DayTotals,
  type SummaryLedger,
} from '../src/main/summary'
import { CURRENCIES } from '../src/shared/economy'
import { tuning } from '../src/shared/tuning'
import type { Currency } from '../src/shared/types'

// The daily summary's words and timing (src/main/summary.ts, BITBOT_SPEC.md §9.4).

const S = tuning.ui.summary
const ZERO: DayTotals = { crumbs: 0, pellets: 0, treats: 0, mileage: 0, sparks: 0 }
const SPEC_DAY: DayTotals = { crumbs: 11_240, pellets: 830, treats: 9, mileage: 41, sparks: 6 }

/** A ledger whose history holds `days` (day → totals) and whose current day is `currentDay` with `today`'s totals. */
function ledgerWith(days: Record<string, Partial<DayTotals>>, currentDay: string, today: Partial<DayTotals> = {}, extraLifetime = 0): SummaryLedger {
  const ordered = Object.keys(days).sort()
  const perCurrency = {} as SummaryLedger['perCurrency']
  for (const c of CURRENCIES) {
    const dailyHistory = ordered.map((day) => ({ day, earned: days[day]?.[c] ?? 0 }))
    const todayAmount = today[c] ?? 0
    const lifetimeEarned = dailyHistory.reduce((sum, e) => sum + e.earned, 0) + todayAmount + extraLifetime
    perCurrency[c] = { lifetimeEarned, today: todayAmount, dailyHistory }
  }
  return { perCurrency, currentDay }
}

/** Picks the first template of every kind. */
const first = (): number => 0

describe('summary words', () => {
  it('formats counts with thousands separators and singular units, rounded down', () => {
    expect(countPhrase('crumbs', 11_240)).toBe('11,240 crumbs')
    expect(countPhrase('crumbs', 1)).toBe('1 crumb')
    expect(countPhrase('treats', 1.9)).toBe('1 treat')
    expect(countPhrase('mileage', 41)).toBe('41 miles')
    expect(countPhrase('mileage', 1)).toBe('1 mile')
    expect(countPhrase('sparks', 1_234_567)).toBe('1,234,567 sparks')
  })

  it('joins lists with "and" and the serial comma (§9.4’s example)', () => {
    expect(joinList([])).toBe('')
    expect(joinList(['a'])).toBe('a')
    expect(joinList(['a', 'b'])).toBe('a and b')
    expect(joinList(['a', 'b', 'c'])).toBe('a, b, and c')
    expect(joinList(['11,240 crumbs', '830 pellets', '9 treats', '41 miles', '6 sparks'])).toBe(
      '11,240 crumbs, 830 pellets, 9 treats, 41 miles, and 6 sparks',
    )
  })

  it('skips currencies with less than one whole unit', () => {
    expect(earnedPhrases({ ...ZERO, crumbs: 1240, treats: 3, pellets: 0.6 })).toEqual(['1,240 crumbs', '3 treats'])
    expect(joinList(earnedPhrases({ ...ZERO, crumbs: 1240, treats: 3 }))).toBe('1,240 crumbs and 3 treats')
    expect(earnedPhrases(ZERO)).toEqual([])
  })

  it('fills placeholders and leaves unknown ones alone', () => {
    expect(fillTemplate('{When} I ate {list}. {nope}', { When: 'Yesterday', list: 'x' })).toBe('Yesterday I ate x. {nope}')
  })

  it('reproduces §9.4’s example line', () => {
    // Yesterday the spec's day, best of four days this week.
    const ledger = ledgerWith(
      { '2026-10-04': { crumbs: 5000 }, '2026-10-05': { crumbs: 6000 }, '2026-10-06': { crumbs: 7000 }, '2026-10-07': SPEC_DAY },
      '2026-10-08',
    )
    const s = summaryFor(ledger, '2026-10-08', first)
    expect(s).toEqual({
      day: '2026-10-07',
      shownFor: '2026-10-08',
      yesterday: true,
      kind: 'best',
      text: 'Yesterday I ate 11,240 crumbs, 830 pellets, 9 treats, 41 miles, and 6 sparks. Best day this week!',
    })
  })
})

describe('summary: never guilt-trippy (§9.4)', () => {
  const GUILT = ['only', 'should', 'just', 'less', 'lazy', 'fewer', 'disappoint', 'disappointed', 'disappointing', 'sad', 'worse', 'worst', 'not enough', 'too little', 'barely', 'must']
  const guilty = (text: string): string | null => {
    for (const word of GUILT) if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return word
    return null
  }

  it('no template uses a guilt word, and every one says something', () => {
    const templates = allTemplates()
    expect(templates.length).toBeGreaterThan(10)
    for (const t of templates) {
      expect(guilty(t), t).toBeNull()
      expect(t.trim().length, t).toBeGreaterThan(10)
    }
  })

  it('no generated line uses a guilt word or leaves a placeholder, over many random days', () => {
    let seed = 7
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647
      return (seed - 1) / 2147483646
    }
    const kinds = new Set<string>()
    for (let i = 0; i < 400; i++) {
      const days: Record<string, Partial<DayTotals>> = {}
      const count = Math.floor(rand() * 8)
      for (let back = 1; back <= count; back++) {
        if (rand() < 0.3) continue
        const day = `2026-10-${String(8 - back).padStart(2, '0')}`
        const pick = (max: number): number => (rand() < 0.25 ? 0 : Math.floor(rand() * max))
        days[day] = rand() < 0.1 ? {} : { crumbs: pick(15_000), pellets: pick(1500), treats: pick(12), mileage: pick(60), sparks: pick(rand() < 0.3 ? 2000 : 12) }
      }
      const s = summaryFor(ledgerWith(days, '2026-10-08', {}, rand() < 0.5 ? 100 : 0), '2026-10-08', rand)
      if (!s) continue
      kinds.add(s.kind)
      expect(guilty(s.text), s.text).toBeNull()
      expect(s.text, s.text).not.toMatch(/[{}]/)
      expect(s.text, s.text).not.toMatch(/\b0 \w/) // never "0 treats"
      expect(s.text, s.text).not.toMatch(/ ,|,,|: \.|  /)
    }
    expect([...kinds].sort()).toEqual(['best', 'first', 'normal', 'nothing', 'quiet', 'sparks'])
  })
})

describe('summary: which day and which kind', () => {
  it('nothing before today: no summary', () => {
    expect(summaryFor(ledgerWith({}, '2026-10-08', { crumbs: 500 }), '2026-10-08', first)).toBeNull()
  })

  it('reads yesterday from a ledger that has not rolled over yet (its current day is yesterday)', () => {
    const ledger = ledgerWith({}, '2026-10-07', { crumbs: 4000, pellets: 300 })
    const s = summaryFor(ledger, '2026-10-08', first)
    expect(s?.day).toBe('2026-10-07')
    expect(s?.yesterday).toBe(true)
    expect(s?.text).toContain('4,000 crumbs and 300 pellets')
  })

  it('reads the same yesterday from a rolled-over ledger, ignoring today’s totals', () => {
    const rolled = freshLedger('2026-10-07')
    addPayout(rolled, 'crumbs', 4000, 10, tuning.economy.nutritionWeights)
    addPayout(rolled, 'pellets', 300, 11, tuning.economy.nutritionWeights)
    rollDay(rolled, '2026-10-08', tuning.economy.historyDays)
    addPayout(rolled, 'crumbs', 99, 9, tuning.economy.nutritionWeights)
    const s = summaryFor(rolled, '2026-10-08', first)
    expect(s?.day).toBe('2026-10-07')
    expect(s?.text).toContain('4,000 crumbs and 300 pellets')
    expect(s?.text).not.toContain('99')
  })

  it('Bitbot did not run yesterday: "Last time…" for a day up to lastTimeMaxDays back, nothing beyond', () => {
    const ledger = ledgerWith({ '2026-10-01': { crumbs: 3000, pellets: 200 }, '2026-10-02': { crumbs: 2500, treats: 2 } }, '2026-10-08')
    const s = summaryFor(ledger, '2026-10-08', first)
    expect(s?.day).toBe('2026-10-02')
    expect(s?.yesterday).toBe(false)
    expect(s?.text).toMatch(/^Last time /)
    expect(s?.kind).not.toBe('best')
    const old = ledgerWith({ '2026-09-01': { crumbs: 3000 } }, '2026-10-08')
    expect(summaryFor(old, '2026-10-08', first)).toBeNull()
    const edge = ledgerWith({ [`2026-09-${30 - S.lastTimeMaxDays + 8}`]: { crumbs: 3000 } }, '2026-10-08')
    expect(summaryFor(edge, '2026-10-08', first)?.yesterday).toBe(false)
  })

  it('the first day Bitbot ever ran gets the first-day line; not when the lifetime says it ran before', () => {
    const ledger = ledgerWith({ '2026-10-07': { crumbs: 3000, pellets: 100 } }, '2026-10-08', { crumbs: 50 })
    expect(summaryFor(ledger, '2026-10-08', first)?.kind).toBe('first')
    expect(summaryFor(ledger, '2026-10-08', first)?.text).toBe('Our first day together! I ate 3,000 crumbs and 100 pellets.')
    // Earned on a day the 60-day history no longer has.
    const veteran = ledgerWith({ '2026-10-07': { crumbs: 3000, pellets: 100 } }, '2026-10-08', {}, 5000)
    expect(summaryFor(veteran, '2026-10-08', first)?.kind).toBe('normal')
    // An earlier day with nothing earned doesn't count as a first day.
    const zeroBefore = ledgerWith({ '2026-10-06': {}, '2026-10-07': { crumbs: 3000 } }, '2026-10-08')
    expect(summaryFor(zeroBefore, '2026-10-08', first)?.kind).toBe('first')
  })

  it('best day of the week: beats every other day in the 7 ending yesterday, with at least bestDayMinDays', () => {
    const week = { '2026-10-02': { crumbs: 9000 }, '2026-10-05': { crumbs: 4000 } }
    const best = ledgerWith({ ...week, '2026-10-07': { crumbs: 9500 } }, '2026-10-08', {}, 1)
    expect(summaryFor(best, '2026-10-08', first)?.kind).toBe('best')
    // A tie is not a best day.
    expect(summaryFor(ledgerWith({ ...week, '2026-10-07': { crumbs: 9000 } }, '2026-10-08', {}, 1), '2026-10-08', first)?.kind).toBe('normal')
    // A bigger day 7 days back is outside the window.
    const outside = ledgerWith({ '2026-09-30': { crumbs: 20_000 }, ...week, '2026-10-07': { crumbs: 9500 } }, '2026-10-08')
    expect(summaryFor(outside, '2026-10-08', first)?.kind).toBe('best')
    // Two days are no contest.
    const two = ledgerWith({ '2026-10-05': { crumbs: 4000 }, '2026-10-07': { crumbs: 9500 } }, '2026-10-08', {}, 1)
    expect(summaryFor(two, '2026-10-08', first)?.kind).toBe('normal')
    // Weighted by nutrition: 2,000 sparks-weighted beats more crumbs.
    const sparks = ledgerWith({ ...week, '2026-10-07': { crumbs: 6000, sparks: 900 } }, '2026-10-08', {}, 1)
    expect(summaryFor(sparks, '2026-10-08', first)?.kind).toBe('best')
  })

  it('a quiet day gets a cosy line, never compared with other days', () => {
    const ledger = ledgerWith({ '2026-10-05': { crumbs: 12_000 }, '2026-10-06': { crumbs: 11_000 }, '2026-10-07': { crumbs: 240, treats: 1 } }, '2026-10-08', {}, 1)
    const s = summaryFor(ledger, '2026-10-08', first)
    expect(s?.kind).toBe('quiet')
    expect(s?.text).toBe('Yesterday was a cosy, slow one: 240 crumbs and 1 treat, and lots of naps.')
  })

  it('a day with nothing earned is a sleepy, cosy one', () => {
    const ledger = ledgerWith({ '2026-10-06': { crumbs: 5000 }, '2026-10-07': { pellets: 0.4 } }, '2026-10-08')
    const s = summaryFor(ledger, '2026-10-08', first)
    expect(s?.kind).toBe('nothing')
    expect(s?.text).toBe('Yesterday was a sleepy one. Lots of naps, very cosy!')
  })

  it('a sparks-heavy day thanks for the breaks, with food listed separately', () => {
    const ledger = ledgerWith({ '2026-10-06': { crumbs: 9000 }, '2026-10-07': { crumbs: 3000, pellets: 400, sparks: 6 } }, '2026-10-08', {}, 1)
    // 6 sparks × 4 = 24 of 3,424: not enough of the day.
    expect(summaryFor(ledger, '2026-10-08', first)?.kind).toBe('normal')
    const heavy = ledgerWith({ '2026-10-06': { crumbs: 9000 }, '2026-10-07': { crumbs: 1000, pellets: 400, sparks: 120 } }, '2026-10-08', {}, 1)
    const s = summaryFor(heavy, '2026-10-08', first)
    expect(s?.kind).toBe('sparks')
    expect(s?.text).toBe('Yesterday I ate 1,000 crumbs and 400 pellets, and 120 sparks. I loved our breaks!')
  })

  it('picks the template with the random source, clamped', () => {
    const ledger = ledgerWith({ '2026-10-06': { crumbs: 9000 }, '2026-10-07': { crumbs: 3000, pellets: 400 } }, '2026-10-08', {}, 1)
    const texts = new Set<string>()
    for (const r of [0, 0.3, 0.6, 0.99, 1, -1, Number.NaN]) texts.add(summaryFor(ledger, '2026-10-08', () => r)?.text ?? '')
    expect(texts.size).toBe(S.templates.normal.length)
  })

  it('summaryKind works on the same day map summaryFor builds', () => {
    const ledger = ledgerWith({ '2026-10-07': SPEC_DAY }, '2026-10-08', {}, 1)
    expect(summaryKind('2026-10-07', true, ledgerDays(ledger), ledger)).toBe('normal')
    expect(summaryKind('2026-10-01', true, ledgerDays(ledger), ledger)).toBe('nothing')
  })
})

describe('shouldShowSummary (once a day, first wake/unlock/launch after the 4 AM rollover)', () => {
  const triggers = ['wake', 'unlock', 'launch'] as const

  it('shows when never shown, or last shown on an earlier day, for every trigger', () => {
    for (const trigger of triggers) {
      expect(shouldShowSummary({ today: '2026-10-08', lastSummaryShownDay: null, trigger })).toBe(true)
      expect(shouldShowSummary({ today: '2026-10-08', lastSummaryShownDay: '2026-10-07', trigger })).toBe(true)
      expect(shouldShowSummary({ today: '2026-10-08', lastSummaryShownDay: '2026-09-01', trigger })).toBe(true)
      expect(shouldShowSummary({ today: '2026-10-08', lastSummaryShownDay: '2026-10-08', trigger })).toBe(false)
    }
  })

  it('a clock set back never shows it again; malformed days are handled', () => {
    expect(shouldShowSummary({ today: '2026-10-07', lastSummaryShownDay: '2026-10-08', trigger: 'wake' })).toBe(false)
    expect(shouldShowSummary({ today: '2026-10-08', lastSummaryShownDay: 'garbage', trigger: 'wake' })).toBe(true)
    expect(shouldShowSummary({ today: 'garbage', lastSummaryShownDay: null, trigger: 'wake' })).toBe(false)
  })

  it('follows the economy’s day: a 3 AM wake is still the day before, a 4 AM one is the new day', () => {
    const zone = 'America/Los_Angeles'
    const rollover = tuning.economy.dayRolloverHour
    const at = (iso: string): string => localDay(Date.parse(iso), zone, rollover)
    // Shown on the 7th at 9 AM; a wake at 3:30 AM on the 8th is still the 7th: not again.
    expect(shouldShowSummary({ today: at('2026-10-08T03:30:00-07:00'), lastSummaryShownDay: '2026-10-07', trigger: 'wake' })).toBe(false)
    expect(shouldShowSummary({ today: at('2026-10-08T04:00:00-07:00'), lastSummaryShownDay: '2026-10-07', trigger: 'wake' })).toBe(true)
    // DST: spring forward (2026-03-08) and fall back (2026-11-01) nights still roll at 4:00 local.
    expect(at('2026-03-08T03:59:00-07:00')).toBe('2026-03-07')
    expect(shouldShowSummary({ today: at('2026-03-08T04:00:00-07:00'), lastSummaryShownDay: '2026-03-07', trigger: 'unlock' })).toBe(true)
    expect(at('2026-11-01T03:30:00-08:00')).toBe('2026-10-31')
    expect(shouldShowSummary({ today: at('2026-11-01T03:30:00-08:00'), lastSummaryShownDay: '2026-10-31', trigger: 'unlock' })).toBe(false)
    expect(shouldShowSummary({ today: at('2026-11-01T04:00:00-08:00'), lastSummaryShownDay: '2026-10-31', trigger: 'unlock' })).toBe(true)
  })

  it('yesterday across a DST night is still the calendar day before', () => {
    const ledger = ledgerWith({ '2026-03-07': { crumbs: 4000 } }, '2026-03-08')
    expect(summaryFor(ledger, '2026-03-08', first)?.yesterday).toBe(true)
    const fall = ledgerWith({ '2026-10-31': { crumbs: 4000 } }, '2026-11-01')
    expect(summaryFor(fall, '2026-11-01', first)?.yesterday).toBe(true)
  })
})

// Compile-time: the units cover every currency.
const _units: Record<Currency, readonly [string, string]> = S.units
void _units
