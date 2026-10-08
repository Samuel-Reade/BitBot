// The healthy rhythm (BITBOT_SPEC.md §7.2 sparks, §9.3 breaks): activity, breaks, wakes, the streak, and the sparks
// they earn. State shaped like §16's SaveFile.rhythm so M8 saves it as is.
//
// Active: the system idle time (powerMonitor, sampled every activity.idlePollS) is under activity.activeIdleS. Each
// active sample adds the time since the previous sample (at most activity.maxStepS) to continuousActiveMs, and moves
// lastActiveAt to the last input (sample time − idle time).
//
// A break: no input for healthySession.breakMin (§9.3: 5 min). Detected two ways, so a break with the Mac asleep
// (no samples at all) counts like one sat out in front of it:
//   - while it lasts: a sample with idle ≥ breakMin resets continuousActiveMs (stuffed clears, §9.3), keeping the
//     session's length in sessionBeforeBreakMs for the healthy-session check;
//   - at the return: an active sample (or a wake) whose last input is ≥ breakMin after lastActiveAt ends a break that
//     long. The return awards, by §7.2: welcome back (break ≥ welcomeBack.breakMinMin and ≤ breakMaxHours, at most
//     maxPerDay); a healthy session (the session before it ≥ activeMin, at most maxPerDay); after ≥ neglect.minDays
//     away, the neglect sparks and a 'returnAfterNeglect' event.
// A wake (resume, unlock, Bitbot starting) counts as input now: it ends a break as above, then the day's first wake
// gives the morning wake and the streak (+perDay per consecutive day with a wake, today included, at most cap).
//
// Additions to §16's shape: sessionBeforeBreakMs. sparksToday holds spark amounts; a per-day limit counts awards as
// amount / value. Pure: times are epoch ms from the caller, days from days.ts.

import type { SparkSource } from '../../shared/economy'
import { DAY_MS } from './days'

export interface RhythmState {
  /** Active time since the last break, ms (§9.3 stuffed after 90 min, M6). */
  continuousActiveMs: number
  /** The last input seen (from idle samples and wakes), ISO. */
  lastActiveAt: string
  /** When the last break ended, ISO; null before the first. */
  lastBreakAt: string | null
  /** Consecutive days with a wake, today included once today's first wake happened. */
  streakDays: number
  /** The day of the last first-wake (morning wake and streak), 'YYYY-MM-DD'; null before the first. */
  lastStreakDay: string | null
  /** Spark amounts earned today, per source (reset at the rollover). */
  sparksToday: Record<SparkSource, number>
  /** The session's active time when the current break began, ms; 0 outside a break. */
  sessionBeforeBreakMs: number
}

export interface RhythmParams {
  activity: { activeIdleS: number; maxStepS: number }
  sparks: {
    morningWake: number
    welcomeBack: { value: number; breakMinMin: number; breakMaxHours: number; maxPerDay: number }
    healthySession: { value: number; activeMin: number; breakMin: number; maxPerDay: number }
    streak: { perDay: number; cap: number }
    neglect: { minDays: number; value: number }
  }
}

export type RhythmAward = { kind: 'spark'; source: SparkSource; amount: number } | { kind: 'returnAfterNeglect'; days: number }

const MIN_MS = 60_000
const HOUR_MS = 3_600_000

export function freshSparksToday(): Record<SparkSource, number> {
  return { morningWake: 0, welcomeBack: 0, healthySession: 0, streak: 0, neglect: 0 }
}

export function freshRhythm(nowMs: number): RhythmState {
  return {
    continuousActiveMs: 0,
    lastActiveAt: new Date(nowMs).toISOString(),
    lastBreakAt: null,
    streakDays: 0,
    lastStreakDay: null,
    sparksToday: freshSparksToday(),
    sessionBeforeBreakMs: 0,
  }
}

export class Rhythm {
  /** The previous idle sample, epoch ms (transient). */
  private lastSampleAt: number | null = null

  constructor(
    readonly state: RhythmState,
    private readonly params: RhythmParams,
  ) {}

  private get breakMs(): number {
    return this.params.sparks.healthySession.breakMin * MIN_MS
  }

  private lastActiveMs(): number {
    const t = Date.parse(this.state.lastActiveAt)
    return Number.isFinite(t) ? t : 0
  }

