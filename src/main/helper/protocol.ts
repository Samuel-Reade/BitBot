// Wire protocol between the main process and bitbot-helper (BITBOT_SPEC.md §5.3).
// Pure TypeScript: no Electron or Node imports, so it is unit-testable and reusable.
//
// Newline-delimited JSON, one object per line. Must match helper/Sources/Helper.swift
// (HELPER_PROTOCOL_VERSION == its `protocolVersion`).
//
// Version 2: inputTap.reason, frontmostFullscreen.displayIds, scroll.linesX/pxX, and
// startInputTap with keys and mouse both false means stop.
//
// Privacy: `input` key messages carry a virtual key code for the in-memory anti-gaming checks
// (§7.3) only. Never log, persist or translate them to characters.

export const HELPER_PROTOCOL_VERSION = 2

// ───────────────────────────── helper → main ─────────────────────────────

/** One on-screen window, in global points (top-left origin of the main display, y down). */
export interface HelperWindow {
  wid: number
  pid: number
  bundleId: string | null
  layer: number
  x: number
  y: number
  w: number
  h: number
  onScreen: boolean
  alpha: number
}

export interface DisplayInfo {
  id: number
  x: number
  y: number
  w: number
  h: number
  main: boolean
}

export interface HelloMsg {
  type: 'hello'
  version: number
  pid: number
}

/** `id` is null for snapshots pushed at the poll rate. `windows` is front-to-back z-order. */
export interface SnapshotMsg {
  type: 'snapshot'
  id: number | null
  /** Unix time in seconds (fractional). */
  ts: number
  windows: HelperWindow[]
}

export interface PongMsg {
  type: 'pong'
  id: number
}

export interface DisplaysMsg {
  type: 'displays'
  id: number
  displays: DisplayInfo[]
}

export interface FrontmostMsg {
  type: 'frontmost'
  id: number
  bundleId: string | null
  pid: number | null
  appName: string | null
  fullscreen: boolean
}

export interface AppInfoMsg {
  type: 'appInfo'
  id: number
  pid: number
  bundleId: string | null
  appName: string | null
}

/** Preflight-only permission state (never prompts). */
export interface InputAccessMsg {
  type: 'inputAccess'
  id: number
  listen: boolean
  post: boolean
  accessibility: boolean
}

/** Why the helper could not start an input tap (machine-readable; `error` is for humans). */
export const HELPER_TAP_FAILURES = [
  /** Input Monitoring is not granted. No tap was attempted, so nothing prompted (show the tray reminder, §7.1). */
  'notGranted',
  /** Granted, but macOS refused the tap; it may need a relaunch after the grant (§15.1). */
  'tapCreateFailed',
] as const

/**
 * Why an inputTap is inactive with an error: a helper reason, or (client side only)
 * 'helperUnavailable' when re-applying the tap after a restart could not reach the helper.
 */
export type InputTapFailure = (typeof HELPER_TAP_FAILURES)[number] | 'helperUnavailable'

/** Reply to start/stopInputTap. `id` is null when the client re-applies the tap after a restart. */
export interface InputTapMsg {
  type: 'inputTap'
  id: number | null
  active: boolean
  error: string | null
  /** Set exactly when the tap could not be started; null when it runs or was stopped. */
  reason: InputTapFailure | null
}

// SPEC-DEVIATION: the `input` messages and the inputAccess / requestInputAccess / startInputTap /
// stopInputTap commands move global input capture from uiohook-napi (§3, §7.1, §10.4) into the
// helper, as a listen-only tap needing only Input Monitoring (docs/decisions/input-and-helper.md).
// Pending the user's approval.
export interface KeyInputMsg {
  type: 'input'
  kind: 'key'
  down: boolean
  /** macOS virtual key code. Transient anti-gaming use only (§7.3); never persist or log. */
  code: number
  repeat: boolean
  ts: number
}

export interface MouseDownInputMsg {
  type: 'input'
  kind: 'mouseDown'
  /** 0 = left, 1 = right, 2+ = other. */
  button: number
  alt: boolean
  cmd: boolean
  shift: boolean
  ctrl: boolean
  /**
   * Global points, same space as window bounds. Only present on ⌥⌘-clicks (alt && cmd), the one
   * use for a location (send-to-point, §10.4); null on every other click (data minimisation, §2).
   */
  x: number | null
  y: number | null
  ts: number
}

