// The economy (BITBOT_SPEC.md §7): raw activity in, currencies, sparks and nutrition out. Main's glue feeds it the
// helper's input tap (keys, clicks, scrolls), cursor samples, app launches and activations, idle samples and wakes;
// the dev panel shows snapshot() (§14.1) and M8 saves `state` (§16 economy + rhythm).
//
//   activity → antiGaming.ts (raw → credited units; key codes, timing and positions stay in memory there)
//            → curves.ts (§7.4 payout: base × units × soft-cap multiplier × stuffedFactor)
//            → ledger.ts (today, hourly buckets, history, lifetime, nutrition)
//   idle samples and wakes → rhythm.ts (active time, breaks, streak) → sparks (no curve) and events for M6.
//
// Every method reads clock.now() itself (events are timestamped on receipt) and first rolls the day over if the local
// day (days.ts: dayRolloverHour, DST-safe) has moved on: today's totals go to the history, buckets and sparksToday
// reset. The day only moves forward: a clock or time zone change back to an earlier day keeps booking to the current
// one. Keys, clicks and scrolls are counted only while input counting is on (the helper's tap runs, Input Monitoring
// granted, §7.1); mileage, treats and sparks always flow. Dev injections skip anti-gaming and the input switch (they
// are the tester's "varied human typing"), but not the curves.
//
// Pure and deterministic: the clock, time zone, tuning and stuffedFactor are injected; unit-tested in
// test/economy.test.ts.

import { CURRENCIES, SPARK_SOURCES, type CurrencyToday, type DevInject, type EconomySnapshot, type SparkSource } from '../../shared/economy'
import { tuning } from '../../shared/tuning'
import type { Currency } from '../../shared/types'
import { ClickCounter, KeyCounter, MileageCounter, ScrollCounter, TreatRules, type ScrollEvent, type TreatKind } from './antiGaming'
import { payout, safeStuffedFactor, softCapMultiplier } from './curves'
import { addDays, localDay, localHour, systemTimeZone } from './days'
import { addPayout, addUnits, dietVector, freshLedger, rhythmScore, rollDay, type LedgerState } from './ledger'
import { freshRhythm, Rhythm, type RhythmAward, type RhythmState } from './rhythm'

/** Numbers widened from tuning's literal types, so tests can pass other values. */
type Widen<T> = T extends number ? number : T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> }
export type EconomyTuning = Widen<typeof tuning.economy>

export interface EconomyClock {
  /** Wall-clock epoch ms (Date.now in production). */
  now(): number
}

/** What M8 saves: §16's SaveFile.economy and SaveFile.rhythm (plus the additions noted in ledger.ts and rhythm.ts). */
export interface EconomyState {
  economy: LedgerState
  rhythm: RhythmState
}

export interface EconomyOptions {
  clock: EconomyClock
  /** IANA zone for local days; default: the system's. */
  timeZone?: string
  tuning?: EconomyTuning
  /** §9.3 (M6): 0.5 while stuffed; default () => 1. */
  stuffedFactor?: () => number
  /** A saved state to continue from (M8); default: fresh. Copied, not kept. */
  state?: EconomyState
}

export type EconomyEvent = { kind: 'spark'; source: SparkSource; amount: number } | { kind: 'returnAfterNeglect'; days: number }

/** The four currencies with a soft cap. */
type Curved = Exclude<Currency, 'sparks'>

export class Economy {
  private readonly clock: EconomyClock
  private readonly timeZone: string
  private readonly tuning: EconomyTuning
  private readonly stuffedFactor: () => number
  private readonly ledger: LedgerState
  private readonly rhythm: Rhythm
  private readonly keys: KeyCounter
  private readonly clicks: ClickCounter
  private readonly scrolls: ScrollCounter
  private readonly mileage: MileageCounter
  private readonly treats: TreatRules
  private inputCounting = false
  private events: EconomyEvent[] = []

  constructor(opts: EconomyOptions) {
    this.clock = opts.clock
    this.timeZone = opts.timeZone ?? systemTimeZone()
    this.tuning = opts.tuning ?? tuning.economy
    this.stuffedFactor = opts.stuffedFactor ?? (() => 1)
    const t = this.tuning
    const now = this.clock.now()
    const saved = opts.state ? (structuredClone(opts.state) as EconomyState) : null
    this.ledger = saved?.economy ?? freshLedger(this.dayAt(now))
    this.rhythm = new Rhythm(saved?.rhythm ?? freshRhythm(now), t)
    const ag = t.antiGaming
    this.keys = new KeyCounter({ hammering: ag.hammering, robotic: ag.robotic, burstPerS: ag.burstPerS.keys })
    this.clicks = new ClickCounter({ robotic: ag.robotic, burstPerS: ag.burstPerS.clicks })
    this.scrolls = new ScrollCounter(t.scroll)
    this.mileage = new MileageCounter(ag.jiggle)
    this.treats = new TreatRules(t.treats)
    this.tick(now)
  }

