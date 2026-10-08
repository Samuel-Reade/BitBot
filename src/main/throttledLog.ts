// Throttled logging for problems that may repeat on every wake (an uncaught exception in a timer, a simulation step
// that keeps throwing, a renderer sending malformed messages): the first occurrence of a message is logged, repeats
// within intervalMs are only counted, and the next line logged for that message says how many were skipped. Pure:
// the clock and the sink are injected (unit-tested in test/appSupport.test.ts).

export interface ThrottledLogOptions {
  /** Monotonic ms. */
  now(): number
  /** tuning.app.errorLogIntervalMs */
  intervalMs: number
  /** tuning.app.errorLogKeys: distinct messages remembered (the oldest is forgotten first). */
  maxKeys: number
  write(line: string): void
}

interface Seen {
  lastAt: number
  skipped: number
}

export class ThrottledLog {
  private readonly seen = new Map<string, Seen>()

  constructor(private readonly opts: ThrottledLogOptions) {}

  /**
   * Writes `line` unless the message `key` was written less than intervalMs ago (then it is only counted). Returns
   * whether it wrote, so a caller can do its own once-per-streak work (e.g. cancel an interaction) only then.
   */
  log(key: string, line: string): boolean {
    const now = this.opts.now()
    const seen = this.seen.get(key)
    if (seen && now - seen.lastAt < this.opts.intervalMs) {
      seen.skipped++
      return false
    }
    const skipped = seen?.skipped ?? 0
    this.seen.delete(key) // re-inserted below: the Map's order is then least recently written first
    this.seen.set(key, { lastAt: now, skipped: 0 })
    while (this.seen.size > Math.max(1, this.opts.maxKeys)) {
      const oldest = this.seen.keys().next()
      if (oldest.done) break
      this.seen.delete(oldest.value)
    }
    this.write(skipped > 0 ? `${line} (repeated ${skipped} more time${skipped === 1 ? '' : 's'} since the last report)` : line)
    return true
  }

  private write(line: string): void {
    try {
      this.opts.write(line)
    } catch {
      // Nowhere left to report it.
    }
  }
}
