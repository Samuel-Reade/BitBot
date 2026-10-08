import { describe, expect, it } from 'vitest'
import {
  activationsSince,
  ActivationMonitor,
  FOCUS_EVENTS,
  isActivation,
  verdictLine,
  type FocusEntry,
  type FocusEventName,
  type FocusEventSource,
} from '../src/main/activationMonitor'
import type { Scheduler } from '../src/main/sim/loop'
import type { InteractionLabel } from '../src/main/windows/petInteraction'

// The self-reporting focus check (src/main/activationMonitor.ts): focus events logged with the interaction, and one
// verdict line per press and per menu, counting activations from a little before the interaction began.

class FakeApp implements FocusEventSource {
  readonly listeners = new Map<FocusEventName, Set<() => void>>()

  on(name: FocusEventName, listener: () => void): void {
    let set = this.listeners.get(name)
    if (!set) this.listeners.set(name, (set = new Set()))
    set.add(listener)
  }

  off(name: FocusEventName, listener: () => void): void {
    this.listeners.get(name)?.delete(listener)
  }

  emit(name: FocusEventName): void {
    for (const l of [...(this.listeners.get(name) ?? [])]) l()
  }

  get listenerCount(): number {
    let n = 0
    for (const set of this.listeners.values()) n += set.size
    return n
  }
}

class Timers implements Scheduler {
  now = 1000
  private id = 1
  private readonly timers = new Map<number, { at: number; fn: () => void }>()
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.id++
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
      const due = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.now = due[1].at
      due[1].fn()
    }
    this.now = end
  }
}

function setup(): { mon: ActivationMonitor; app: FakeApp; timers: Timers; lines: string[]; label: { now: InteractionLabel } } {
  const app = new FakeApp()
  const timers = new Timers()
  const lines: string[] = []
  const label = { now: 'none' as InteractionLabel }
  const mon = new ActivationMonitor({
    source: app,
    now: () => timers.now,
    scheduler: timers,
    label: () => label.now,
    log: (l) => lines.push(l),
    verdictDelayMs: 400,
    lookBackMs: 400,
    eventCap: 50,
  })
  mon.start()
  return { mon, app, timers, lines, label }
}

const verdicts = (lines: string[]): string[] => lines.filter((l) => l.includes('became the active app'))

describe('verdict rules', () => {
  it('activation events are did-become-active and browser-window-focus', () => {
    expect(FOCUS_EVENTS.filter(isActivation)).toEqual(['did-become-active', 'browser-window-focus'])
  })

  it('formats PASS and FAIL lines', () => {
    expect(verdictLine('click', [])).toBe('click -> Bitbot became the active app: NO (PASS)')
    expect(verdictLine('drag', ['did-become-active', 'browser-window-focus'])).toBe(
      'drag -> Bitbot became the active app: YES (FAIL: did-become-active, browser-window-focus)',
    )
  })

  it('counts activations at or after the cut-off only', () => {
    const entries: FocusEntry[] = [
      { tMs: 10, event: 'did-become-active', interaction: 'none' },
      { tMs: 20, event: 'did-resign-active', interaction: 'none' },
      { tMs: 30, event: 'browser-window-focus', interaction: 'press' },
    ]
    expect(activationsSince(entries, 0)).toEqual(['did-become-active', 'browser-window-focus'])
    expect(activationsSince(entries, 11)).toEqual(['browser-window-focus'])
    expect(activationsSince(entries, 31)).toEqual([])
  })
})

