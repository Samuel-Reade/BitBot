import { describe, expect, it } from 'vitest'
import type { InputMsg } from '../src/main/helper/protocol'
import {
  emptyCounts,
  formatCounts,
  HelperInputCounter,
  totalEvents,
  UiohookInputCounter,
} from '../src/main/spike/input/counters'
import { parseInputOptions } from '../src/main/spike/input/options'
import {
  RESTART_AFTER_GRANT,
  RestartAfterGrantProbe,
  followUpAfterRetry,
  type RestartProbeDeps,
} from '../src/main/spike/input/restartAfterGrant'
import { tuning } from '../src/shared/tuning'

// A key code that appears nowhere else in these tests, to prove codes never leak into counts or text.
const SECRET_CODE = 31337
const NOW = 1_791_337_451

const key = (down: boolean, repeat = false, code = SECRET_CODE, ts = NOW - 0.002): InputMsg => ({
  type: 'input',
  kind: 'key',
  down,
  code,
  repeat,
  ts,
})
const click = (button: number): InputMsg => ({
  type: 'input',
  kind: 'mouseDown',
  button,
  alt: false,
  cmd: false,
  shift: false,
  ctrl: false,
  x: 10,
  y: 20,
  ts: NOW - 0.001,
})
const scroll = (fields: Partial<Extract<InputMsg, { kind: 'scroll' }>>): InputMsg => ({
  type: 'input',
  kind: 'scroll',
  lines: -1,
  px: -10,
  linesX: 0,
  pxX: 0,
  continuous: false,
  momentum: false,
  ts: NOW - 0.001,
  ...fields,
})

const counter = (): HelperInputCounter => new HelperInputCounter(tuning.spikeInput.maxPlausibleAgeS, 100)

describe('HelperInputCounter', () => {
  it('counts key downs, ups and flagged repeats, agreeing with the held-key set', () => {
    const c = counter()
    c.record(key(true), NOW)
    c.record(key(true, true), NOW)
    c.record(key(true, true), NOW)
    c.record(key(false), NOW)
    expect(c.total).toMatchObject({ keyDown: 3, keyUp: 1, keyRepeat: 2, repeatDisagreements: { flaggedNotHeld: 0, heldNotFlagged: 0 } })
  })

  it('counts both kinds of repeat-flag disagreement', () => {
    const c = counter()
    c.record(key(true, true, 1), NOW) // flagged repeat, but key 1 was never down
    c.record(key(true, false, 2), NOW)
    c.record(key(true, false, 2), NOW) // second down for held key 2 without the flag
    expect(c.total.repeatDisagreements).toEqual({ flaggedNotHeld: 1, heldNotFlagged: 1 })
  })

  it('forgets held keys when the tap stops', () => {
    const c = counter()
    c.record(key(true), NOW)
    c.clearHeld()
    c.record(key(true), NOW)
    expect(c.total.repeatDisagreements).toEqual({ flaggedNotHeld: 0, heldNotFlagged: 0 })
  })

  it('counts mouse buttons by index (0 left, 1 right, 2+ other)', () => {
    const c = counter()
    for (const button of [0, 0, 1, 2, 5]) c.record(click(button), NOW)
    expect(c.total.mouseDown).toEqual({ left: 2, right: 1, other: 2 })
  })

  it('classifies scrolls: continuous, momentum, zero-delta gesture edges, horizontal', () => {
    const c = counter()
    c.record(scroll({ continuous: true }), NOW)
    c.record(scroll({ continuous: true, momentum: true }), NOW)
    c.record(scroll({ lines: 0, px: 0, linesX: 0, pxX: 0, continuous: true }), NOW)
    c.record(scroll({ lines: 0, px: 0, linesX: 1, pxX: 8 }), NOW)
    expect(c.total.scroll).toEqual({ events: 4, continuous: 3, momentum: 1, zeroDelta: 1, horizontal: 1 })
  })

  it('reports per interval and in total', () => {
    const c = counter()
    c.record(key(true), NOW)
    c.record(click(0), NOW)
    expect(totalEvents(c.takeInterval())).toBe(2)
    c.record(key(false), NOW)
    expect(totalEvents(c.takeInterval())).toBe(1)
    expect(totalEvents(c.takeInterval())).toBe(0)
    expect(c.total).toMatchObject({ keyDown: 1, keyUp: 1, mouseDown: { left: 1 } })
  })

  it('keeps event ages in ms and counts implausible ones (wrong timestamp unit)', () => {
    const c = new HelperInputCounter(10, 2)
    c.record(key(true, false, 1, NOW - 0.004), NOW)
    c.record(key(false, false, 1, NOW + 5), NOW) // 5 s in the future
    c.record(key(true, false, 1, NOW - 3600), NOW) // an hour old
    c.record(key(false, false, 1, NOW - 0.001), NOW)
    c.record(key(true, false, 1, NOW - 0.001), NOW) // over the sample cap
    expect(c.ages.implausible).toBe(2)
    expect(c.ages.samplesMs).toHaveLength(2)
    expect(c.ages.samplesMs[0]).toBeCloseTo(4, 3)
  })

  it('never exposes key codes in counts, intervals or text', () => {
    const c = counter()
    for (let i = 0; i < 5; i++) {
      c.record(key(true, i > 0), NOW)
    }
    c.record(key(false), NOW)
    const texts = [JSON.stringify(c.total), JSON.stringify(c.takeInterval()), formatCounts(c.total)]
    for (const text of texts) {
      expect(text).not.toContain(String(SECRET_CODE))
      expect(text).not.toMatch(/"code"/)
    }
  })
})

