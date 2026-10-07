// Pure measurement helpers for the Spike B harnesses: summary statistics, `ps` output parsing and the
// helper-CPU phase plan. No Electron imports: unit-tested in test/spikeB-checks.test.ts.

export interface Summary {
  n: number
  mean: number
  min: number
  p50: number
  p95: number
  max: number
}

/** Nearest-rank percentile (p in 0..1) of an ascending array; NaN when empty. */
export function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)))
  return sorted[rank - 1] ?? Number.NaN
}

export function summarize(values: readonly number[]): Summary | null {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return null
  const sorted = [...finite].sort((a, b) => a - b)
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return {
    n: sorted.length,
    mean,
    min: sorted[0] ?? Number.NaN,
    p50: percentileSorted(sorted, 0.5),
    p95: percentileSorted(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  }
}

export function round(value: number, digits = 3): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function roundSummary(summary: Summary | null, digits = 3): Summary | null {
  if (!summary) return null
  return {
    n: summary.n,
    mean: round(summary.mean, digits),
    min: round(summary.min, digits),
    p50: round(summary.p50, digits),
    p95: round(summary.p95, digits),
    max: round(summary.max, digits),
  }
}

export function formatSummary(summary: Summary | null, unit: string, digits = 2): string {
  if (!summary) return 'no samples'
  const f = (value: number): string => value.toFixed(digits)
  return `p50 ${f(summary.p50)}${unit} p95 ${f(summary.p95)}${unit} max ${f(summary.max)}${unit} (n=${summary.n})`
}

// ───────────────────────────── round-trip latency ─────────────────────────────

/**
 * One burst of sequential requests. Sub-ms round trips depend on how busy (awake) the Mac's cores are,
 * so they are only comparable between runs with identical flags (overlay, poll rate, duration).
 */
export interface LatencyBurst {
  label: string
  tRunS: number
  /** Snapshot push rate while the burst ran. */
  pollHz: number
  /** Windows per snapshot. */
  windows: number | null
  snapshotSamplesMs: number[]
  pingSamplesMs: number[]
}

/** The INFO line: run configuration, each burst, and all bursts pooled. */
export function formatLatency(bursts: readonly LatencyBurst[], config: string): string {
  if (bursts.length === 0) return `${config}; no bursts measured`
  const one = (burst: LatencyBurst): string =>
    `${burst.label} @${burst.pollHz} Hz${burst.windows === null ? '' : `, ${burst.windows} windows`}: snapshot ` +
    `${formatSummary(summarize(burst.snapshotSamplesMs), ' ms')}, ping ${formatSummary(summarize(burst.pingSamplesMs), ' ms', 3)}`
  const pooled =
    bursts.length > 1
      ? ` | all ${bursts.length} bursts: snapshot ${formatSummary(summarize(bursts.flatMap((b) => b.snapshotSamplesMs)), ' ms')}, ` +
        `ping ${formatSummary(summarize(bursts.flatMap((b) => b.pingSamplesMs)), ' ms', 3)}`
      : ''
  return `${config}; ${bursts.map(one).join(' | ')}${pooled}`
}

// ───────────────────────────── ps ─────────────────────────────

/**
 * macOS `ps` cumulative CPU time ([[dd-]hh:]mm:ss.ss; minutes may exceed 59) → seconds. null if unparseable.
 */
export function parseCpuTime(text: string): number | null {
  const trimmed = text.trim()
  const match = /^(?:(\d+)-)?((?:\d+:){0,2}\d+(?:\.\d+)?)$/.exec(trimmed)
  if (!match?.[2]) return null
  const days = match[1] ? Number(match[1]) : 0
  const parts = match[2].split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return null
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return days * 86_400 + seconds
}

export interface PsSample {
  /**
   * `ps` %cpu: the scheduler's decaying average, printed to 0.1. Lags a rate change by seconds and read
   * 0.6-0.7× the true helper CPU at 4 Hz: a diagnostic, never a CPU figure.
   */
  cpuPct: number
  /** Cumulative CPU time (user + system), s, rounded to whole hundredths (PS_CPU_TIME_QUANTUM_S). */
  cpuTimeS: number
}

/**
 * `ps -o time=` prints cumulative CPU time rounded to hundredths of a second (macOS adv_cmds:
 * (µs + 5000) / 10000; checked against proc_pid_rusage: 33/33 steps consistent with rounding).
 */
export const PS_CPU_TIME_QUANTUM_S = 0.01

/** One line of `ps -o %cpu=,time= -p <pid>`. */
export function parsePsLine(text: string): PsSample | null {
  const fields = text.trim().split(/\s+/)
  if (fields.length !== 2 || !fields[0] || !fields[1]) return null
  const cpuPct = Number(fields[0].replace(',', '.'))
  const cpuTimeS = parseCpuTime(fields[1])
  if (!Number.isFinite(cpuPct) || cpuTimeS === null) return null
  return { cpuPct, cpuTimeS }
}

// ───────────────────────────── helper CPU phases ─────────────────────────────

export interface CpuPhasePlan {
  hz: number
  seconds: number
}

export interface CpuPhaseMode {
  /** --duration=0: no deadline, so each phase gets `defaultPhaseS`. */
  untilQuit: boolean
  /** --cpu-phase-s: each phase gets exactly this long and the run is extended to fit; null = not given. */
  fixedPhaseS: number | null
}

/**
 * The normal-rate and attached-rate phases (§11: 4 Hz and 15 Hz). An explicit phase length wins (the
 * caller extends the run); without a deadline each phase gets `defaultPhaseS`; otherwise the time left
 * after the checks is split in two, or given to the normal-rate phase alone when it holds fewer than two
 * phases of `minPhaseS`, or to none.
 */
export function planCpuPhases(
  remainingS: number,
  rates: { normal: number; attached: number },
  limits: { minPhaseS: number; defaultPhaseS: number },
  mode: CpuPhaseMode,
): CpuPhasePlan[] {
  const both = (seconds: number): CpuPhasePlan[] => [
    { hz: rates.normal, seconds },
    { hz: rates.attached, seconds },
  ]
  if (mode.fixedPhaseS !== null) return both(mode.fixedPhaseS)
  if (mode.untilQuit) return both(limits.defaultPhaseS)
  if (!(remainingS >= limits.minPhaseS)) return []
  if (remainingS < 2 * limits.minPhaseS) return [{ hz: rates.normal, seconds: Math.floor(remainingS) }]
  return both(Math.floor(remainingS / 2))
}

/** Mean CPU % over a phase from two cumulative CPU-time readings. */
export function cpuPercentFromTimes(startS: number, endS: number, wallS: number): number | null {
  if (!(wallS > 0) || !(endS >= startS)) return null
  return ((endS - startS) / wallS) * 100
}

// ───────────────────────────── helper CPU from quantized readings ─────────────────────────────

/**
 * One `ps -o time=` reading of a process's cumulative CPU time. `ps` read it at some instant between
 * startS and endS (wall clock, s); cpuS is what it printed, a whole number of quanta.
 */
export interface CpuTimeReading {
  startS: number
  endS: number
  cpuS: number
}

/** Mean CPU use with bounds that hold for any true CPU time consistent with the quantized readings. */
export interface CpuEstimate {
  /**
   * 'edges': between the first and the last reading at which the printed value stepped up, i.e. between
   * two instants where the true CPU time sat exactly on a quantum boundary (no quantization error left;
   * only the timing of those two steps is uncertain, by about one sampling interval each).
   * 'delta': first to last reading, ± one quantum.
   */
  method: 'edges' | 'delta'
  /** % of one core. */
  pct: number
  lowPct: number
  /** Infinity when the readings cannot bound it from above. */
  highPct: number
  /** Wall time the estimate covers, s. */
  spanS: number
  /** CPU time used over that span, s. */
  cpuS: number
}

const midpoint = (reading: CpuTimeReading): number => (reading.startS + reading.endS) / 2

/** First-to-last reading: the CPU time is known to ± one quantum, the span to the readings' durations. */
export function deltaCpuEstimate(readings: readonly CpuTimeReading[], quantumS: number): CpuEstimate | null {
  const first = readings[0]
  const last = readings[readings.length - 1]
  if (!first || !last || readings.length < 2) return null
  const cpu = last.cpuS - first.cpuS
  if (cpu < -quantumS / 2) return null // went backwards: not the same process
  const used = Math.max(0, cpu)
  const span = midpoint(last) - midpoint(first)
  const spanMin = last.startS - first.endS
  const spanMax = last.endS - first.startS
  if (!(span > 0) || !(spanMax > 0)) return null
  return {
    method: 'delta',
    pct: (used / span) * 100,
    lowPct: (Math.max(0, used - quantumS) / spanMax) * 100,
    highPct: spanMin > 0 ? ((used + quantumS) / spanMin) * 100 : Number.POSITIVE_INFINITY,
    spanS: span,
    cpuS: used,
  }
}

/**
 * Edge-aligned estimate. Where the printed value steps up between readings j−1 and j, the true CPU time
 * crossed that quantum boundary at an instant in (start(j−1), end(j)]. Between the first and the last
 * such crossing the CPU used is exactly the difference of the printed values; only the two crossing
 * instants are uncertain. Needs at least two steps (a phase of a few quanta of CPU).
 */
export function edgeCpuEstimate(readings: readonly CpuTimeReading[], quantumS: number): CpuEstimate | null {
  const crossings: { lo: number; hi: number; cpuS: number }[] = []
  for (let j = 1; j < readings.length; j++) {
    const previous = readings[j - 1]
    const current = readings[j]
    if (previous && current && current.cpuS - previous.cpuS > quantumS / 2) {
      crossings.push({ lo: previous.startS, hi: current.endS, cpuS: current.cpuS })
    }
  }
  const a = crossings[0]
  const b = crossings[crossings.length - 1]
  if (!a || !b || crossings.length < 2) return null
  const cpu = b.cpuS - a.cpuS
  const span = (b.lo + b.hi) / 2 - (a.lo + a.hi) / 2
  const spanMin = b.lo - a.hi
  const spanMax = b.hi - a.lo
  if (!(span > 0) || !(cpu > 0)) return null
  return {
    method: 'edges',
    pct: (cpu / span) * 100,
    lowPct: (cpu / spanMax) * 100,
    highPct: spanMin > 0 ? (cpu / spanMin) * 100 : Number.POSITIVE_INFINITY,
    spanS: span,
    cpuS: cpu,
  }
}

/** Half the width of the estimate's bounds, in percentage points (Infinity when unbounded). */
export function cpuHalfWidthPct(estimate: CpuEstimate): number {
  return (estimate.highPct - estimate.lowPct) / 2
}

/** The tighter of the edge-aligned and the first-to-last estimates. */
export function bestCpuEstimate(readings: readonly CpuTimeReading[], quantumS: number): CpuEstimate | null {
  const candidates = [edgeCpuEstimate(readings, quantumS), deltaCpuEstimate(readings, quantumS)].filter(
    (estimate): estimate is CpuEstimate => estimate !== null,
  )
  candidates.sort((x, y) => cpuHalfWidthPct(x) - cpuHalfWidthPct(y))
  return candidates[0] ?? null
}

/** An estimate is resolved when its bounds are within ± maxHalfWidthPct percentage points. */
export function isResolved(estimate: CpuEstimate | null, maxHalfWidthPct: number): boolean {
  return estimate !== null && cpuHalfWidthPct(estimate) <= maxHalfWidthPct
}

/** '0.241% (0.229–0.254%, edges over 24.1 s)' or 'n/a (below resolution: …)'. */
export function formatCpuEstimate(estimate: CpuEstimate | null, maxHalfWidthPct: number): string {
  if (!estimate) return 'n/a (no usable readings)'
  const range = `${estimate.lowPct.toFixed(3)}–${Number.isFinite(estimate.highPct) ? estimate.highPct.toFixed(3) : '∞'}%`
  if (!isResolved(estimate, maxHalfWidthPct)) {
    return `n/a (below resolution: ${estimate.pct.toFixed(2)}% but anywhere in ${range} after ${estimate.spanS.toFixed(1)} s; longer phase needed)`
  }
  return `${estimate.pct.toFixed(3)}% (${range}, ${estimate.method} over ${estimate.spanS.toFixed(1)} s)`
}

export type BudgetVerdict = 'within' | 'over' | 'inconclusive' | 'unresolved'

/** Compares the bounds (not the point estimate) with a CPU budget in %. */
export function budgetVerdict(estimate: CpuEstimate | null, budgetPct: number, maxHalfWidthPct: number): BudgetVerdict {
  if (estimate === null || !isResolved(estimate, maxHalfWidthPct)) return 'unresolved'
  if (estimate.highPct < budgetPct) return 'within'
  if (estimate.lowPct > budgetPct) return 'over'
  return 'inconclusive'
}

export interface CpuPhaseFigures {
  hz: number
  estimate: CpuEstimate | null
  pushes: number
  wallS: number
  note: string | null
}

/** One phase of the helper-CPU line: the estimate with its bounds and how it compares with the budget. */
export function formatCpuPhase(phase: CpuPhaseFigures, maxHalfWidthPct: number, budgetPct: number): string {
  const verdict = budgetVerdict(phase.estimate, budgetPct, maxHalfWidthPct)
  const versus =
    verdict === 'within'
      ? ` → within the ${budgetPct}% budget`
      : verdict === 'over'
        ? ` → OVER the ${budgetPct}% budget`
        : verdict === 'inconclusive'
          ? ` → bounds straddle the ${budgetPct}% budget`
          : ''
  return (
    `${phase.hz} Hz: ${formatCpuEstimate(phase.estimate, maxHalfWidthPct)}${versus}; ` +
    `${phase.pushes} pushes in ${phase.wallS.toFixed(1)} s${phase.note ? ` [${phase.note}]` : ''}`
  )
}