describe('ActivationMonitor', () => {
  it('logs every focus event with the interaction in progress, and counts them', () => {
    const { mon, app, lines, label } = setup()
    label.now = 'drag'
    app.emit('did-become-active')
    label.now = 'none'
    app.emit('did-resign-active')
    expect(lines).toEqual([
      '[bitbot] focus: did-become-active (interaction: drag)',
      '[bitbot] focus: did-resign-active (interaction: none)',
    ])
    const c = mon.counters
    expect(c.events['did-become-active']).toBe(1)
    expect(c.events['did-resign-active']).toBe(1)
    expect(c.activations).toBe(1)
  })

  it('a click: one PASS verdict after the delay, not before', () => {
    const { mon, timers, lines } = setup()
    mon.observe('hover')
    mon.observe('press')
    timers.advance(80)
    mon.observe('hover')
    expect(verdicts(lines)).toEqual([])
    expect(mon.counters.pending).toBe(1)
    timers.advance(399)
    expect(verdicts(lines)).toEqual([])
    timers.advance(1)
    expect(verdicts(lines)).toEqual(['[bitbot] click -> Bitbot became the active app: NO (PASS)'])
    expect(mon.counters).toMatchObject({ verdicts: 1, passes: 1, fails: 0, pending: 0, last: { what: 'click', becameActive: false } })
  })

  it('a press whose label ever read drag is a drag', () => {
    const { mon, timers, lines } = setup()
    mon.observe('press')
    mon.observe('drag')
    mon.observe('drag')
    mon.observe('near')
    timers.advance(400)
    expect(verdicts(lines)).toEqual(['[bitbot] drag -> Bitbot became the active app: NO (PASS)'])
  })

  it('FAIL when Bitbot became active shortly before the press began (AppKit activates on the mouse-down) or during it', () => {
    const { mon, app, timers, lines } = setup()
    app.emit('did-become-active')
    timers.advance(300)
    mon.observe('press')
    timers.advance(50)
    app.emit('browser-window-focus')
    mon.observe('hover')
    timers.advance(400)
    expect(verdicts(lines)).toEqual([
      '[bitbot] click -> Bitbot became the active app: YES (FAIL: did-become-active, browser-window-focus)',
    ])
    expect(mon.counters).toMatchObject({ fails: 1, passes: 0, last: { becameActive: true } })
  })

  it('an activation long before the press does not count; one after it ended, within the delay, does', () => {
    const { mon, app, timers, lines } = setup()
    app.emit('did-become-active')
    timers.advance(401)
    mon.observe('press')
    mon.observe('none')
    timers.advance(200)
    app.emit('did-become-active')
    timers.advance(200)
    expect(verdicts(lines)).toEqual(['[bitbot] click -> Bitbot became the active app: YES (FAIL: did-become-active)'])
  })

  it('a menu, with the item chosen after it closed', () => {
    const { mon, timers, lines } = setup()
    mon.observe('hover')
    mon.observe('menu')
    timers.advance(1500)
    mon.observe('menu')
    mon.observe('none')
    timers.advance(10)
    mon.menuChoice('Hide')
    timers.advance(400)
    expect(verdicts(lines)).toEqual(['[bitbot] right-click menu (chose Hide) -> Bitbot became the active app: NO (PASS)'])
  })

  it('a menu dismissed without a choice', () => {
    const { mon, timers, lines } = setup()
    mon.observe('menu')
    mon.observe('hover')
    timers.advance(400)
    expect(verdicts(lines)).toEqual(['[bitbot] right-click menu (nothing chosen) -> Bitbot became the active app: NO (PASS)'])
  })

  it('one verdict per interaction, in order, even when they overlap their delays', () => {
    const { mon, timers, lines } = setup()
    mon.observe('press')
    mon.observe('hover')
    timers.advance(100)
    mon.observe('press')
    mon.observe('drag')
    mon.observe('hover')
    timers.advance(100)
    mon.observe('menu')
    mon.observe('none')
    timers.advance(1000)
    expect(verdicts(lines)).toEqual([
      '[bitbot] click -> Bitbot became the active app: NO (PASS)',
      '[bitbot] drag -> Bitbot became the active app: NO (PASS)',
      '[bitbot] right-click menu (nothing chosen) -> Bitbot became the active app: NO (PASS)',
    ])
    expect(mon.counters.verdicts).toBe(3)
  })

  it('a press that turns straight into a menu ends the press first', () => {
    const { mon, timers, lines } = setup()
    mon.observe('press')
    mon.observe('menu')
    mon.observe('none')
    timers.advance(400)
    expect(verdicts(lines)).toEqual([
      '[bitbot] click -> Bitbot became the active app: NO (PASS)',
      '[bitbot] right-click menu (nothing chosen) -> Bitbot became the active app: NO (PASS)',
    ])
  })

  it('no verdict for hovering or nearing only', () => {
    const { mon, timers, lines } = setup()
    for (const l of ['near', 'hover', 'near', 'none', 'hover'] as const) mon.observe(l)
    timers.advance(2000)
    expect(verdicts(lines)).toEqual([])
    expect(mon.counters.verdicts).toBe(0)
  })

  it('stop() removes its listeners and drops pending verdicts', () => {
    const { mon, app, timers, lines } = setup()
    expect(app.listenerCount).toBe(4)
    mon.observe('press')
    mon.observe('none')
    mon.stop()
    expect(app.listenerCount).toBe(0)
    expect(timers.pending).toBe(0)
    timers.advance(1000)
    app.emit('did-become-active')
    expect(lines).toEqual([])
  })

  it('start() is idempotent', () => {
    const { mon, app } = setup()
    mon.start()
    expect(app.listenerCount).toBe(4)
  })

  it('keeps at most eventCap focus events', () => {
    const { mon, app } = setup()
    for (let i = 0; i < 120; i++) app.emit('did-resign-active')
    expect(mon.focusEvents).toHaveLength(50)
    expect(mon.counters.events['did-resign-active']).toBe(120)
  })

  it('survives a label provider and a log sink that throw', () => {
    const app = new FakeApp()
    const timers = new Timers()
    const mon = new ActivationMonitor({
      source: app,
      now: () => timers.now,
      scheduler: timers,
      label: () => {
        throw new Error('gone')
      },
      log: () => {
        throw new Error('closed')
      },
      verdictDelayMs: 10,
      lookBackMs: 10,
      eventCap: 10,
    })
    mon.start()
    expect(() => app.emit('did-become-active')).not.toThrow()
    expect(mon.focusEvents[0]?.interaction).toBe('none')
    mon.observe('press')
    mon.observe('none')
    expect(() => timers.advance(10)).not.toThrow()
    expect(mon.counters.fails).toBe(1)
  })
})