  /** keyDown / keyUp from the helper's tap. The code is used here, transiently, and never kept. */
  key(code: number, down: boolean, repeat: boolean): void {
    const now = this.tick()
    if (!this.inputCounting) return
    if (!down) {
      this.keys.keyUp(code)
      return
    }
    const credit = this.keys.keyDown(code, repeat, now)
    this.earn('crumbs', 1, credit, this.tuning.base.crumbsPerKey * credit, now)
  }

  /** A mouseDown from the helper's tap. Every button counts the same (§7.3 has no per-button rule). */
  click(_button: number): void {
    const now = this.tick()
    if (!this.inputCounting) return
    const credit = this.clicks.click(now)
    this.earn('pellets', 1, credit, this.tuning.base.pelletsPerClick * credit, now)
  }

  /** A scroll from the helper's tap, in ticks by the decided rule (antiGaming.ts ScrollCounter). */
  scroll(s: ScrollEvent): void {
    const now = this.tick()
    if (!this.inputCounting) return
    const { raw, credited } = this.scrolls.scroll(s, now)
    this.earn('pellets', raw, credited, this.tuning.base.pelletsPerScrollTick * credited, now)
  }

  /** A cursor sample (global pt), every 1 / cursorPollHz s. */
  cursor(x: number, y: number): void {
    const now = this.tick()
    const { raw, credited } = this.mileage.sample(x, y, now)
    this.earn('mileage', raw, credited, this.tuning.base.mileagePerPt * credited, now)
  }

  appLaunched(bundleId: string): void {
    const now = this.tick()
    const known = this.ledger.knownBundleIds[bundleId]
    const kind = this.treats.launch(bundleId, now, known === undefined ? undefined : Date.parse(known))
    this.ledger.knownBundleIds[bundleId] = new Date(now).toISOString()
    this.earnTreat(kind, now)
  }

  appActivated(bundleId: string): void {
    const now = this.tick()
    // An activation of a known app refreshes its "last opened"; an unknown one isn't recorded, so its first launch
    // seen still counts as first-ever.
    if (bundleId in this.ledger.knownBundleIds) this.ledger.knownBundleIds[bundleId] = new Date(now).toISOString()
    this.earnTreat(this.treats.activate(bundleId, now), now)
  }

  /** The system idle time, every activity.idlePollS: active time, breaks, and their sparks (rhythm.ts). */
  idle(idleS: number): void {
    const now = this.tick()
    this.award(this.rhythm.idle(idleS, now), now)
  }

  /** Resume, unlock, or Bitbot starting: a break's end, the morning wake and streak, a return after neglect. */
  wake(): void {
    const now = this.tick()
    const day = this.ledger.currentDay
    this.award(this.rhythm.wake(now, day, addDays(day, -1)), now)
  }

  /** Input counting on while the helper's tap runs (Input Monitoring granted); off: keys, clicks, scrolls ignored. */
  setInputCounting(on: boolean): void {
    this.tick()
    if (on === this.inputCounting) return
    this.inputCounting = on
    // Keyups may have been missed while the tap was down: forget held keys and the timing windows.
    this.keys.clear()
    this.clicks.clear()
    this.scrolls.clear()
  }

  /** The dev panel's injections (§14.1). */
  inject(i: DevInject): void {
    const now = this.tick()
    const d = this.tuning.devInject
    const b = this.tuning.base
    switch (i.kind) {
      case 'keys':
        for (let n = Math.round(i.amount ?? d.keys); n > 0; n--) this.earn('crumbs', 1, 1, b.crumbsPerKey, now)
        return
      case 'clicks':
        for (let n = Math.round(i.amount ?? d.clicks); n > 0; n--) this.earn('pellets', 1, 1, b.pelletsPerClick, now)
        return
      case 'scroll':
        for (let n = Math.round(i.amount ?? d.scrollTicks); n > 0; n--) this.earn('pellets', 1, 1, b.pelletsPerScrollTick, now)
        return
      case 'mileage': {
        const pt = i.amount ?? d.mileagePt
        this.earn('mileage', pt, pt, b.mileagePerPt * pt, now)
        return
      }
      // Launches are credited without recording a made-up bundle ID in knownBundleIds (which the user sees, §16).
      case 'launchNew':
        this.earnTreat('firstEver', now)
        return
      case 'launchReturning':
        this.earnTreat('returning', now)
        return
      case 'activate':
        this.earnTreat('activation', now)
        return
      case 'wake':
        this.wake()
        return
      case 'break':
        this.award(this.rhythm.injectBreak((i.amount ?? d.breakMin) * 60_000, now), now)
        return
    }
  }

