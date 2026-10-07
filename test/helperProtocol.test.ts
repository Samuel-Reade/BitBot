import { describe, expect, it } from 'vitest'
import {
  encodeCommand,
  HELPER_PROTOCOL_VERSION,
  HELPER_TAP_FAILURES,
  LineSplitter,
  parseHelperMessage,
  RESPONSE_TYPE,
  type HelperCommand,
} from '../src/main/helper/protocol'

const window1 = { wid: 5132, pid: 61869, bundleId: 'com.anthropic.claudefordesktop', layer: 0, x: 147, y: 109, w: 992, h: 772, onScreen: true, alpha: 1 }
const window2 = { wid: 5750, pid: 382, bundleId: null, layer: 24, x: 0, y: 0, w: 1710, h: 38, onScreen: true, alpha: 0.5 }

const line = (value: unknown): string => JSON.stringify(value)

describe('LineSplitter', () => {
  it('joins partial lines across chunks', () => {
    const splitter = new LineSplitter(1000)
    expect(splitter.push('{"a":')).toEqual([])
    expect(splitter.push('1}')).toEqual([])
    expect(splitter.push('\n')).toEqual(['{"a":1}'])
  })

  it('returns several lines from one chunk and keeps the trailing partial', () => {
    const splitter = new LineSplitter(1000)
    expect(splitter.push('one\ntwo\nthr')).toEqual(['one', 'two'])
    expect(splitter.push('ee\n')).toEqual(['three'])
  })

  it('strips CRLF, including a CR and LF that arrive in different chunks', () => {
    const splitter = new LineSplitter(1000)
    expect(splitter.push('a\r\nb\r')).toEqual(['a'])
    expect(splitter.push('\nc\n')).toEqual(['b', 'c'])
  })

  it('skips blank and whitespace-only lines', () => {
    const splitter = new LineSplitter(1000)
    expect(splitter.push('\n\r\n  \nx\n\n')).toEqual(['x'])
  })

  it('drops an over-long line arriving in one chunk and keeps the next', () => {
    const drops: number[] = []
    const splitter = new LineSplitter(10, (n) => drops.push(n))
    expect(splitter.push(`${'x'.repeat(11)}\nok\n`)).toEqual(['ok'])
    expect(splitter.droppedLines).toBe(1)
    expect(drops).toEqual([11])
  })

  it('accepts a line of exactly the cap', () => {
    const splitter = new LineSplitter(10)
    expect(splitter.push(`${'y'.repeat(10)}\n`)).toEqual(['y'.repeat(10)])
    expect(splitter.droppedLines).toBe(0)
  })

  it('drops an over-long line spread over many chunks, without buffering it, then resyncs', () => {
    const splitter = new LineSplitter(10)
    expect(splitter.push('0123456789')).toEqual([])
    expect(splitter.push('ABC')).toEqual([]) // now over the cap: discarding until the next newline
    expect(splitter.push('x'.repeat(100_000))).toEqual([])
    expect(splitter.push('tail\nnext\n')).toEqual(['next'])
    expect(splitter.droppedLines).toBe(1)
  })

  it('drops a line that only exceeds the cap once its newline arrives', () => {
    const splitter = new LineSplitter(10)
    expect(splitter.push('012345678')).toEqual([])
    expect(splitter.push('9AB\nfine\n')).toEqual(['fine'])
    expect(splitter.droppedLines).toBe(1)
  })

  it('reset() discards a partial line', () => {
    const splitter = new LineSplitter(100)
    splitter.push('partial')
    splitter.reset()
    expect(splitter.push(' rest\n')).toEqual([' rest'])
  })

  it('handles a 1 MB snapshot line delivered in 64 kB chunks', () => {
    const windows = Array.from({ length: 8000 }, (_, i) => ({ ...window1, wid: i }))
    const big = line({ type: 'snapshot', id: null, ts: 1, windows })
    const splitter = new LineSplitter(4_000_000)
    const out: string[] = []
    for (let i = 0; i < big.length; i += 65_536) out.push(...splitter.push(big.slice(i, i + 65_536)))
    out.push(...splitter.push('\n'))
    expect(out).toHaveLength(1)
    const parsed = parseHelperMessage(out[0] ?? '')
    expect(parsed?.type === 'snapshot' && parsed.windows.length).toBe(8000)
  })
})

