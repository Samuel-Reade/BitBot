// The daily summary (BITBOT_SPEC.md §9.4): once a day, on the first wake, unlock or launch after the 4:00 AM rollover,
// the pet says what it ate the day before in its own voice ("Yesterday I ate 11,240 crumbs, 830 pellets, 9 treats,
// 41 miles, and 6 sparks. Best day this week!"). This module picks the words; src/main/summaryBubble.ts decides when
// and shows them. Pure: the ledger, today and the random source are passed in (test/summary.test.ts).
//
// Which day: the newest day before today the ledger has. Yesterday gets "Yesterday…"; if Bitbot didn't run
// yesterday, an older day (at most tuning.ui.summary.lastTimeMaxDays back) gets "Last time…"; older than that, or no
// day at all, nothing is said. The kind of line (summaryKind) is picked from that day's totals, and one of the kind's
// templates (tuning.ui.summary.templates) at random. Never guilt-trippy (§9.4): a quiet day is never compared with
// other days, only the best day is (upward), and the templates avoid "only", "should" and friends.
//
// Mileage is the economy's earned number with the word "miles" (§9.4's example), not converted to real miles.

import { CURRENCIES } from '../shared/economy'
import { tuning } from '../shared/tuning'
import type { Currency } from '../shared/types'
import { addDays, dayDiff, isDay } from './economy/days'
import { formatWhole } from './menus/trayMenu'

/** The part of a currency's ledger (economy/ledger.ts CurrencyLedger) the summary reads. */
export interface SummaryCurrencyLedger {
  lifetimeEarned: number
  today: number
  dailyHistory: readonly { day: string; earned: number }[]
}

/** The part of the ledger (economy/ledger.ts LedgerState, e.g. Economy.state.economy) the summary reads. */
export interface SummaryLedger {
  perCurrency: Record<Currency, SummaryCurrencyLedger>
  /** The day `today` belongs to; a ledger that hasn't rolled over yet still has yesterday here. */
  currentDay: string
}

type Widen<T> = T extends number ? number : T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> }
export type SummaryTuning = Widen<typeof tuning.ui.summary>

export type SummaryKind = 'normal' | 'best' | 'quiet' | 'sparks' | 'first' | 'nothing'

/** What triggers the check (§9.4 "first wake/unlock after the rollover"; app launch counts too, see shouldShowSummary). */
export type SummaryTrigger = 'wake' | 'unlock' | 'launch'

export interface Summary {
  /** The day summarized, 'YYYY-MM-DD'. */
  day: string
  /** The day shown for: what goes in SaveFile.meta.lastSummaryShownDay. */
  shownFor: string
  /** Yesterday, or an older day ("last time"). */
  yesterday: boolean
  kind: SummaryKind
  text: string
}

export type DayTotals = Record<Currency, number>

// SPEC-DEVIATION: §9.4 shows the summary on the first wake or unlock after the rollover; app launch counts too, so a
// Mac that stays awake overnight and starts Bitbot in the morning (or after a restart) gets it on the same day.
/**
 * True if the summary is due: today ('YYYY-MM-DD', the economy's day with its 4 AM rollover) is later than the last
 * day one was shown for. The trigger doesn't change the answer: §9.4 names the first wake or unlock after the
 * rollover, and app launch counts too (decided): a Mac that never sleeps overnight, where Bitbot is started each
 * morning or after a restart, would otherwise wait until its first sleep. A clock set back (today before the last
 * shown day) never shows one again that day. An unreadable last day counts as never shown.
 */
export function shouldShowSummary(i: { today: string; lastSummaryShownDay: string | null; trigger: SummaryTrigger }): boolean {
  if (!isDay(i.today)) return false
  if (i.lastSummaryShownDay === null || !isDay(i.lastSummaryShownDay)) return true
  return dayDiff(i.lastSummaryShownDay, i.today) > 0
}

/** Every day the ledger knows with its totals, the current day included; days are 'YYYY-MM-DD'. */
export function ledgerDays(ledger: SummaryLedger): Map<string, DayTotals> {
  const days = new Map<string, DayTotals>()
  const totalsFor = (day: string): DayTotals => {
    let t = days.get(day)
    if (!t) {
      t = { crumbs: 0, pellets: 0, treats: 0, mileage: 0, sparks: 0 }
      days.set(day, t)
    }
    return t
  }
  for (const c of CURRENCIES) {
    const l = ledger.perCurrency[c]
    for (const e of l.dailyHistory) if (isDay(e.day)) totalsFor(e.day)[c] += finite(e.earned)
    if (isDay(ledger.currentDay)) totalsFor(ledger.currentDay)[c] += finite(l.today)
  }
  return days
}

/** A day's nutrition: payouts × tuning.economy.nutritionWeights (§7.5). */
export function nutritionOf(totals: DayTotals, weights: Record<Currency, number> = tuning.economy.nutritionWeights): number {
  let n = 0
  for (const c of CURRENCIES) n += totals[c] * weights[c]
  return n
}

/** "1 crumb", "11,240 crumbs": whole numbers, rounded down like the tray (formatWhole). */
export function countPhrase(currency: Currency, amount: number, t: SummaryTuning = tuning.ui.summary): string {
  const [one, many] = t.units[currency]
  const text = formatWhole(amount)
  return `${text} ${text === '1' ? one : many}`
}

