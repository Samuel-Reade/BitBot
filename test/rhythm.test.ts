import { describe, expect, it } from 'vitest'
import { freshRhythm, Rhythm, type RhythmAward } from '../src/main/economy/rhythm'
import { tuning } from '../src/shared/tuning'

// The healthy rhythm (src/main/economy/rhythm.ts, BITBOT_SPEC.md §7.2 sparks, §9.3 breaks): active time, breaks seen
// in idle samples and across sleep, welcome back, healthy sessions, the morning wake, the streak, neglect.

const E = tuning.economy
const SP = E.sparks
const POLL = E.activity.idlePollS * 1000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.parse('2026-10-08T16:00:00Z')

const sparks = (awards: RhythmAward[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const a of awards) if (a.kind === 'spark') out[a.source] = (out[a.source] ?? 0) + a.amount
  return out
}

/** A Rhythm and a clock; helpers to be active or idle for a while (samples every idlePollS). */
function setup(start = T0) {
  const r = new Rhythm(freshRhythm(start), E)
  let now = start
  let lastInput = start
  const awards: RhythmAward[] = []
  return {
    r,
    get now() {
      return now
    },
    awards,
    /** Active (input every poll) for ms. */
    active(ms: number): void {
      for (let end = now + ms; now < end; ) {
        now += POLL
        lastInput = now - 1000
        awards.push(...r.idle((now - lastInput) / 1000, now))
      }
    },
    /** No input for ms, sampled. */
    idle(ms: number): void {
      for (let end = now + ms; now < end; ) {
        now += POLL
        awards.push(...r.idle((now - lastInput) / 1000, now))
      }
    },
    /** No samples at all for ms (asleep), then a wake. */
    sleep(ms: number): RhythmAward[] {
      now += ms
      lastInput = now
      const a = r.wake(now, '2026-10-08', '2026-10-07')
      awards.push(...a)
      return a
    },
    take(): RhythmAward[] {
      return awards.splice(0)
    },
  }
}

describe('active time', () => {
  it('accumulates while the idle time is under activeIdleS', () => {
    const s = setup()
    s.active(10 * MIN)
    expect(s.r.state.continuousActiveMs).toBeCloseTo(10 * MIN - POLL, -3)
    // A pause to read (idle < activeIdleS) still counts as active.
    s.idle(40_000)
    expect(s.r.state.continuousActiveMs).toBeGreaterThan(10 * MIN + 30_000)
  })

  it('stops between activeIdleS and the break, without resetting', () => {
    const s = setup()
    s.active(10 * MIN)
    const before = s.r.state.continuousActiveMs
    s.idle(3 * MIN)
    expect(s.r.state.continuousActiveMs).toBeLessThan(before + E.activity.activeIdleS * 1000)
    expect(s.r.state.continuousActiveMs).toBeGreaterThanOrEqual(before)
    s.active(MIN)
    expect(s.take()).toEqual([])
    expect(s.r.state.continuousActiveMs).toBeGreaterThan(before)
  })

  it('a late sample adds at most maxStepS', () => {
    const s = setup()
    s.r.idle(0, T0)
    s.r.idle(0, T0 + 4 * MIN) // a stalled poll (the last input "just now", gap under the break)
    expect(s.r.state.continuousActiveMs).toBe(E.activity.maxStepS * 1000)
  })

  it('lastActiveAt follows the last input', () => {
    const s = setup()
    s.r.idle(2, T0 + 10_000)
    expect(s.r.state.lastActiveAt).toBe(new Date(T0 + 8000).toISOString())
  })
})

