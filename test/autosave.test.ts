import { describe, expect, it } from 'vitest'
import { Autosaver } from '../src/main/persistence/autosave'
import type { Scheduler } from '../src/main/sim/loop'
import { tuning } from '../src/shared/tuning'

// When the save is written (src/main/persistence/autosave.ts, §16): every 60 s, debounced on mode/settings changes,
// at once on suspend and quit.

class FakeTimers implements Scheduler {
  now = 0
  private timers: { at: number; fn: () => void; id: number }[] = []
  private nextId = 1
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ at: this.now + ms, fn, id })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }
  get count(): number {
    return this.timers.length
  }
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at)
      const next = this.timers[0]
      if (!next || next.at > end) break
      this.timers.shift()
      this.now = next.at
      next.fn()
    }
    this.now = end
  }
}

function setup() {
  const timers = new FakeTimers()
  const writes: number[] = []
  const errors: unknown[] = []
  const saver = new Autosaver({
    everyMs: tuning.persistence.autosaveEveryMs,
    debounceMs: tuning.persistence.changeDebounceMs,
    write: () => writes.push(timers.now),
    scheduler: timers,
    onError: (e) => errors.push(e),
  })
  return { timers, writes, saver, errors }
}

describe('Autosaver', () => {
  it('uses §16’s 60 s and a short change debounce', () => {
    expect(tuning.persistence.autosaveEveryMs).toBe(60_000)
    expect(tuning.persistence.changeDebounceMs).toBeLessThan(5000)
  })

  it('writes every 60 s while started, never before start or after stop', () => {
    const { timers, writes, saver } = setup()
    timers.advance(120_000)
    expect(writes).toEqual([])
    saver.start()
    saver.start()
    timers.advance(185_000)
    expect(writes).toEqual([180_000, 240_000, 300_000])
    saver.stop()
    timers.advance(600_000)
    expect(writes).toHaveLength(3)
    expect(timers.count).toBe(0)
  })

  it('changed(): one write a debounce after the last of a burst; the periodic save restarts from it', () => {
    const { timers, writes, saver } = setup()
    const d = tuning.persistence.changeDebounceMs
    saver.start()
    timers.advance(10_000)
    for (let i = 0; i < 20; i++) {
      saver.changed()
      timers.advance(d / 4)
    }
    expect(writes).toEqual([])
    expect(saver.pending).toBe(true)
    timers.advance(d)
    const changeWrite = 10_000 + 20 * (d / 4) - d / 4 + d
    expect(writes).toEqual([changeWrite])
    expect(saver.pending).toBe(false)
    timers.advance(60_000)
    expect(writes).toEqual([changeWrite, changeWrite + 60_000])
  })

  it('changes that never stop are still written by the periodic save', () => {
    const { timers, writes, saver } = setup()
    const d = tuning.persistence.changeDebounceMs
    saver.start()
    for (let t = 0; t < 130_000; t += d / 2) {
      saver.changed()
      timers.advance(d / 2)
    }
    expect(writes).toEqual([60_000, 120_000])
  })

  it('changed() is ignored while stopped', () => {
    const { timers, writes, saver } = setup()
    saver.changed()
    timers.advance(10_000)
    expect(writes).toEqual([])
  })

  it('flush(): writes now, drops the pending change write, restarts the periodic wait; works stopped too (quit)', () => {
    const { timers, writes, saver } = setup()
    saver.start()
    timers.advance(30_000)
    saver.changed()
    saver.flush()
    expect(writes).toEqual([30_000])
    expect(saver.pending).toBe(false)
    timers.advance(59_000)
    expect(writes).toEqual([30_000])
    timers.advance(1000)
    expect(writes).toEqual([30_000, 90_000])
    saver.stop()
    saver.flush()
    expect(writes).toEqual([30_000, 90_000, 90_000])
    expect(timers.count).toBe(0)
  })

  it('a throwing write is reported and the schedule carries on', () => {
    const timers = new FakeTimers()
    const errors: unknown[] = []
    let n = 0
    const saver = new Autosaver({
      everyMs: 60_000,
      debounceMs: 1000,
      scheduler: timers,
      write: () => {
        n++
        if (n === 1) throw new Error('disk full')
      },
      onError: (e) => errors.push(e),
    })
    saver.start()
    timers.advance(120_000)
    expect(n).toBe(2)
    expect(errors).toHaveLength(1)
  })
})
