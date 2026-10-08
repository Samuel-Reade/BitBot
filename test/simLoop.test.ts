import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemClock, type Clock } from '../src/main/sim/clock'
import { FixedStepClock } from '../src/main/sim/fixedStep'
import { defaultSimTiming, SimLoop, type Scheduler, type SimLoopHook, type SimLoopOptions } from '../src/main/sim/loop'
import { tuning } from '../src/shared/tuning'

// The simulation's timebase and loop (BITBOT_SPEC.md §5.1, §14.2), driven by a hand-cranked clock and timer queue.

const STEP = 1000 / 30
const LEAD = 8
const MAX_STEPS = 5

/** Seeded uniform [0, 1) (Park–Miller), so the jittery runs are reproducible. */
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

interface FakeTimer {
  id: number
  at: number
  fn: () => void
}

/**
 * A clock and timer queue that move only when the test says so. A timer fires at its due time plus `lateness()`
 * (main-process timers run late). Throws if timers keep firing without time passing (a loop spinning on zero delays).
 */
class FakeTime implements Clock, Scheduler {
  private t: number
  private nextId = 1
  private readonly timers = new Map<number, FakeTimer>()
  private firesAtSameTime = 0
  /** Every delay the loop asked for, in order. */
  readonly delays: number[] = []
  lateness: () => number = () => 0

  constructor(start = 0) {
    this.t = start
  }

  now(): number {
    return this.t
  }

