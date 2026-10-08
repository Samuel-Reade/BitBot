// Needs (BITBOT_SPEC.md §9.1) and the healthy rhythm's needs side (§9.3 stuffed, breaks, neglect), on the pet's life
// clock: real time, which the dev panel's time scale (§14.1) speeds up. The caller advances it every tick by the
// life-clock time since the last call; after the Mac slept, by the whole sleep in one step (computerAsleep), capped at
// maxCatchUpH (§9 "apply the elapsed time in one step, capped sensibly"). Every rate and threshold is tuning.needs.
//
// Each step is classified by the input at its end:
//   asleep  the Mac slept through it: hunger at idlePerH, energy rests at restPerH, the time counts as idle;
//   active  the user's idle time is under activeIdleS (tuning.economy.activity): hunger at activePerH, energy falls at
//           activeDropPerH, the time adds to continuous activity and marks the local day as used;
//   idle    otherwise: hunger at idlePerH; energy rests at restPerH for the part of the step past restAfterIdleMin of
//           idleness. Idleness is the longer of the user's idle time and the life-clock time since the last active
//           step, so it also runs at the dev time scale and across one big step.
// Idleness ≥ breakMin is a break (§9.3): continuous activity resets, which clears stuffed's activity part.
//
// Fullness follows the nutrition rate over the trailing fullness.windowMin (perNutritionPerH × nutrition per hour),
// rising with it at once and never falling faster than decayPerH. Boredom rises at perH; interaction() (pet, drag,
// command, app launch) takes off `interaction` and shakes off all dust. Dust grows per local day ('YYYY-MM-DD', 4 AM
// rollover, from the caller) without any active step: when the day changes, the day that ended adds perDay if it was
// unused, and each day skipped entirely (a long sleep, Bitbot not running) adds perDay. All levels clamp to 0..100.
//
// Neglect (§9.3): no active step for neglectDays of life-clock time; `neglected` says so (progress pauses, Phase 2).
// The pet never dies and nothing here takes progress away (§2).
//
// State is plain JSON (M8 saves it) and relative: ages and durations rather than clock readings, so it stays right
// when the life clock restarts with the app. Pure and deterministic: time and input come from the caller.

import type { NeedLevels } from '../../../shared/life'
import { NEEDS } from '../../../shared/life'
import type { Mood } from '../../../shared/types'
import type { tuning } from '../../../shared/tuning'
import { isStuffed, moodOf } from './mood'

/** Numbers widened from tuning's literal types, so tests can pass other values. */
type Widen<T> = T extends number ? number : T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> }
/** tuning.needs satisfies this as is. */
export type NeedsParams = Omit<Widen<typeof tuning.needs>, 'moodPriority'> & { moodPriority: readonly Mood[] }

export interface NeedsAdvanceInput {
  /** Seconds since the user's last input (system idle time); active when under tuning.economy.activity.activeIdleS. */
  userIdleS: number
  /** The Mac slept through this step (a resume applies the elapsed time in one step, capped at maxCatchUpH). */
  computerAsleep: boolean
  /** The local day (4 AM rollover, 'YYYY-MM-DD'): dust grows per day the user didn't use the computer at all. */
  dayKey: string
}

/** Nutrition received in one bucket of the trailing window. */
export interface NutritionBucket {
  /** Life-clock seconds since the bucket opened. */
  ageS: number
  amount: number
}

export interface NeedsState {
  levels: NeedLevels
  /** Active life-clock time since the last break, ms (§9.3 stuffed after stuffed.continuousMin). */
  continuousActiveMs: number
  /** Life-clock seconds since the last interaction (happy after one, §9.2); null before the first. */
  sinceInteractionS: number | null
  /** Life-clock seconds since the last active step (breaks, energy rest; 0 while active). */
  idleRunS: number
  /** Life-clock seconds since the last active step, not reset by a break (neglect). */
  unusedS: number
  /** The local day of the last step; null before the first. */
  dayKey: string | null
  /** That day had an active step. */
  dayActive: boolean
  /** Nutrition over the trailing fullness.windowMin, newest last. */
  nutritionWindow: NutritionBucket[]
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Days from day a to day b ('YYYY-MM-DD', calendar arithmetic); null if either is malformed. */
function daysBetween(a: string, b: string): number | null {
  const ma = DAY_RE.exec(a)
  const mb = DAY_RE.exec(b)
  if (!ma || !mb) return null
  const ta = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]))
  const tb = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]))
  return Number.isFinite(ta) && Number.isFinite(tb) ? Math.round((tb - ta) / 86_400_000) : null
}

