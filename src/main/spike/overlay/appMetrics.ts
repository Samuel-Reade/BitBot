import { cpus } from 'node:os'
import { app } from 'electron'
import type { MetricsSample, ProcSample } from './metricsAggregate'

// Samples app.getAppMetrics() (CPU per process type, idle wakeups, working set) at a fixed period.
//
// SPEC-DEVIATION: the task asks for percentCPUUsage per process type. Measured on Electron 44 /
// macOS 15 (M4, 10 cores), percentCPUUsage is normalized by the core count (a process using 14.6 % of
// one core reports 1.46), while cumulativeCPUUsage is plain CPU seconds. So CPU is reported as percent
// of ONE core (Activity Monitor style, the unit of the §11 budget) from cumulative-CPU deltas between
// samples, falling back to percentCPUUsage × cores; the raw value is kept per sample (cpuNormalized).
//
// Memory here is workingSetSize = resident set size (RSS), the only memory figure app.getAppMetrics()
// has on macOS. It is not Activity Monitor's "Memory"; see footprint.ts for that (§11 budget unit).
export class AppMetricsSampler {
  readonly samples: MetricsSample[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly cores = Math.max(1, cpus().length)

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
  ) {}

  start(): void {
    this.sample()
    this.timer = setInterval(() => this.sample(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  sample(): void {
    const tMs = this.now()
    const prev = this.samples[this.samples.length - 1]
    const dtS = prev ? (tMs - prev.tMs) / 1000 : 0
    const procs = app.getAppMetrics().map((m): ProcSample => {
      const cum = m.cpu.cumulativeCPUUsage ?? null
      const before = prev?.procs.find((p) => p.pid === m.pid)
      let cpu = m.cpu.percentCPUUsage * this.cores
      if (before && cum !== null && before.cum !== null && dtS > 0) cpu = ((cum - before.cum) / dtS) * 100
      return {
        pid: m.pid,
        type: m.type,
        name: m.name ?? m.serviceName ?? null,
        cpu,
        cpuNormalized: m.cpu.percentCPUUsage,
        cum,
        wakeups: m.cpu.idleWakeupsPerSecond,
        memKB: m.memory.workingSetSize,
      }
    })
    this.samples.push({ tMs, procs })
  }
}