/** "a", "a and b", "a, b, and c" (the serial comma, as in §9.4's example); "" for none. */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** The currencies earned (at least 1 whole unit), in CURRENCIES order, as count phrases. */
export function earnedPhrases(totals: DayTotals, which: readonly Currency[] = CURRENCIES, t: SummaryTuning = tuning.ui.summary): string[] {
  return which.filter((c) => wholeUnits(totals[c]) >= 1).map((c) => countPhrase(c, totals[c], t))
}

/**
 * Which kind of line a day gets, first match wins:
 * - nothing: no whole unit of anything earned;
 * - first: the first day Bitbot ever ran (nothing earned before it: lifetime totals are all in the known days);
 * - best: yesterday beat every other day Bitbot ran in the week ending yesterday, with enough days to compare;
 * - quiet: under quietBelowNutrition (a cosy line, never compared with other days);
 * - sparks: sparks were a big part of the day (and some food was eaten too);
 * - normal.
 */
export function summaryKind(
  day: string,
  yesterday: boolean,
  days: ReadonlyMap<string, DayTotals>,
  ledger: SummaryLedger,
  t: SummaryTuning = tuning.ui.summary,
  weights: Record<Currency, number> = tuning.economy.nutritionWeights,
): SummaryKind {
  const totals = days.get(day)
  if (!totals || CURRENCIES.every((c) => wholeUnits(totals[c]) < 1)) return 'nothing'
  if (isFirstDay(day, days, ledger)) return 'first'
  const n = nutritionOf(totals, weights)
  if (yesterday && isBestOfWeek(day, n, days, t, weights)) return 'best'
  if (n < t.quietBelowNutrition) return 'quiet'
  const food = CURRENCIES.some((c) => c !== 'sparks' && wholeUnits(totals[c]) >= 1)
  if (food && wholeUnits(totals.sparks) >= t.sparksMin && n > 0 && (totals.sparks * weights.sparks) / n >= t.sparksShareMin) return 'sparks'
  return 'normal'
}

// SPEC-DEVIATION: §9.4 summarizes yesterday. If Bitbot didn't run yesterday, the newest earlier day it ran (at most
// tuning.ui.summary.lastTimeMaxDays back) is summarized with "Last time…" words instead of saying nothing.
/**
 * The summary to show today, or null when there is nothing to say (no day before today within lastTimeMaxDays).
 * `random` picks the template (0 ≤ r < 1; Math.random in production).
 */
export function summaryFor(
  ledger: SummaryLedger,
  today: string,
  random: () => number,
  t: SummaryTuning = tuning.ui.summary,
  weights: Record<Currency, number> = tuning.economy.nutritionWeights,
): Summary | null {
  if (!isDay(today)) return null
  const days = ledgerDays(ledger)
  let day: string | null = null
  for (const d of days.keys()) if (dayDiff(d, today) >= 1 && (day === null || d > day)) day = d
  if (day === null) return null
  const age = dayDiff(day, today)
  if (age > t.lastTimeMaxDays) return null
  const yesterday = age === 1
  const kind = summaryKind(day, yesterday, days, ledger, t, weights)
  const totals = days.get(day) as DayTotals
  const templates = t.templates[kind]
  const template = templates[pickIndex(random, templates.length)] ?? templates[0] ?? ''
  const [When, when] = yesterday ? t.when.yesterday : t.when.lastTime
  const text = fillTemplate(template, {
    When,
    when,
    list: joinList(earnedPhrases(totals, CURRENCIES, t)),
    food: joinList(earnedPhrases(totals, FOOD, t)),
    sparks: countPhrase('sparks', totals.sparks, t),
  })
  return { day, shownFor: today, yesterday, kind, text }
}

/** Replaces every {name} in `template` with `values[name]`; unknown names stay as they are. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}

/** Every template (for the word checks in the tests). */
export function allTemplates(t: SummaryTuning = tuning.ui.summary): string[] {
  return Object.values(t.templates).flat()
}

const FOOD: readonly Currency[] = CURRENCIES.filter((c) => c !== 'sparks')

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Whole units as formatWhole shows them (so "0 treats" is never listed). */
function wholeUnits(value: number): number {
  return Number(formatWhole(value).replace(/,/g, ''))
}

function pickIndex(random: () => number, n: number): number {
  const r = random()
  if (!(n > 0) || !Number.isFinite(r)) return 0
  return Math.min(n - 1, Math.max(0, Math.floor(r * n)))
}

/** No known day before `day`, and every currency's lifetime total is accounted for by the known days. */
function isFirstDay(day: string, days: ReadonlyMap<string, DayTotals>, ledger: SummaryLedger): boolean {
  for (const [d, totals] of days) if (d < day && CURRENCIES.some((c) => totals[c] > 0)) return false
  for (const c of CURRENCIES) {
    let known = 0
    for (const totals of days.values()) known += totals[c]
    // Something was earned on a day the history no longer has (older than historyDays): not the first day.
    if (finite(ledger.perCurrency[c].lifetimeEarned) > known + 1e-6 + known * 1e-9) return false
  }
  return true
}

function isBestOfWeek(
  day: string,
  nutrition: number,
  days: ReadonlyMap<string, DayTotals>,
  t: SummaryTuning,
  weights: Record<Currency, number>,
): boolean {
  if (!(nutrition > 0)) return false
  let ran = 1
  for (let back = 1; back < t.bestDayWindowDays; back++) {
    const other = days.get(addDays(day, -back))
    if (!other) continue
    ran++
    if (nutritionOf(other, weights) >= nutrition) return false
  }
  return ran >= t.bestDayMinDays
}