const clamp100 = (v: number): number => Math.min(100, Math.max(0, v))
const finiteOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const nonNeg = (v: unknown): number => Math.max(0, finiteOr(v, 0))

/** A newly hatched pet's needs state. */
export function freshNeedsState(params: NeedsParams): NeedsState {
  return {
    levels: { ...params.initial },
    continuousActiveMs: 0,
    sinceInteractionS: null,
    idleRunS: 0,
    unusedS: 0,
    dayKey: null,
    dayActive: false,
    nutritionWindow: [],
  }
}

/** A loaded state made safe: levels finite and 0..100, durations finite and ≥ 0; anything unusable → the fresh value. */
export function sanitizeNeedsState(raw: unknown, params: NeedsParams): NeedsState {
  const fresh = freshNeedsState(params)
  if (typeof raw !== 'object' || raw === null) return fresh
  const r = raw as Partial<Record<keyof NeedsState, unknown>>
  const rawLevels = (typeof r.levels === 'object' && r.levels !== null ? r.levels : {}) as Record<string, unknown>
  const levels = { ...fresh.levels }
  for (const need of NEEDS) levels[need] = clamp100(finiteOr(rawLevels[need], fresh.levels[need]))
  const window = Array.isArray(r.nutritionWindow) ? r.nutritionWindow : []
  return {
    levels,
    continuousActiveMs: nonNeg(r.continuousActiveMs),
    sinceInteractionS: typeof r.sinceInteractionS === 'number' && Number.isFinite(r.sinceInteractionS) ? Math.max(0, r.sinceInteractionS) : null,
    idleRunS: nonNeg(r.idleRunS),
    unusedS: nonNeg(r.unusedS),
    dayKey: typeof r.dayKey === 'string' && DAY_RE.test(r.dayKey) ? r.dayKey : null,
    dayActive: r.dayActive === true,
    nutritionWindow: window
      .filter((b): b is NutritionBucket => typeof b === 'object' && b !== null)
      .map((b) => ({ ageS: nonNeg(b.ageS), amount: nonNeg(b.amount) }))
      .filter((b) => b.ageS < params.fullness.windowMin * 60 && b.amount > 0),
  }
}

export class Needs {
  private readonly s: NeedsState
  /** The nowS of the last advance or interaction in this run (transient: the life clock may restart with the app). */
  private lastNowS: number | null

  constructor(
    private readonly params: NeedsParams,
    private readonly activeIdleS: number,
    state?: NeedsState,
    nowS?: number,
  ) {
    this.s = state ? sanitizeNeedsState(state, params) : freshNeedsState(params)
    this.lastNowS = nowS !== undefined && Number.isFinite(nowS) ? nowS : null
  }

  /** Advances the needs by dtS life-clock seconds (capped at maxCatchUpH) ending at nowS, classified by input. */
  advance(dtS: number, nowS: number, input: NeedsAdvanceInput): void {
    const p = this.params
    const s = this.s
    const dt = Number.isFinite(dtS) && dtS > 0 ? Math.min(dtS, p.maxCatchUpH * 3600) : 0
    const h = dt / 3600
    if (Number.isFinite(nowS)) this.lastNowS = nowS
    this.rollDay(input.dayKey)

    // An unreadable idle time counts as just idle: no activity, no rest.
    const idleS = Number.isFinite(input.userIdleS) ? Math.max(0, input.userIdleS) : this.activeIdleS
    const active = !input.computerAsleep && idleS < this.activeIdleS
    const lv = s.levels
    if (active) {
      s.idleRunS = 0
      s.unusedS = 0
      s.dayActive = true
      s.continuousActiveMs += dt * 1000
      lv.hunger += p.hunger.activePerH * h
      lv.energy -= p.energy.activeDropPerH * h
    } else {
      s.idleRunS += dt
      s.unusedS += dt
      const idleness = Math.max(input.computerAsleep ? 0 : idleS, s.idleRunS)
      // Energy rests for the part of the step past restAfterIdleMin of idleness (all of it while asleep).
      const restS = input.computerAsleep ? dt : Math.min(dt, Math.max(0, idleness - p.energy.restAfterIdleMin * 60))
      lv.hunger += p.hunger.idlePerH * h
      lv.energy += (p.energy.restPerH * restS) / 3600
      if (idleness >= p.breakMin * 60) s.continuousActiveMs = 0
    }
    lv.boredom += p.boredom.perH * h
    if (s.sinceInteractionS !== null) s.sinceInteractionS += dt

    // Fullness: the window ages, then fullness follows its rate, falling at most decayPerH.
    const windowS = p.fullness.windowMin * 60
    for (const b of s.nutritionWindow) b.ageS += dt
    s.nutritionWindow = s.nutritionWindow.filter((b) => b.ageS < windowS)
    lv.fullness = Math.max(this.fullnessTarget(), lv.fullness - p.fullness.decayPerH * h)

    for (const need of NEEDS) lv[need] = clamp100(lv[need])
  }

