// Spike A (BITBOT_SPEC.md §12, §5.2): overlay-approach harness. IPC channel names and payloads
// shared by src/main/spike/overlaySpike.ts and src/renderer/spike/petSpike.ts.
// Throwaway: removed together with the harness once the overlay decision is made.
//
// Hover and pointer messages reuse the production channels in ./ipc.ts ('pet:hover', 'pet:pointer').

export const OVERLAY_VARIANTS = ['A1', 'A2', 'B', 'Bfull'] as const
/**
 * A1    small moving window, setPosition from a main-process timer.
 * A2    small moving window, setPosition driven by the renderer's requestAnimationFrame.
 * B     display-sized transparent window, small canvas moved with a CSS transform.
 * Bfull display-sized transparent window and canvas, pet placed with camera.setViewOffset.
 */
export type OverlayVariant = (typeof OVERLAY_VARIANTS)[number]

export const OVERLAY_MODES = ['static', 'walk', 'synthetic', 'follow', 'interactive'] as const
export type OverlayMode = (typeof OVERLAY_MODES)[number]

/** Simulation phase carried in every state message (cosmetic only on the renderer side). */
export type OverlayPhase = 'stand' | 'walk' | 'chase' | 'held' | 'fall' | 'land'

export const SPIKE_OVERLAY_IPC = {
  /** renderer → main (invoke): get the run configuration. Returns OverlayConfig. */
  config: 'spike:overlay:config',
  /** renderer → main: first frame rendered. Payload: OverlayReadyMsg */
  ready: 'spike:overlay:ready',
  /** main → renderer, once per simulation step. Payload: OverlayStateMsg */
  state: 'spike:overlay:state',
  /** renderer → main, every requestAnimationFrame (variant A2 only). Payload: OverlayFrameMsg */
  frame: 'spike:overlay:frame',
  /** main → renderer: warm-up is over, reset the renderer's counters. No payload. */
  measureStart: 'spike:overlay:measure-start',
  /** main → renderer: reply with OverlayRendererStats on `stats`. No payload. */
  statsRequest: 'spike:overlay:stats-request',
  /** renderer → main. Payload: OverlayRendererStats */
  stats: 'spike:overlay:stats',
  /** main → renderer: main forced click-through back on (safety net); forget the hover state. */
  hoverReset: 'spike:overlay:hover-reset',
  /** renderer → main: problem report recorded in the results. Payload: OverlayLogMsg */
  log: 'spike:overlay:log',
} as const

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayConfig {
  variant: OverlayVariant
  mode: OverlayMode
  /** Window content bounds in global screen points (top-left origin, y down). */
  window: Rect
  /** Pet viewport edge in points (approach A window size, approach B canvas size). */
  edge: number
  /** Simulation step in ms; the renderer interpolates one step behind (§5.1 pipeline). */
  stepMs: number
  /** Drag/toss/menu are enabled (interactive mode). */
  interactive: boolean
}

export interface OverlayStateMsg {
  seq: number
  /** Nominal time of this state on main's performance.now() clock, ms (may be slightly in the future). */
  t: number
  /** Main's performance.now() when sent: lets the renderer estimate the clock offset. */
  sentAt: number
  /** Pet ground-contact point in global screen points. */
  x: number
  y: number
  facing: 1 | -1
  phase: OverlayPhase
  /** Do not interpolate from earlier states (start, grab, release). */
  snap: boolean
}

export interface OverlayFrameMsg {
  seq: number
  /** requestAnimationFrame timestamp (renderer clock, ms). */
  t: number
}

export interface OverlayReadyMsg {
  /** Viewport point (CSS px) where the ground-contact point is drawn. */
  anchor: { x: number; y: number }
  /** Pet's projected bounding box relative to the anchor, pt (union over both facings). */
  petBox: { left: number; top: number; right: number; bottom: number }
  devicePixelRatio: number
  canvas: { width: number; height: number }
  /** Unmasked WebGL renderer string, when the browser exposes it. */
  glRenderer: string | null
}

export interface OverlayRendererStats {
  /** Renderer time covered by these stats (since measure-start), ms. */
  measuredMs: number
  frames: number
  /** Intervals between consecutive requestAnimationFrame timestamps, ms (capped). */
  rafIntervalsMs: number[]
  /** Time spent inside each rAF callback, ms (capped). */
  callbackMs: number[]
  /** Time spent in pet.render() (JS submission only, not GPU time), ms (capped). */
  renderMs: number[]
  /** B/Bfull: frames where no newer sim state was available for interpolation. */
  starvedFrames: number
  stateMsgs: number
  mousemoves: number
  hitTests: number
  hoverMsgsSent: number
  /** Samples dropped because a series hit its cap. */
  truncated: boolean
}

export interface OverlayLogMsg {
  level: 'error' | 'warning' | 'info'
  message: string
}

// ── interpolation (pure; used by main for A1/A2 and by the renderer for B/Bfull) ──────────────

export interface TimedPoint {
  /** Nominal time, ms. */
  t: number
  x: number
  y: number
}