  wallNow(): number {
    return 1_760_000_000_000 + this.t
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.delays.push(ms)
    this.timers.set(id, { id, at: this.t + ms + this.lateness(), fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  get pending(): number {
    return this.timers.size
  }

  /** Due time of the earliest pending timer. */
  get nextDue(): number | undefined {
    return this.earliest()?.at
  }

  /** Time passes and no timer fires (the loop is parked, or the process is stalled). */
  pass(ms: number): void {
    this.t += ms
  }

  /** Fires the earliest timer at `at` (default: its due time; early or late on request). False if none is pending. */
  fireNext(at?: number): boolean {
    const next = this.earliest()
    if (!next) return false
    this.timers.delete(next.id)
    const fireAt = Math.max(this.t, at ?? next.at)
    this.firesAtSameTime = fireAt === this.t ? this.firesAtSameTime + 1 : 0
    if (this.firesAtSameTime > 1000) throw new Error('FakeTime: timers keep firing without time passing')
    this.t = fireAt
    next.fn()
    return true
  }

  /** Fires timers at their due times while they are due by `until`, then moves the clock to `until`. */
  runUntil(until: number): void {
    for (let next = this.earliest(); next && next.at <= until; next = this.earliest()) this.fireNext()
    this.t = Math.max(this.t, until)
  }

  private earliest(): FakeTimer | undefined {
    let best: FakeTimer | undefined
    for (const timer of this.timers.values()) if (!best || timer.at < best.at) best = timer
    return best
  }
}

interface StepRecord {
  dtS: number
  /** Nominal time. */
  t: number
  /** Clock when it was computed. */
  at: number
}

/** A loop on `time` at 30 Hz with an 8 ms lead that records its steps and hook calls. */
function makeLoop(time: FakeTime, overrides: Partial<SimLoopOptions> = {}) {
  const steps: StepRecord[] = []
  const calls: string[] = []
  const errors: { where: SimLoopHook; message: string }[] = []
  const loop = new SimLoop({
    clock: time,
    scheduler: time,
    stepMs: STEP,
    leadMs: LEAD,
    maxStepsPerWake: MAX_STEPS,
    beforeSteps: (wakeMs, stepTimes) => calls.push(`before ${wakeMs} [${stepTimes.join(', ')}]`),
    onStep: (dtS, t) => {
      steps.push({ dtS, t, at: time.now() })
      calls.push(`step ${t}`)
    },
    afterSteps: (wakeMs, n) => calls.push(`after ${wakeMs} ${n}`),
    onError: (err, where) => errors.push({ where, message: err instanceof Error ? err.message : String(err) }),
    ...overrides,
  })
  return { loop, steps, calls, errors }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('systemClock', () => {
  it('reads a monotonic clock and the wall clock', () => {
    const a = systemClock.now()
    const b = systemClock.now()
    expect(b).toBeGreaterThanOrEqual(a)
    expect(Math.abs(systemClock.wallNow() - Date.now())).toBeLessThan(1000)
  })
})

describe('FixedStepClock', () => {
  it('runs whole steps only, stamped on the fixed grid', () => {
    const clock = new FixedStepClock(10, 0, 5)
    expect(clock.advance(9.99)).toEqual([])
    expect(clock.advance(25)).toEqual([10, 20])
    expect(clock.advance(29)).toEqual([])
    expect(clock.msUntilNextStep(29)).toBeCloseTo(1)
    expect(clock.advance(30)).toEqual([30])
    expect(clock.stepCount).toBe(3)
    expect(clock.latestStepTime).toBe(30)
  })

  it('drops (does not replay) time beyond maxStepsPerAdvance', () => {
    const clock = new FixedStepClock(10, 0, 5)
    expect(clock.advance(100)).toEqual([60, 70, 80, 90, 100])
    expect(clock.droppedSteps).toBe(5)
    expect(clock.stepCount).toBe(5)
    expect(clock.latestStepTime).toBe(100)
    expect(clock.advance(110)).toEqual([110])
  })

  it('is drift-free under timer jitter', () => {
    const clock = new FixedStepClock(STEP, 0, 5)
    const rand = lcg(7)
    let now = 0
    while (now < 60_000) {
      now += clock.msUntilNextStep(now) + rand() * 12 // timers fire 0-12 ms late
      clock.advance(now)
    }
    expect(clock.stepCount).toBe(Math.floor(now / STEP))
    expect(clock.droppedSteps).toBe(0)
  })

  it('keeps every nominal time exactly on the grid, even after an hour of jittery wakes', () => {
    const start = 1234.5
    const clock = new FixedStepClock(STEP, start, 5)
    const rand = lcg(11)
    let now = start
    let k = 0
    let offGrid = 0
    while (now < start + 3_600_000) {
      now += clock.msUntilNextStep(now) + rand() * 12
      for (const t of clock.advance(now)) {
        k += 1
        if (t !== start + k * STEP) offGrid++
      }
    }
    expect(offGrid).toBe(0)
    expect(k).toBe(clock.stepCount)
    expect(clock.latestStepTime).toBe(start + k * STEP)
  })

  it('agrees with msUntilNextStep at exact step boundaries, so a re-armed timer is never 0 ms', () => {
    // Step times like 0.1 + k·(1000/30) are where the division in advance() can round the wrong way.
    const start = 0.1
    const clock = new FixedStepClock(STEP, start, 5)
    for (let k = 0; k < 3000; k += 2) {
      // Two steps due at once, the second exactly at `now`.
      const now = start + (k + 2) * STEP
      expect(clock.msUntilNextStep(now)).toBe(0)
      expect(clock.advance(now)).toEqual([start + (k + 1) * STEP, now])
      expect(clock.msUntilNextStep(now)).toBeGreaterThan(0)
      expect(clock.advance(now)).toEqual([])
    }
  })

  it('ignores a time that is not finite and rejects a bad configuration', () => {
    const clock = new FixedStepClock(10, 0, 5)
    expect(clock.advance(Number.NaN)).toEqual([])
    expect(clock.advance(Number.POSITIVE_INFINITY)).toEqual([])
    expect(clock.advance(10)).toEqual([10])
    expect(clock.stepCount).toBe(1)
    expect(() => new FixedStepClock(0, 0, 5)).toThrow(RangeError)
    expect(() => new FixedStepClock(Number.POSITIVE_INFINITY, 0, 5)).toThrow(RangeError)
    expect(() => new FixedStepClock(10, Number.NaN, 5)).toThrow(RangeError)
    expect(() => new FixedStepClock(10, 0, 0)).toThrow(RangeError)
    expect(() => new FixedStepClock(10, 0, 2.5)).toThrow(RangeError)
  })
})

describe('SimLoop', () => {
  it('takes its timing from tuning.sim', () => {
    const { hz, leadMs, maxStepsPerWake } = tuning.sim
    expect(defaultSimTiming()).toEqual({ stepMs: 1000 / hz, leadMs, maxStepsPerWake })
  })

  it('runs at 30 Hz on average over a long run with late timers: one step per grid time, none skipped or repeated', () => {
    const time = new FakeTime(5000)
    const rand = lcg(3)
    time.lateness = () => rand() * 12
    const { loop, steps, errors } = makeLoop(time)
    loop.start()
    const runMs = 10 * 60_000
    time.runUntil(5000 + runMs)
    expect(errors).toEqual([])
    expect(loop.droppedSteps).toBe(0)
    expect(Math.abs(steps.length / (runMs / 1000) - 30)).toBeLessThan(0.01)
    expect(steps.every((s, i) => s.t === 5000 + (i + 1) * STEP && s.dtS === STEP / 1000)).toBe(true)
    expect(loop.stepCount).toBe(steps.length)
    expect(loop.latestStepTime).toBe(steps[steps.length - 1]?.t)
  })

  it('computes each step up to leadMs before its nominal time', () => {
    const time = new FakeTime()
    const { loop, steps } = makeLoop(time)
    loop.start()
    time.runUntil(2000)
    expect(steps.length).toBeGreaterThan(55)
    // Timers on time: the delay is rounded up to whole ms, so each step is computed (leadMs − 1, leadMs] early.
    for (const s of steps) {
      expect(s.t - s.at).toBeLessThanOrEqual(LEAD)
      expect(s.t - s.at).toBeGreaterThan(LEAD - 1)
    }
  })

  it('absorbs timer lateness below the lead: no step is computed after its nominal time', () => {
    const late = (leadMs: number): StepRecord[] => {
      const time = new FakeTime()
      time.lateness = () => 6
      const { loop, steps } = makeLoop(time, { leadMs })
      loop.start()
      time.runUntil(2000)
      return steps
    }
    expect(late(LEAD).every((s) => s.at < s.t)).toBe(true)
    // Without the lead every one of them would be late (the overlay, one step behind, would starve).
    expect(late(0).every((s) => s.at > s.t)).toBe(true)
  })

  it('asks for whole-ms delays, ceil(msUntilNextStep(now + leadMs)), and never 0 after a wake', () => {
    const time = new FakeTime()
    const { loop } = makeLoop(time)
    loop.start()
    time.runUntil(3000)
    // start at 0: ceil(33.33 − 8) = 26; wake 26: ceil(66.67 − 34) = 33; wake 59: ceil(100 − 67) = 33;
    // wake 92 computes the step at 100 exactly leadMs early: ceil(133.33 − 100) = 34.
    expect(time.delays.slice(0, 4)).toEqual([26, 33, 33, 34])
    expect(time.delays.every((d) => Number.isInteger(d) && d >= 1)).toBe(true)
  })

  it('an early wake finds no step, calls no hook and re-arms', () => {
    const time = new FakeTime()
    const { loop, calls } = makeLoop(time)
    loop.start()
    expect(time.nextDue).toBe(26)
    time.fireNext(25) // Node can fire a fraction of a ms early; here a whole one
    expect(calls).toEqual([])
    expect(loop.emptyWakeCount).toBe(1)
    expect(time.pending).toBe(1)
    expect(time.nextDue).toBe(26)
    time.fireNext()
    expect(calls).toEqual([`before 26 [${STEP}]`, `step ${STEP}`, 'after 26 1'])
    expect(loop.wakeCount).toBe(2)
  })

  it('calls beforeSteps, then onStep per due step (oldest first), then afterSteps, with the wake time', () => {
    const time = new FakeTime()
    const { loop, calls, steps } = makeLoop(time)
    loop.start()
    time.fireNext(96) // 70 ms late: three steps due (lead included)
    const due = [STEP, 2 * STEP, 3 * STEP]
    expect(calls).toEqual([`before 96 [${due.join(', ')}]`, ...due.map((t) => `step ${t}`), 'after 96 3'])
    expect(steps.map((s) => s.dtS)).toEqual([STEP / 1000, STEP / 1000, STEP / 1000])
    expect(loop.latestStepTime).toBe(3 * STEP)
  })

  it('drops the oldest excess steps after a stall instead of bursting through them, then is back on schedule', () => {
    const time = new FakeTime()
    const { loop, calls, steps } = makeLoop(time)
    loop.start()
    time.fireNext() // wake 26: step 1
    time.fireNext(1000) // due at 59, fires at 1000: steps 2..30 are due
    expect(loop.droppedSteps).toBe(24)
    expect(steps.map((s) => s.t)).toEqual([1, 26, 27, 28, 29, 30].map((k) => k * STEP))
    expect(calls).toContain(`before 1000 [${[26, 27, 28, 29, 30].map((k) => k * STEP).join(', ')}]`)
    expect(calls[calls.length - 1]).toBe(`after 1000 ${MAX_STEPS}`)
    time.fireNext()
    expect(steps.map((s) => s.t).slice(-1)).toEqual([31 * STEP])
    expect(loop.stepCount).toBe(7)
    expect(loop.droppedSteps).toBe(24)
  })

  it('reports a throwing hook to onError and keeps stepping', () => {
    const time = new FakeTime()
    let wake = 0
    const ran: number[] = []
    let afters = 0
    const { loop, errors } = makeLoop(time, {
      beforeSteps: () => {
        wake++
        if (wake === 1) throw new Error('before failed')
      },
      onStep: (_dtS, t) => {
        ran.push(t)
        if (ran.length === 2) throw new Error('step failed')
      },
      afterSteps: () => {
        afters++
        if (wake === 2) throw new Error('after failed')
      },
    })
    loop.start()
    time.fireNext(96) // three steps; the second throws
    expect(ran).toEqual([STEP, 2 * STEP, 3 * STEP])
    expect(afters).toBe(1)
    time.fireNext() // afterSteps throws
    time.fireNext()
    expect(errors).toEqual([
      { where: 'beforeSteps', message: 'before failed' },
      { where: 'onStep', message: 'step failed' },
      { where: 'afterSteps', message: 'after failed' },
    ])
    expect(ran).toHaveLength(5)
    expect(afters).toBe(3)
    expect(time.pending).toBe(1)
    expect(loop.running).toBe(true)
  })

  it('keeps stepping when onError itself throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const time = new FakeTime()
    const failing = new Error('step failed')
    let stepsRun = 0
    const { loop } = makeLoop(time, {
      onStep: () => {
        stepsRun++
        throw failing
      },
      onError: () => {
        throw new Error('handler failed')
      },
    })
    loop.start()
    time.runUntil(1000)
    expect(stepsRun).toBe(30)
    expect(time.pending).toBe(1)
    const message = expect.stringContaining('onStep threw and reporting it failed')
    expect(consoleError).toHaveBeenCalledWith(message, failing, expect.any(Error))
  })

  it('reports to console.error with the hook name when no onError is given', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const time = new FakeTime()
    const failing = new Error('step failed')
    const loop = new SimLoop({
      clock: time,
      scheduler: time,
      stepMs: STEP,
      leadMs: LEAD,
      maxStepsPerWake: MAX_STEPS,
      onStep: () => {
        throw failing
      },
    })
    loop.start()
    time.runUntil(100)
    expect(loop.stepCount).toBe(3)
    expect(consoleError).toHaveBeenCalledTimes(3)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('onStep threw'), failing)
  })

  it.each([
    { hook: 'beforeSteps', ran: 0, after: false },
    { hook: 'onStep', ran: 1, after: false },
    { hook: 'afterSteps', ran: 3, after: true },
  ] as const)('stop() inside $hook parks the loop at once', ({ hook, ran, after }) => {
    const time = new FakeTime()
    let afterCalled = false
    const steps: number[] = []
    const fixture = makeLoop(time, {
      beforeSteps: () => {
        if (hook === 'beforeSteps') fixture.loop.stop()
      },
      onStep: (_dtS, t) => {
        steps.push(t)
        if (hook === 'onStep') fixture.loop.stop()
      },
      afterSteps: () => {
        afterCalled = true
        if (hook === 'afterSteps') fixture.loop.stop()
      },
    })
    const { loop, errors } = fixture
    loop.start()
    time.fireNext(96) // three steps due
    expect(steps).toHaveLength(ran)
    expect(afterCalled).toBe(after)
    expect(loop.running).toBe(false)
    expect(time.pending).toBe(0)
    expect(loop.stepCount).toBe(ran)
    expect(loop.latestStepTime).toBe(ran * STEP)
    time.runUntil(5000)
    expect(steps).toHaveLength(ran)
    expect(errors).toEqual([])
  })

  it('stop() then start() inside a hook leaves exactly one timer and continues the same grid', () => {
    const time = new FakeTime()
    let restarted = false
    const fixture = makeLoop(time, {
      afterSteps: () => {
        if (restarted) return
        restarted = true
        fixture.loop.stop()
        fixture.loop.start()
      },
    })
    const { loop, steps } = fixture
    loop.start()
    for (let i = 0; i < 60; i++) {
      time.fireNext()
      expect(time.pending).toBe(1)
    }
    // The restart anchored at the newest step (computed early, so later than the clock): no repeat, no gap.
    expect(steps).toHaveLength(60)
    expect(steps.every((s, i) => Math.abs(s.t - (i + 1) * STEP) < 1e-9)).toBe(true)
  })

  it('stop() cancels the pending wake; start() is idempotent while running', () => {
    const time = new FakeTime()
    const { loop, steps } = makeLoop(time)
    loop.start()
    loop.start()
    expect(time.pending).toBe(1)
    expect(time.delays).toHaveLength(1)
    loop.stop()
    loop.stop()
    expect(time.pending).toBe(0)
    time.runUntil(1000)
    expect(steps).toEqual([])
    expect(loop.running).toBe(false)
  })

  it('start() after stop() re-anchors at the clock: the parked time is skipped, not replayed', () => {
    const time = new FakeTime()
    const { loop, steps } = makeLoop(time)
    loop.start()
    time.runUntil(1000)
    const before = steps.length
    loop.stop()
    time.pass(10_000) // hidden for 10 s
    loop.start()
    expect(loop.latestStepTime).toBe(11_000)
    time.fireNext()
    expect(steps.length).toBe(before + 1)
    expect(steps[steps.length - 1]?.t).toBe(11_000 + STEP)
    expect(loop.droppedSteps).toBe(0)
    expect(loop.stepCount).toBe(before + 1)
  })

  it('never moves nominal time backwards across a quick stop and start', () => {
    const time = new FakeTime()
    const { loop, steps } = makeLoop(time)
    loop.start()
    time.fireNext() // wake 26 computes the step at 33.33, ahead of the clock
    loop.stop()
    loop.start()
    expect(time.now()).toBe(26)
    expect(loop.latestStepTime).toBe(STEP)
    time.fireNext()
    expect(steps.map((s) => s.t)).toEqual([STEP, 2 * STEP])
  })

  it('survives a clock that returns NaN or throws: no steps while broken, no spinning, back to work after', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const time = new FakeTime()
    let mode: 'ok' | 'nan' | 'throws' = 'ok'
    const clock: Clock = {
      now: () => {
        if (mode === 'throws') throw new Error('clock failed')
        return mode === 'nan' ? Number.NaN : time.now()
      },
      wallNow: () => time.wallNow(),
    }
    const { loop, steps } = makeLoop(time, { clock })
    loop.start()
    time.runUntil(500)
    const healthy = steps.length
    mode = 'nan'
    time.runUntil(1000)
    mode = 'throws'
    time.runUntil(1500)
    expect(steps.length).toBe(healthy)
    expect(loop.running).toBe(true)
    expect(time.pending).toBe(1)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('the clock threw'), expect.any(Error))
    mode = 'ok'
    time.runUntil(2500)
    expect(steps.length).toBeGreaterThan(healthy + 25)
  })

  it('works on the global timers by default', () => {
    vi.useFakeTimers()
    const clock: Clock = { now: () => Date.now(), wallNow: () => Date.now() }
    let stepsRun = 0
    const loop = new SimLoop({ clock, ...defaultSimTiming(), onStep: () => stepsRun++ })
    loop.start()
    vi.advanceTimersByTime(1000)
    expect(stepsRun).toBeGreaterThanOrEqual(29)
    expect(stepsRun).toBeLessThanOrEqual(31)
    loop.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a bad configuration', () => {
    const time = new FakeTime()
    const base = { clock: time, scheduler: time, stepMs: STEP, leadMs: LEAD, maxStepsPerWake: MAX_STEPS, onStep: () => {} }
    expect(() => new SimLoop({ ...base, leadMs: -1 })).toThrow(RangeError)
    expect(() => new SimLoop({ ...base, leadMs: Number.NaN })).toThrow(RangeError)
    expect(() => new SimLoop({ ...base, stepMs: 0 })).toThrow(RangeError)
    expect(() => new SimLoop({ ...base, maxStepsPerWake: 0 })).toThrow(RangeError)
  })
})
