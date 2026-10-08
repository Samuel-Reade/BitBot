// The simulation's fixed-step loop (BITBOT_SPEC.md §5.1): wakes on a timer, runs every step that is due on a
// FixedStepClock grid, and re-arms for the next one. Main runs it at tuning.sim.hz; the overlay renders one step
// behind main's clock and interpolates between the states it is sent (src/shared/interpolation.ts).
//
// A wake with steps due calls beforeSteps once (sample the inputs), onStep once per step (oldest first), then
// afterSteps once (react to the new state). A hook that throws is reported to onError and the loop carries on: the
// remaining steps still run and the timer is always re-armed, so one bad step can never freeze the pet. A wake that
// finds no step due (its timer fired early) calls nothing and re-arms. stop() parks the loop; start() re-anchors the
// grid at the current time, so time spent parked is skipped, never replayed in a burst.
//
// SPEC-DEVIATION: §5.1 computes a step once real time has reached it. Electron main-process timers
// run several ms late, which starved presentation (rendered one step behind real time) in 4-8 % of
// frames in Spike A, so steps are computed up to leadMs early; they keep their nominal times and the
// render time is unchanged. The delay is rounded up because Node schedules timers on its cached
// millisecond loop clock and can fire a fraction of a ms early; an early wake finds no step due and
// re-arms. Rare after rounding, not impossible.
//
// Pure: no Electron. The clock and the timers are injected, so tests drive both by hand.