describe('breaks (§9.3)', () => {
  it('5 min of idle resets the continuous-activity timer while the break lasts', () => {
    const s = setup()
    s.active(60 * MIN)
    expect(s.r.state.continuousActiveMs).toBeGreaterThan(59 * MIN)
    s.idle(5 * MIN + POLL)
    expect(s.r.state.continuousActiveMs).toBe(0)
    expect(s.r.state.sessionBeforeBreakMs).toBeGreaterThan(59 * MIN)
  })

  it('the return after a 10-min break: welcome back and a healthy session after ≥ 25 min of activity', () => {
    const s = setup()
    s.active(30 * MIN)
    s.idle(10 * MIN)
    expect(s.take()).toEqual([])
    s.active(POLL)
    expect(sparks(s.take())).toEqual({ welcomeBack: SP.welcomeBack.value, healthySession: SP.healthySession.value })
    expect(s.r.state.lastBreakAt).toBe(new Date(s.now).toISOString())
    expect(s.r.state.sessionBeforeBreakMs).toBe(0)
    expect(s.r.state.continuousActiveMs).toBe(0)
  })

  it('a break after a short session: welcome back only', () => {
    const s = setup()
    s.active(10 * MIN)
    s.idle(10 * MIN)
    s.active(POLL)
    expect(sparks(s.take())).toEqual({ welcomeBack: 1 })
  })

  it('a pause under 5 min is no break', () => {
    const s = setup()
    s.active(30 * MIN)
    s.idle(4 * MIN)
    s.active(POLL)
    expect(s.take()).toEqual([])
    expect(s.r.state.continuousActiveMs).toBeGreaterThan(30 * MIN)
  })

  it('a break longer than 4 h: no welcome back (but the healthy session still counts)', () => {
    const s = setup()
    s.active(30 * MIN)
    s.idle(5 * HOUR)
    s.active(POLL)
    expect(sparks(s.take())).toEqual({ healthySession: 1 })
  })

  it('a break with the Mac asleep (no samples) counts at the wake', () => {
    const s = setup()
    s.r.wake(T0, '2026-10-08', '2026-10-07') // today's first wake, out of the way
    s.take()
    s.active(30 * MIN)
    const a = s.sleep(20 * MIN)
    expect(sparks(a)).toEqual({ welcomeBack: 1, healthySession: 1 })
    // The samples after the wake don't count it again.
    s.active(MIN)
    expect(s.take().filter((x) => x.kind === 'spark' && x.source !== 'morningWake')).toHaveLength(2)
  })

  it('a break with the Mac asleep and no wake call is found by the next active sample', () => {
    const s = setup()
    s.active(30 * MIN)
    const last = s.now
    expect(sparks(s.r.idle(0, last + 30 * MIN))).toEqual({ welcomeBack: 1, healthySession: 1 })
  })

  it('daily limits: welcome back at most 6, healthy sessions at most 4', () => {
    const s = setup()
    for (let i = 0; i < 10; i++) {
      s.active(26 * MIN)
      s.idle(6 * MIN)
      s.active(POLL)
    }
    const got = sparks(s.take())
    expect(got.welcomeBack).toBe(SP.welcomeBack.maxPerDay)
    expect(got.healthySession).toBe(SP.healthySession.maxPerDay)
    expect(s.r.state.sparksToday).toMatchObject({ welcomeBack: 6, healthySession: 4 })
    // A new day resets the counts.
    s.r.newDay()
    s.active(26 * MIN)
    s.idle(6 * MIN)
    s.active(POLL)
    expect(sparks(s.take())).toEqual({ welcomeBack: 1, healthySession: 1 })
  })
})

describe('wakes, streak, neglect', () => {
  it('the first wake of the day: morning wake 3 and the streak; later wakes that day nothing', () => {
    const r = new Rhythm(freshRhythm(T0), E)
    expect(sparks(r.wake(T0, '2026-10-08', '2026-10-07'))).toEqual({ morningWake: SP.morningWake, streak: 1 })
    expect(r.wake(T0 + MIN, '2026-10-08', '2026-10-07')).toEqual([])
    expect(r.state).toMatchObject({ streakDays: 1, lastStreakDay: '2026-10-08' })
  })

  it('the streak grows one per consecutive day, capped at +5, and starts over after a missed day', () => {
    const r = new Rhythm(freshRhythm(T0), E)
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
    const streak: number[] = []
    let t = T0
    let prev = '2026-09-30'
    for (const d of days) {
      t += 3 * MIN // short gaps: no breaks, just the day's first wake
      streak.push(sparks(r.wake(t, d, prev)).streak ?? 0)
      prev = d
    }
    expect(streak).toEqual([1, 2, 3, 4, 5, 5, 5])
    expect(r.state.streakDays).toBe(7)
    // 2026-10-08 skipped.
    expect(sparks(r.wake(t + MIN, '2026-10-09', '2026-10-08')).streak).toBe(1)
  })

  it('coming back after ≥ 2 days away: neglect sparks and a returnAfterNeglect event', () => {
    const r = new Rhythm(freshRhythm(T0), E)
    const a = r.wake(T0 + 3 * DAY + HOUR, '2026-10-11', '2026-10-10')
    expect(sparks(a)).toEqual({ neglect: SP.neglect.value, morningWake: 3, streak: 1 })
    expect(a).toContainEqual({ kind: 'returnAfterNeglect', days: 3 })
    // Only once.
    expect(r.idle(0, T0 + 3 * DAY + HOUR + POLL)).toEqual([])
  })

  it('a day and a half away is no neglect', () => {
    const r = new Rhythm(freshRhythm(T0), E)
    const a = r.wake(T0 + 36 * HOUR, '2026-10-09', '2026-10-08')
    expect(a.some((x) => x.kind === 'returnAfterNeglect' || (x.kind === 'spark' && x.source === 'neglect'))).toBe(false)
  })

  it('neglect is also found by an idle sample (Mac left on, nobody there)', () => {
    const s = setup()
    s.active(MIN)
    s.idle(2 * DAY + HOUR)
    s.active(POLL)
    const a = s.take()
    expect(sparks(a)).toEqual({ neglect: 2 })
    expect(a).toContainEqual({ kind: 'returnAfterNeglect', days: 2 })
  })

  it('the dev break: a break of N minutes ending now', () => {
    const s = setup()
    s.active(30 * MIN)
    expect(sparks(s.r.injectBreak(10 * MIN, s.now))).toEqual({ welcomeBack: 1, healthySession: 1 })
    expect(s.r.state.continuousActiveMs).toBe(0)
    // The next real sample doesn't see another break.
    s.active(POLL)
    expect(s.take()).toEqual([])
  })
})
