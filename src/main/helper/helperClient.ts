// Process manager and typed client for bitbot-helper (BITBOT_SPEC.md §5.3).
//
// - Spawns the helper and parses its newline-delimited JSON stdout.
// - request(): sends a command with a fresh id and resolves with the reply carrying that id
//   (or rejects on a helper error reply, a timeout, or the helper exiting).
// - on(type, cb): unsolicited helper messages (snapshot pushes, app events, fullscreen changes,
//   input events, hello) plus client lifecycle events ('exit', 'restart', 'stderr', 'protocolError').
//   Replies to requests go only to the request's promise, never to listeners.
// - Restarts the helper with exponential backoff when it exits unexpectedly, then re-applies the
//   last poll rate and input-tap configuration. stop() never restarts.
// - Watchdog: pings the helper every tuning.helper.watchdog.heartbeatMs; after maxMissedHeartbeats
//   consecutive unanswered pings the helper is wedged (alive but stuck, e.g. in a window-server
//   call), so it is SIGKILLed and the normal exit path restarts it.
//
// No Electron imports: the binary path and the spawn function are injected (tests use a fake).
// Privacy: never log `input` messages (they carry key codes for anti-gaming only, §7.3); this
// module logs nothing itself and reports unparseable lines by length, never by content.

import { spawn as spawnChildProcess } from 'node:child_process'
import { tuning } from '../../shared/tuning'
import {
  encodeCommand,
  HELPER_PROTOCOL_VERSION,
  LineSplitter,
  parseHelperMessage,
  RESPONSE_TYPE,
  type AppInfoMsg,
  type DiagMsg,
  type DisplaysMsg,
  type FrontmostFullscreenMsg,
  type FrontmostMsg,
  type HelloMsg,
  type HelperCommand,
  type HelperMessage,
  type HelperMessageOf,
  type HelperMessageType,
  type HelperRequest,
  type HelperRequestPayload,
  type HelperRequestType,
  type InputAccessMsg,
  type InputTapMsg,
  type PongMsg,
  type ResponseFor,
  type SnapshotMsg,
} from './protocol'

// ───────────────────────────── process abstraction ─────────────────────────────

