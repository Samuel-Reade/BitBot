// Runs a callback once a burst of triggers has gone quiet (pure; unit-tested in test/appSupport.test.ts). Display
// changes arrive in bursts (display-added, then several display-metrics-changed), and the overlay is laid out again
// once, tuning.overlay.displayChangeDebounceMs after the last of them. The timers are injected (the SimLoop's
// Scheduler), so tests drive them by hand.

import { globalScheduler, type Scheduler } from './sim/loop'

export class Debouncer {
  private handle: unknown = undefined
  private armed = false

  constructor(
    private readonly delayMs: number,
    private readonly fn: () => void,
    private readonly scheduler: Scheduler = globalScheduler,
  ) {}

  /** (Re)starts the quiet period: `fn` runs delayMs after the last trigger. */
  trigger(): void {
    this.cancel()
    this.armed = true
    this.handle = this.scheduler.setTimeout(() => {
      this.armed = false
      this.handle = undefined
      this.fn()
    }, this.delayMs)
  }

  /** Drops a pending run. Idempotent. */
  cancel(): void {
    if (!this.armed) return
    this.armed = false
    this.scheduler.clearTimeout(this.handle)
    this.handle = undefined
  }

  /** A run is pending. */
  get pending(): boolean {
    return this.armed
  }
}