/** Trackpad gesture begin/end events carry zero deltas on both axes: not a scroll. */
export interface ScrollInputMsg {
  type: 'input'
  kind: 'scroll'
  /** Vertical line delta (kCGScrollWheelEventDeltaAxis1). */
  lines: number
  /** Vertical point delta (kCGScrollWheelEventPointDeltaAxis1). */
  px: number
  /** Horizontal line delta (kCGScrollWheelEventDeltaAxis2). */
  linesX: number
  /** Horizontal point delta (kCGScrollWheelEventPointDeltaAxis2). */
  pxX: number
  /** Trackpad / Magic Mouse (pixel-precise) rather than a notched wheel. */
  continuous: boolean
  /** Inertial scrolling after the fingers lifted: not a user action. */
  momentum: boolean
  ts: number
}

export type InputMsg = KeyInputMsg | MouseDownInputMsg | ScrollInputMsg

export interface DiagMsg {
  type: 'diag'
  id: number
  pid: number
  ppid: number
  /** The process macOS TCC attributes the helper's permission checks to (private SPI; may be null). */
  responsiblePid: number | null
  responsiblePath: string | null
  executablePath: string | null
  version: number
}

/**
 * Unsolicited (id null) for the initial state and on every change: the value, or while fullscreen
 * the app or its displays. Also the reply to fullscreenState (id set).
 */
export interface FrontmostFullscreenMsg {
  type: 'frontmostFullscreen'
  id: number | null
  /** The frontmost app covers at least one whole display (§5.3 heuristic). */
  value: boolean
  bundleId: string | null
  /**
   * CGDirectDisplayIDs of the displays it covers (empty when value is false). Hide the pet only
   * when its own display is listed (§8.6, §8.7).
   */
  displayIds: number[]
}

export const APP_EVENT_TYPES = ['appLaunched', 'appActivated', 'appTerminated'] as const
export type AppEventType = (typeof APP_EVENT_TYPES)[number]

export interface AppEventMsg<T extends AppEventType = AppEventType> {
  type: T
  bundleId: string | null
  pid: number
  appName: string | null
  ts: number
}
export type AppLaunchedMsg = AppEventMsg<'appLaunched'>
export type AppActivatedMsg = AppEventMsg<'appActivated'>
export type AppTerminatedMsg = AppEventMsg<'appTerminated'>

/** A malformed or failed command. `id` is set when the helper could read the request id. */
export interface ErrorMsg {
  type: 'error'
  id: number | null
  message: string
}

export type HelperMessage =
  | HelloMsg
  | SnapshotMsg
  | PongMsg
  | DisplaysMsg
  | FrontmostMsg
  | AppInfoMsg
  | InputAccessMsg
  | InputTapMsg
  | InputMsg
  | DiagMsg
  | FrontmostFullscreenMsg
  | AppLaunchedMsg
  | AppActivatedMsg
  | AppTerminatedMsg
  | ErrorMsg

export type HelperMessageType = HelperMessage['type']
export type HelperMessageOf<T extends HelperMessageType> = Extract<HelperMessage, { type: T }>

// ───────────────────────────── main → helper ─────────────────────────────

export type HelperRequest =
  | { type: 'snapshot'; id: number }
  | { type: 'ping'; id: number }
  | { type: 'displays'; id: number }
  | { type: 'frontmost'; id: number }
  | { type: 'appInfo'; id: number; pid: number }
  | { type: 'inputAccess'; id: number }
  /** Shows the system Input Monitoring prompt (when undecided), then replies like inputAccess. */
  | { type: 'requestInputAccess'; id: number }
  /** Listen-only tap. Never prompts: without Input Monitoring it fails with reason 'notGranted'. Both false = stop. */
  | { type: 'startInputTap'; id: number; keys: boolean; mouse: boolean }
  | { type: 'stopInputTap'; id: number }
  | { type: 'diag'; id: number }
  | { type: 'fullscreenState'; id: number }

export type HelperCommand =
  | HelperRequest
  /** Push snapshots at `hz` (0 stops). No reply. */
  | { type: 'setPollRate'; hz: number }
  /** Exit immediately. No reply. */
  | { type: 'quit' }

export type HelperRequestType = HelperRequest['type']

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** A request as the caller writes it; the client assigns the id. */
export type HelperRequestPayload = DistributiveOmit<HelperRequest, 'id'>

/** The message type that answers each request type. */
export const RESPONSE_TYPE = {
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
} as const satisfies Record<HelperRequestType, HelperMessageType>

export type ResponseFor<T extends HelperRequestType> = HelperMessageOf<(typeof RESPONSE_TYPE)[T]>