  /** A payout's nutrition (§7.5): hunger −perNutrition × amount; it joins fullness's trailing window. */
  nutrition(amount: number, nowS: number): void {
    if (!(Number.isFinite(amount) && amount > 0)) return
    if (Number.isFinite(nowS)) this.lastNowS = nowS
    const p = this.params
    const lv = this.s.levels
    lv.hunger = clamp100(lv.hunger - p.hunger.perNutrition * amount)
    const last = this.s.nutritionWindow[this.s.nutritionWindow.length - 1]
    if (last && last.ageS < p.fullness.bucketS) last.amount += amount
    else this.s.nutritionWindow.push({ ageS: 0, amount })
    lv.fullness = clamp100(Math.max(lv.fullness, this.fullnessTarget()))
  }

  /**
   * A direct interaction (pet, drag, command) or an app launch: boredom −interaction, and all dust comes off. shakeOff:
   * the dust was visible (≥ dust.visibleAt), so the pet plays the shake-off (§9.1); only the first interaction after a
   * dusty return has any to shake.
   */
  interaction(nowS: number): { shakeOff: boolean } {
    if (Number.isFinite(nowS)) this.lastNowS = nowS
    const p = this.params
    const lv = this.s.levels
    lv.boredom = clamp100(lv.boredom - p.boredom.interaction)
    this.s.sinceInteractionS = 0
    const shakeOff = lv.dust >= p.dust.visibleAt
    lv.dust = 0
    return { shakeOff }
  }

  get levels(): NeedLevels {
    return { ...this.s.levels }
  }

  /** §9.3: continuous activity ≥ stuffed.continuousMin without a breakMin break, or fullness ≥ fullness.stuffedAt. */
  get stuffed(): boolean {
    return isStuffed(this.s.levels, this.continuousActiveMin, this.params)
  }

  /** Energy ≤ sleepyAt (§9.1). */
  get sleepy(): boolean {
    return this.s.levels.energy <= this.params.energy.sleepyAt
  }

  /** Energy ≤ napAt: naps wherever it is (§9.1). */
  get napNow(): boolean {
    return this.s.levels.energy <= this.params.energy.napAt
  }

  /** Minutes of continuous activity (§9.3). */
  get continuousActiveMin(): number {
    return this.s.continuousActiveMs / 60_000
  }

  /** §9.3 neglect: no activity for neglectDays; progress (Phase 2) pauses until the user is active again. */
  get neglected(): boolean {
    return this.s.unusedS >= this.params.neglectDays * 86_400
  }

  /** §9.2: the mood at nowS (happy counts the time since the last interaction up to nowS). */
  mood(nowS: number): Mood {
    let since = this.s.sinceInteractionS
    if (since !== null && this.lastNowS !== null && Number.isFinite(nowS)) since += Math.max(0, nowS - this.lastNowS)
    return moodOf({ levels: this.s.levels, continuousActiveMin: this.continuousActiveMin, sinceInteractionS: since }, this.params)
  }

  /** A plain JSON copy (M8 saves it). */
  get state(): NeedsState {
    return {
      ...this.s,
      levels: { ...this.s.levels },
      nutritionWindow: this.s.nutritionWindow.map((b) => ({ ...b })),
    }
  }

  /** The fullness the trailing window's nutrition rate asks for. */
  private fullnessTarget(): number {
    const f = this.params.fullness
    const total = this.s.nutritionWindow.reduce((sum, b) => sum + b.amount, 0)
    return f.windowMin > 0 ? clamp100(((total * 60) / f.windowMin) * f.perNutritionPerH) : 0
  }

  /** The local day changed: dust for the day that ended if unused, and for each day skipped entirely. */
  private rollDay(dayKey: string): void {
    const s = this.s
    if (s.dayKey === dayKey) return
    if (!DAY_RE.test(dayKey)) return
    const gap = s.dayKey === null ? null : daysBetween(s.dayKey, dayKey)
    if (gap !== null && gap > 0) {
      const unusedDays = (s.dayActive ? 0 : 1) + (gap - 1)
      s.levels.dust = clamp100(s.levels.dust + this.params.dust.perDay * unusedDays)
    }
    s.dayKey = dayKey
    s.dayActive = false
  }
}