import { tuning } from '../../shared/tuning'
import type { Clock } from './clock'
import { FixedStepClock } from './fixedStep'

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** The global setTimeout/clearTimeout (Node's timers in main). */
export const globalScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type SimLoopHook = 'beforeSteps' | 'onStep' | 'afterSteps'

export interface SimLoopOptions {
  clock: Clock
  /** Default: the global setTimeout/clearTimeout. */
  scheduler?: Scheduler
  /** Step length, ms (1000 / tuning.sim.hz). */
  stepMs: number
  /** tuning.sim.leadMs: steps are computed up to this many ms before their nominal time (see the header). */
  leadMs: number
  /** tuning.sim.maxStepsPerWake: a wake that owes more steps drops the oldest excess (after a stall). */
  maxStepsPerWake: number
  /** Once per wake with steps due, before them (sample the cursor and the held point). stepTimes: nominal times, oldest first. */
  beforeSteps?(wakeMs: number, stepTimes: readonly number[]): void
  /** One step: advance the world by dtS to nominal time t (ms on clock). */
  onStep(dtS: number, t: number): void
  /** Once per wake that ran ≥ 1 step, after them (grab area, safety net, state sending). */
  afterSteps?(wakeMs: number, steps: number): void
  /** A hook threw; the loop keeps running. Default: console.error with the hook name. */
  onError?(err: unknown, where: SimLoopHook): void
}

/** The loop timing configured in tuning.sim. */
export function defaultSimTiming(): Pick<SimLoopOptions, 'stepMs' | 'leadMs' | 'maxStepsPerWake'> {
  const t = tuning.sim
  return { stepMs: 1000 / t.hz, leadMs: t.leadMs, maxStepsPerWake: t.maxStepsPerWake }
}

/** For failures that have no hook to report to (the error handler itself, a broken clock). */
function lastResort(what: string, ...errors: unknown[]): void {
  try {
    console.error(`[bitbot] sim loop: ${what}:`, ...errors)
  } catch {
    // Nothing left to tell.
  }
}

export class SimLoop {
  readonly stepMs: number
  private readonly leadMs: number
  private readonly maxStepsPerWake: number
  private readonly clock: Clock
  private readonly scheduler: Scheduler
  /** The hooks are called on this object, so hook methods keep their `this`. */
  private readonly opts: SimLoopOptions

  private grid: FixedStepClock
  /** Steps dropped on the grids of earlier runs (start() re-anchors on a new grid). */
  private droppedBefore = 0
  private steps = 0
  private latest: number
  private wakes = 0
  private emptyWakes = 0

  private isRunning = false
  /** Increments per start(): a wake from an earlier run must not call hooks once the loop was restarted. */
  private run = 0
  /** Token of the armed timer (0: none). A wake whose token is not this one is stale and does nothing. */
  private armedToken = 0
  private tokenSeq = 0
  private timerHandle: unknown = undefined

  constructor(opts: SimLoopOptions) {
    if (!(Number.isFinite(opts.leadMs) && opts.leadMs >= 0)) throw new RangeError('SimLoop: leadMs must be a finite number >= 0')
    this.opts = opts
    this.stepMs = opts.stepMs
    this.leadMs = opts.leadMs
    this.maxStepsPerWake = opts.maxStepsPerWake
    this.clock = opts.clock
    this.scheduler = opts.scheduler ?? globalScheduler
    // Validates stepMs and maxStepsPerWake. Until the first start() the grid is anchored at construction.
    this.grid = new FixedStepClock(this.stepMs, opts.clock.now(), this.maxStepsPerWake)
    this.latest = this.grid.latestStepTime
  }

  /**
   * Starts the loop (idempotent while running). Each start anchors a fresh step grid at clock.now(), or at the newest
   * step time if that is later (steps run up to leadMs ahead), so nominal times never go backwards and the time the
   * loop was parked is skipped: un-parking after a hide never bursts through catch-up steps.
   */
  start(): void {
    if (this.isRunning) return
    const now = this.readClock()
    const anchor = Number.isFinite(now) ? Math.max(now, this.latest) : this.latest
    const grid = new FixedStepClock(this.stepMs, anchor, this.maxStepsPerWake)
    this.droppedBefore += this.grid.droppedSteps
    this.grid = grid
    this.latest = anchor
    this.isRunning = true
    this.run += 1
    this.arm()
  }

  /**
   * Parks the loop: no further wakes and no further hook calls, also when called from inside a hook (the rest of
   * that wake's steps and its afterSteps are skipped). Idempotent.
   */
  stop(): void {
    if (!this.isRunning) return
    this.isRunning = false
    if (this.armedToken !== 0) {
      this.armedToken = 0
      this.scheduler.clearTimeout(this.timerHandle)
    }
    this.timerHandle = undefined
  }

  get running(): boolean {
    return this.isRunning
  }

  /** Steps run (onStep called, whether or not it threw), over every run. */
  get stepCount(): number {
    return this.steps
  }

  /** Steps skipped because a wake owed more than maxStepsPerWake (process stalled), over every run. */
  get droppedSteps(): number {
    return this.droppedBefore + this.grid.droppedSteps
  }

  /** Nominal time of the newest step run, or of the last start() anchor if none ran since (ms on clock). */
  get latestStepTime(): number {
    return this.latest
  }

  /** Timer wakes handled. */
  get wakeCount(): number {
    return this.wakes
  }

  /** Wakes that found no step due (the timer fired early) and only re-armed. */
  get emptyWakeCount(): number {
    return this.emptyWakes
  }

  private arm(): void {
    const now = this.readClock()
    // A broken clock reading must neither stop the loop nor make it spin: try again a step later.
    const ms = Math.ceil(Number.isFinite(now) ? this.grid.msUntilNextStep(now + this.leadMs) : this.stepMs)
    const token = ++this.tokenSeq
    this.armedToken = token
    this.timerHandle = this.scheduler.setTimeout(() => this.wake(token), ms)
  }

  private wake(token: number): void {
    if (token !== this.armedToken) return
    this.armedToken = 0
    this.timerHandle = undefined
    this.wakes += 1
    try {
      const wakeMs = this.readClock()
      // Steps may be computed up to leadMs early (see the header); they keep their nominal times.
      const times = Number.isFinite(wakeMs) ? this.grid.advance(wakeMs + this.leadMs) : []
      if (times.length === 0) this.emptyWakes += 1
      else this.runSteps(this.run, wakeMs, times)
    } finally {
      // Re-arm unless a hook stopped the loop, or stopped and restarted it (start() armed already).
      if (this.isRunning && this.armedToken === 0) this.arm()
    }
  }

  private runSteps(run: number, wakeMs: number, times: readonly number[]): void {
    const live = (): boolean => this.isRunning && this.run === run
    const opts = this.opts
    try {
      opts.beforeSteps?.(wakeMs, times)
    } catch (err) {
      this.report(err, 'beforeSteps')
    }
    const dtS = this.stepMs / 1000
    for (const t of times) {
      if (!live()) return
      this.steps += 1
      this.latest = t
      try {
        opts.onStep(dtS, t)
      } catch (err) {
        this.report(err, 'onStep')
      }
    }
    if (!live()) return
    try {
      opts.afterSteps?.(wakeMs, times.length)
    } catch (err) {
      this.report(err, 'afterSteps')
    }
  }

  private report(err: unknown, where: SimLoopHook): void {
    try {
      if (this.opts.onError) this.opts.onError(err, where)
      else console.error(`[bitbot] sim loop: ${where} threw:`, err)
    } catch (failure) {
      lastResort(`${where} threw and reporting it failed`, err, failure)
    }
  }

  private readClock(): number {
    try {
      return this.clock.now()
    } catch (err) {
      lastResort('the clock threw', err)
      return Number.NaN
    }
  }
}