describe('parseHelperMessage: valid messages', () => {
  it('hello', () => {
    expect(parseHelperMessage(line({ type: 'hello', version: 1, pid: 42 }))).toEqual({ type: 'hello', version: 1, pid: 42 })
    expect(HELPER_PROTOCOL_VERSION).toBe(2)
  })

  it('snapshot (pushed and replied), preserving window order', () => {
    const pushed = parseHelperMessage(line({ type: 'snapshot', id: null, ts: 1791335998.977375, windows: [window1, window2] }))
    expect(pushed).toEqual({ type: 'snapshot', id: null, ts: 1791335998.977375, windows: [window1, window2] })
    const replied = parseHelperMessage(line({ type: 'snapshot', id: 8, ts: 1, windows: [] }))
    expect(replied).toEqual({ type: 'snapshot', id: 8, ts: 1, windows: [] })
  })

  it('a snapshot without id is treated as a push', () => {
    expect(parseHelperMessage(line({ type: 'snapshot', ts: 1, windows: [] }))).toMatchObject({ id: null })
  })

  it('pong, displays, frontmost, appInfo, inputAccess, diag', () => {
    expect(parseHelperMessage(line({ type: 'pong', id: 1 }))).toEqual({ type: 'pong', id: 1 })
    expect(
      parseHelperMessage(line({ type: 'displays', id: 2, displays: [{ id: 1, x: 0, y: 0, w: 1710, h: 1107, main: true }] })),
    ).toEqual({ type: 'displays', id: 2, displays: [{ id: 1, x: 0, y: 0, w: 1710, h: 1107, main: true }] })
    const frontmost = { type: 'frontmost', id: 3, bundleId: 'com.x', pid: 9, appName: 'X', fullscreen: false }
    expect(parseHelperMessage(line(frontmost))).toEqual(frontmost)
    const noFront = { type: 'frontmost', id: 3, bundleId: null, pid: null, appName: null, fullscreen: false }
    expect(parseHelperMessage(line(noFront))).toEqual(noFront)
    const appInfo = { type: 'appInfo', id: 4, pid: 1, bundleId: null, appName: null }
    expect(parseHelperMessage(line(appInfo))).toEqual(appInfo)
    const access = { type: 'inputAccess', id: 5, listen: false, post: false, accessibility: true }
    expect(parseHelperMessage(line(access))).toEqual(access)
    const diag = {
      type: 'diag',
      id: 6,
      pid: 80685,
      ppid: 80663,
      responsiblePid: 682,
      responsiblePath: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      executablePath: '/x/build/helper/bitbot-helper',
      version: 1,
    }
    expect(parseHelperMessage(line(diag))).toEqual(diag)
    expect(parseHelperMessage(line({ ...diag, responsiblePid: null, responsiblePath: null }))).toMatchObject({ responsiblePid: null })
  })

  it('inputTap with id, and with id null (re-applied after restart)', () => {
    const refused = { type: 'inputTap', id: 7, active: false, error: 'Input Monitoring is not granted', reason: 'notGranted' }
    expect(parseHelperMessage(line(refused))).toEqual(refused)
    const failed = { type: 'inputTap', id: 8, active: false, error: 'CGEventTapCreate failed', reason: 'tapCreateFailed' }
    expect(parseHelperMessage(line(failed))).toEqual(failed)
    expect(parseHelperMessage(line({ type: 'inputTap', id: null, active: true, error: null, reason: null }))).toEqual({
      type: 'inputTap',
      id: null,
      active: true,
      error: null,
      reason: null,
    })
    expect(HELPER_TAP_FAILURES).toEqual(['notGranted', 'tapCreateFailed'])
  })

  it('input events of each kind', () => {
    const key = { type: 'input', kind: 'key', down: true, code: 49, repeat: false, ts: 1.5 }
    expect(parseHelperMessage(line(key))).toEqual(key)
    const mouse = { type: 'input', kind: 'mouseDown', button: 0, alt: true, cmd: true, shift: false, ctrl: false, x: 10.5, y: 20, ts: 2 }
    expect(parseHelperMessage(line(mouse))).toEqual(mouse)
    // Plain clicks carry no location (data minimisation): only ⌥⌘-clicks need one (§10.4).
    const plainClick = { type: 'input', kind: 'mouseDown', button: 0, alt: false, cmd: false, shift: false, ctrl: false, x: null, y: null, ts: 2 }
    expect(parseHelperMessage(line(plainClick))).toEqual(plainClick)
    const scroll = { type: 'input', kind: 'scroll', lines: -1, px: -12.25, linesX: 2, pxX: 20, continuous: true, momentum: false, ts: 3 }
    expect(parseHelperMessage(line(scroll))).toEqual(scroll)
    const gestureEnd = { type: 'input', kind: 'scroll', lines: 0, px: 0, linesX: 0, pxX: 0, continuous: true, momentum: false, ts: 4 }
    expect(parseHelperMessage(line(gestureEnd))).toEqual(gestureEnd)
  })

  it('frontmostFullscreen: unsolicited without id, and as a reply, with the covered displays', () => {
    expect(parseHelperMessage(line({ type: 'frontmostFullscreen', value: true, bundleId: 'com.apple.TV', displayIds: [1, 69733248] }))).toEqual({
      type: 'frontmostFullscreen',
      id: null,
      value: true,
      bundleId: 'com.apple.TV',
      displayIds: [1, 69733248],
    })
    expect(parseHelperMessage(line({ type: 'frontmostFullscreen', id: 9, value: false, bundleId: null, displayIds: [] }))).toMatchObject({
      id: 9,
      displayIds: [],
    })
  })

  it('app events', () => {
    for (const type of ['appLaunched', 'appActivated', 'appTerminated'] as const) {
      const event = { type, bundleId: 'com.apple.calculator', pid: 123, appName: 'Calculator', ts: 1791336000.5 }
      expect(parseHelperMessage(line(event))).toEqual(event)
    }
    expect(parseHelperMessage(line({ type: 'appLaunched', bundleId: null, pid: 1, appName: null, ts: 1 }))).not.toBeNull()
  })

  it('error, with and without id', () => {
    expect(parseHelperMessage(line({ type: 'error', id: 9, message: 'bad' }))).toEqual({ type: 'error', id: 9, message: 'bad' })
    expect(parseHelperMessage(line({ type: 'error', message: 'bad' }))).toEqual({ type: 'error', id: null, message: 'bad' })
  })

  it('drops unknown extra fields and returns a fresh object', () => {
    const parsed = parseHelperMessage(line({ type: 'pong', id: 1, extra: 'x', windowTitle: 'never forwarded' }))
    expect(parsed).toEqual({ type: 'pong', id: 1 })
    expect(Object.keys(parsed ?? {})).toEqual(['type', 'id'])
    const snapshot = parseHelperMessage(line({ type: 'snapshot', id: null, ts: 1, windows: [{ ...window1, name: 'secret' }] }))
    expect(snapshot?.type === 'snapshot' && Object.keys(snapshot.windows[0] ?? {})).toEqual(Object.keys(window1))
    const raw = { type: 'frontmostFullscreen', value: true, bundleId: null, displayIds: [1] }
    const fullscreen = parseHelperMessage(line(raw))
    expect(fullscreen?.type === 'frontmostFullscreen' && fullscreen.displayIds).toEqual([1])
    expect(fullscreen?.type === 'frontmostFullscreen' && fullscreen.displayIds).not.toBe(raw.displayIds)
  })
})