describe('UiohookInputCounter', () => {
  it('derives repeats from the held-key set (libuiohook repeats are plain keydowns)', () => {
    const c = new UiohookInputCounter()
    c.keydown(SECRET_CODE)
    c.keydown(SECRET_CODE)
    c.keydown(SECRET_CODE)
    c.keyup(SECRET_CODE)
    c.keydown(SECRET_CODE)
    expect(c.total).toMatchObject({ keyDown: 4, keyUp: 1, keyRepeat: 2 })
    expect(JSON.stringify(c.total)).not.toContain(String(SECRET_CODE))
  })

  it('maps 1-based uiohook buttons and counts wheel events without a breakdown it cannot observe', () => {
    const c = new UiohookInputCounter()
    for (const button of [1, 1, 2, 3, undefined]) c.mousedown(button)
    c.wheel()
    c.wheel()
    c.wheel()
    expect(c.total.mouseDown).toEqual({ left: 2, right: 1, other: 2 })
    // libuiohook never delivers zero-delta or sub-line scrolls, labels diagonal ones vertical and has no
    // continuous/momentum flag: those counts are null (unobservable), never a 0 that reads as data.
    expect(c.total.scroll).toEqual({ events: 3, continuous: null, momentum: null, zeroDelta: null, horizontal: null })
    expect(c.total.repeatDisagreements).toBeNull()
  })

  it('keeps unobservable counts null across intervals and totals', () => {
    const c = new UiohookInputCounter()
    c.wheel()
    expect(c.takeInterval().scroll.zeroDelta).toBeNull()
    c.keydown(SECRET_CODE)
    expect(c.total.scroll).toEqual({ events: 1, continuous: null, momentum: null, zeroDelta: null, horizontal: null })
    expect(c.total.repeatDisagreements).toBeNull()
  })
})

describe('formatCounts', () => {
  it('leaves out what uiohook cannot observe instead of printing 0', () => {
    const counts = emptyCounts('uiohook')
    counts.keyDown = 5
    counts.keyUp = 5
    counts.scroll.events = 3
    expect(formatCounts(counts)).toBe(
      'keys down 5 (repeat 0) up 5 · clicks left 0 right 0 other 0 · scroll 3 (whole-line events only, no breakdown)',
    )
  })

  it('prints every helper count on one line', () => {
    const counts = emptyCounts('helper')
    counts.keyDown = 12
    counts.keyRepeat = 3
    counts.keyUp = 11
    counts.mouseDown.left = 2
    counts.scroll.events = 14
    counts.scroll.continuous = 14
    expect(formatCounts(counts)).toBe(
      'keys down 12 (repeat 3) up 11 · clicks left 2 right 0 other 0 · ' +
        'scroll 14 (continuous 14, momentum 0, zero-delta 0, horizontal 0) · repeat-flag disagreements 0/0',
    )
  })
})

describe('input options', () => {
  it('requires a source', () => {
    expect(() => parseInputOptions({}, '/')).toThrow(/--source/)
    expect(() => parseInputOptions({ source: 'iohook' }, '/')).toThrow(/--source/)
  })

  it('defaults', () => {
    expect(parseInputOptions({ source: 'helper' }, '/repo')).toEqual({
      source: 'helper',
      keys: true,
      mouse: true,
      request: false,
      durationS: tuning.spikeInput.defaultDurationS,
      retryOnGrant: true,
      resultsDir: null,
      label: null,
    })
  })

  it('parses the flags', () => {
    expect(
      parseInputOptions(
        { source: 'helper', keys: 'false', request: 'true', duration: '0', 'retry-on-grant': 'false', results: 'r', label: 'a' },
        '/repo',
      ),
    ).toEqual({
      source: 'helper',
      keys: false,
      mouse: true,
      request: true,
      durationS: 0,
      retryOnGrant: false,
      resultsDir: '/repo/r',
      label: 'a',
    })
    expect(parseInputOptions({ source: 'uiohook', mouse: 'false' }, '/').mouse).toBe(false)
  })

  it('rejects nothing-to-count and --request with uiohook', () => {
    expect(() => parseInputOptions({ source: 'helper', keys: 'false', mouse: 'false' }, '/')).toThrow(/nothing to count/)
    expect(() => parseInputOptions({ source: 'uiohook', request: 'true' }, '/')).toThrow(/--request/)
  })
})