  snapshot(): EconomySnapshot {
    this.tick()
    const t = this.tuning
    const stuffed = safeStuffedFactor(this.stuffedFactor())
    const currencies = {} as Record<Currency, CurrencyToday>
    for (const c of CURRENCIES) {
      const l = this.ledger.perCurrency[c]
      const softCap = c === 'sparks' ? null : t.softCaps[c]
      currencies[c] = {
        raw: l.todayRaw,
        credited: l.todayCredited,
        earned: l.today,
        multiplier: softCap === null ? 1 : softCapMultiplier(l.today, softCap) * stuffed,
        softCap,
        lifetime: l.lifetimeEarned,
        wallet: l.wallet,
      }
    }
    const sparksToday = {} as Record<SparkSource, number>
    for (const s of SPARK_SOURCES) sparksToday[s] = this.rhythm.state.sparksToday[s]
    return {
      day: this.ledger.currentDay,
      currencies,
      sparksToday,
      diet: dietVector(this.ledger, t.diet.windowDays, t.nutritionWeights),
      rhythm: rhythmScore(this.ledger, t.diet.windowDays),
      nutritionLifetime: this.ledger.nutritionLifetime,
      inputCounting: this.inputCounting,
    }
  }

  /** Sparks and returns since the last call, oldest first. */
  drainEvents(): EconomyEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  /** A copy of the state to save (§16): plain JSON, counts only; never key codes, buttons, timing traces or positions. */
  get state(): EconomyState {
    this.tick()
    return structuredClone({ economy: this.ledger, rhythm: this.rhythm.state })
  }

  private dayAt(now: number): string {
    return localDay(now, this.timeZone, this.tuning.dayRolloverHour)
  }

  /** Rolls the day over if it moved forward; returns now. */
  private tick(now = this.clock.now()): number {
    const day = this.dayAt(now)
    if (day > this.ledger.currentDay) {
      rollDay(this.ledger, day, this.tuning.historyDays)
      this.rhythm.newDay()
    }
    return now
  }

  /** Books raw and credited units and pays baseAmount (base × credited units) through the soft cap. */
  private earn(c: Curved, raw: number, credited: number, baseAmount: number, now: number): void {
    addUnits(this.ledger, c, raw, credited)
    if (!(baseAmount > 0)) return
    const amount = payout(baseAmount, 1, this.ledger.perCurrency[c].today, this.tuning.softCaps[c], this.stuffedFactor())
    addPayout(this.ledger, c, amount, localHour(now, this.timeZone), this.tuning.nutritionWeights)
  }

  private earnTreat(kind: TreatKind | null, now: number): void {
    const b = this.tuning.base
    const base =
      kind === 'firstEver'
        ? b.treatsLaunchFirstEver
        : kind === 'returning'
          ? b.treatsLaunchReturning
          : kind === 'launch'
            ? b.treatsLaunch
            : kind === 'activation'
              ? b.treatsActivation
              : 0
    this.earn('treats', 1, kind === null ? 0 : 1, base, now)
  }

  // SPEC-DEVIATION: §9.3 puts stuffedFactor "on all payouts"; sparks don't take it. They are whole awards fixed by
  // §7.2's rules (no curve either, §7.4), and nearly all come at the end of a break, which is what clears stuffed.
  private award(awards: RhythmAward[], now: number): void {
    for (const a of awards) {
      if (a.kind === 'returnAfterNeglect') {
        this.events.push({ kind: 'returnAfterNeglect', days: a.days })
        continue
      }
      addUnits(this.ledger, 'sparks', 1, a.amount)
      addPayout(this.ledger, 'sparks', a.amount, localHour(now, this.timeZone), this.tuning.nutritionWeights)
      this.events.push({ kind: 'spark', source: a.source, amount: a.amount })
    }
  }
}
