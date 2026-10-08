// The dev check's judgments (src/main/dev/overlayCheck.ts): hover latencies paired with the silhouette crossings that
// caused them, the grab area's coverage of the pet, the window order the helper sees, the thresholds of the verdict,
// and Spike A's A2 results to compare with. Pure; unit-tested (test/overlayCheck.test.ts).

import type { Rect } from '../../shared/geometry'
import type { OverlayStatsMsg } from '../../shared/petProtocol'
import type { Crossing } from './checkPaths'
import { percentileSorted, roundSummary, summarize, type Summary } from './stats'

/** The grab area's mouse switched on (it takes the mouse) or off (click-through) at tMs. */
export interface MouseToggle {
  tMs: number
  on: boolean
}

export interface LatencyPairs {
  /** Silhouette reached the still cursor → mouse on, ms (negative: on before the crossing, e.g. the hit test's halo). */
  enterMs: number[]
  /** Silhouette left the still cursor → mouse off, ms. */
  leaveMs: number[]
  /** Crossings with no matching toggle within the window. */
  missedEnter: number
  missedLeave: number
  /** Toggles that matched no crossing (flicker, or a crossing outside the measured window). */
  unpaired: number
}

/**
 * Pairs each crossing with the first unused toggle of its kind (enter → on, leave → off) in [crossing − earlyMs,
 * crossing + windowMs].
 */
export function pairLatencies(
  crossings: readonly Crossing[],
  toggles: readonly MouseToggle[],
  earlyMs: number,
  windowMs: number,
): LatencyPairs {
  const sorted = [...toggles].sort((a, b) => a.tMs - b.tMs)
  const used = new Set<number>()
  const result: LatencyPairs = { enterMs: [], leaveMs: [], missedEnter: 0, missedLeave: 0, unpaired: 0 }
  for (const c of [...crossings].sort((a, b) => a.tMs - b.tMs)) {
    const want = c.kind === 'enter'
    const index = sorted.findIndex((t, i) => !used.has(i) && t.on === want && t.tMs >= c.tMs - earlyMs && t.tMs <= c.tMs + windowMs)
    const toggle = sorted[index]
    if (index < 0 || !toggle) {
      if (want) result.missedEnter++
      else result.missedLeave++
      continue
    }
    used.add(index)
    ;(want ? result.enterMs : result.leaveMs).push(toggle.tMs - c.tMs)
  }
  result.unpaired = sorted.length - used.size
  return result
}

/**
 * The p-th percentile of `values` with `missed` samples counted as `missValue` (a lower bound for a toggle that never
 * came within the window); null when there are no samples at all.
 */
export function percentileWithMisses(values: readonly number[], missed: number, missValue: number, p: number): number | null {
  const all = [...values.filter((v) => Number.isFinite(v)), ...Array.from({ length: Math.max(0, missed) }, () => missValue)]
  if (all.length === 0) return null
  return percentileSorted(Float64Array.from(all).sort(), p)
}

/** The overlay's renderer counters over a phase (two debug:overlay-stats snapshots of the same page load). */
export interface RendererDelta {
  /** requestAnimationFrame callbacks. */
  frames: number
  /** WebGL renders. */
  renders: number
  /** Frame intervals above tuning.overlay.longFrameMs. */
  longFrames: number
  /** Frames with nothing newer to interpolate toward. */
  starvedFrames: number
  framesPerS: number
  rendersPerS: number
  /** Intervals between consecutive frames of a run of frames, ms. */
  rafMs: Summary | null
  cursorMsgs: number
  cursorMsgsIgnored: number
  hitTests: number
  hoverMsgs: number
  pointerMsgs: number
  /** Grab-area mousemove of a press → the frame that drew the pet for it, ms. */
  inputToFrameMs: Summary | null
  /** A sample list hit its cap: the lists may miss part of the phase. */
  truncated: boolean
}

/** Counters between two snapshots `seconds` apart; null if one is missing or they come from different page loads. */
export function rendererDelta(a: OverlayStatsMsg | null, b: OverlayStatsMsg | null, seconds: number): RendererDelta | null {
  if (!a || !b || b.frames < a.frames || b.renders < a.renders || b.rafIntervalsMs.length < a.rafIntervalsMs.length) return null
  const s = seconds > 0 ? seconds : Number.NaN
  const frames = b.frames - a.frames
  const renders = b.renders - a.renders
  return {
    frames,
    renders,
    longFrames: b.longFrames - a.longFrames,
    starvedFrames: b.starvedFrames - a.starvedFrames,
    framesPerS: frames / s,
    rendersPerS: renders / s,
    rafMs: roundSummary(summarize(b.rafIntervalsMs.slice(a.rafIntervalsMs.length))),
    cursorMsgs: b.cursorMsgs - a.cursorMsgs,
    cursorMsgsIgnored: b.cursorMsgsIgnored - a.cursorMsgsIgnored,
    hitTests: b.hitTests - a.hitTests,
    hoverMsgs: b.hoverMsgs - a.hoverMsgs,
    pointerMsgs: b.pointerMsgs - a.pointerMsgs,
    inputToFrameMs: roundSummary(summarize(b.inputToFrameMs.slice(a.inputToFrameMs.length))),
    truncated: b.truncated,
  }
}

/** Pixels of a BGRA (or RGBA) bitmap whose alpha is above `alphaMin`. */
export function countDrawnPixels(bitmap: Uint8Array, alphaMin: number): number {
  let n = 0
  for (let i = 3; i < bitmap.length; i += 4) if ((bitmap[i] ?? 0) > alphaMin) n++
  return n
}

