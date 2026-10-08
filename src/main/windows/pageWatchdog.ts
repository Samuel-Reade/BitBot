// The overlay page's liveness watchdog (docs/decisions/overlay.md "M1 code review": a silent renderer hang after
// pet:ready was not detected, because Chromium's 'unresponsive' comes from input acks and the overlay takes no input).
// While started, it sends a ping (pet:ping) every pingMs; a ping still unanswered when the next one is due counts as
// missed, and maxMissed missed in a row declare the page dead (onDead, once; the watchdog stops). Any answer (pet:pong)
// to a ping of this run, even a late one, resets the count: a page that answers slowly is alive. reset() forgets the
// count and starts the period again (after a system sleep, during which timers and the renderer both paused).
//
// Pure: the timers are injected (unit-tested in test/pageWatchdog.test.ts). PetWindow starts it after each pet:ready
// and stops it whenever the page goes away.

import type { Scheduler } from '../sim/loop'

export interface PageWatchdogOptions {
  scheduler: Scheduler
  /** tuning.overlay.watchdog.pingMs */
  pingMs: number
  /** tuning.overlay.watchdog.maxMissed */
  maxMissed: number
  /** Sends ping `id` to the page (failing to send counts as no answer). */
  send(id: number): void
  /** The page missed maxMissed pings in a row. */
  onDead(): void
}

export class PageWatchdog {
  private timer: unknown = undefined
  private armed = false
  private running = false
  /** The newest ping id sent (ids increase over every run, so no pong can answer a ping of an earlier run). */
  private seq = 0
  /** The first ping id of the current run. */
  private firstOfRun = 1
  /** The newest ping still unanswered; null: answered (or none sent yet). */
  private outstanding: number | null = null
  private missedInRow = 0

  constructor(private readonly opts: PageWatchdogOptions) {
    if (!(Number.isFinite(opts.pingMs) && opts.pingMs > 0)) throw new RangeError('PageWatchdog: pingMs must be > 0')
    if (!(Number.isInteger(opts.maxMissed) && opts.maxMissed >= 1)) throw new RangeError('PageWatchdog: maxMissed must be an integer >= 1')
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Pings missed in a row so far. */
  get missed(): number {
    return this.missedInRow
  }

  /** Starts pinging, the first ping pingMs from now. Restarts (count forgotten) when already running. */
  start(): void {
    this.running = true
    this.restart()
  }

  /** No more pings; answers to earlier ones are ignored. Idempotent. */
  stop(): void {
    this.running = false
    this.disarm()
    this.outstanding = null
    this.missedInRow = 0
    this.firstOfRun = this.seq + 1
  }

  /** Forgets the missed pings and starts the period again (no-op when stopped). */
  reset(): void {
    if (this.running) this.restart()
  }

  /** The page answered ping `id`. Ignored when stopped, or for an id this run never sent. */
  pong(id: number): void {
    if (!this.running || !Number.isInteger(id) || id < this.firstOfRun || id > this.seq) return
    this.missedInRow = 0
    if (id === this.outstanding) this.outstanding = null
  }

  private restart(): void {
    this.disarm()
    this.outstanding = null
    this.missedInRow = 0
    this.firstOfRun = this.seq + 1
    this.arm()
  }

  private arm(): void {
    this.armed = true
    this.timer = this.opts.scheduler.setTimeout(() => this.tick(), this.opts.pingMs)
  }

  private disarm(): void {
    if (this.armed) this.opts.scheduler.clearTimeout(this.timer)
    this.armed = false
    this.timer = undefined
  }

  private tick(): void {
    this.armed = false
    this.timer = undefined
    if (!this.running) return
    if (this.outstanding !== null) this.missedInRow++
    if (this.missedInRow >= this.opts.maxMissed) {
      this.stop()
      this.opts.onDead()
      return
    }
    const id = ++this.seq
    this.outstanding = id
    this.arm()
    this.opts.send(id)
  }
}
