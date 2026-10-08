// The ledger (BITBOT_SPEC.md §7.5), shaped like §16's SaveFile.economy so M8 saves it as is: per currency the lifetime
// total, today's total and its 24 hourly buckets, the daily totals of the last historyDays days and the wallet; the
// lifetime nutrition; known bundle IDs; the current day. Plain JSON (no Maps or Sets), counts only (§2).
//
// Additions to §16's shape (aggregate counts, for the dev panel's raw vs credited, §14.1): todayRaw, todayCredited.
//
// Hourly buckets are indexed by the local wall-clock hour (0–23), so the hours after midnight and before the 4 AM
// rollover land in buckets 0–3 of the day they belong to; on the fall-back night hour 1 holds two real hours, on the
// spring-forward night hour 2 none. dailyHistory holds the days the ledger saw, oldest first (days Bitbot never ran
// have no entry and count as nothing). Diet and rhythm (§7.5) are computed from today plus the history. Pure.

import { CURRENCIES } from '../../shared/economy'
import type { Currency } from '../../shared/types'
import { dayDiff } from './days'

export interface CurrencyLedger {
  lifetimeEarned: number
  /** Payout earned today. */
  today: number
  /** Today's payout per local hour; 24 entries. */
  todayHourly: number[]
  /** Daily payout of the last historyDays days before today, oldest first. */
  dailyHistory: { day: string; earned: number }[]
  /** Accrues only after the final form (Phase 3); always 0 in Phase 1. */
  wallet: number
  /** Raw units today, before anti-gaming (CurrencyToday.raw). */
  todayRaw: number
  /** Credited units today, after anti-gaming (CurrencyToday.credited). */
  todayCredited: number
}

export interface LedgerState {
  perCurrency: Record<Currency, CurrencyLedger>
  nutritionLifetime: number
  /** Phase 2 (evolution); stays 0 in Phase 1. */
  evolutionProgress: number
  /** bundleId → the last time it was opened (launched, or activated once known), ISO (§16; treat bonuses). */
  knownBundleIds: Record<string, string>
  /** The current local day (4 AM rollover), 'YYYY-MM-DD'. */
  currentDay: string
}

export type NutritionWeights = Record<Currency, number>

export function freshCurrencyLedger(): CurrencyLedger {
  return {
    lifetimeEarned: 0,
    today: 0,
    todayHourly: new Array<number>(24).fill(0),
    dailyHistory: [],
    wallet: 0,
    todayRaw: 0,
    todayCredited: 0,
  }
}

export function freshLedger(day: string): LedgerState {
  const perCurrency = {} as Record<Currency, CurrencyLedger>
  for (const c of CURRENCIES) perCurrency[c] = freshCurrencyLedger()
  return { perCurrency, nutritionLifetime: 0, evolutionProgress: 0, knownBundleIds: {}, currentDay: day }
}

/** Counts raw and credited units today (§14.1). */
export function addUnits(ledger: LedgerState, currency: Currency, raw: number, credited: number): void {
  const l = ledger.perCurrency[currency]
  l.todayRaw += raw
  l.todayCredited += credited
}

/** Books a payout in the local hour `hour`; it also feeds nutrition (payout × weight, §7.5). */
export function addPayout(ledger: LedgerState, currency: Currency, amount: number, hour: number, weights: NutritionWeights): void {
  if (!(amount > 0)) return
  const l = ledger.perCurrency[currency]
  l.today += amount
  l.lifetimeEarned += amount
  const h = Math.min(23, Math.max(0, Math.floor(hour)))
  l.todayHourly[h] = (l.todayHourly[h] ?? 0) + amount
  ledger.nutritionLifetime += amount * weights[currency]
}

/**
 * Rolls over to newDay (a later day than currentDay): today's totals go to dailyHistory, which keeps the days within
 * historyDays of newDay; today's totals and hourly buckets reset.
 */
export function rollDay(ledger: LedgerState, newDay: string, historyDays: number): void {
  for (const c of CURRENCIES) {
    const l = ledger.perCurrency[c]
    l.dailyHistory.push({ day: ledger.currentDay, earned: l.today })
    l.dailyHistory = l.dailyHistory.filter((e) => dayDiff(e.day, newDay) <= historyDays).slice(-historyDays)
    l.today = 0
    l.todayHourly = new Array<number>(24).fill(0)
    l.todayRaw = 0
    l.todayCredited = 0
  }
  ledger.currentDay = newDay
}

/** A currency's payout over the trailing windowDays (today and the windowDays − 1 days before it). */
export function earnedInWindow(ledger: LedgerState, currency: Currency, windowDays: number): number {
  const l = ledger.perCurrency[currency]
  let sum = l.today
  for (const e of l.dailyHistory) {
    const age = dayDiff(e.day, ledger.currentDay)
    if (age >= 1 && age < windowDays) sum += e.earned
  }
  return sum
}

export type Diet = { crumbs: number; pellets: number; treats: number; mileage: number }

/** §7.5 diet vector: each of the four currencies' share of their nutrition over the window; sums to 1, or all 0. */
export function dietVector(ledger: LedgerState, windowDays: number, weights: NutritionWeights): Diet {
  const n = {
    crumbs: earnedInWindow(ledger, 'crumbs', windowDays) * weights.crumbs,
    pellets: earnedInWindow(ledger, 'pellets', windowDays) * weights.pellets,
    treats: earnedInWindow(ledger, 'treats', windowDays) * weights.treats,
    mileage: earnedInWindow(ledger, 'mileage', windowDays) * weights.mileage,
  }
  const total = n.crumbs + n.pellets + n.treats + n.mileage
  if (!(total > 0)) return { crumbs: 0, pellets: 0, treats: 0, mileage: 0 }
  return { crumbs: n.crumbs / total, pellets: n.pellets / total, treats: n.treats / total, mileage: n.mileage / total }
}

/**
 * §7.5 rhythm score: sparks per day over the window. The days counted run from the oldest day the ledger saw inside
 * the window (days Bitbot didn't run count, as 0) to today, so a new pet isn't diluted by days before it existed.
 */
export function rhythmScore(ledger: LedgerState, windowDays: number): number {
  const l = ledger.perCurrency.sparks
  let days = 1
  for (const e of l.dailyHistory) {
    const age = dayDiff(e.day, ledger.currentDay)
    if (age >= 1 && age < windowDays) days = Math.max(days, age + 1)
  }
  return earnedInWindow(ledger, 'sparks', windowDays) / days
}