export interface HelperWritable {
  write(chunk: string): boolean
  end(): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

export interface HelperReadable {
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

/** The part of a Node ChildProcess the client uses; child_process.spawn's result satisfies it. */
export interface HelperChildProcess {
  readonly pid?: number | undefined
  readonly stdin: HelperWritable | null
  readonly stdout: HelperReadable | null
  readonly stderr: HelperReadable | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

export type HelperSpawnFn = (command: string, args: readonly string[]) => HelperChildProcess

export const spawnHelperProcess: HelperSpawnFn = (command, args) =>
  spawnChildProcess(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })

/** Arguments that hand the helper-side tunables (tuning.helper) to the binary. */
export function defaultHelperArgs(): string[] {
  const t = tuning.helper
  return [
    `--fullscreen-idle-hz=${t.fullscreenIdleHz}`,
    `--fullscreen-tolerance-pt=${t.fullscreenTolerancePt}`,
    `--fullscreen-follow-up-ms=${t.fullscreenFollowUpMs}`,
    `--resync-ms=${t.resyncMs}`,
  ]
}

export interface HelperWatchdogOptions {
  /** Ping the running helper this often, ms. */
  heartbeatMs: number
  /** A ping unanswered for this long is missed, ms. */
  timeoutMs: number
  /** After this many consecutive missed pings the helper is SIGKILLed (and then restarted). */
  maxMissed: number
}

/** The watchdog configured in tuning.helper. */
export function defaultWatchdog(): HelperWatchdogOptions {
  const t = tuning.helper
  return { heartbeatMs: t.watchdog.heartbeatMs, timeoutMs: t.requestTimeoutMs, maxMissed: t.watchdog.maxMissedHeartbeats }
}

// ───────────────────────────── events and errors ─────────────────────────────

export interface HelperExitInfo {
  code: number | null
  signal: string | null
  /**
   * Spawn failure or similar (e.g. "spawn … ENOENT" when the binary has not been built), or why the
   * client killed it ("unresponsive: …" from the watchdog).
   */
  error: string | null
  /** How long that helper process ran, ms (0 if it never started). */
  uptimeMs: number
  willRestart: boolean
  restartInMs: number | null
}

export interface HelperRestartInfo {
  /** 1 for the first restart after a healthy run, growing while the helper keeps failing. */
  attempt: number
  pid: number | undefined
}

export type HelperProtocolErrorInfo =
  | {
      /** unparseable: not a valid helper message. overlong: line dropped by the splitter.
       *  unmatchedReply: a reply whose request already timed out or never existed. */
      reason: 'unparseable' | 'overlong' | 'unmatchedReply'
      /** Line length in chars. Content is never included (it may be an input event). */
      length: number
    }
  | {
      /** The helper speaks another protocol version (in dev: rerun helper/build-helper.sh). */
      reason: 'versionMismatch'
      expected: number
      actual: number
    }

type MessageEvents = { [K in HelperMessageType]: HelperMessageOf<K> }

export type HelperClientEventMap = MessageEvents & {
  exit: HelperExitInfo
  restart: HelperRestartInfo
  /** One line of the helper's stderr (rare operational diagnostics; never input data). */
  stderr: string
  protocolError: HelperProtocolErrorInfo
}

export type HelperRequestFailure = 'not-running' | 'stopped' | 'exited' | 'timeout' | 'helper-error' | 'protocol'

export class HelperRequestError extends Error {
  constructor(
    message: string,
    readonly reason: HelperRequestFailure,
  ) {
    super(message)
    this.name = 'HelperRequestError'
  }
}

export interface InputTapConfig {
  keys: boolean
  mouse: boolean
}

export interface HelperClientOptions {
  /** Absolute path of the bitbot-helper binary (see resolveHelperPath). */
  binaryPath: string
  /** Defaults to child_process.spawn with piped stdio. */
  spawn?: HelperSpawnFn
  /** Defaults to defaultHelperArgs(). */
  args?: readonly string[]
  /** Clock for uptime bookkeeping, ms. Defaults to Date.now. */
  now?: () => number
  /** Called when a listener throws. Defaults to console.error. */
  onListenerError?: (err: unknown) => void
  /** Liveness watchdog. Defaults to defaultWatchdog() (tuning.helper); false disables it. */
  watchdog?: HelperWatchdogOptions | false
}

interface PendingRequest {
  type: HelperRequestType
  expect: HelperMessageType
  resolve: (message: HelperMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Listener = (event: unknown) => void

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ───────────────────────────── client ─────────────────────────────

export class HelperClient {
  private readonly binaryPath: string
  private readonly spawnFn: HelperSpawnFn
  private readonly args: readonly string[]
  private readonly now: () => number
  private readonly onListenerError: (err: unknown) => void

  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly messageListeners = new Set<(message: HelperMessage) => void>()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly splitter: LineSplitter
  private readonly stderrSplitter = new LineSplitter(tuning.helper.maxStderrLineChars)
  private decoder = new TextDecoder()
  private stderrDecoder = new TextDecoder()

  private child: HelperChildProcess | null = null
  /** Increments per spawn; events from older processes are ignored. */
  private generation = 0
  private exitedGeneration = 0
  private startedAt = 0
  private nextId = 1
  private failures = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = false
  private stopPromise: Promise<void> | null = null
  private resolveStop: (() => void) | null = null
  private hello: HelloMsg | null = null

  private readonly watchdog: HelperWatchdogOptions | null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private missedHeartbeats = 0
  /** Set when the watchdog kills a process: its generation and the error its exit reports. */
  private watchdogKill: { generation: number; message: string } | null = null
  private watchdogKillTimer: ReturnType<typeof setTimeout> | null = null

  // Desired state, re-applied to every new helper process.
  private pollHz = 0
  private tapConfig: InputTapConfig | null = null

  constructor(options: HelperClientOptions) {
    this.binaryPath = options.binaryPath
    this.spawnFn = options.spawn ?? spawnHelperProcess
    this.args = options.args ?? defaultHelperArgs()
    this.now = options.now ?? Date.now
    this.onListenerError = options.onListenerError ?? ((err) => console.error('[bitbot-helper] listener failed:', err))
    this.watchdog = options.watchdog === false ? null : (options.watchdog ?? defaultWatchdog())
    this.splitter = new LineSplitter(tuning.helper.maxLineChars, (length) =>
      this.emit('protocolError', { reason: 'overlong', length }),
    )
  }

  /** True while a helper process is running and the client is not stopping. */
  get isRunning(): boolean {
    return this.child !== null && !this.stopping
  }

  /** PID of the running helper process, if any. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** The hello of the current helper process (null until it arrives, or after an exit). */
  get helloMessage(): HelloMsg | null {
    return this.hello
  }

  /** Starts the helper. Ignored while one is running, a restart is pending, or a stop is in progress. */
  start(): void {
    if (this.child !== null || this.restartTimer !== null) return
    this.stopping = false
    this.failures = 0
    this.spawnChild()
  }

  /**
   * Asks the helper to quit (then SIGTERM, then SIGKILL after tuning.helper.stopGraceMs each) and
   * never restarts it. Pending requests reject immediately. Resolves once the process has exited.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.clearRestartTimer()
    this.clearHeartbeat()
    this.rejectAll(new HelperRequestError('bitbot-helper stopped', 'stopped'))
    const child = this.child
    if (!child) return Promise.resolve()

    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStop = resolve
    })
    this.writeLine(encodeCommand({ type: 'quit' }))
    try {
      child.stdin?.end()
    } catch {
      // Already closed: the exit handler finishes the stop.
    }
    const generation = this.generation
    const grace = tuning.helper.stopGraceMs
    this.killTimer = setTimeout(() => {
      this.signal(child, 'SIGTERM')
      this.killTimer = setTimeout(() => {
        this.signal(child, 'SIGKILL')
        // An unkillable process cannot be waited on forever: finish the stop regardless.
        this.killTimer = setTimeout(() => this.handleExit(generation, null, 'SIGKILL', 'did not exit after SIGKILL'), grace)
      }, grace)
    }, grace)
    return this.stopPromise
  }

  /** Subscribes to unsolicited helper messages of one type, or to a client lifecycle event. */
  on<K extends keyof HelperClientEventMap>(type: K, listener: (event: HelperClientEventMap[K]) => void): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    const entry: Listener = (event) => listener(event as HelperClientEventMap[K])
    set.add(entry)
    return () => {
      set.delete(entry)
    }
  }

  /** Every parsed message, replies included (debugging). Never log `input` messages. */
  onMessage(listener: (message: HelperMessage) => void): () => void {
    const entry = (message: HelperMessage): void => listener(message)
    this.messageListeners.add(entry)
    return () => {
      this.messageListeners.delete(entry)
    }
  }

  /** Sends a request and resolves with the reply that carries its id. */
  request<C extends HelperRequestPayload>(command: C, options: { timeoutMs?: number } = {}): Promise<ResponseFor<C['type']>> {
    if (!this.isRunning) {
      const reason = this.stopping ? 'stopped' : 'not-running'
      return Promise.reject(new HelperRequestError(`bitbot-helper is not running ('${command.type}')`, reason))
    }
    const id = this.nextId
    this.nextId = this.nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1
    let line: string
    try {
      line = encodeCommand({ ...command, id } as HelperRequest)
    } catch (err) {
      return Promise.reject(err)
    }
    const timeoutMs = options.timeoutMs ?? tuning.helper.requestTimeoutMs
    return new Promise<ResponseFor<C['type']>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HelperRequestError(`bitbot-helper '${command.type}' timed out after ${timeoutMs} ms`, 'timeout'))
      }, timeoutMs)
      this.pending.set(id, {
        type: command.type,
        expect: RESPONSE_TYPE[command.type],
        resolve: resolve as (message: HelperMessage) => void,
        reject,
        timer,
      })
      this.writeLine(line)
    })
  }

  // ── convenience API ──

  ping(): Promise<PongMsg> {
    return this.request({ type: 'ping' })
  }

  snapshot(): Promise<SnapshotMsg> {
    return this.request({ type: 'snapshot' })
  }

  displays(): Promise<DisplaysMsg> {
    return this.request({ type: 'displays' })
  }

  frontmost(): Promise<FrontmostMsg> {
    return this.request({ type: 'frontmost' })
  }

  appInfo(pid: number): Promise<AppInfoMsg> {
    return this.request({ type: 'appInfo', pid })
  }

  /**
   * Preflight-only permission check; never prompts. Each call is three TCC queries in the helper
   * (30-60 ms of waiting, off its main thread; ~0.8 ms CPU): poll it about once a second during
   * onboarding (§15.1, +0.08% helper CPU) and rarely otherwise (e.g. when the tray menu or settings
   * opens, §7.1).
   */
  inputAccess(): Promise<InputAccessMsg> {
    return this.request({ type: 'inputAccess' })
  }

  /** Shows the system Input Monitoring prompt if the user has not decided yet (onboarding only). */
  // SPEC-DEVIATION: input capture through the helper instead of uiohook-napi (§3, §7.1, §10.4);
  // see src/main/helper/protocol.ts and docs/decisions/input-and-helper.md.
  requestInputAccess(): Promise<InputAccessMsg> {
    return this.request({ type: 'requestInputAccess' }, { timeoutMs: tuning.helper.interactiveRequestTimeoutMs })
  }

  diag(): Promise<DiagMsg> {
    return this.request({ type: 'diag' })
  }

  fullscreenState(): Promise<FrontmostFullscreenMsg> {
    return this.request({ type: 'fullscreenState' })
  }

  /**
   * Snapshot push rate in Hz (0 stops; clamped to tuning.helper.maxPollHz). Remembered and
   * re-applied after a restart, so it may be called while the helper is down.
   */
  setPollRate(hz: number): void {
    if (!Number.isFinite(hz) || hz < 0) throw new RangeError(`setPollRate: invalid rate ${hz}`)
    this.pollHz = Math.min(hz, tuning.helper.maxPollHz)
    if (this.isRunning) this.writeLine(encodeCommand({ type: 'setPollRate', hz: this.pollHz }))
  }

  get pollRate(): number {
    return this.pollHz
  }

  /**
   * Starts (or reconfigures) the listen-only input tap. Never prompts: without Input Monitoring the
   * reply is inactive with reason 'notGranted'. The configuration is remembered and re-applied after
   * a restart (the outcome then arrives as an 'inputTap' event with id null), even if this request
   * itself fails because the helper is down. keys and mouse both false is stopInputTap().
   */
  startInputTap(config: InputTapConfig): Promise<InputTapMsg> {
    if (!config.keys && !config.mouse) return this.stopInputTap()
    this.tapConfig = { keys: config.keys, mouse: config.mouse }
    return this.request({ type: 'startInputTap', keys: config.keys, mouse: config.mouse })
  }

  stopInputTap(): Promise<InputTapMsg> {
    this.tapConfig = null
    return this.request({ type: 'stopInputTap' })
  }

  get inputTapConfig(): InputTapConfig | null {
    return this.tapConfig ? { ...this.tapConfig } : null
  }

  // ───────────────────────────── internals ─────────────────────────────

  private spawnChild(): void {
    this.restartTimer = null
    const generation = ++this.generation
    this.hello = null
    this.splitter.reset()
    this.stderrSplitter.reset()
    this.decoder = new TextDecoder()
    this.stderrDecoder = new TextDecoder()
    this.startedAt = this.now()

    let child: HelperChildProcess
    try {
      child = this.spawnFn(this.binaryPath, this.args)
    } catch (err) {
      this.handleExit(generation, null, null, errorText(err))
      return
    }
    this.child = child
    // Output is read until the next process spawns: Node can deliver a child's last stdout/stderr
    // chunks after its 'exit' event, and a crashing helper's final stderr lines are worth keeping.
    const current = (): boolean => generation === this.generation

    child.stdout?.on('data', (chunk) => {
      if (current()) this.handleStdout(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (current()) this.handleStderr(chunk)
    })
    // Pipe errors (EPIPE after the helper died, …) surface as exits; swallow them here.
    child.stdin?.on('error', () => {})
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    child.on('exit', (code, signal) => this.handleExit(generation, code, signal, null))
    child.on('error', (err) => {
      // Node also reports failed kill()/IPC here; only a process that never started is an exit.
      if (child.pid === undefined) this.handleExit(generation, null, null, err.message)
    })

    if (this.failures > 0) this.emit('restart', { attempt: this.failures, pid: child.pid })
    this.applyDesiredState()
    this.missedHeartbeats = 0
    this.scheduleHeartbeat(generation)
  }

  private applyDesiredState(): void {
    if (this.pollHz > 0) this.writeLine(encodeCommand({ type: 'setPollRate', hz: this.pollHz }))
    const config = this.tapConfig
    if (config) {
      this.request({ type: 'startInputTap', keys: config.keys, mouse: config.mouse }).then(
        (reply) => this.emit('inputTap', { ...reply, id: null }),
        (err: unknown) =>
          this.emit('inputTap', { type: 'inputTap', id: null, active: false, error: errorText(err), reason: 'helperUnavailable' }),
      )
    }
  }

  // ── watchdog ──

  private scheduleHeartbeat(generation: number): void {
    const watchdog = this.watchdog
    if (!watchdog) return
    this.clearHeartbeat()
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null
      this.heartbeat(generation, watchdog)
    }, watchdog.heartbeatMs)
  }

  private heartbeat(generation: number, watchdog: HelperWatchdogOptions): void {
    const alive = (): boolean => generation === this.generation && this.isRunning
    if (!alive()) return
    this.request({ type: 'ping' }, { timeoutMs: watchdog.timeoutMs }).then(
      () => {
        if (!alive()) return
        this.missedHeartbeats = 0
        this.scheduleHeartbeat(generation)
      },
      (err: unknown) => {
        if (!alive()) return
        if (err instanceof HelperRequestError && err.reason === 'timeout') {
          this.missedHeartbeats += 1
          if (this.missedHeartbeats >= watchdog.maxMissed) {
            this.killUnresponsive(generation, this.missedHeartbeats)
            return
          }
        }
        this.scheduleHeartbeat(generation)
      },
    )
  }

  /** SIGKILLs a wedged helper; its exit (or, failing that, a timeout) then restarts it. */
  private killUnresponsive(generation: number, missed: number): void {
    const child = this.child
    if (!child || generation !== this.generation) return
    this.watchdogKill = { generation, message: `unresponsive: no reply to ${missed} heartbeats, killed by the watchdog` }
    this.signal(child, 'SIGKILL')
    // A process that cannot be reaped must not block recovery forever.
    this.watchdogKillTimer = setTimeout(() => {
      this.watchdogKillTimer = null
      this.handleExit(generation, null, 'SIGKILL', null)
    }, tuning.helper.stopGraceMs)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private handleExit(generation: number, code: number | null, signal: string | null, spawnError: string | null): void {
    if (generation !== this.generation || this.exitedGeneration === generation) return
    this.exitedGeneration = generation
    this.clearHeartbeat()
    if (this.watchdogKillTimer !== null) clearTimeout(this.watchdogKillTimer)
    this.watchdogKillTimer = null
    const killedByWatchdog = this.watchdogKill?.generation === generation ? this.watchdogKill.message : null
    this.watchdogKill = null
    const error = spawnError ?? killedByWatchdog
    const uptimeMs = Math.max(0, this.now() - this.startedAt)
    this.child = null
    this.hello = null
    this.rejectAll(new HelperRequestError('bitbot-helper exited', 'exited'))

    if (this.stopping) {
      if (this.killTimer !== null) clearTimeout(this.killTimer)
      this.killTimer = null
      const resolve = this.resolveStop
      this.resolveStop = null
      this.stopPromise = null
      this.emit('exit', { code, signal, error, uptimeMs, willRestart: false, restartInMs: null })
      resolve?.()
      return
    }

    if (uptimeMs >= tuning.helper.stableUptimeMs) this.failures = 0
    const { initialMs, factor, maxMs } = tuning.helper.restartBackoff
    const delay = Math.min(initialMs * factor ** this.failures, maxMs)
    this.failures += 1
    this.restartTimer = setTimeout(() => this.spawnChild(), delay)
    // Emitted after scheduling, so a listener that calls stop() cancels this restart.
    this.emit('exit', { code, signal, error, uptimeMs, willRestart: true, restartInMs: delay })
  }

  private handleStdout(chunk: string | Uint8Array): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    for (const line of this.splitter.push(text)) this.handleLine(line)
  }

  private handleStderr(chunk: string | Uint8Array): void {
    const text = typeof chunk === 'string' ? chunk : this.stderrDecoder.decode(chunk, { stream: true })
    for (const line of this.stderrSplitter.push(text)) this.emit('stderr', line)
  }

  private handleLine(line: string): void {
    const message = parseHelperMessage(line)
    if (!message) {
      this.emit('protocolError', { reason: 'unparseable', length: line.length })
      return
    }
    for (const listener of [...this.messageListeners]) this.invoke(() => listener(message))

    const id = 'id' in message ? message.id : null
    if (id !== null) {
      const pending = this.pending.get(id)
      if (!pending) {
        this.emit('protocolError', { reason: 'unmatchedReply', length: line.length })
        return
      }
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (message.type === 'error') {
        pending.reject(new HelperRequestError(`bitbot-helper rejected '${pending.type}': ${message.message}`, 'helper-error'))
      } else if (message.type !== pending.expect) {
        pending.reject(new HelperRequestError(`bitbot-helper answered '${pending.type}' with '${message.type}'`, 'protocol'))
      } else {
        pending.resolve(message)
      }
      return
    }

    if (message.type === 'hello') {
      this.hello = message
      if (message.version !== HELPER_PROTOCOL_VERSION) {
        this.emit('protocolError', { reason: 'versionMismatch', expected: HELPER_PROTOCOL_VERSION, actual: message.version })
      }
    }
    this.emit(message.type, message)
  }

  private emit<K extends keyof HelperClientEventMap>(type: K, event: HelperClientEventMap[K]): void {
    const set = this.listeners.get(type)
    if (!set) return
    for (const listener of [...set]) this.invoke(() => listener(event))
  }

  private invoke(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.onListenerError(err)
    }
  }

  private writeLine(line: string): void {
    const stdin = this.child?.stdin
    if (!stdin) return
    try {
      stdin.write(line)
    } catch {
      // The stream is gone; the exit handler takes it from here.
    }
  }

  private signal(child: HelperChildProcess, signal: NodeJS.Signals): void {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }

  private rejectAll(error: HelperRequestError): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }
}
