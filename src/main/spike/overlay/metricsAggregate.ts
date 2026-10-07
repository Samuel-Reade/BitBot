// Aggregation of app.getAppMetrics() samples (pure; unit-tested). CPU percentages are percent of
// ONE core (Activity Monitor style: 100 = one core fully busy), per process type.

import { percentileSorted, round } from './stats'

export interface ProcSample {
  pid: number
  /** 'Browser' (main), 'Tab' (renderer), 'GPU', 'Utility', … */
  type: string
  name: string | null
  /** CPU since the previous sample, percent of one core. */
  cpu: number
  /** Electron's raw percentCPUUsage (normalized by the core count). */
  cpuNormalized: number
  /** cumulativeCPUUsage: CPU seconds since the process started (null if unavailable). */
  cum: number | null
  /** idleWakeupsPerSecond: CPU wakeups from idle per second (energy impact; lower is better). */
  wakeups: number
  /** workingSetSize = resident set size (RSS), KB. Not Activity Monitor's "Memory" (see footprint.ts). */
  memKB: number
}

export interface MetricsSample {
  /** Sample time on the harness clock (performance.now(), ms). */
  tMs: number
  procs: ProcSample[]
}

export interface CpuMemStats {
  /** Most processes of this type seen in one sample. */
  processes: number
  cpuMean: number
  cpuP95: number
  cpuMax: number
  /** Mean from cumulative CPU time over the window (more exact than averaging samples). */
  cpuMeanCumulative: number | null
  wakeupsMean: number
  memMeanMB: number
  memMaxMB: number
}

export interface MetricsAggregate {
  /** Samples whose interval lies inside the window. */
  samples: number
  windowS: number
  byType: Record<string, CpuMemStats>
  total: CpuMemStats
}

interface Accum {
  cpu: number[]
  wakeups: number[]
  memMB: number[]
  processes: number
}

function stats(acc: Accum, cumulative: number | null): CpuMemStats {
  const cpuSorted = Float64Array.from(acc.cpu).sort()
  const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  return {
    processes: acc.processes,
    cpuMean: round(mean(acc.cpu), 2),
    cpuP95: round(cpuSorted.length ? percentileSorted(cpuSorted, 95) : 0, 2),
    cpuMax: round(cpuSorted.length ? (cpuSorted[cpuSorted.length - 1] ?? 0) : 0, 2),
    cpuMeanCumulative: cumulative === null ? null : round(cumulative, 2),
    wakeupsMean: round(mean(acc.wakeups), 1),
    memMeanMB: round(mean(acc.memMB), 1),
    memMaxMB: round(acc.memMB.length ? Math.max(...acc.memMB) : 0, 1),
  }
}

/**
 * Aggregates samples taken every `intervalMs` over [fromMs, toMs]. A sample's CPU% describes the
 * interval before it, so only samples taken at least half an interval after `fromMs` count.
 */
export function aggregateMetrics(samples: readonly MetricsSample[], fromMs: number, toMs: number, intervalMs: number): MetricsAggregate {
  const inWindow = samples.filter((s) => s.tMs >= fromMs + intervalMs / 2 && s.tMs <= toMs + 1)
  const types = new Set<string>()
  for (const s of inWindow) for (const p of s.procs) types.add(p.type)

  const perType = new Map<string, Accum>()
  const total: Accum = { cpu: [], wakeups: [], memMB: [], processes: 0 }
  for (const type of types) perType.set(type, { cpu: [], wakeups: [], memMB: [], processes: 0 })
  for (const s of inWindow) {
    let tc = 0
    let tw = 0
    let tm = 0
    for (const type of types) {
      const procs = s.procs.filter((p) => p.type === type)
      const acc = perType.get(type)
      if (!acc) continue
      const cpu = procs.reduce((a, p) => a + p.cpu, 0)
      const wake = procs.reduce((a, p) => a + p.wakeups, 0)
      const mem = procs.reduce((a, p) => a + p.memKB, 0) / 1024
      acc.cpu.push(cpu)
      acc.wakeups.push(wake)
      acc.memMB.push(mem)
      acc.processes = Math.max(acc.processes, procs.length)
      tc += cpu
      tw += wake
      tm += mem
    }
    total.cpu.push(tc)
    total.wakeups.push(tw)
    total.memMB.push(tm)
    total.processes = Math.max(total.processes, s.procs.length)
  }

  // Cumulative CPU: from the last sample at/before the window start to the last one inside it.
  const base = [...samples].reverse().find((s) => s.tMs <= fromMs + intervalMs / 2) ?? inWindow[0]
  const end = inWindow[inWindow.length - 1]
  const cumByType = new Map<string, number>()
  let cumTotal: number | null = null
  if (base && end && end.tMs > base.tMs) {
    const dtS = (end.tMs - base.tMs) / 1000
    cumTotal = 0
    for (const p of end.procs) {
      const b = base.procs.find((q) => q.pid === p.pid)
      if (!b || b.cum === null || p.cum === null) continue
      const pct = ((p.cum - b.cum) / dtS) * 100
      cumByType.set(p.type, (cumByType.get(p.type) ?? 0) + pct)
      cumTotal += pct
    }
  }

  const byType: Record<string, CpuMemStats> = {}
  for (const [type, acc] of perType) byType[type] = stats(acc, cumByType.get(type) ?? (cumTotal === null ? null : 0))
  const first = inWindow[0]
  return {
    samples: inWindow.length,
    windowS: first && end ? round((end.tMs - (first.tMs - intervalMs)) / 1000, 2) : 0,
    byType,
    total: stats(total, cumTotal),
  }
}
