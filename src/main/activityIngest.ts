// Activity ingest (BITBOT_SPEC.md §5.1 ActivityIngest, §7.1): every raw activity source, fed to the economy. Pure apart
// from what is injected (no Electron imports; unit-tested with fakes in test/activityIngest.test.ts).
// - Keys, clicks and scrolls: bitbot-helper's listen-only tap (decided: Input Monitoring only; without it nothing is
//   counted from them). Key codes and buttons go straight to the economy's in-memory anti-gaming and nowhere else:
//   never logged, never kept (§2).
// - Mouse travel: the cursor sampled at tuning.economy.cursorPollHz while it moves (no permission needed). M9 (§11):
//   once it has not moved for cursorStillAfterMs, cursorStillHz (distance is summed between samples, so the first
//   sample of the next move still counts all of it); on battery with the pet asleep (§11 "pause the cursor-distance
//   poll"), cursorPausedHz.
// - App launches and activations: the helper's NSWorkspace notifications (bundle IDs only; Bitbot's own ignored).
// - Breaks: the system idle time every tuning.economy.activity.idlePollS.
// - Wake: Bitbot starting, the Mac waking, the screen unlocking.

import type { Point } from '../shared/geometry'
import type { DevInject } from '../shared/economy'
import type { InputMsg } from './helper/protocol'
import type { Scheduler } from './sim/loop'

/** The economy's inputs (src/main/economy/economy.ts implements them). */
export interface ActivitySink {
  key(code: number, down: boolean, repeat: boolean): void
  click(button: number): void
  scroll(s: { lines: number; px: number; linesX: number; pxX: number; continuous: boolean; momentum: boolean }): void
  cursor(x: number, y: number): void
  appLaunched(bundleId: string): void
  appActivated(bundleId: string): void
  idle(idleS: number): void
  wake(): void
  setInputCounting(on: boolean): void
  inject(i: DevInject): void
}

export interface ActivityIngestOptions {
  sink: ActivitySink
  scheduler: Scheduler
  /** The cursor, global pt (Electron's screen.getCursorScreenPoint). */
  cursor(): Point
  /** Seconds since the last user input, system-wide (powerMonitor.getSystemIdleTime). */
  systemIdleS(): number
  cursorPollHz: number
  /** M9: the poll rate once the cursor has been still for cursorStillAfterMs, Hz. Default: cursorPollHz. */
  cursorStillHz?: number
  cursorStillAfterMs?: number
  /** M9: the rate while cursorPaused() (on battery, the pet asleep), Hz. Default: cursorStillHz. */
  cursorPausedHz?: number
  cursorPaused?(): boolean
  idlePollS: number
  /** Bitbot's own bundle ID and pid: its own launches and activations are not activity. */
  ownBundleId: string | null
  ownPid: number
  /** Errors from a source (reported, never thrown at the timer). */
  onError(err: unknown, where: string): void
}

export class ActivityIngest {
  private cursorTimer: unknown = null
  /** The newest cursor sample, and how many polls in a row found it there (the still rate after cursorStillAfterMs). */
  private lastCursor: Point | null = null
  private stillPolls = 0
  private idleTimer: unknown = null
  private running = false

  constructor(private readonly opts: ActivityIngestOptions) {}

  get isRunning(): boolean {
    return this.running
  }

  /** Starts the cursor and idle polls and counts a wake (Bitbot starting). Idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    this.safely('wake', () => this.opts.sink.wake())
    this.scheduleCursor()
    this.scheduleIdle()
  }

  stop(): void {
    this.running = false
    const s = this.opts.scheduler
    if (this.cursorTimer !== null) s.clearTimeout(this.cursorTimer)
    if (this.idleTimer !== null) s.clearTimeout(this.idleTimer)
    this.cursorTimer = null
    this.idleTimer = null
  }

  /** A helper `input` message: keys, mouse presses and scrolls (the tap only runs with Input Monitoring granted). */
  input(m: InputMsg): void {
    if (!this.running) return
    const sink = this.opts.sink
    this.safely('input', () => {
      if (m.kind === 'key') sink.key(m.code, m.down, m.repeat)
      else if (m.kind === 'mouseDown') sink.click(m.button)
      else sink.scroll({ lines: m.lines, px: m.px, linesX: m.linesX, pxX: m.pxX, continuous: m.continuous, momentum: m.momentum })
    })
  }

  appLaunched(bundleId: string | null, pid: number): void {
    if (!this.running || !this.counts(bundleId, pid)) return
    this.safely('appLaunched', () => this.opts.sink.appLaunched(bundleId as string))
  }

  appActivated(bundleId: string | null, pid: number): void {
    if (!this.running || !this.counts(bundleId, pid)) return
    this.safely('appActivated', () => this.opts.sink.appActivated(bundleId as string))
  }

  /** The Mac woke or the screen unlocked. */
  wake(): void {
    if (!this.running) return
    this.safely('wake', () => this.opts.sink.wake())
  }

  /** Whether keys, clicks and scrolls are being counted (the helper's tap runs). */
  setInputCounting(on: boolean): void {
    this.safely('setInputCounting', () => this.opts.sink.setInputCounting(on))
  }

  /** The developer panel's injected activity. */
  inject(i: DevInject): void {
    this.safely('inject', () => this.opts.sink.inject(i))
  }

  private counts(bundleId: string | null, pid: number): boolean {
    return bundleId !== null && bundleId !== '' && pid !== this.opts.ownPid && bundleId !== this.opts.ownBundleId
  }

  /** The cursor poll's rate now (see the header). */
  cursorHz(): number {
    const o = this.opts
    const still = o.cursorStillHz ?? o.cursorPollHz
    let paused = false
    try {
      paused = o.cursorPaused?.() === true
    } catch {
      paused = false
    }
    if (paused) return o.cursorPausedHz ?? still
    return this.stillPolls * (1000 / o.cursorPollHz) >= (o.cursorStillAfterMs ?? Infinity) ? still : o.cursorPollHz
  }

  private scheduleCursor(): void {
    const ms = 1000 / this.cursorHz()
    this.cursorTimer = this.opts.scheduler.setTimeout(() => {
      this.cursorTimer = null
      if (!this.running) return
      this.safely('cursor', () => {
        const p = this.opts.cursor()
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return
        const last = this.lastCursor
        this.stillPolls = last && last.x === p.x && last.y === p.y ? this.stillPolls + 1 : 0
        this.lastCursor = { x: p.x, y: p.y }
        this.opts.sink.cursor(p.x, p.y)
      })
      this.scheduleCursor()
    }, ms)
  }

  private scheduleIdle(): void {
    this.idleTimer = this.opts.scheduler.setTimeout(() => {
      this.idleTimer = null
      if (!this.running) return
      this.safely('idle', () => {
        const idleS = this.opts.systemIdleS()
        if (Number.isFinite(idleS) && idleS >= 0) this.opts.sink.idle(idleS)
      })
      this.scheduleIdle()
    }, this.opts.idlePollS * 1000)
  }

  private safely(where: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.opts.onError(err, where)
    }
  }
}
