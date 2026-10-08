import { describe, expect, it } from 'vitest'
import { InputTap } from '../src/main/inputTap'
import type { Scheduler } from '../src/main/sim/loop'

// The input tap as the app keeps it (src/main/inputTap.ts): runs while Input Monitoring is granted, re-checks quietly
// while it isn't, stops with the helper.

class ManualTimers implements Scheduler {
  now = 0
  private nextId = 1
  readonly timers = new Map<number, { at: number; fn: () => void }>()
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.now + ms, fn })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      const next = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.timers.delete(next[0])
      this.now = next[1].at
      next[1].fn()
    }
    this.now = end
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function setup(granted: boolean, tapActive = true) {
  const state = { granted, tapActive, checks: 0, taps: 0 }
  const changes: boolean[] = []
  const logs: string[] = []
  const timers = new ManualTimers()
  const tap = new InputTap({
    granted: async () => {
      state.checks++
      return state.granted
    },
    startTap: async () => {
      state.taps++
      return { active: state.tapActive, reason: state.tapActive ? null : 'tapCreateFailed' }
    },
    scheduler: timers,
    pollS: 5,
    onChange: (c) => changes.push(c),
    log: (l) => logs.push(l),
  })
  return { tap, state, changes, logs, timers }
}

describe('InputTap', () => {
  it('granted: starts the tap at once and counts', async () => {
    const t = setup(true)
    t.tap.helperReady()
    await flush()
    expect(t.tap.isCounting).toBe(true)
    expect(t.changes).toEqual([true])
    expect(t.state.taps).toBe(1)
    expect(t.timers.timers.size).toBe(0)
  })

  it('not granted: never starts a tap, logs once, re-checks every pollS, and starts when it is granted', async () => {
    const t = setup(false)
    t.tap.helperReady()
    await flush()
    expect(t.tap.isCounting).toBe(false)
    expect(t.state.taps).toBe(0)
    t.timers.advance(5000)
    await flush()
    t.timers.advance(5000)
    await flush()
    expect(t.state.checks).toBe(3)
    expect(t.logs.filter((l) => l.includes('not granted'))).toHaveLength(1)
    t.state.granted = true
    t.timers.advance(5000)
    await flush()
    expect(t.tap.isCounting).toBe(true)
    expect(t.changes).toEqual([true])
  })

  it('a tap that fails to start does not count, and is tried again later', async () => {
    const t = setup(true, false)
    t.tap.helperReady()
    await flush()
    expect(t.tap.isCounting).toBe(false)
    t.state.tapActive = true
    t.timers.advance(5000)
    await flush()
    expect(t.tap.isCounting).toBe(true)
  })

  it('the helper exiting stops counting and the re-checks; its next hello starts again', async () => {
    const t = setup(false)
    t.tap.helperReady()
    await flush()
    t.tap.helperGone()
    expect(t.timers.timers.size).toBe(0)
    t.state.granted = true
    t.tap.helperReady()
    await flush()
    expect(t.tap.isCounting).toBe(true)
    t.tap.helperGone()
    expect(t.tap.isCounting).toBe(false)
    expect(t.changes).toEqual([true, false])
  })

  it('an answer from before a restart is ignored', async () => {
    const t = setup(true)
    t.tap.helperReady()
    t.tap.helperGone() // before the first check resolves
    await flush()
    expect(t.tap.isCounting).toBe(false)
    expect(t.state.taps).toBe(0)
  })
})