/** Serializes one command as a single newline-terminated line. Throws on non-finite numbers. */
export function encodeCommand(command: HelperCommand): string {
  const numbers: unknown[] = []
  if ('id' in command) numbers.push(command.id)
  if (command.type === 'setPollRate') numbers.push(command.hz)
  if (command.type === 'appInfo') numbers.push(command.pid)
  for (const value of numbers) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`bitbot-helper command '${command.type}' has a non-finite number`)
    }
  }
  // JSON.stringify escapes control characters, so the result never contains a raw newline.
  return `${JSON.stringify(command)}\n`
}

// ───────────────────────────── line splitting ─────────────────────────────

/**
 * Turns arbitrary stdout chunks into complete lines: handles partial lines across chunks, many
 * lines per chunk, CRLF, and blank lines (skipped). A line longer than `maxLineChars` is dropped
 * whole (it can only be corrupt output), counted in `droppedLines`, and the stream resyncs at the
 * next newline.
 */
export class LineSplitter {
  private pending = ''
  private discarding = false
  private dropped = 0

  constructor(
    private readonly maxLineChars: number,
    private readonly onDrop?: (approxChars: number) => void,
  ) {}

  get droppedLines(): number {
    return this.dropped
  }

  push(chunk: string): string[] {
    const lines: string[] = []
    let start = 0
    for (;;) {
      const newline = chunk.indexOf('\n', start)
      if (newline === -1) break
      if (this.discarding) {
        this.discarding = false
      } else {
        const piece = chunk.slice(start, newline)
        const line = this.pending.length > 0 ? this.pending + piece : piece
        this.pending = ''
        this.emit(line, lines)
      }
      start = newline + 1
    }
    if (start < chunk.length && !this.discarding) {
      this.pending += chunk.slice(start)
      if (this.pending.length > this.maxLineChars) this.drop(this.pending.length, true)
    }
    return lines
  }

  /** Discards any partial line (e.g. when the stream it came from has ended). */
  reset(): void {
    this.pending = ''
    this.discarding = false
  }

  private emit(raw: string, out: string[]): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length > this.maxLineChars) {
      this.drop(line.length, false)
      return
    }
    if (line.trim().length > 0) out.push(line)
  }

  private drop(approxChars: number, untilNewline: boolean): void {
    this.dropped += 1
    this.pending = ''
    this.discarding = untilNewline
    this.onDrop?.(approxChars)
  }
}

// ───────────────────────────── parsing ─────────────────────────────

type Fields = Record<string, unknown>

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const isBool = (value: unknown): value is boolean => typeof value === 'boolean'
const isStrOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isIntOrNull = (value: unknown): value is number | null => value === null || isInt(value)
const isIntArray = (value: unknown): value is number[] => Array.isArray(value) && value.every(isInt)
const isTapFailureOrNull = (value: unknown): value is (typeof HELPER_TAP_FAILURES)[number] | null =>
  value === null || (HELPER_TAP_FAILURES as readonly unknown[]).includes(value)
/** Unsolicited messages may omit `id`; normalize missing to null. */
const optionalId = (value: unknown): number | null | undefined =>
  value === undefined || value === null ? null : isInt(value) ? value : undefined

/**
 * Parses and validates one helper line. Returns a freshly built, well-typed message, or null for
 * anything malformed or unknown. Never throws. Unknown extra fields are dropped.
 */
export function parseHelperMessage(line: string): HelperMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  try {
    return parseRecord(raw)
  } catch {
    return null
  }
}

