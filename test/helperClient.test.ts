import { spawn as spawnProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultHelperArgs,
  defaultWatchdog,
  HelperClient,
  HelperRequestError,
  spawnHelperProcess,
  type HelperChildProcess,
  type HelperClientEventMap,
  type HelperExitInfo,
  type HelperWatchdogOptions,
} from '../src/main/helper/helperClient'
import { resolveHelperPath } from '../src/main/helper/paths'
import { HELPER_PROTOCOL_VERSION, type HelperMessage, type SpaceChangedMsg } from '../src/main/helper/protocol'
import { tuning } from '../src/shared/tuning'

const T = tuning.helper

class FakeStdin extends EventEmitter {
  readonly written: string[] = []
  ended = false
  write(chunk: string): boolean {
    this.written.push(chunk)
    return true
  }
  end(): void {
    this.ended = true
  }
}

let nextPid = 1000

class FakeChild extends EventEmitter implements HelperChildProcess {
  readonly pid: number | undefined
  readonly stdin = new FakeStdin()
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly signals: string[] = []

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    spawned = true,
  ) {
    super()
    this.pid = spawned ? nextPid++ : undefined
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.signals.push(String(signal))
    return true
  }

  /** Commands the client wrote, parsed. */
  commands(): Record<string, unknown>[] {
    return this.stdin.written
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  lastCommand(): Record<string, unknown> {
    const all = this.commands()
    const last = all[all.length - 1]
    if (!last) throw new Error('no command written')
    return last
  }

  send(message: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(message)}\n`)
  }

  reply(type: string, fields: Record<string, unknown> = {}): void {
    this.send({ type, id: this.lastCommand()['id'], ...fields })
  }

  exit(code: number | null = 0, signal: string | null = null): void {
    this.emit('exit', code, signal)
  }
}

/** The watchdog is off unless a test asks for it, so its heartbeat pings never mix into command lists. */
function setup(options: { failSpawn?: boolean; watchdog?: HelperWatchdogOptions } = {}) {
  const children: FakeChild[] = []
  const spawn = vi.fn((command: string, args: readonly string[]) => {
    const child = new FakeChild(command, args, !options.failSpawn)
    children.push(child)
    return child
  })
  const client = new HelperClient({ binaryPath: '/bin/bitbot-helper', spawn, watchdog: options.watchdog ?? false })
  const events: { type: keyof HelperClientEventMap; event: unknown }[] = []
  for (const type of ['exit', 'restart', 'protocolError', 'inputTap', 'snapshot', 'appLaunched', 'error', 'stderr', 'hello'] as const) {
    client.on(type, (event) => events.push({ type, event }))
  }
  const child = (index = children.length - 1): FakeChild => {
    const c = children[index]
    if (!c) throw new Error(`no child ${index}`)
    return c
  }
  const eventsOf = <K extends keyof HelperClientEventMap>(type: K): HelperClientEventMap[K][] =>
    events.filter((e) => e.type === type).map((e) => e.event as HelperClientEventMap[K])
  return { client, children, spawn, child, events, eventsOf }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HelperClient requests', () => {
  it('spawns the binary with the tuning-derived arguments', () => {
    const { client, spawn } = setup()
    client.start()
    expect(spawn).toHaveBeenCalledWith('/bin/bitbot-helper', defaultHelperArgs())
    expect(defaultHelperArgs()).toEqual([
      `--fullscreen-idle-hz=${T.fullscreenIdleHz}`,
      `--fullscreen-tolerance-pt=${T.fullscreenTolerancePt}`,
      `--fullscreen-follow-up-ms=${T.fullscreenFollowUpMs}`,
      `--resync-ms=${T.resyncMs}`,
    ])
    expect(client.isRunning).toBe(true)
  })

  it('matches replies to requests by id, even out of order', async () => {
    const { client, child } = setup()
    client.start()
    const diag = client.diag()
    const ping = client.ping()
    const [diagCommand, pingCommand] = child().commands()
    expect(diagCommand).toEqual({ type: 'diag', id: 1 })
    expect(pingCommand).toEqual({ type: 'ping', id: 2 })
    child().send({ type: 'pong', id: 2 })
    child().send({ type: 'diag', id: 1, pid: 5, ppid: 4, responsiblePid: null, responsiblePath: null, executablePath: '/x', version: 1 })
    await expect(ping).resolves.toEqual({ type: 'pong', id: 2 })
    await expect(diag).resolves.toMatchObject({ type: 'diag', id: 1, pid: 5 })
  })

  it('sends every convenience request with the right shape', () => {
    const { client, child } = setup()
    client.start()
    const calls = [
      client.snapshot(),
      client.displays(),
      client.frontmost(),
      client.appInfo(77),
      client.inputAccess(),
      client.requestInputAccess(),
      client.startInputTap({ keys: true, mouse: false }),
      client.stopInputTap(),
      client.fullscreenState(),
    ]
    for (const call of calls) call.catch(() => {})
    expect(child().commands()).toEqual([
      { type: 'snapshot', id: 1 },
      { type: 'displays', id: 2 },
      { type: 'frontmost', id: 3 },
      { type: 'appInfo', id: 4, pid: 77 },
      { type: 'inputAccess', id: 5 },
      { type: 'requestInputAccess', id: 6 },
      { type: 'startInputTap', id: 7, keys: true, mouse: false },
      { type: 'stopInputTap', id: 8 },
      { type: 'fullscreenState', id: 9 },
    ])
  })

  it('parses replies split across chunks, several per chunk, and UTF-8 split mid-character', async () => {
    const { client, child } = setup()
    client.start()
    const a = client.appInfo(1)
    const b = client.ping()
    const reply = JSON.stringify({ type: 'appInfo', id: 1, pid: 1, bundleId: 'com.x', appName: 'Café ☕' })
    const bytes = new TextEncoder().encode(`${reply}\n${JSON.stringify({ type: 'pong', id: 2 })}\n`)
    const cut = bytes.indexOf(0xe2) + 1 // inside the 3-byte ☕
    child().stdout.emit('data', bytes.slice(0, cut))
    child().stdout.emit('data', bytes.slice(cut))
    await expect(a).resolves.toMatchObject({ appName: 'Café ☕' })
    await expect(b).resolves.toEqual({ type: 'pong', id: 2 })
  })

  it('rejects on an error reply that carries the request id', async () => {
    const { client, child } = setup()
    client.start()
    const request = client.appInfo(1)
    child().send({ type: 'error', id: 1, message: 'appInfo: invalid arguments' })
    await expect(request).rejects.toMatchObject({ name: 'HelperRequestError', reason: 'helper-error' })
  })

  it('rejects a reply of the wrong type', async () => {
    const { client, child } = setup()
    client.start()
    const request = client.displays()
    child().send({ type: 'pong', id: 1 })
    await expect(request).rejects.toMatchObject({ reason: 'protocol' })
  })

  it('times out, then treats the late reply as unmatched instead of an event', async () => {
    const { client, child, eventsOf } = setup()
    client.start()
    const request = client.snapshot()
    const assertion = expect(request).rejects.toMatchObject({ reason: 'timeout' })
    vi.advanceTimersByTime(T.requestTimeoutMs)
    await assertion
    child().send({ type: 'snapshot', id: 1, ts: 1, windows: [] })
    expect(eventsOf('snapshot')).toEqual([])
    expect(eventsOf('protocolError')).toEqual([{ reason: 'unmatchedReply', length: expect.any(Number) }])
  })

  it('gives requestInputAccess the long interactive timeout', async () => {
    const { client } = setup()
    client.start()
    const request = client.requestInputAccess()
    let settled = false
    request.catch(() => (settled = true))
    await vi.advanceTimersByTimeAsync(T.requestTimeoutMs * 2)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(T.interactiveRequestTimeoutMs)
    expect(settled).toBe(true)
  })

  it('rejects immediately when the helper is not running', async () => {
    const { client } = setup()
    await expect(client.ping()).rejects.toMatchObject({ reason: 'not-running' })
  })

  it('routes unsolicited messages to typed listeners, and unsubscribe stops delivery', () => {
    const { client, child, eventsOf } = setup()
    client.start()
    const seen: unknown[] = []
    const off = client.on('appActivated', (event) => seen.push(event.bundleId))
    child().send({ type: 'hello', version: HELPER_PROTOCOL_VERSION, pid: 99 })
    child().send({ type: 'snapshot', id: null, ts: 1, windows: [] })
    child().send({ type: 'appActivated', bundleId: 'com.a', pid: 3, appName: 'A', ts: 1 })
    off()
    child().send({ type: 'appActivated', bundleId: 'com.b', pid: 4, appName: 'B', ts: 2 })
    child().send({ type: 'error', message: 'malformed command' })
    expect(seen).toEqual(['com.a'])
    expect(eventsOf('snapshot')).toEqual([{ type: 'snapshot', id: null, ts: 1, windows: [] }])
    expect(eventsOf('hello')).toEqual([{ type: 'hello', version: HELPER_PROTOCOL_VERSION, pid: 99 }])
    expect(client.helloMessage).toEqual({ type: 'hello', version: HELPER_PROTOCOL_VERSION, pid: 99 })
    expect(eventsOf('error')).toEqual([{ type: 'error', id: null, message: 'malformed command' }])
  })

  it('delivers spaceChanged pushes to their listeners, never to a pending request, and drops malformed ones', async () => {
    const { client, child, eventsOf } = setup()
    client.start()
    const seen: SpaceChangedMsg[] = []
    const off = client.on('spaceChanged', (event) => seen.push(event))
    const ping = client.ping() // id 1 waits for its reply
    child().send({ type: 'spaceChanged', ts: 1791336000.5 })
    child().send({ type: 'spaceChanged', id: 1, ts: 1791336001 }) // a stray id: still a push, not the ping's reply
    child().send({ type: 'spaceChanged', ts: 'now' })
    off()
    child().send({ type: 'spaceChanged', ts: 1791336002 })
    expect(seen).toEqual([
      { type: 'spaceChanged', ts: 1791336000.5 },
      { type: 'spaceChanged', ts: 1791336001 },
    ])
    expect(eventsOf('protocolError')).toEqual([{ reason: 'unparseable', length: expect.any(Number) }])
    child().reply('pong')
    await expect(ping).resolves.toEqual({ type: 'pong', id: 1 })
  })

  it('does not deliver replies to listeners, but onMessage sees everything', async () => {
    const { client, child, eventsOf } = setup()
    client.start()
    const all: string[] = []
    client.onMessage((message) => all.push(message.type))
    const request = client.snapshot()
    child().reply('snapshot', { ts: 1, windows: [] })
    await request
    expect(eventsOf('snapshot')).toEqual([])
    expect(all).toEqual(['snapshot'])
  })

  it('reports unparseable lines by length only and keeps going after a listener throws', async () => {
    const errors: unknown[] = []
    const children: FakeChild[] = []
    const client = new HelperClient({
      binaryPath: '/h',
      spawn: (command, args) => {
        const c = new FakeChild(command, args)
        children.push(c)
        return c
      },
      onListenerError: (err) => errors.push(err),
    })
    const protocolErrors: unknown[] = []
    client.on('protocolError', (e) => protocolErrors.push(e))
    client.on('appLaunched', () => {
      throw new Error('listener bug')
    })
    client.start()
    const c = children[0]!
    c.stdout.emit('data', 'not json at all\n')
    c.send({ type: 'appLaunched', bundleId: null, pid: 1, appName: null, ts: 1 })
    const ping = client.ping()
    c.reply('pong')
    await expect(ping).resolves.toEqual({ type: 'pong', id: 1 })
    expect(protocolErrors).toEqual([{ reason: 'unparseable', length: 15 }])
    expect(errors).toHaveLength(1)
  })

  it('forwards stderr line by line', () => {
    const { client, child, eventsOf } = setup()
    client.start()
    child().stderr.emit('data', 'bitbot-helper: one\nbitbot-helper: t')
    child().stderr.emit('data', 'wo\n')
    expect(eventsOf('stderr')).toEqual(['bitbot-helper: one', 'bitbot-helper: two'])
  })

  it('flags a helper that speaks another protocol version', () => {
    const { client, child, eventsOf } = setup()
    client.start()
    child().send({ type: 'hello', version: HELPER_PROTOCOL_VERSION, pid: 1 })
    expect(eventsOf('protocolError')).toEqual([])
    child().send({ type: 'hello', version: 1, pid: 1 }) // a stale dev build
    expect(eventsOf('protocolError')).toEqual([{ reason: 'versionMismatch', expected: HELPER_PROTOCOL_VERSION, actual: 1 }])
    expect(eventsOf('hello')).toHaveLength(2)
  })
})

describe('HelperClient restart and backoff', () => {
  it('rejects pending requests on exit and restarts after the initial backoff', async () => {
    const { client, children, child, eventsOf } = setup()
    client.start()
    const request = client.diag()
    child().exit(1)
    await expect(request).rejects.toMatchObject({ reason: 'exited' })
    expect(client.isRunning).toBe(false)
    expect(eventsOf('exit')).toEqual([
      { code: 1, signal: null, error: null, uptimeMs: 0, willRestart: true, restartInMs: T.restartBackoff.initialMs },
    ])
    vi.advanceTimersByTime(T.restartBackoff.initialMs - 1)
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(2)
    expect(eventsOf('restart')).toEqual([{ attempt: 1, pid: child(1).pid }])
    expect(client.isRunning).toBe(true)
  })

  it('backs off exponentially while the helper keeps crashing, capped at maxMs', () => {
    const { client, child, eventsOf } = setup()
    client.start()
    const delays: (number | null)[] = []
    for (let i = 0; i < 12; i++) {
      child().exit(1)
      const exits = eventsOf('exit')
      const last = exits[exits.length - 1] as HelperExitInfo
      delays.push(last.restartInMs)
      vi.advanceTimersByTime(last.restartInMs ?? 0)
    }
    const { initialMs, factor, maxMs } = T.restartBackoff
    const expected = delays.map((_, i) => Math.min(initialMs * factor ** i, maxMs))
    expect(delays).toEqual(expected)
    expect(delays[delays.length - 1]).toBe(maxMs)
    expect(eventsOf('restart').map((r) => r.attempt)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it('resets the backoff after a run longer than stableUptimeMs', () => {
    const { client, child, eventsOf } = setup()
    client.start()
    child().exit(1)
    vi.advanceTimersByTime(T.restartBackoff.initialMs)
    child().exit(1)
    expect(eventsOf('exit')[1]?.restartInMs).toBe(T.restartBackoff.initialMs * T.restartBackoff.factor)
    vi.advanceTimersByTime(T.restartBackoff.initialMs * T.restartBackoff.factor)
    vi.advanceTimersByTime(T.stableUptimeMs) // a healthy run
    child().exit(null, 'SIGSEGV')
    expect(eventsOf('exit')[2]).toMatchObject({ signal: 'SIGSEGV', restartInMs: T.restartBackoff.initialMs, uptimeMs: T.stableUptimeMs })
  })

  it('treats a spawn failure (missing binary) as an exit and keeps retrying', () => {
    const { client, children, child, eventsOf } = setup({ failSpawn: true })
    client.start()
    child().emit('error', new Error('spawn /bin/bitbot-helper ENOENT'))
    child().exit(-2) // Node may also report an exit; it must not double count
    expect(eventsOf('exit')).toHaveLength(1)
    expect(eventsOf('exit')[0]).toMatchObject({ error: 'spawn /bin/bitbot-helper ENOENT', willRestart: true })
    vi.advanceTimersByTime(T.restartBackoff.initialMs)
    expect(children).toHaveLength(2)
  })

  it('treats a synchronous spawn throw as an exit', () => {
    let calls = 0
    const client = new HelperClient({
      binaryPath: '/h',
      spawn: (command, args) => {
        calls += 1
        if (calls === 1) throw new Error('EACCES')
        return new FakeChild(command, args)
      },
    })
    const exits: HelperExitInfo[] = []
    client.on('exit', (e) => exits.push(e))
    client.start()
    expect(exits).toEqual([{ code: null, signal: null, error: 'EACCES', uptimeMs: 0, willRestart: true, restartInMs: T.restartBackoff.initialMs }])
    vi.advanceTimersByTime(T.restartBackoff.initialMs)
    expect(client.isRunning).toBe(true)
  })

  it('ignores an error event from a running process (e.g. a failed kill)', () => {
    const { client, child, eventsOf } = setup()
    client.start()
    child().emit('error', new Error('kill EPERM'))
    expect(eventsOf('exit')).toEqual([])
    expect(client.isRunning).toBe(true)
  })

  it('ignores output and exits from a previous process', () => {
    const { client, children, child, eventsOf } = setup()
    client.start()
    const old = child()
    old.exit(1)
    vi.advanceTimersByTime(T.restartBackoff.initialMs)
    expect(children).toHaveLength(2)
    old.send({ type: 'appLaunched', bundleId: 'stale', pid: 1, appName: null, ts: 1 })
    old.exit(0)
    expect(eventsOf('appLaunched')).toEqual([])
    expect(eventsOf('exit')).toHaveLength(1)
  })

  it("still delivers a crashed helper's last output when it arrives after the exit event", () => {
    const { client, child, eventsOf } = setup()
    client.start()
    const crashed = child()
    crashed.stdout.emit('data', '{"type":"appLaunched","bundleId":"com.x","pid":7,')
    crashed.exit(null, 'SIGTRAP')
    crashed.stdout.emit('data', '"appName":"X","ts":1}\n')
    crashed.stderr.emit('data', 'Fatal error: something broke\n')
    expect(eventsOf('appLaunched')).toEqual([{ type: 'appLaunched', bundleId: 'com.x', pid: 7, appName: 'X', ts: 1 }])
    expect(eventsOf('stderr')).toEqual(['Fatal error: something broke'])
  })

  it('re-applies the poll rate and input-tap configuration after a restart', async () => {
    const { client, child, eventsOf } = setup()
    client.start()
    client.setPollRate(15)
    const tap = client.startInputTap({ keys: true, mouse: true })
    child().reply('inputTap', { active: true, error: null, reason: null })
    await expect(tap).resolves.toEqual({ type: 'inputTap', id: 1, active: true, error: null, reason: null })
    expect(child().commands()[0]).toEqual({ type: 'setPollRate', hz: 15 })

    child().exit(1)
    vi.advanceTimersByTime(T.restartBackoff.initialMs)
    expect(child().commands()).toEqual([
      { type: 'setPollRate', hz: 15 },
      { type: 'startInputTap', id: 2, keys: true, mouse: true },
    ])
    child().reply('inputTap', { active: false, error: 'Input Monitoring is not granted', reason: 'notGranted' })
    await vi.advanceTimersByTimeAsync(0)
    expect(eventsOf('inputTap')).toEqual([
      { type: 'inputTap', id: null, active: false, error: 'Input Monitoring is not granted', reason: 'notGranted' },
    ])
  })

  it('does not re-apply a stopped tap or a zero poll rate', async () => {
    const { client, child } = setup()
    client.start()
    client.setPollRate(4)
    client.startInputTap({ keys: false, mouse: true }).catch(() => {})
    client.stopInputTap().catch(() => {})
    client.setPollRate(0)
    expect(client.inputTapConfig).toBeNull()
    child().exit(1)
    vi.advanceTimersByTime(T.restartBackoff.initialMs)
    expect(child().commands()).toEqual([])
  })

  it('remembers settings made while the helper is down and applies them on start', async () => {
    const { client, child, eventsOf } = setup()
    client.setPollRate(4)
    await expect(client.startInputTap({ keys: true, mouse: false })).rejects.toMatchObject({ reason: 'not-running' })
    client.start()
    expect(child().commands()).toEqual([
      { type: 'setPollRate', hz: 4 },
      { type: 'startInputTap', id: 1, keys: true, mouse: false },
    ])
    child().reply('inputTap', { active: true, error: null, reason: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(eventsOf('inputTap')).toEqual([{ type: 'inputTap', id: null, active: true, error: null, reason: null }])
  })

  it('reports a failed re-application as an inactive inputTap event', async () => {
    const { client, child, eventsOf } = setup()
    client.startInputTap({ keys: true, mouse: true }).catch(() => {})
    client.start()
    child().exit(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(eventsOf('inputTap')).toEqual([
      { type: 'inputTap', id: null, active: false, error: 'bitbot-helper exited', reason: 'helperUnavailable' },
    ])
  })

  it('treats a start with keys and mouse both false as a stop, which is never re-applied', async () => {
    const { client, child } = setup()
    client.start()
    client.startInputTap({ keys: true, mouse: true }).catch(() => {})
    const off = client.startInputTap({ keys: false, mouse: false })
    expect(child().commands()).toEqual([
      { type: 'startInputTap', id: 1, keys: true, mouse: true },
      { type: 'stopInputTap', id: 2 },
    ])
    expect(client.inputTapConfig).toBeNull()
    child().reply('inputTap', { active: false, error: null, reason: null })
    await expect(off).resolves.toEqual({ type: 'inputTap', id: 2, active: false, error: null, reason: null })
    child().exit(1)
    vi.advanceTimersByTime(T.restartBackoff.initialMs)
    expect(child().commands()).toEqual([])
  })
})

describe('HelperClient setPollRate', () => {
  it('clamps to maxPollHz and rejects invalid rates', () => {
    const { client, child } = setup()
    client.start()
    client.setPollRate(1000)
    expect(child().lastCommand()).toEqual({ type: 'setPollRate', hz: T.maxPollHz })
    expect(client.pollRate).toBe(T.maxPollHz)
    expect(() => client.setPollRate(-1)).toThrow(RangeError)
    expect(() => client.setPollRate(Number.NaN)).toThrow(RangeError)
    expect(client.pollRate).toBe(T.maxPollHz)
  })
})

describe('HelperClient stop()', () => {
  it('sends quit, closes stdin, rejects pending requests and never restarts', async () => {
    const { client, children, child, eventsOf } = setup()
    client.start()
    const pending = client.diag()
    const stopped = client.stop()
    await expect(pending).rejects.toMatchObject({ reason: 'stopped' })
    expect(child().lastCommand()).toEqual({ type: 'quit' })
    expect(child().stdin.ended).toBe(true)
    expect(client.isRunning).toBe(false)
    child().exit(0)
    await stopped
    expect(eventsOf('exit')).toEqual([{ code: 0, signal: null, error: null, uptimeMs: 0, willRestart: false, restartInMs: null }])
    vi.advanceTimersByTime(T.restartBackoff.maxMs * 2)
    expect(children).toHaveLength(1)
    await expect(client.ping()).rejects.toMatchObject({ reason: 'stopped' })
  })

  it('escalates to SIGTERM then SIGKILL when the helper does not exit', async () => {
    const { client, child } = setup()
    client.start()
    const stopped = client.stop()
    expect(client.stop()).toBe(stopped) // idempotent while in progress
    vi.advanceTimersByTime(T.stopGraceMs)
    expect(child().signals).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(T.stopGraceMs)
    expect(child().signals).toEqual(['SIGTERM', 'SIGKILL'])
    child().exit(null, 'SIGKILL')
    await stopped
  })

  it('finishes the stop even if the process never reports its exit', async () => {
    const { client, child, eventsOf } = setup()
    client.start()
    const stopped = client.stop()
    vi.advanceTimersByTime(T.stopGraceMs * 3)
    await stopped
    expect(eventsOf('exit')[0]).toMatchObject({ willRestart: false, signal: 'SIGKILL' })
    child().exit(0) // a very late exit changes nothing
    expect(eventsOf('exit')).toHaveLength(1)
  })

  it('cancels a pending restart', async () => {
    const { client, children, child } = setup()
    client.start()
    child().exit(1)
    await client.stop()
    vi.advanceTimersByTime(T.restartBackoff.maxMs)
    expect(children).toHaveLength(1)
  })

  it('cancels the restart when an exit listener calls stop()', () => {
    const { client, children, child } = setup()
    client.on('exit', () => void client.stop())
    client.start()
    child().exit(1)
    vi.advanceTimersByTime(T.restartBackoff.maxMs)
    expect(children).toHaveLength(1)
    expect(client.isRunning).toBe(false)
  })

  it('can be started again after stopping', async () => {
    const { client, children, child } = setup()
    client.start()
    const stopped = client.stop()
    child().exit(0)
    await stopped
    client.start()
    expect(children).toHaveLength(2)
    const ping = client.ping()
    child().reply('pong')
    await expect(ping).resolves.toMatchObject({ type: 'pong' })
  })

  it('resolves immediately when nothing is running', async () => {
    const { client } = setup()
    await expect(client.stop()).resolves.toBeUndefined()
  })
})

describe('HelperRequestError', () => {
  it('is an Error with a reason', () => {
    const error = new HelperRequestError('x', 'timeout')
    expect(error).toBeInstanceOf(Error)
    expect(error.reason).toBe('timeout')
  })
})

describe('resolveHelperPath', () => {
  it('uses build/helper in dev and Resources when packaged', () => {
    const context = { appPath: '/Users/me/BitBot', resourcesPath: '/Applications/Bitbot.app/Contents/Resources' }
    expect(resolveHelperPath({ ...context, isPackaged: false })).toBe('/Users/me/BitBot/build/helper/bitbot-helper')
    expect(resolveHelperPath({ ...context, isPackaged: true })).toBe('/Applications/Bitbot.app/Contents/Resources/bitbot-helper')
  })
})

describe('HelperClient watchdog', () => {
  const watchdog: HelperWatchdogOptions = { heartbeatMs: 1000, timeoutMs: 200, maxMissed: 2 }
  const pings = (c: FakeChild): Record<string, unknown>[] => c.commands().filter((command) => command['type'] === 'ping')

  it('defaults to tuning.helper and pings once per heartbeat', async () => {
    expect(defaultWatchdog()).toEqual({
      heartbeatMs: T.watchdog.heartbeatMs,
      timeoutMs: T.requestTimeoutMs,
      maxMissed: T.watchdog.maxMissedHeartbeats,
    })
    const children: FakeChild[] = []
    const client = new HelperClient({
      binaryPath: '/h',
      spawn: (command, args) => {
        const c = new FakeChild(command, args)
        children.push(c)
        return c
      },
    })
    client.start()
    await vi.advanceTimersByTimeAsync(T.watchdog.heartbeatMs - 1)
    expect(pings(children[0]!)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(pings(children[0]!)).toHaveLength(1)
    children[0]!.reply('pong')
    const stopped = client.stop()
    children[0]!.exit(0)
    await stopped
  })

  it('keeps an answering helper alive', async () => {
    const { client, child } = setup({ watchdog })
    client.start()
    for (let beat = 1; beat <= 5; beat++) {
      await vi.advanceTimersByTimeAsync(watchdog.heartbeatMs)
      expect(pings(child())).toHaveLength(beat)
      child().reply('pong')
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(child().signals).toEqual([])
  })

  it('forgives a single missed heartbeat once the next one is answered', async () => {
    const { client, child } = setup({ watchdog })
    client.start()
    for (const answer of [false, true, false, true, false]) {
      await vi.advanceTimersByTimeAsync(watchdog.heartbeatMs)
      if (answer) child().reply('pong')
      await vi.advanceTimersByTimeAsync(watchdog.timeoutMs)
    }
    expect(child().signals).toEqual([])
    expect(client.isRunning).toBe(true)
  })

  it('kills a helper that misses consecutive heartbeats, then restarts it with heartbeats', async () => {
    const { client, children, child, eventsOf } = setup({ watchdog })
    client.start()
    await vi.advanceTimersByTimeAsync(watchdog.heartbeatMs + watchdog.timeoutMs) // missed 1
    expect(child().signals).toEqual([])
    await vi.advanceTimersByTimeAsync(watchdog.heartbeatMs + watchdog.timeoutMs) // missed 2
    expect(child().signals).toEqual(['SIGKILL'])
    child().exit(null, 'SIGKILL')
    expect(eventsOf('exit')).toEqual([
      {
        code: null,
        signal: 'SIGKILL',
        error: 'unresponsive: no reply to 2 heartbeats, killed by the watchdog',
        uptimeMs: 2 * (watchdog.heartbeatMs + watchdog.timeoutMs),
        willRestart: true,
        restartInMs: T.restartBackoff.initialMs,
      },
    ])
    await vi.advanceTimersByTimeAsync(T.restartBackoff.initialMs)
    expect(children).toHaveLength(2)
    expect(eventsOf('restart')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(watchdog.heartbeatMs)
    expect(pings(child())).toHaveLength(1) // the new process is watched too, from a clean count
    child().reply('pong')
    await vi.advanceTimersByTimeAsync(0)
    expect(child().signals).toEqual([])
  })

  it('does not wait forever for an unkillable helper', async () => {
    const { client, children, child, eventsOf } = setup({ watchdog })
    client.start()
    await vi.advanceTimersByTimeAsync(2 * (watchdog.heartbeatMs + watchdog.timeoutMs))
    expect(child().signals).toEqual(['SIGKILL'])
    await vi.advanceTimersByTimeAsync(T.stopGraceMs) // no exit event ever arrives
    expect(eventsOf('exit')).toEqual([expect.objectContaining({ signal: 'SIGKILL', error: expect.stringContaining('watchdog'), willRestart: true })])
    child().exit(null, 'SIGKILL') // a very late exit changes nothing
    expect(eventsOf('exit')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(T.restartBackoff.initialMs)
    expect(children).toHaveLength(2)
  })

  it('stops pinging once stop() is called', async () => {
    const { client, child } = setup({ watchdog })
    client.start()
    const stopped = client.stop()
    child().exit(0)
    await stopped
    await vi.advanceTimersByTimeAsync(watchdog.heartbeatMs * 10)
    expect(pings(child())).toEqual([])
    expect(child().signals).toEqual([])
  })

  it('reports an ordinary crash without blaming the watchdog', async () => {
    const { client, child, eventsOf } = setup({ watchdog })
    client.start()
    await vi.advanceTimersByTimeAsync(watchdog.heartbeatMs + watchdog.timeoutMs) // one miss, no kill
    child().exit(null, 'SIGSEGV')
    expect(eventsOf('exit')[0]).toMatchObject({ signal: 'SIGSEGV', error: null })
  })
})

// ───────────────────── contract with the real binary (macOS, when built) ─────────────────────

const REPO = join(__dirname, '..')
const BINARY = resolveHelperPath({ isPackaged: false, appPath: REPO, resourcesPath: '' })

/**
 * Why the real-binary tests cannot run here, or null. Off macOS they are skipped; on macOS a missing or stale binary
 * fails the test below, so editing helper/Sources without rebuilding can't silently drop the contract tests.
 */
function binarySkipReason(): string | null {
  if (process.platform !== 'darwin') return 'macOS only'
  if (!existsSync(BINARY)) return 'build/helper/bitbot-helper is not built (bash helper/build-helper.sh)'
  const sources = join(REPO, 'helper', 'Sources')
  const newestSource = Math.max(
    ...readdirSync(sources)
      .filter((name) => name.endsWith('.swift'))
      .map((name) => statSync(join(sources, name)).mtimeMs),
  )
  if (newestSource > statSync(BINARY).mtimeMs) return 'build/helper/bitbot-helper is older than helper/Sources (bash helper/build-helper.sh)'
  return null
}

const SKIP_REAL = binarySkipReason()

it.runIf(process.platform === 'darwin')('the built bitbot-helper is current (npm run build:helper)', () => {
  expect(SKIP_REAL).toBeNull()
})

describe.skipIf(SKIP_REAL !== null)(`HelperClient with the real bitbot-helper${SKIP_REAL ? ` (skipped: ${SKIP_REAL})` : ''}`, () => {
  // Nothing here creates an input tap or can show a permission prompt: inputAccess is preflight
  // only, and the only tap commands are stops.
  const spawned: HelperChildProcess[] = []

  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  const realClient = (watchdog: HelperWatchdogOptions | false = false): HelperClient =>
    new HelperClient({
      binaryPath: BINARY,
      watchdog,
      spawn: (command, args) => {
        const child = spawnHelperProcess(command, args)
        spawned.push(child)
        return child
      },
    })

  /** The next event of a type that satisfies `accept`, or a rejection after timeoutMs. */
  function next<K extends keyof HelperClientEventMap>(
    client: HelperClient,
    type: K,
    accept: (event: HelperClientEventMap[K]) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<HelperClientEventMap[K]> {
    return new Promise((resolve, reject) => {
      const off = client.on(type, (event) => {
        if (!accept(event)) return
        clearTimeout(timer)
        off()
        resolve(event)
      })
      const timer = setTimeout(() => {
        off()
        reject(new Error(`no '${String(type)}' event within ${timeoutMs} ms`))
      }, timeoutMs)
    })
  }

  function nextMessage(client: HelperClient, accept: (message: HelperMessage) => boolean, timeoutMs = 5000): Promise<HelperMessage> {
    return new Promise((resolve, reject) => {
      const off = client.onMessage((message) => {
        if (!accept(message)) return
        clearTimeout(timer)
        off()
        resolve(message)
      })
      const timer = setTimeout(() => {
        off()
        reject(new Error(`no matching message within ${timeoutMs} ms`))
      }, timeoutMs)
    })
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('answers every request with a message the client accepts, pushes snapshots, and stops cleanly', async () => {
    const client = realClient()
    const protocolErrors: unknown[] = []
    client.on('protocolError', (error) => protocolErrors.push(error))
    const hello = next(client, 'hello')
    const initial = next(client, 'frontmostFullscreen')
    client.start()
    try {
      expect(await hello).toEqual({ type: 'hello', version: HELPER_PROTOCOL_VERSION, pid: client.pid })
      const initialState = await initial
      expect(initialState.id).toBeNull()
      expect(initialState.value).toBe(initialState.displayIds.length > 0)

      await expect(client.ping()).resolves.toMatchObject({ type: 'pong' })
      const { displays } = await client.displays()
      expect(displays.length).toBeGreaterThan(0)
      expect(displays.filter((display) => display.main)).toHaveLength(1)
      const snapshot = await client.snapshot()
      expect(snapshot.windows.length).toBeGreaterThan(0)
      expect(snapshot.ts).toBeGreaterThan(Date.now() / 1000 - 60)
      const front = await client.frontmost()
      expect(typeof front.fullscreen).toBe('boolean')
      const state = await client.fullscreenState()
      expect(state.value).toBe(state.displayIds.length > 0)
      for (const id of state.displayIds) expect(displays.map((display) => display.id)).toContain(id)
      const diag = await client.diag()
      expect(diag).toMatchObject({ pid: client.pid, ppid: process.pid, version: HELPER_PROTOCOL_VERSION })
      expect(diag.executablePath).toMatch(/bitbot-helper$/)
      const access = await client.inputAccess() // preflight only
      expect([access.listen, access.post, access.accessibility].every((flag) => typeof flag === 'boolean')).toBe(true)
      await expect(client.appInfo(process.pid)).resolves.toMatchObject({ pid: process.pid })
      await expect(client.stopInputTap()).resolves.toEqual({ type: 'inputTap', id: expect.any(Number), active: false, error: null, reason: null })

      // Raw lines the typed API never sends: the helper's own handling of a both-false start
      // (a stop) and of a malformed line (an error without an id).
      const child = spawned[spawned.length - 1]!
      const bothFalse = nextMessage(client, (message) => message.type === 'inputTap' && message.id === 900_001)
      child.stdin?.write('{"type":"startInputTap","id":900001,"keys":false,"mouse":false}\n')
      expect(await bothFalse).toEqual({ type: 'inputTap', id: 900_001, active: false, error: null, reason: null })
      const malformed = next(client, 'error')
      child.stdin?.write('this is not json\n')
      expect(await malformed).toEqual({ type: 'error', id: null, message: 'malformed command: not a JSON object' })

      const pushes: number[] = []
      const offSnapshots = client.on('snapshot', (push) => pushes.push(push.windows.length))
      client.setPollRate(20)
      await sleep(600)
      expect(pushes.length).toBeGreaterThanOrEqual(4)
      client.setPollRate(0)
      // The helper runs commands in order on its main queue, so the pong proves the poll timer is cancelled.
      await client.ping()
      const afterStop = pushes.length
      await sleep(300)
      expect(pushes.length).toBe(afterStop)
      offSnapshots()
      expect(protocolErrors).toEqual([{ reason: 'unmatchedReply', length: expect.any(Number) }]) // the raw both-false reply
    } finally {
      const pid = client.pid
      const exit = next(client, 'exit')
      await client.stop()
      expect(await exit).toMatchObject({ willRestart: false })
      expect(() => process.kill(pid ?? -1, 0)).toThrow()
    }
  }, 20_000)

  it('exits by itself when stdin closes (the parent is gone)', async () => {
    const child = spawnProcess(BINARY, defaultHelperArgs(), { stdio: ['pipe', 'pipe', 'ignore'] })
    spawned.push(child)
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve())) // hello
    child.stdin.end()
    const code = await Promise.race([exited, sleep(4000).then(() => 'timeout' as const)])
    expect(code).toBe(0)
  }, 10_000)

  it('the watchdog kills and restarts a wedged (SIGSTOPped) helper', async () => {
    const client = realClient({ heartbeatMs: 100, timeoutMs: 400, maxMissed: 2 })
    const firstHello = next(client, 'hello')
    client.start()
    try {
      const wedged = (await firstHello).pid
      const killed = next(client, 'exit', () => true, 6000)
      const restarted = next(client, 'hello', (hello) => hello.pid !== wedged, 8000)
      process.kill(wedged, 'SIGSTOP')
      expect(await killed).toMatchObject({ signal: 'SIGKILL', error: expect.stringContaining('watchdog'), willRestart: true })
      expect((await restarted).pid).not.toBe(wedged)
      await expect(client.ping()).resolves.toMatchObject({ type: 'pong' })
    } finally {
      await client.stop()
    }
  }, 20_000)
})
