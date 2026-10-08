import { describe, expect, it } from 'vitest'
import { Debouncer } from '../src/main/debounce'
import { SignalGate } from '../src/main/signals'
import type { Scheduler } from '../src/main/sim/loop'
import { ThrottledLog } from '../src/main/throttledLog'
import { tuning } from '../src/shared/tuning'

// Small pure pieces of the running app's glue (src/main/bitbotApp.ts): the Ctrl+C gate, the display-change debouncer
// and the throttled error log.

/** Timers that fire only when the test advances time. */
class ManualTimers implements Scheduler {
  now = 0
  private nextId = 1
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.now + ms, fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  get pending(): number {
    return this.timers.size
  }

  /** Advances time by `ms`, firing due timers in order. */
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
      if (!next) break
      this.timers.delete(next[0])
      this.now = next[1].at
      next[1].fn()
    }
    this.now = end
  }
}

describe('SignalGate', () => {
  it('quits on the first signal, ignores the Ctrl+C echo within the grace period, force-exits on a later one', () => {
    const gate = new SignalGate(1000)
    expect(gate.onSignal(5000)).toBe('quit')
    expect(gate.onSignal(5003)).toBe('ignore')
    expect(gate.onSignal(5999)).toBe('ignore')
    expect(gate.onSignal(6000)).toBe('force-exit')
    expect(gate.onSignal(9000)).toBe('force-exit')
  })

  it('uses a production grace period of about a second', () => {
    expect(tuning.app.signalRepeatGraceMs).toBeGreaterThanOrEqual(100)
    expect(tuning.app.signalRepeatGraceMs).toBeLessThanOrEqual(5000)
  })
})

describe('Debouncer', () => {
  it('runs once, delayMs after the last trigger of a burst', () => {
    const timers = new ManualTimers()
    let runs = 0
    const d = new Debouncer(100, () => runs++, timers)
    d.trigger()
    timers.advance(60)
    d.trigger()
    timers.advance(60)
    d.trigger()
    expect(runs).toBe(0)
    expect(d.pending).toBe(true)
    timers.advance(99)
    expect(runs).toBe(0)
    timers.advance(1)
    expect(runs).toBe(1)
    expect(d.pending).toBe(false)
    expect(timers.pending).toBe(0)
    timers.advance(1000)
    expect(runs).toBe(1)
  })

  it('cancel drops a pending run and is idempotent; a later trigger works again', () => {
    const timers = new ManualTimers()
    let runs = 0
    const d = new Debouncer(100, () => runs++, timers)
    d.cancel()
    d.trigger()
    d.cancel()
    d.cancel()
    timers.advance(500)
    expect(runs).toBe(0)
    expect(timers.pending).toBe(0)
    d.trigger()
    timers.advance(100)
    expect(runs).toBe(1)
  })

  it('a trigger from inside the callback schedules another run', () => {
    const timers = new ManualTimers()
    let runs = 0
    const d: Debouncer = new Debouncer(
      50,
      () => {
        runs++
        if (runs === 1) d.trigger()
      },
      timers,
    )
    d.trigger()
    timers.advance(50)
    expect(runs).toBe(1)
    expect(d.pending).toBe(true)
    timers.advance(50)
    expect(runs).toBe(2)
  })
})

describe('ThrottledLog', () => {
  const make = (intervalMs = 1000, maxKeys = 10): { log: ThrottledLog; lines: string[]; clock: { t: number } } => {
    const clock = { t: 0 }
    const lines: string[] = []
    return { log: new ThrottledLog({ now: () => clock.t, intervalMs, maxKeys, write: (l) => lines.push(l) }), lines, clock }
  }

  it('logs the first occurrence, counts repeats within the interval, reports the count with the next line', () => {
    const { log, lines, clock } = make()
    expect(log.log('boom', 'ERROR boom')).toBe(true)
    clock.t = 10
    expect(log.log('boom', 'ERROR boom')).toBe(false)
    clock.t = 999
    expect(log.log('boom', 'ERROR boom')).toBe(false)
    clock.t = 1000
    expect(log.log('boom', 'ERROR boom again')).toBe(true)
    expect(lines).toEqual(['ERROR boom', 'ERROR boom again (repeated 2 more times since the last report)'])
    clock.t = 2500
    expect(log.log('boom', 'ERROR boom')).toBe(true)
    expect(lines[2]).toBe('ERROR boom')
  })

  it('says "time" for a single repeat', () => {
    const { log, lines, clock } = make()
    log.log('k', 'x')
    clock.t = 1
    log.log('k', 'x')
    clock.t = 5000
    log.log('k', 'y')
    expect(lines[1]).toBe('y (repeated 1 more time since the last report)')
  })

  it('throttles each message on its own', () => {
    const { log, lines } = make()
    expect(log.log('a', 'A')).toBe(true)
    expect(log.log('b', 'B')).toBe(true)
    expect(log.log('a', 'A')).toBe(false)
    expect(lines).toEqual(['A', 'B'])
  })

  it('remembers at most maxKeys messages, forgetting the least recently logged first', () => {
    const { log, lines } = make(1000, 2)
    log.log('a', 'A')
    log.log('b', 'B')
    log.log('c', 'C') // forgets a
    expect(log.log('a', 'A')).toBe(true)
    expect(log.log('c', 'C')).toBe(false)
    expect(lines).toEqual(['A', 'B', 'C', 'A'])
  })

  it('never throws, even when the sink does', () => {
    const t = new ThrottledLog({
      now: () => 0,
      intervalMs: 1000,
      maxKeys: 5,
      write: () => {
        throw new Error('stdout closed')
      },
    })
    expect(t.log('k', 'line')).toBe(true)
  })
})
