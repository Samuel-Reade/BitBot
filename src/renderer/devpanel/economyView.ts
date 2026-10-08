// The developer panel's Economy section, the pure part (BITBOT_SPEC.md §14.1 "currency table: raw vs credited counts
// today, multipliers, soft-cap progress, wallet, diet vector"; "buttons to inject events"): validating the economy in a
// debug:panel-status, the text of every table cell and status line, and the injects the buttons send. Counts only,
// never which keys or buttons (§2). No DOM: the page (./main.ts) puts these strings in place.

import {
  CURRENCIES,
  isDevInject,
  SPARK_SOURCES,
  type CurrencyToday,
  type DevInject,
  type EconomySnapshot,
  type SparkSource,
} from '../../shared/economy'
import { tuning } from '../../shared/tuning'
import type { Currency } from '../../shared/types'

/** Shown for whatever the economy doesn't know yet (or has no meaning: sparks have no soft cap). */
export const NONE = '—'

const D = tuning.dev.panel.economy.decimals

/** The currencies in the diet vector (§7.5: sparks are the separate "rhythm"). */
const DIET = ['crumbs', 'pellets', 'treats', 'mileage'] as const satisfies readonly Currency[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite number ≥ 0 (counts, payouts, multipliers, shares). */
function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isCurrencyToday(value: unknown): value is CurrencyToday {
  if (!isRecord(value)) return false
  const softCap = value['softCap']
  return (
    isAmount(value['raw']) &&
    isAmount(value['credited']) &&
    isAmount(value['earned']) &&
    isAmount(value['multiplier']) &&
    (softCap === null || (isAmount(softCap) && softCap > 0)) &&
    isAmount(value['lifetime']) &&
    isAmount(value['wallet'])
  )
}

/** DevPanelStatus.economy when not null: every currency, spark source and diet share present and a sane number. */
export function isEconomySnapshot(value: unknown): value is EconomySnapshot {
  if (!isRecord(value)) return false
  const { currencies, sparksToday, diet } = value
  return (
    typeof value['day'] === 'string' &&
    isRecord(currencies) &&
    CURRENCIES.every((c) => isCurrencyToday(currencies[c])) &&
    isRecord(sparksToday) &&
    SPARK_SOURCES.every((s) => isAmount(sparksToday[s])) &&
    isRecord(diet) &&
    DIET.every((c) => isAmount(diet[c]) && diet[c] <= 1) &&
    isAmount(value['rhythm']) &&
    isAmount(value['nutritionLifetime']) &&
    typeof value['inputCounting'] === 'boolean'
  )
}

const formats = new Map<number, Intl.NumberFormat>()

/** A number with thousands separators and exactly `decimals` places ("12,345.6"); NONE when not finite. */
export function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return NONE
  let format = formats.get(decimals)
  if (!format) {
    format = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    formats.set(decimals, format)
  }
  // No "-0" for a tiny negative rounding to zero.
  const text = format.format(value)
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text
}

/** The currency table's columns after the currency's name, in order (the page's <thead> matches). */
export const ECONOMY_COLUMNS = ['raw', 'credited', 'earned', 'multiplier', 'softCap', 'lifetime', 'wallet'] as const

export interface EconomyRow {
  currency: Currency
  /** One string per ECONOMY_COLUMNS entry. */
  cells: readonly string[]
}

/** Soft-cap progress: earned today as a share of the daily soft cap S (§7.4), "87%"; NONE for sparks (no curve). */
function softCapProgress(day: CurrencyToday): string {
  return day.softCap === null ? NONE : `${formatNumber((day.earned / day.softCap) * 100, D.share)}%`
}

/** One row per currency in CURRENCIES order; every cell NONE before the economy starts. */
export function economyRows(economy: EconomySnapshot | null): EconomyRow[] {
  return CURRENCIES.map((currency) => {
    if (!economy) return { currency, cells: ECONOMY_COLUMNS.map(() => NONE) }
    const day = economy.currencies[currency]
    return {
      currency,
      cells: [
        formatNumber(day.raw, D.raw),
        formatNumber(day.credited, D.credited),
        formatNumber(day.earned, D.earned),
        `×${formatNumber(day.multiplier, D.multiplier)}`,
        softCapProgress(day),
        formatNumber(day.lifetime, D.lifetime),
        formatNumber(day.wallet, D.wallet),
      ],
    }
  })
}

const SPARK_LABELS: Record<SparkSource, string> = {
  morningWake: 'morning wake',
  welcomeBack: 'welcome back',
  healthySession: 'healthy session',
  streak: 'streak',
  neglect: 'after neglect',
}

export const INPUT_OFF_TEXT = "Input Monitoring off: keys, clicks and scrolls aren't counted"

/** The status lines under the table; NONE everywhere before the economy starts. */
export interface EconomyDetails {
  day: string
  /** The diet vector: the four shares as %. */
  diet: string
  /** Sparks per day over the diet window. */
  rhythm: string
  nutrition: string
  /** Sparks today per source. */
  sparks: string
  input: string
  /** Keys, clicks and scrolls are not counted (the page marks the input line). */
  inputOff: boolean
}

export function economyDetails(economy: EconomySnapshot | null): EconomyDetails {
  if (!economy) return { day: NONE, diet: NONE, rhythm: NONE, nutrition: NONE, sparks: NONE, input: NONE, inputOff: false }
  return {
    day: economy.day,
    diet: DIET.map((c) => `${c} ${formatNumber(economy.diet[c] * 100, D.share)}%`).join(' · '),
    rhythm: `${formatNumber(economy.rhythm, D.rhythm)} sparks/day`,
    nutrition: `${formatNumber(economy.nutritionLifetime, D.nutrition)} lifetime`,
    sparks: SPARK_SOURCES.map((s) => `${SPARK_LABELS[s]} ${formatNumber(economy.sparksToday[s], 0)}`).join(' · '),
    input: economy.inputCounting ? 'keys, clicks and scrolls are counted' : INPUT_OFF_TEXT,
    inputOff: !economy.inputCounting,
  }
}

/** The inject buttons (the page's button ids) and what each sends; amounts absent: main's defaults (§14.1). */
export const ECONOMY_INJECTS: readonly (readonly [string, DevInject])[] = [
  ['ec-keys', { kind: 'keys' }],
  ['ec-clicks', { kind: 'clicks' }],
  ['ec-scroll', { kind: 'scroll' }],
  ['ec-mileage', { kind: 'mileage' }],
  ['ec-launch-new', { kind: 'launchNew' }],
  ['ec-launch-returning', { kind: 'launchReturning' }],
  ['ec-activate', { kind: 'activate' }],
  ['ec-wake', { kind: 'wake' }],
]

/** The "Break" button's inject for the minutes typed; null when they aren't a length main accepts. */
export function breakInject(minutes: number): DevInject | null {
  const inject: DevInject = { kind: 'break', amount: minutes }
  return isDevInject(inject) ? inject : null
}