function parseRecord(m: Fields): HelperMessage | null {
  switch (m['type']) {
    case 'hello': {
      const { version, pid } = m
      return isInt(version) && isInt(pid) ? { type: 'hello', version, pid } : null
    }
    case 'snapshot': {
      const id = optionalId(m['id'])
      const { ts, windows } = m
      if (id === undefined || !isNum(ts) || !Array.isArray(windows)) return null
      const parsed: HelperWindow[] = []
      // A partial window list would corrupt occlusion (§8.3), so one bad window rejects the snapshot.
      for (const entry of windows) {
        const window = parseWindow(entry)
        if (!window) return null
        parsed.push(window)
      }
      return { type: 'snapshot', id, ts, windows: parsed }
    }
    case 'pong': {
      const { id } = m
      return isInt(id) ? { type: 'pong', id } : null
    }
    case 'displays': {
      const { id, displays } = m
      if (!isInt(id) || !Array.isArray(displays)) return null
      const parsed: DisplayInfo[] = []
      for (const entry of displays) {
        const display = parseDisplay(entry)
        if (!display) return null
        parsed.push(display)
      }
      return { type: 'displays', id, displays: parsed }
    }
    case 'frontmost': {
      const { id, bundleId, pid, appName, fullscreen } = m
      return isInt(id) && isStrOrNull(bundleId) && isIntOrNull(pid) && isStrOrNull(appName) && isBool(fullscreen)
        ? { type: 'frontmost', id, bundleId, pid, appName, fullscreen }
        : null
    }
    case 'appInfo': {
      const { id, pid, bundleId, appName } = m
      return isInt(id) && isInt(pid) && isStrOrNull(bundleId) && isStrOrNull(appName)
        ? { type: 'appInfo', id, pid, bundleId, appName }
        : null
    }
    case 'inputAccess': {
      const { id, listen, post, accessibility } = m
      return isInt(id) && isBool(listen) && isBool(post) && isBool(accessibility)
        ? { type: 'inputAccess', id, listen, post, accessibility }
        : null
    }
    case 'inputTap': {
      const id = optionalId(m['id'])
      const { active, error, reason } = m
      return id !== undefined && isBool(active) && isStrOrNull(error) && isTapFailureOrNull(reason)
        ? { type: 'inputTap', id, active, error, reason }
        : null
    }
    case 'input':
      return parseInput(m)
    case 'diag': {
      const { id, pid, ppid, responsiblePid, responsiblePath, executablePath, version } = m
      return isInt(id) &&
        isInt(pid) &&
        isInt(ppid) &&
        isIntOrNull(responsiblePid) &&
        isStrOrNull(responsiblePath) &&
        isStrOrNull(executablePath) &&
        isInt(version)
        ? { type: 'diag', id, pid, ppid, responsiblePid, responsiblePath, executablePath, version }
        : null
    }
    case 'frontmostFullscreen': {
      const id = optionalId(m['id'])
      const { value, bundleId, displayIds } = m
      return id !== undefined && isBool(value) && isStrOrNull(bundleId) && isIntArray(displayIds)
        ? { type: 'frontmostFullscreen', id, value, bundleId, displayIds: [...displayIds] }
        : null
    }
    case 'appLaunched':
    case 'appActivated':
    case 'appTerminated': {
      const { bundleId, pid, appName, ts } = m
      if (!isStrOrNull(bundleId) || !isInt(pid) || !isStrOrNull(appName) || !isNum(ts)) return null
      const base = { bundleId, pid, appName, ts }
      if (m['type'] === 'appLaunched') return { type: 'appLaunched', ...base }
      if (m['type'] === 'appActivated') return { type: 'appActivated', ...base }
      return { type: 'appTerminated', ...base }
    }
    case 'error': {
      const id = optionalId(m['id'])
      const { message } = m
      return id !== undefined && typeof message === 'string' ? { type: 'error', id, message } : null
    }
    default:
      return null
  }
}

function parseWindow(entry: unknown): HelperWindow | null {
  if (!isRecord(entry)) return null
  const { wid, pid, bundleId, layer, x, y, w, h, onScreen, alpha } = entry
  if (!isInt(wid) || !isInt(pid) || !isStrOrNull(bundleId) || !isInt(layer)) return null
  if (!isNum(x) || !isNum(y) || !isNum(w) || !isNum(h) || !isBool(onScreen) || !isNum(alpha)) return null
  return { wid, pid, bundleId, layer, x, y, w, h, onScreen, alpha }
}

function parseDisplay(entry: unknown): DisplayInfo | null {
  if (!isRecord(entry)) return null
  const { id, x, y, w, h, main } = entry
  return isInt(id) && isNum(x) && isNum(y) && isNum(w) && isNum(h) && isBool(main) ? { id, x, y, w, h, main } : null
}

function parseInput(m: Fields): InputMsg | null {
  const { ts } = m
  if (!isNum(ts)) return null
  switch (m['kind']) {
    case 'key': {
      const { down, code, repeat } = m
      return isBool(down) && isInt(code) && isBool(repeat) ? { type: 'input', kind: 'key', down, code, repeat, ts } : null
    }
    case 'mouseDown': {
      const { button, alt, cmd, shift, ctrl, x, y } = m
      const located = isNum(x) && isNum(y)
      const unlocated = x === null && y === null
      return isInt(button) && isBool(alt) && isBool(cmd) && isBool(shift) && isBool(ctrl) && (located || unlocated)
        ? { type: 'input', kind: 'mouseDown', button, alt, cmd, shift, ctrl, x: located ? x : null, y: located ? y : null, ts }
        : null
    }
    case 'scroll': {
      const { lines, px, linesX, pxX, continuous, momentum } = m
      return isInt(lines) && isNum(px) && isInt(linesX) && isNum(pxX) && isBool(continuous) && isBool(momentum)
        ? { type: 'input', kind: 'scroll', lines, px, linesX, pxX, continuous, momentum, ts }
        : null
    }
    default:
      return null
  }
}
