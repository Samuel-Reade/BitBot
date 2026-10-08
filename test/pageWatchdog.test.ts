import { describe, expect, it } from 'vitest'
import type { Scheduler } from '../src/main/sim/loop'
import { PageWatchdog } from '../src/main/windows/pageWatchdog'
import { isPetPingMsg, isPetPongMsg } from '../src/shared/petProtocol'
import { tuning } from '../src/shared/tuning'

// The overlay page's liveness watchdog (docs/decisions/overlay.md "M1 code review": silent renderer hangs).

/** Timers driven by hand (as in test/appSupport.test.ts). */
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

const PING_MS = 2000
const MAX_MISSED = 3

function setup(opts: { answer?: boolean } = {}): {
  timers: ManualTimers
  dog: PageWatchdog
  sent: number[]
  deaths: () => number
} {
  const timers = new ManualTimers()
  const sent: number[] = []
  let dead = 0
  const dog: PageWatchdog = new PageWatchdog({
    scheduler: timers,
    pingMs: PING_MS,
    maxMissed: MAX_MISSED,
    send: (id) => {
      sent.push(id)
      if (opts.answer) dog.pong(id)
    },
    onDead: () => dead++,
  })
  return { timers, dog, sent, deaths: () => dead }
}

describe('PageWatchdog', () => {
  it('uses the tuned period and allowance, and ping ids are valid pet:ping / pet:pong payloads', () => {
    expect(tuning.overlay.watchdog.pingMs).toBeGreaterThan(0)
    expect(tuning.overlay.watchdog.maxMissed).toBeGreaterThanOrEqual(1)
    const { timers, dog, sent } = setup({ answer: true })
    dog.start()
    timers.advance(PING_MS)
    expect(isPetPingMsg({ id: sent[0] })).toBe(true)
    expect(isPetPongMsg({ id: sent[0] })).toBe(true)
  })

  it('sends nothing until started, then a ping every pingMs', () => {
    const { timers, dog, sent } = setup({ answer: true })
    timers.advance(10 * PING_MS)
    expect(sent).toEqual([])
    expect(timers.pending).toBe(0)
    dog.start()
    expect(dog.isRunning).toBe(true)
    timers.advance(PING_MS - 1)
    expect(sent).toEqual([])
    timers.advance(1)
    expect(sent).toEqual([1])
    timers.advance(3 * PING_MS)
    expect(sent).toEqual([1, 2, 3, 4])
  })

  it('a page that answers lives for ever', () => {
    const { timers, dog, deaths } = setup({ answer: true })
    dog.start()
    timers.advance(1000 * PING_MS)
    expect(deaths()).toBe(0)
    expect(dog.missed).toBe(0)
  })

  it('a silent page is declared dead after maxMissed pings in a row, once, and the watchdog stops', () => {
    const { timers, dog, sent, deaths } = setup()
    dog.start()
    timers.advance(PING_MS) // ping 1
    timers.advance(PING_MS) // 1 missed, ping 2
    timers.advance(PING_MS) // 2 missed, ping 3
    expect(dog.missed).toBe(2)
    expect(deaths()).toBe(0)
    timers.advance(PING_MS) // 3 missed: dead
    expect(deaths()).toBe(1)
    expect(sent).toEqual([1, 2, 3])
    expect(dog.isRunning).toBe(false)
    expect(timers.pending).toBe(0)
    timers.advance(10 * PING_MS)
    expect(deaths()).toBe(1)
  })

  it('a late answer (to an older ping) still counts as alive', () => {
    const { timers, dog, deaths } = setup()
    dog.start()
    for (let i = 0; i < 20; i++) {
      timers.advance(PING_MS) // ping n+1 goes out while ping n is answered only now
      if (i > 0) dog.pong(i)
    }
    expect(deaths()).toBe(0)
    expect(dog.missed).toBe(0)
  })

  it('ignores answers to pings it never sent, or sent before a restart', () => {
    const { timers, dog, deaths } = setup()
    dog.start()
    timers.advance(PING_MS) // ping 1
    dog.pong(2)
    dog.pong(0)
    dog.pong(1.5)
    timers.advance(PING_MS) // ping 2
    timers.advance(PING_MS) // ping 3
    expect(dog.missed).toBe(2)
    dog.start() // a new page load's ready
    dog.pong(3) // the old page's answer
    timers.advance(3 * PING_MS)
    expect(dog.missed).toBe(2)
    timers.advance(PING_MS)
    expect(deaths()).toBe(1)
  })

  it('stop() ends pinging, and answers after it change nothing', () => {
    const { timers, dog, sent, deaths } = setup()
    dog.start()
    timers.advance(2 * PING_MS)
    dog.stop()
    dog.stop()
    expect(timers.pending).toBe(0)
    dog.pong(2)
    timers.advance(10 * PING_MS)
    expect(sent).toEqual([1, 2])
    expect(deaths()).toBe(0)
    expect(dog.isRunning).toBe(false)
  })

  it('reset() forgets missed pings and starts the period again (after a system sleep); no-op when stopped', () => {
    const { timers, dog, sent, deaths } = setup()
    dog.start()
    timers.advance(3 * PING_MS)
    expect(dog.missed).toBe(2)
    timers.advance(PING_MS / 2)
    dog.reset()
    expect(dog.missed).toBe(0)
    timers.advance(PING_MS - 1)
    expect(sent).toEqual([1, 2, 3])
    timers.advance(1)
    expect(sent).toEqual([1, 2, 3, 4])
    timers.advance(2 * PING_MS)
    expect(deaths()).toBe(0)
    timers.advance(PING_MS)
    expect(deaths()).toBe(1)
    dog.reset()
    expect(dog.isRunning).toBe(false)
    expect(timers.pending).toBe(0)
  })

  it('restarting (start while running) keeps a single timer', () => {
    const { timers, dog } = setup()
    dog.start()
    dog.start()
    dog.start()
    expect(timers.pending).toBe(1)
  })

  it('rejects a period or allowance that could never work', () => {
    const base = { scheduler: new ManualTimers(), send: () => undefined, onDead: () => undefined }
    expect(() => new PageWatchdog({ ...base, pingMs: 0, maxMissed: 3 })).toThrow(RangeError)
    expect(() => new PageWatchdog({ ...base, pingMs: Number.NaN, maxMissed: 3 })).toThrow(RangeError)
    expect(() => new PageWatchdog({ ...base, pingMs: 1000, maxMissed: 0 })).toThrow(RangeError)
    expect(() => new PageWatchdog({ ...base, pingMs: 1000, maxMissed: 1.5 })).toThrow(RangeError)
  })
})
