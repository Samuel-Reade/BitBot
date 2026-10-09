import { describe, expect, it } from 'vitest'
import { ActivityIngest, type ActivitySink } from '../src/main/activityIngest'
import type { Scheduler } from '../src/main/sim/loop'
import type { InputMsg } from '../src/main/helper/protocol'

// Activity ingest (src/main/activityIngest.ts): every source reaches the economy, nothing else; polls run on the
// injected scheduler; Bitbot's own app events don't count.

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
    this.timers.delete(handle as number)
  }
  get pending(): number {
    return this.timers.size
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

function setup(extra: Partial<ConstructorParameters<typeof ActivityIngest>[0]> = {}) {
  const calls: string[] = []
  const sink: ActivitySink = {
    key: (code, down, repeat) => calls.push(`key ${code} ${down} ${repeat}`),
    click: (b) => calls.push(`click ${b}`),
    scroll: (s) => calls.push(`scroll ${s.lines} ${s.px} ${s.continuous} ${s.momentum}`),
    cursor: (x, y) => calls.push(`cursor ${x},${y}`),
    appLaunched: (id) => calls.push(`launch ${id}`),
    appActivated: (id) => calls.push(`activate ${id}`),
    idle: (s) => calls.push(`idle ${s}`),
    wake: () => calls.push('wake'),
    setInputCounting: (on) => calls.push(`counting ${on}`),
    inject: (i) => calls.push(`inject ${i.kind}`),
  }
  const timers = new ManualTimers()
  let cursor = { x: 10, y: 20 }
  let idleS = 3
  const errors: string[] = []
  const ingest = new ActivityIngest({
    sink,
    scheduler: timers,
    cursor: () => cursor,
    systemIdleS: () => idleS,
    cursorPollHz: 20,
    idlePollS: 5,
    ownBundleId: 'com.bitbot.desktop',
    ownPid: 42,
    onError: (_err, where) => errors.push(where),
    ...extra,
  })
  return {
    ingest,
    calls,
    timers,
    errors,
    setCursor: (p: { x: number; y: number }) => (cursor = p),
    setIdle: (s: number) => (idleS = s),
  }
}

const key = (code: number, down = true, repeat = false): InputMsg => ({ type: 'input', kind: 'key', code, down, repeat, ts: 0 })

describe('ActivityIngest', () => {
  it('counts a wake on start, then polls the cursor at cursorPollHz and the idle time every idlePollS', () => {
    const t = setup()
    t.ingest.start()
    expect(t.calls).toEqual(['wake'])
    t.timers.advance(1000)
    expect(t.calls.filter((c) => c.startsWith('cursor'))).toHaveLength(20)
    t.timers.advance(4000) // the first idle check, at 5 s
    t.setIdle(400)
    t.timers.advance(5000)
    expect(t.calls.filter((c) => c.startsWith('idle'))).toEqual(['idle 3', 'idle 400'])
  })

  it('polls a still cursor at cursorStillHz after cursorStillAfterMs, and at full rate again once it moves (M9)', () => {
    const t = setup({ cursorStillHz: 4, cursorStillAfterMs: 500 })
    t.ingest.start()
    t.timers.advance(1000) // still from the start: 20 Hz for 0.5 s, then 4 Hz
    const first = t.calls.filter((c) => c.startsWith('cursor')).length
    expect(first).toBeGreaterThanOrEqual(11)
    expect(first).toBeLessThanOrEqual(13)
    t.calls.length = 0
    t.timers.advance(2000)
    expect(t.calls.filter((c) => c.startsWith('cursor'))).toHaveLength(8)
    t.setCursor({ x: 300, y: 400 }) // a move: the next sample sees all of it, then full rate
    t.calls.length = 0
    t.timers.advance(250)
    t.calls.length = 0
    t.setCursor({ x: 320, y: 400 })
    t.timers.advance(400)
    const moving = t.calls.filter((c) => c.startsWith('cursor'))
    expect(moving.length).toBeGreaterThanOrEqual(7)
    expect(moving[0]).toBe('cursor 320,400')
  })

  it('on battery with the pet asleep the poll drops to cursorPausedHz (§11)', () => {
    let paused = true
    const t = setup({ cursorStillHz: 4, cursorStillAfterMs: 500, cursorPausedHz: 1, cursorPaused: () => paused })
    t.ingest.start()
    t.timers.advance(3000)
    expect(t.calls.filter((c) => c.startsWith('cursor'))).toHaveLength(3)
    paused = false
    t.calls.length = 0
    t.setCursor({ x: 1, y: 2 })
    t.timers.advance(2000) // the pending 1 Hz poll first, then the moving cursor at full rate
    expect(t.calls.filter((c) => c.startsWith('cursor')).length).toBeGreaterThan(10)
  })

  it('passes keys, clicks and scrolls through as they are', () => {
    const t = setup()
    t.ingest.start()
    t.ingest.input(key(12))
    t.ingest.input(key(12, true, true))
    t.ingest.input(key(12, false))
    t.ingest.input({ type: 'input', kind: 'mouseDown', button: 0, alt: false, cmd: false, shift: false, ctrl: false, x: null, y: null, ts: 0 })
    t.ingest.input({ type: 'input', kind: 'scroll', lines: 0, px: 12.5, linesX: 0, pxX: 0, continuous: true, momentum: false, ts: 0 })
    expect(t.calls.slice(1)).toEqual(['key 12 true false', 'key 12 true true', 'key 12 false false', 'click 0', 'scroll 0 12.5 true false'])
  })

  it('ignores Bitbot’s own app events and ones without a bundle ID', () => {
    const t = setup()
    t.ingest.start()
    t.ingest.appLaunched('com.apple.Safari', 100)
    t.ingest.appActivated('com.apple.Safari', 100)
    t.ingest.appLaunched('com.bitbot.desktop', 7)
    t.ingest.appActivated('com.apple.Notes', 42)
    t.ingest.appLaunched(null, 101)
    expect(t.calls.slice(1)).toEqual(['launch com.apple.Safari', 'activate com.apple.Safari'])
  })

  it('counts nothing before start or after stop, and stop clears its timers', () => {
    const t = setup()
    t.ingest.input(key(1))
    t.ingest.appLaunched('com.apple.Safari', 100)
    expect(t.calls).toEqual([])
    t.ingest.start()
    t.ingest.stop()
    expect(t.timers.pending).toBe(0)
    t.timers.advance(10_000)
    t.ingest.wake()
    expect(t.calls).toEqual(['wake'])
  })

  it('a failing source is reported, never thrown, and the polls go on', () => {
    const t = setup()
    t.ingest.start()
    t.setCursor({ x: Number.NaN, y: 0 })
    t.timers.advance(100)
    expect(t.calls.filter((c) => c.startsWith('cursor'))).toEqual([])
    const throwing = setup()
    ;(throwing.ingest as unknown as { opts: { cursor: () => never } }).opts.cursor = () => {
      throw new Error('gone')
    }
    throwing.ingest.start()
    throwing.timers.advance(200)
    expect(throwing.errors.filter((w) => w === 'cursor').length).toBeGreaterThan(1)
  })
})