describe('restart after grant (§15.1: does a fresh helper process get the tap?)', () => {
  const tap = (active: boolean, reason: 'notGranted' | 'tapCreateFailed' | 'helperUnavailable' | null = null) => ({
    type: 'inputTap' as const,
    id: null,
    active,
    error: active ? null : 'refused',
    reason,
  })

  function harness(options: { killThrows?: boolean } = {}) {
    const records: { name: string; status: string; detail: string }[] = []
    const kills: number[] = []
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    let t = 1000
    let pid: number | null = 501
    const deps: RestartProbeDeps = {
      kill: (p) => {
        if (options.killThrows) throw new Error('ESRCH')
        kills.push(p)
        pid = 777 // HelperClient's respawned helper
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms, cleared: false })
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (timer) => {
        const entry = timers[(timer as unknown as number) - 1]
        if (entry) entry.cleared = true
      },
      nowMs: () => t,
      currentPid: () => pid,
      record: (name, status, detail) => records.push({ name, status, detail }),
      log: () => {},
    }
    const probe = new RestartAfterGrantProbe(deps, 10_000)
    return { probe, records, kills, timers, advance: (ms: number) => (t += ms) }
  }

  it('follows the same-process retry: nothing to test, restart the helper, or nothing', () => {
    expect(followUpAfterRetry({ active: true, reason: null })).toBe('notNeeded')
    expect(followUpAfterRetry({ active: false, reason: 'tapCreateFailed' })).toBe('restartHelper')
    expect(followUpAfterRetry({ active: false, reason: 'notGranted' })).toBe('none')
  })

  it('passes when the tap re-applied in the respawned helper is active', () => {
    const h = harness()
    h.probe.start(501)
    expect(h.kills).toEqual([501])
    h.advance(420)
    h.probe.onReapplied(tap(true))
    expect(h.records).toEqual([
      { name: RESTART_AFTER_GRANT, status: 'PASS', detail: expect.stringContaining('new helper pid 777 420 ms after the SIGTERM') },
    ])
    expect(h.timers[0]?.cleared).toBe(true)
    expect(h.probe.state).toMatchObject({ oldPid: 501, newPid: 777, done: true, result: { active: true, afterMs: 420 } })
  })

  it('fails (the app needs a relaunch) when the re-applied tap is refused again', () => {
    const h = harness()
    h.probe.start(501)
    h.probe.onReapplied(tap(false, 'tapCreateFailed'))
    expect(h.records[0]).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('reason=tapCreateFailed') })
    expect(h.records[0]?.detail).toContain('Relaunch Bitbot')
  })

  it('fails on a timeout or a failed SIGTERM, and is inconclusive when the run ends first', () => {
    const timedOut = harness()
    timedOut.probe.start(501)
    timedOut.timers[0]?.fn()
    expect(timedOut.records[0]).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('no re-applied tap within 10000 ms') })

    const noKill = harness({ killThrows: true })
    noKill.probe.start(501)
    expect(noKill.records[0]).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('SIGTERM failed: ESRCH') })

    const ended = harness()
    ended.probe.start(501)
    ended.probe.abort('the run ended')
    expect(ended.records[0]).toMatchObject({ status: 'WARN', detail: expect.stringContaining('inconclusive') })
  })

  it('records once, ignores re-applied taps when not pending, and restarts at most once per run', () => {
    const h = harness()
    h.probe.onReapplied(tap(true)) // a crash restart before any grant: not ours
    expect(h.records).toEqual([])
    h.probe.start(501)
    h.probe.onReapplied(tap(true))
    h.probe.onReapplied(tap(false, 'tapCreateFailed'))
    h.probe.abort('late')
    h.timers[0]?.fn()
    h.probe.start(777)
    expect(h.records).toHaveLength(1)
    expect(h.kills).toEqual([501])
  })

  it('records "not needed" when the same-process retry worked', () => {
    const h = harness()
    h.probe.notNeeded()
    expect(h.records).toEqual([{ name: RESTART_AFTER_GRANT, status: 'SKIP', detail: expect.stringContaining('same helper process') }])
    expect(h.kills).toEqual([])
  })
})
