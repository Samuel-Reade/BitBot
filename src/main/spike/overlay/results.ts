// Shape of the per-run results JSON written by the Spike A harness and read by
// spikes/analysis/summarize.mjs. Bump RESULTS_SCHEMA when the shape changes incompatibly.

import type { OverlayMode, OverlayVariant, Rect } from '../../../shared/spikeOverlay'
import type { FocusEvent } from './focus'
import type { FootprintAggregate } from './footprint'
import type { InteractionStats, PetBox } from './interaction'
import type { MetricsAggregate, MetricsSample } from './metricsAggregate'
import type { A1TimerKind, WindowTypeOption } from './options'
import type { Summary } from './stats'
import type { OverlayWindowState } from './window'

export const RESULTS_SCHEMA = 'bitbot.spike.overlay/1'

export interface PresentationResults {
  /** 'timer-deadline' / 'timer-interval' (A1) or 'raf' (A2). */
  driver: 'timer-deadline' | 'timer-interval' | 'raf'
  ticks: number
  /** Real time between consecutive presentation ticks in main, ms. */
  intervalMs: Summary | null
  rawIntervalsMs: number[]
  setPosition: {
    calls: number
    /** Ticks whose rounded position equalled the previous one (no call made). */
    unchanged: number
    errors: number
    durationMs: Summary | null
  }
  /** Ticks whose render time was past the newest sim state (sim timer late). */
  starved: number
  /** A1 deadline timer: deadlines skipped because a tick ran more than a period late. */
  missedDeadlines: number
  /** A2: frame-message delivery delay beyond the fastest one seen (main-thread responsiveness), ms. */
  frameLatencyMs: Summary | null
  /** Once-per-second checks where getPosition() differed from the last setPosition(). */
  positionMismatches: number
  positionChecks: number
}

export interface RendererResults {
  frames: number
  measuredS: number
  rafIntervalMs: Summary | null
  /** Median rAF interval: the display's frame period when nothing is dropped. */
  medianRafMs: number | null
  longFrameMs: number
  /** % of rAF intervals above longFrameMs. */
  pctLongFrames: number
  callbackMs: Summary | null
  renderMs: Summary | null
  starvedFrames: number
  stateMsgs: number
  mousemoves: number
  hitTests: number
  hoverMsgsSent: number
  truncated: boolean
  rawRafIntervalsMs: number[]
}

export interface CaptureResults {
  file: string
  /** Captured page rect, DIP (approach A: the whole window). */
  rectDip: Rect
  /** Image size in device pixels. */
  width: number
  height: number
  opaquePixels: number
  alphaSum: number
  /** Bounding box of non-transparent pixels, device pixels relative to the capture. */
  opaqueBox: { x: number; y: number; width: number; height: number } | null
}

export interface FootprintResults extends FootprintAggregate {
  /** When `footprint` ran (s since the window was shown): after the measurement window closed. */
  atS: number
  /** How long it took, ms. */
  tookMs: number
}

export interface MemoryResults {
  /**
   * Activity Monitor's "Memory" (kernel phys_footprint) per process type and summed over all Bitbot
   * processes: the unit of the §11 budget. Read once at the end of the run; null if unavailable.
   */
  footprint: FootprintResults | null
  footprintError: string | null
  /**
   * Mean over the measured window of summed workingSetSize (resident set size). It counts shared
   * framework pages once per process and misses GPU memory: NOT comparable with the §11 budget.
   */
  rssMeanMB: number
}