export interface InterpolationResult {
  x: number
  y: number
  /** The render time was past the newest state (nothing newer to interpolate toward). */
  starved: boolean
}

/** Linear interpolation between two timed states at `renderT`, clamped to [prev, curr]. */
export function interpolate(prev: TimedPoint, curr: TimedPoint, renderT: number, starveToleranceMs = 0.5): InterpolationResult {
  const span = curr.t - prev.t
  if (span <= 0 || renderT >= curr.t) return { x: curr.x, y: curr.y, starved: renderT > curr.t + starveToleranceMs }
  if (renderT <= prev.t) return { x: prev.x, y: prev.y, starved: false }
  const a = (renderT - prev.t) / span
  return { x: prev.x + (curr.x - prev.x) * a, y: prev.y + (curr.y - prev.y) * a, starved: false }
}

/** Interpolates inside a time-ordered buffer (oldest first); null when the buffer is empty. */
export function sampleBuffer(buffer: readonly TimedPoint[], renderT: number, starveToleranceMs = 0.5): InterpolationResult | null {
  const last = buffer[buffer.length - 1]
  if (!last) return null
  if (renderT >= last.t) return { x: last.x, y: last.y, starved: renderT > last.t + starveToleranceMs }
  for (let i = buffer.length - 1; i > 0; i--) {
    const a = buffer[i - 1]
    const b = buffer[i]
    if (a && b && renderT >= a.t) return interpolate(a, b, renderT, starveToleranceMs)
  }
  const first = buffer[0] ?? last
  return { x: first.x, y: first.y, starved: false }
}

export function isOverlayVariant(value: unknown): value is OverlayVariant {
  return typeof value === 'string' && (OVERLAY_VARIANTS as readonly string[]).includes(value)
}

export function isOverlayMode(value: unknown): value is OverlayMode {
  return typeof value === 'string' && (OVERLAY_MODES as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRect(value: unknown): value is Rect {
  return (
    isRecord(value) &&
    isFiniteNumber(value['x']) &&
    isFiniteNumber(value['y']) &&
    isFiniteNumber(value['width']) &&
    isFiniteNumber(value['height'])
  )
}

export function isOverlayConfig(value: unknown): value is OverlayConfig {
  return (
    isRecord(value) &&
    isOverlayVariant(value['variant']) &&
    isOverlayMode(value['mode']) &&
    isRect(value['window']) &&
    isFiniteNumber(value['edge']) &&
    isFiniteNumber(value['stepMs']) &&
    typeof value['interactive'] === 'boolean'
  )
}

export function isOverlayStateMsg(value: unknown): value is OverlayStateMsg {
  return (
    isRecord(value) &&
    isFiniteNumber(value['seq']) &&
    isFiniteNumber(value['t']) &&
    isFiniteNumber(value['sentAt']) &&
    isFiniteNumber(value['x']) &&
    isFiniteNumber(value['y']) &&
    (value['facing'] === 1 || value['facing'] === -1) &&
    typeof value['phase'] === 'string' &&
    typeof value['snap'] === 'boolean'
  )
}

export function isOverlayFrameMsg(value: unknown): value is OverlayFrameMsg {
  return isRecord(value) && isFiniteNumber(value['seq']) && isFiniteNumber(value['t'])
}

export function isOverlayReadyMsg(value: unknown): value is OverlayReadyMsg {
  if (!isRecord(value)) return false
  const anchor = value['anchor']
  const box = value['petBox']
  const canvas = value['canvas']
  return (
    isRecord(anchor) &&
    isFiniteNumber(anchor['x']) &&
    isFiniteNumber(anchor['y']) &&
    isRecord(box) &&
    isFiniteNumber(box['left']) &&
    isFiniteNumber(box['top']) &&
    isFiniteNumber(box['right']) &&
    isFiniteNumber(box['bottom']) &&
    isFiniteNumber(value['devicePixelRatio']) &&
    isRecord(canvas) &&
    isFiniteNumber(canvas['width']) &&
    isFiniteNumber(canvas['height']) &&
    (value['glRenderer'] === null || typeof value['glRenderer'] === 'string')
  )
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber)
}

export function isOverlayRendererStats(value: unknown): value is OverlayRendererStats {
  return (
    isRecord(value) &&
    isFiniteNumber(value['measuredMs']) &&
    isFiniteNumber(value['frames']) &&
    isNumberArray(value['rafIntervalsMs']) &&
    isNumberArray(value['callbackMs']) &&
    isNumberArray(value['renderMs']) &&
    isFiniteNumber(value['starvedFrames']) &&
    isFiniteNumber(value['stateMsgs']) &&
    isFiniteNumber(value['mousemoves']) &&
    isFiniteNumber(value['hitTests']) &&
    isFiniteNumber(value['hoverMsgsSent']) &&
    typeof value['truncated'] === 'boolean'
  )
}

export function isOverlayLogMsg(value: unknown): value is OverlayLogMsg {
  return (
    isRecord(value) &&
    (value['level'] === 'error' || value['level'] === 'warning' || value['level'] === 'info') &&
    typeof value['message'] === 'string'
  )
}
