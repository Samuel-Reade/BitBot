// The helper's input tap as the app keeps it (BITBOT_SPEC.md §7.1, §10.4; decided: Input Monitoring only, listen-only).
// While Input Monitoring is granted the tap runs for keys and mouse presses (counting, §7; ⌥⌘-click send, §10.4); while
// it isn't, the grant is re-checked every tuning.app.inputAccessPollS without ever prompting (the preflight check), so
// turning it on in System Settings starts counting by itself. Pure apart from what is injected (unit-tested with fakes).

import type { Scheduler } from './sim/loop'

export interface InputTapDeps {
  /** The preflight check (never prompts): is Input Monitoring granted? */
  granted(): Promise<boolean>
  /** Starts the tap for keys and mouse presses; resolves with whether it runs. */
  startTap(): Promise<{ active: boolean; reason: string | null }>
  scheduler: Scheduler
  pollS: number
  /** Counting started or stopped. */
  onChange(counting: boolean): void
  log(line: string): void
}

export class InputTap {
  private counting = false
  private timer: unknown = null
  private generation = 0
  private reportedOff = false

  constructor(private readonly deps: InputTapDeps) {}

  /** Keys, clicks and scrolls are being counted. */
  get isCounting(): boolean {
    return this.counting
  }

  /** A (re)started helper said hello: check the grant now, start the tap if granted, else keep checking. */
  helperReady(): void {
    this.generation++
    this.clearTimer()
    void this.check(this.generation)
  }

  /** The helper exited: nothing is counted until it is back. */
  helperGone(): void {
    this.generation++
    this.clearTimer()
    this.set(false)
  }

  stop(): void {
    this.generation++
    this.clearTimer()
    this.set(false)
  }

  private async check(generation: number): Promise<void> {
    let ok = false
    try {
      if (await this.deps.granted()) {
        if (generation !== this.generation) return
        const tap = await this.deps.startTap()
        if (generation !== this.generation) return
        ok = tap.active
        if (!ok) this.deps.log(`[bitbot] input counting is off: the tap did not start (${tap.reason ?? 'unknown'})`)
      } else if (!this.reportedOff) {
        this.reportedOff = true
        this.deps.log('[bitbot] input counting is off: Input Monitoring is not granted (keys, clicks and scrolls are not counted; ⌥⌘-click send is off)')
      }
    } catch (err) {
      this.deps.log(`[bitbot] input counting: check failed (${err instanceof Error ? err.message : String(err)})`)
    }
    if (generation !== this.generation) return
    this.set(ok)
    if (ok) {
      this.reportedOff = false
      return
    }
    this.timer = this.deps.scheduler.setTimeout(() => {
      this.timer = null
      if (generation === this.generation) void this.check(generation)
    }, this.deps.pollS * 1000)
  }

  private set(counting: boolean): void {
    if (counting === this.counting) return
    this.counting = counting
    if (counting) this.deps.log('[bitbot] input counting is on (keys, clicks, scrolls; ⌥⌘-click send)')
    this.deps.onChange(counting)
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.scheduler.clearTimeout(this.timer)
    this.timer = null
  }
}
