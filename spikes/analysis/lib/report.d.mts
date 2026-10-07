// Types for report.mjs (lets the TypeScript tests import the analysis code). Loose on purpose: the
// rows mirror the harness results JSON, which src/main/spike/overlay/results.ts types precisely.
import type { MotionResult } from './judder.mjs'

export const RESULTS_SCHEMA: string

export interface LoadedRun {
  base: string
  results?: Record<string, any>
  error?: string
  bench?: Record<string, any> | null
  gpu?: Record<string, any>[] | null
  ws?: Record<string, any>[] | null
  probe?: Record<string, any>[] | null
  probeSummary?: Record<string, any> | null
}

export interface CpuCell {
  mean: number | null
  p95: number | null
}

export interface SummaryRow {
  base: string
  variant?: string
  mode?: string
  ok: boolean
  errors: string[]
  warnings?: string[]
  notes?: string[]
  windowType?: string
  a1Timer?: string | null
  measuredS?: number
  cpu?: Record<string, CpuCell | null>
  memMB?: number | null
  memByType?: Record<string, { processes: number; mb: number; peakMB: number | null }> | null
  rssMB?: number | null
  wakeups?: number | null
  gpu?: { samples: number; deviceMean: number | null; deviceP95: number | null; rendererMean: number | null; baselineDeviceMean: number | null } | null
  windowServer?: { meanPct: number | null; p95Pct: number | null; baselinePct: number | null; baselineSpanS: number | null } | null
  probe?: { status: string | null; cpuPctWhileRunning: number | null; staticWindowChanges: number | null }
  conditions?: {
    power: string | null
    lowPowerMode: boolean | null
    thermalState: string | null
    loadAvg1m: number | null
    systemBusyCores: number | null
    baselineBusyCores: number | null
    otherLoadCores: number | null
  }
  renderer?: Record<string, any> | null
  presentation?: Record<string, any> | null
  motion?: MotionResult | null
  motionNote?: string | null
  interaction?: Record<string, any>
  env?: Record<string, any>
}

export function loadRuns(dir: string): LoadedRun[]
export function summarizeRun(run: LoadedRun): SummaryRow
export function rowName(row: SummaryRow): string
export function renderMarkdown(rows: SummaryRow[], meta: { generatedAt: string; dir: string }): string
