// The economy as the rest of the app sees it (§7): the five currencies, what was earned today and overall, the diet.
// Shared: main computes it (src/main/economy/), the tray shows today's totals (§15.2), the developer panel the whole
// table (§14.1). Counts only: never which keys or buttons (§2). Pure.

import type { Currency } from './types'

export const CURRENCIES = ['crumbs', 'pellets', 'treats', 'mileage', 'sparks'] as const satisfies readonly Currency[]

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value)
}

/** The spark sources (§7.2), for per-source daily limits and the panel. */
export const SPARK_SOURCES = ['morningWake', 'welcomeBack', 'healthySession', 'streak', 'neglect'] as const
export type SparkSource = (typeof SPARK_SOURCES)[number]

/** One currency's day (§7.5, §14.1 "raw vs credited counts today, multipliers, soft-cap progress, wallet"). */
export interface CurrencyToday {
  /** Raw units today, before anti-gaming (keys, clicks + scroll ticks, launches + activations, pt of travel, spark events). */
  raw: number
  /** Units credited after anti-gaming (may be fractional: hammered keys count 10%). */
  credited: number
  /** Payout earned today (after the soft-cap curve). */
  earned: number
  /** The multiplier the next unit would get (§7.4); 1 for sparks (no curve). */
  multiplier: number
  /** Daily soft cap S; null for sparks. */
  softCap: number | null
  lifetime: number
  /** Accrues only after the final form (Phase 3); always 0 in Phase 1. */
  wallet: number
}

export interface EconomySnapshot {
  /** The local day (4 AM rollover), 'YYYY-MM-DD'. */
  day: string
  currencies: Record<Currency, CurrencyToday>
  /** Sparks today per source (§7.2 limits). */
  sparksToday: Record<SparkSource, number>
  /** Share of nutrition from each currency over the trailing 14 days (sums to 1; all 0 before anything is earned). */
  diet: { crumbs: number; pellets: number; treats: number; mileage: number }
  /** Sparks per day over the same window (§7.5 "rhythm" score). */
  rhythm: number
  nutritionLifetime: number
  /** Keys, clicks and scrolls are counted (the helper's tap runs: Input Monitoring granted). */
  inputCounting: boolean
}

/** debug:panel-inject — dev panel → main: inject activity (§14.1 "buttons to inject events"). */
export const DEV_INJECTS = ['keys', 'clicks', 'scroll', 'mileage', 'launchNew', 'launchReturning', 'activate', 'wake', 'break'] as const
export type DevInjectKind = (typeof DEV_INJECTS)[number]

export interface DevInject {
  kind: DevInjectKind
  /**
   * keys ×100, clicks ×20, scroll ×50 ticks, mileage +5,000 pt by default (§14.1); for 'break', the break's length in
   * minutes. Absent: the default.
   */
  amount?: number
}

export function isDevInject(value: unknown): value is DevInject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  for (const key of Object.keys(v)) if (key !== 'kind' && key !== 'amount') return false
  if (typeof v['kind'] !== 'string' || !(DEV_INJECTS as readonly string[]).includes(v['kind'])) return false
  if ('amount' in v && !(typeof v['amount'] === 'number' && Number.isFinite(v['amount']) && v['amount'] > 0 && v['amount'] <= 100_000)) return false
  return true
}