export interface OverlayResults {
  schema: typeof RESULTS_SCHEMA
  variant: OverlayVariant
  mode: OverlayMode
  label: string | null
  startedAt: string
  file: string
  ok: boolean
  options: {
    durationS: number
    warmupS: number
    windowType: WindowTypeOption
    size: string
    palette: string
    a1Timer: A1TimerKind
    simHz: number
    simLeadMs: number
    a1TimerHz: number
    walkSpeed: number
    followSpeed: number
    syntheticPeakSpeed: number
  }
  env: {
    electron: string
    chrome: string
    node: string
    macos: string
    arch: string
    cpu: string
    cores: number
    displays: number
    gpuFeatureStatus: Record<string, string>
    /** Measurement conditions: CPU% depends on P- vs E-core scheduling, which load and power affect. */
    onBattery: boolean
    thermalState: string
    loadAvg1m: { start: number; end: number }
  }
  display: { id: number; bounds: Rect; workArea: Rect; scaleFactor: number; displayFrequency: number; internal: boolean }
  window: {
    wid: number | null
    requestedBounds: Rect
    state: OverlayWindowState | null
    edge: number
    anchor: { x: number; y: number }
    petBox: PetBox | null
    devicePixelRatio: number | null
    canvas: { width: number; height: number } | null
    glRenderer: string | null
  }
  measure: { warmupS: number; startS: number | null; endS: number; measuredS: number; endReason: string }
  sim: {
    stepMs: number
    steps: number
    droppedSteps: number
    /** Interval between sim wakes that computed at least one step (ideal: stepMs), ms. */
    wakeIntervalMs: Summary | null
    /** Lateness of those wakes against their target (first due step's nominal time − simLeadMs), ms. */
    wakeLatenessMs: Summary | null
    /** Wakes by number of steps computed; '0' = an early wake that only re-armed the timer. */
    stepsPerWake: Record<string, number>
    stepComputeMs: Summary | null
    stateMsgsSent: number
  }
  presentation: PresentationResults | null
  renderer: RendererResults | null
  /** CPU per process type (percent of one core) plus RSS, from app.getAppMetrics(). */
  cpu: MetricsAggregate
  memory: MemoryResults
  /** All app-metrics samples, including warm-up (tS relative to show). */
  metricsSamples: (Omit<MetricsSample, 'tMs'> & { tS: number })[]
  interaction: InteractionStats & { focusEvents: (Omit<FocusEvent, 'tMs'> & { tS: number })[]; activations: number }
  /** --capture dev check, else null. */
  capture: CaptureResults | null
  errors: string[]
  warnings: string[]
  summary: string
}

function fmt(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits)
}

/** One-line human summary printed at exit (also stored in the JSON). */
export function summaryLine(r: Omit<OverlayResults, 'summary'>): string {
  const parts: string[] = [`${r.variant}/${r.mode} measured ${fmt(r.measure.measuredS)}s`]
  if (r.renderer) {
    parts.push(
      `raf p50 ${fmt(r.renderer.rafIntervalMs?.p50, 2)} p95 ${fmt(r.renderer.rafIntervalMs?.p95, 2)} ms, ` +
        `>${r.renderer.longFrameMs}ms ${fmt(r.renderer.pctLongFrames, 2)}% (${r.renderer.frames} frames)`,
    )
  } else {
    parts.push('renderer stats MISSING')
  }
  if (r.presentation) {
    parts.push(
      `present p50 ${fmt(r.presentation.intervalMs?.p50, 2)} p95 ${fmt(r.presentation.intervalMs?.p95, 2)} ms ` +
        `(${r.presentation.ticks} ticks, ${r.presentation.setPosition.calls} setPosition, p95 ${fmt(r.presentation.setPosition.durationMs?.p95, 3)} ms)`,
    )
  }
  const t = r.cpu.total
  const typePart = ['Browser', 'Tab', 'GPU', 'Utility']
    .map((type) => `${type} ${fmt(r.cpu.byType[type]?.cpuMeanCumulative ?? r.cpu.byType[type]?.cpuMean)}`)
    .join(' ')
  const fp = r.memory.footprint
  parts.push(
    `CPU ${fmt(t.cpuMeanCumulative ?? t.cpuMean)}% (${typePart}) | ` +
      `mem ${fp ? `${fmt(fp.totalMB, 0)} MB footprint` : 'footprint n/a'} (RSS sum ${fmt(r.memory.rssMeanMB, 0)} MB)`,
  )
  parts.push(`hover ${r.interaction.hoverOn}/${r.interaction.hoverOff} safety ${r.interaction.safetyNet} activations ${r.interaction.activations}`)
  parts.push(`errors ${r.errors.length}`)
  return parts.join(' | ')
}
