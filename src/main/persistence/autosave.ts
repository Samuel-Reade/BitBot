// When the save is written (BITBOT_SPEC.md §16 "autosave every 60 s, on mode/settings change, on suspend, and on
// quit"). The glue calls changed() on a mode or settings change and flush() on suspend and quit; write() is the glue's
// "assemble the save and SaveStore.write it".
//   - every everyMs (tuning.persistence.autosaveEveryMs) while started;
//   - changed(): debounceMs (changeDebounceMs) after the last of a burst of changes (a slider drag writes once);
//     continuous changes still get written by the periodic save;
//   - flush(): now (suspend, quit), started or not; drops a pending change save.
// Every write restarts the periodic wait (the next periodic save comes everyMs after the last write of any kind). A
// throwing write() is reported to onError and the schedule carries on. Pure: the timers are injected (the SimLoop's Scheduler).

import type { Scheduler } from '../sim/loop'

export interface AutosaverOptions {
  everyMs: number
  debounceMs: number
  write: () => void
  scheduler: Scheduler
  onError?: (error: unknown) => void
}

export class Autosaver {
  private periodic: unknown = undefined
  private debounce: unknown = undefined
  private started = false

  constructor(private readonly opts: AutosaverOptions) {}

  /** Starts the periodic save (the first one everyMs from now). Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.armPeriodic()
  }

  /** Stops all timers without writing (flush() first to save). */
  stop(): void {
    this.started = false
    this.clearPeriodic()
    this.clearDebounce()
  }

  /** A mode or settings change: write soon, once the burst has gone quiet. Ignored while stopped. */
  changed(): void {
    if (!this.started) return
    this.clearDebounce()
    this.debounce = this.opts.scheduler.setTimeout(() => {
      this.debounce = undefined
      this.writeNow()
    }, this.opts.debounceMs)
  }

  /** Write now (suspend, quit). */
  flush(): void {
    this.clearDebounce()
    this.writeNow()
  }

  /** A change save is waiting. */
  get pending(): boolean {
    return this.debounce !== undefined
  }

  private writeNow(): void {
    try {
      this.opts.write()
    } catch (e) {
      this.opts.onError?.(e)
    }
    if (this.started) this.armPeriodic()
  }

  private armPeriodic(): void {
    this.clearPeriodic()
    this.periodic = this.opts.scheduler.setTimeout(() => {
      this.periodic = undefined
      this.writeNow()
    }, this.opts.everyMs)
  }

  private clearPeriodic(): void {
    if (this.periodic === undefined) return
    this.opts.scheduler.clearTimeout(this.periodic)
    this.periodic = undefined
  }

  private clearDebounce(): void {
    if (this.debounce === undefined) return
    this.opts.scheduler.clearTimeout(this.debounce)
    this.debounce = undefined
  }
}