/** How far `inner` sticks out of `outer` on its worst side, pt (0 when it lies inside). */
export function overshoot(outer: Rect, inner: Rect): number {
  return Math.max(
    0,
    outer.x - inner.x,
    outer.y - inner.y,
    inner.x + inner.width - (outer.x + outer.width),
    inner.y + inner.height - (outer.y + outer.height),
  )
}

/** One window of the helper's on-screen list (front to back). */
export interface ZEntry {
  wid: number
  layer: number
  onScreen: boolean
}

export interface ZPlace {
  /** Position in the front-to-back list. */
  index: number
  layer: number
  onScreen: boolean
}

export interface ZOrder {
  overlay: ZPlace | null
  grab: ZPlace | null
  /** Windows listed between the grab area and the overlay; null unless the grab area is listed in front of the overlay. */
  between: number | null
}

/** Where the overlay and the grab area are in the helper's on-screen list. */
export function zOrder(windows: readonly ZEntry[], overlayWid: number | null, grabWid: number | null): ZOrder {
  const place = (wid: number | null): ZPlace | null => {
    if (wid === null) return null
    const index = windows.findIndex((w) => w.wid === wid)
    const w = windows[index]
    return index < 0 || !w ? null : { index, layer: w.layer, onScreen: w.onScreen }
  }
  const overlay = place(overlayWid)
  const grab = place(grabWid)
  const between = overlay && grab && grab.index < overlay.index ? overlay.index - grab.index - 1 : null
  return { overlay, grab, between }
}

export interface Verdict {
  name: string
  /** The measured value; null = not measured (a FAIL). */
  value: number | null
  limit: number
  unit: string
  /** 'max': value ≤ limit; 'below': value < limit. */
  rule: 'max' | 'below'
  pass: boolean
  /** True: a FAIL fails the check (exit code); false: report-only. */
  gate: boolean
  detail: string
}

export function judge(
  name: string,
  value: number | null,
  limit: number,
  unit: string,
  opts: { rule?: 'max' | 'below'; gate?: boolean; detail?: string } = {},
): Verdict {
  const rule = opts.rule ?? 'max'
  const measured = value !== null && Number.isFinite(value)
  const pass = measured && Number.isFinite(limit) && (rule === 'max' ? value <= limit : value < limit)
  return { name, value: measured ? value : null, limit, unit, rule, pass, gate: opts.gate ?? true, detail: opts.detail ?? '' }
}

/**
 * "PASS drag input→frame p95, drag patrol 600 pt/s: 15.2 ms (limit ≤ 18.7 ms)"; N/A when there is nothing to compare
 * with (a missing limit).
 */
export function verdictLine(v: Verdict): string {
  const digits = v.unit === '%' ? 2 : 1
  const value = v.value === null ? 'not measured' : `${v.value.toFixed(digits)} ${v.unit}`
  const limited = Number.isFinite(v.limit)
  const limit = limited ? `limit ${v.rule === 'max' ? '≤' : '<'} ${v.limit.toFixed(digits)} ${v.unit}` : 'no limit to compare with'
  const tag = !limited ? 'N/A' : v.pass ? 'PASS' : 'FAIL'
  return `${tag}${v.gate ? '' : ' (report-only)'} ${v.name}: ${value} (${limit})${v.detail ? `; ${v.detail}` : ''}`
}

/** The part of a Spike A results file (schema bitbot.spike.overlay/1) the comparison reads. */
export interface A2Run {
  file: string
  mode: 'walk' | 'synthetic'
  /** Epoch ms. */
  startedAtMs: number
  /** % of one core per process type (cumulative), and their sum. */
  byType: Record<string, number>
  total: number | null
  onBattery: boolean | null
  load1m: { start: number; end: number } | null
  ok: boolean
}

/** An A2 walk or synthetic run from a Spike A results JSON, or null if it is anything else. */
export function readA2Run(json: unknown, file: string): A2Run | null {
  if (typeof json !== 'object' || json === null) return null
  const r = json as Record<string, unknown>
  if (r['schema'] !== 'bitbot.spike.overlay/1' || r['variant'] !== 'A2') return null
  const mode = r['mode']
  if (mode !== 'walk' && mode !== 'synthetic') return null
  const startedAtMs = Date.parse(String(r['startedAt']))
  if (!Number.isFinite(startedAtMs)) return null
  type CpuStats = { cpuMeanCumulative?: unknown } | undefined
  const cpu = r['cpu'] as { byType?: Record<string, CpuStats>; total?: CpuStats } | undefined
  const byType: Record<string, number> = {}
  for (const [type, stats] of Object.entries(cpu?.byType ?? {})) {
    const v = stats?.cpuMeanCumulative
    if (typeof v === 'number' && Number.isFinite(v)) byType[type] = v
  }
  const total = cpu?.total?.cpuMeanCumulative
  const env = r['env'] as { onBattery?: unknown; loadAvg1m?: { start?: unknown; end?: unknown } } | undefined
  const load = env?.loadAvg1m
  return {
    file,
    mode,
    startedAtMs,
    byType,
    total: typeof total === 'number' && Number.isFinite(total) ? total : null,
    onBattery: typeof env?.onBattery === 'boolean' ? env.onBattery : null,
    load1m: typeof load?.start === 'number' && typeof load.end === 'number' ? { start: load.start, end: load.end } : null,
    ok: r['ok'] === true,
  }
}

/** The newest good run of `mode` that started within maxAgeMs before (or after) `atMs`; null if none. */
export function newestA2(runs: readonly A2Run[], mode: 'walk' | 'synthetic', atMs: number, maxAgeMs: number): A2Run | null {
  let best: A2Run | null = null
  for (const run of runs) {
    if (run.mode !== mode || !run.ok || run.startedAtMs < atMs - maxAgeMs) continue
    if (!best || run.startedAtMs > best.startedAtMs) best = run
  }
  return best
}