describe('parseHelperMessage: malformed input returns null', () => {
  const cases: [string, string][] = [
    ['empty', ''],
    ['not JSON', 'garbage'],
    ['truncated JSON', '{"type":"pong","id":1'],
    ['JSON null', 'null'],
    ['JSON number', '42'],
    ['JSON string', '"pong"'],
    ['array', '[{"type":"pong","id":1}]'],
    ['missing type', line({ id: 1 })],
    ['non-string type', line({ type: 7, id: 1 })],
    ['unknown type', line({ type: 'teleport', id: 1 })],
    ['pong without id', line({ type: 'pong' })],
    ['pong with fractional id', line({ type: 'pong', id: 1.5 })],
    ['pong with string id', line({ type: 'pong', id: '1' })],
    ['pong with unsafe id', '{"type":"pong","id":9007199254740993}'],
    ['hello with string pid', line({ type: 'hello', version: 1, pid: '42' })],
    ['snapshot with non-array windows', line({ type: 'snapshot', id: null, ts: 1, windows: {} })],
    ['snapshot without ts', line({ type: 'snapshot', id: null, windows: [] })],
    ['snapshot with string id', line({ type: 'snapshot', id: 'a', ts: 1, windows: [] })],
    ['snapshot with one bad window', line({ type: 'snapshot', id: null, ts: 1, windows: [window1, { ...window2, w: '1710' }] })],
    ['snapshot with null bound', line({ type: 'snapshot', id: null, ts: 1, windows: [{ ...window1, x: null }] })],
    ['snapshot with non-integer layer', line({ type: 'snapshot', id: null, ts: 1, windows: [{ ...window1, layer: 0.5 }] })],
    ['snapshot with numeric onScreen', line({ type: 'snapshot', id: null, ts: 1, windows: [{ ...window1, onScreen: 1 }] })],
    ['snapshot with a missing field', line({ type: 'snapshot', id: null, ts: 1, windows: [{ wid: 1, pid: 1 }] })],
    ['snapshot with a null window', line({ type: 'snapshot', id: null, ts: 1, windows: [null] })],
    ['displays with bad entry', line({ type: 'displays', id: 1, displays: [{ id: 1, x: 0, y: 0, w: 1, h: 1, main: 'yes' }] })],
    ['frontmost without fullscreen', line({ type: 'frontmost', id: 1, bundleId: null, pid: null, appName: null })],
    ['appInfo with bundleId number', line({ type: 'appInfo', id: 1, pid: 1, bundleId: 5, appName: null })],
    ['inputAccess with string flag', line({ type: 'inputAccess', id: 1, listen: 'false', post: false, accessibility: false })],
    ['inputTap missing error', line({ type: 'inputTap', id: 1, active: true, reason: null })],
    ['inputTap missing reason (protocol v1)', line({ type: 'inputTap', id: 1, active: true, error: null })],
    ['inputTap with an unknown reason', line({ type: 'inputTap', id: 1, active: false, error: 'x', reason: 'cosmicRays' })],
    ['inputTap with the client-only reason', line({ type: 'inputTap', id: 1, active: false, error: 'x', reason: 'helperUnavailable' })],
    ['input with unknown kind', line({ type: 'input', kind: 'typed', text: 'secret', ts: 1 })],
    ['key with fractional code', line({ type: 'input', kind: 'key', down: true, code: 1.5, repeat: false, ts: 1 })],
    ['key without ts', line({ type: 'input', kind: 'key', down: true, code: 1, repeat: false })],
    ['mouseDown with string x', line({ type: 'input', kind: 'mouseDown', button: 0, alt: false, cmd: false, shift: false, ctrl: false, x: '1', y: 2, ts: 1 })],
    ['mouseDown with only one coordinate', line({ type: 'input', kind: 'mouseDown', button: 0, alt: true, cmd: true, shift: false, ctrl: false, x: 1, y: null, ts: 1 })],
    ['scroll with fractional lines', line({ type: 'input', kind: 'scroll', lines: 0.5, px: 1, linesX: 0, pxX: 0, continuous: false, momentum: false, ts: 1 })],
    ['scroll without horizontal deltas (protocol v1)', line({ type: 'input', kind: 'scroll', lines: 1, px: 1, continuous: false, momentum: false, ts: 1 })],
    ['scroll with fractional linesX', line({ type: 'input', kind: 'scroll', lines: 0, px: 0, linesX: 0.5, pxX: 1, continuous: false, momentum: false, ts: 1 })],
    ['scroll with string pxX', line({ type: 'input', kind: 'scroll', lines: 0, px: 0, linesX: 1, pxX: '10', continuous: false, momentum: false, ts: 1 })],
    ['diag with string version', line({ type: 'diag', id: 1, pid: 1, ppid: 1, responsiblePid: null, responsiblePath: null, executablePath: null, version: '1' })],
    ['frontmostFullscreen without value', line({ type: 'frontmostFullscreen', bundleId: null, displayIds: [] })],
    ['frontmostFullscreen with fractional id', line({ type: 'frontmostFullscreen', id: 0.5, value: true, bundleId: null, displayIds: [1] })],
    ['frontmostFullscreen without displayIds (protocol v1)', line({ type: 'frontmostFullscreen', value: true, bundleId: null })],
    ['frontmostFullscreen with non-array displayIds', line({ type: 'frontmostFullscreen', value: true, bundleId: null, displayIds: 1 })],
    ['frontmostFullscreen with a fractional display id', line({ type: 'frontmostFullscreen', value: true, bundleId: null, displayIds: [1.5] })],
    ['frontmostFullscreen with a null display id', line({ type: 'frontmostFullscreen', value: true, bundleId: null, displayIds: [null] })],
    ['app event without pid', line({ type: 'appLaunched', bundleId: 'x', appName: 'X', ts: 1 })],
    ['app event with string ts', line({ type: 'appTerminated', bundleId: 'x', pid: 1, appName: 'X', ts: 'now' })],
    ['error without message', line({ type: 'error', id: 1 })],
  ]
  it.each(cases)('%s', (_name, input) => {
    expect(parseHelperMessage(input)).toBeNull()
  })

  it('treats __proto__ keys as plain data', () => {
    expect(parseHelperMessage('{"__proto__":{"type":"pong","id":1}}')).toBeNull()
    expect(parseHelperMessage('{"type":"pong","id":1,"__proto__":{"polluted":true}}')).toEqual({ type: 'pong', id: 1 })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('never throws on random input', () => {
    let seed = 12345
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const alphabet = '{}[]":,0123456789.eE+-truefalsnul\\ abtypeidwindows\n\r\u0000 '
    for (let i = 0; i < 3000; i++) {
      let text = ''
      const length = Math.floor(random() * 60)
      for (let j = 0; j < length; j++) text += alphabet[Math.floor(random() * alphabet.length)] ?? ''
      expect(() => parseHelperMessage(text)).not.toThrow()
    }
    const values: unknown[] = [null, true, 0, -1, 1e308, 'x', [], {}, [null], { type: null }, { type: 'snapshot', windows: [[]] }]
    for (const value of values) {
      const types: string[] = [...Object.values(RESPONSE_TYPE), 'hello', 'input', 'appLaunched', 'error']
      for (const type of types) {
        expect(() => parseHelperMessage(line({ type, id: value, windows: value, displays: value, kind: value, ts: value }))).not.toThrow()
      }
    }
  })
})

describe('encodeCommand', () => {
  const commands: HelperCommand[] = [
    { type: 'snapshot', id: 1 },
    { type: 'setPollRate', hz: 4 },
    { type: 'setPollRate', hz: 0 },
    { type: 'ping', id: 2 },
    { type: 'displays', id: 3 },
    { type: 'frontmost', id: 4 },
    { type: 'appInfo', id: 5, pid: 1234 },
    { type: 'inputAccess', id: 6 },
    { type: 'requestInputAccess', id: 7 },
    { type: 'startInputTap', id: 8, keys: true, mouse: false },
    { type: 'stopInputTap', id: 9 },
    { type: 'diag', id: 10 },
    { type: 'fullscreenState', id: 11 },
    { type: 'quit' },
  ]

  it.each(commands)('$type encodes as exactly one newline-terminated JSON line', (command) => {
    const encoded = encodeCommand(command)
    expect(encoded.endsWith('\n')).toBe(true)
    expect(encoded.slice(0, -1)).not.toMatch(/[\r\n]/)
    expect(JSON.parse(encoded)).toEqual(command)
  })

  it('rejects non-finite numbers instead of sending null', () => {
    expect(() => encodeCommand({ type: 'setPollRate', hz: Number.NaN })).toThrow(RangeError)
    expect(() => encodeCommand({ type: 'setPollRate', hz: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(() => encodeCommand({ type: 'appInfo', id: 1, pid: Number.NaN })).toThrow(RangeError)
    expect(() => encodeCommand({ type: 'ping', id: Number.NaN })).toThrow(RangeError)
  })

  it('maps every request type to the message type that answers it', () => {
    expect(RESPONSE_TYPE).toEqual({
      snapshot: 'snapshot',
      ping: 'pong',
      displays: 'displays',
      frontmost: 'frontmost',
      appInfo: 'appInfo',
      inputAccess: 'inputAccess',
      requestInputAccess: 'inputAccess',
      startInputTap: 'inputTap',
      stopInputTap: 'inputTap',
      diag: 'diag',
      fullscreenState: 'frontmostFullscreen',
    })
  })
})