  /** An idle sample at now: idleS seconds since the last input. */
  idle(idleS: number, now: number): RhythmAward[] {
    const idleMs = Number.isFinite(idleS) ? Math.max(0, idleS * 1000) : 0
    const inputAt = now - idleMs
    const lastActive = this.lastActiveMs()
    let awards: RhythmAward[] = []
    if (idleMs < this.params.activity.activeIdleS * 1000) {
      if (inputAt - lastActive >= this.breakMs) awards = this.endBreak(inputAt - lastActive, now)
      else if (this.lastSampleAt !== null) {
        this.state.continuousActiveMs += Math.min(Math.max(0, now - this.lastSampleAt), this.params.activity.maxStepS * 1000)
      }
      if (inputAt > lastActive) this.state.lastActiveAt = new Date(inputAt).toISOString()
    } else if (idleMs >= this.breakMs && this.state.continuousActiveMs > 0) {
      // On a break now: the continuous-activity timer resets (§9.3); the session waits for the return.
      this.state.sessionBeforeBreakMs = Math.max(this.state.sessionBeforeBreakMs, this.state.continuousActiveMs)
      this.state.continuousActiveMs = 0
    }
    this.lastSampleAt = now
    return awards
  }

  /** Resume, unlock or Bitbot starting at now, on `day` ('YYYY-MM-DD'), `yesterday` the day before it. */
  wake(now: number, day: string, yesterday: string): RhythmAward[] {
    const lastActive = this.lastActiveMs()
    const awards: RhythmAward[] = now - lastActive >= this.breakMs ? this.endBreak(now - lastActive, now) : []
    if (now > lastActive) this.state.lastActiveAt = new Date(now).toISOString()
    if (this.state.lastStreakDay !== day) {
      const { morningWake, streak } = this.params.sparks
      this.state.streakDays = this.state.lastStreakDay === yesterday ? this.state.streakDays + 1 : 1
      this.state.lastStreakDay = day
      awards.push(this.spark('morningWake', morningWake))
      awards.push(this.spark('streak', Math.min(streak.perDay * this.state.streakDays, streak.cap)))
    }
    this.lastSampleAt = null
    return awards.filter((a) => a.kind !== 'spark' || a.amount > 0)
  }

  /** The dev panel's break (§14.1): a break of breakMs ending now (as if the last input was breakMs ago). */
  injectBreak(breakMs: number, now: number): RhythmAward[] {
    const awards = this.endBreak(breakMs, now)
    this.state.lastActiveAt = new Date(now).toISOString()
    this.lastSampleAt = now
    return awards
  }

  /** The rollover: today's spark counts reset. */
  newDay(): void {
    this.state.sparksToday = freshSparksToday()
  }

  private endBreak(gapMs: number, now: number): RhythmAward[] {
    const { welcomeBack, healthySession, neglect } = this.params.sparks
    const session = Math.max(this.state.sessionBeforeBreakMs, this.state.continuousActiveMs)
    this.state.sessionBeforeBreakMs = 0
    this.state.continuousActiveMs = 0
    this.state.lastBreakAt = new Date(now).toISOString()
    const awards: RhythmAward[] = []
    if (gapMs >= neglect.minDays * DAY_MS) {
      awards.push(this.spark('neglect', neglect.value))
      awards.push({ kind: 'returnAfterNeglect', days: Math.floor(gapMs / DAY_MS) })
    }
    if (
      gapMs >= welcomeBack.breakMinMin * MIN_MS &&
      gapMs <= welcomeBack.breakMaxHours * HOUR_MS &&
      this.awardsToday('welcomeBack', welcomeBack.value) < welcomeBack.maxPerDay
    ) {
      awards.push(this.spark('welcomeBack', welcomeBack.value))
    }
    if (
      session >= healthySession.activeMin * MIN_MS &&
      gapMs >= healthySession.breakMin * MIN_MS &&
      this.awardsToday('healthySession', healthySession.value) < healthySession.maxPerDay
    ) {
      awards.push(this.spark('healthySession', healthySession.value))
    }
    return awards.filter((a) => a.kind !== 'spark' || a.amount > 0)
  }

  private awardsToday(source: SparkSource, value: number): number {
    return value > 0 ? Math.round(this.state.sparksToday[source] / value) : 0
  }

  /** Books a spark award in sparksToday (the caller books it in the ledger). */
  private spark(source: SparkSource, amount: number): RhythmAward {
    if (amount > 0) this.state.sparksToday[source] += amount
    return { kind: 'spark', source, amount }
  }
}
