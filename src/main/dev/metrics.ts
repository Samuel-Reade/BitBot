// CPU and measurement conditions for the dev check (src/main/dev/overlayCheck.ts). The aggregation and the parsers are
// pure and unit-tested (test/overlayCheck.test.ts); the readers run macOS tools that need no permission and never
// prompt. Ported from Spike A (src/main/spike/overlay/appMetrics.ts, metricsAggregate.ts, spikes/analysis/lib/
// system.mjs; spike code is never imported), so the numbers compare with docs/decisions/overlay.md:
// - Electron's processes: CPU as % of ONE core (Activity Monitor style; 100 = one core busy) from
//   cpu.cumulativeCPUUsage deltas. Electron 44's percentCPUUsage is divided by the core count (a process using 14.6 % of
//   one core reports 1.46), so it is only the fallback, multiplied back.
// - bitbot-helper is not an Electron process: its CPU comes from `ps -o time=` deltas (10 ms resolution).

import { execFile } from 'node:child_process'
import type { ProcessMetric } from 'electron'

/** The parts of app.getAppMetrics()'s entries the check reads. */
export type MetricLike = Pick<ProcessMetric, 'pid' | 'type' | 'cpu'>

export interface ProcCpu {
  pid: number
  /** 'Browser' (main), 'Tab' (renderer), 'GPU', 'Utility' (network service)… */
  type: string
  /** cumulativeCPUUsage: CPU seconds since the process started; null if Electron didn't report it. */
  cumS: number | null
  /** percentCPUUsage × cores: % of one core since the previous getAppMetrics() call (the fallback). */
  pctOneCore: number
  /** idleWakeupsPerSecond since the previous getAppMetrics() call (energy impact). */
  wakeupsPerS: number
}

export interface CpuSample {
  /** When it was read (the check's clock), ms. */
  tMs: number
  procs: ProcCpu[]
}

/** One app.getAppMetrics() reading. `cores`: os.cpus().length. */
export function cpuSample(tMs: number, metrics: readonly MetricLike[], cores: number): CpuSample {
  return {
    tMs,
    procs: metrics.map((m) => ({
      pid: m.pid,
      type: m.type,
      cumS: finiteOrNull(m.cpu.cumulativeCPUUsage),
      pctOneCore: m.cpu.percentCPUUsage * Math.max(1, cores),
      wakeupsPerS: m.cpu.idleWakeupsPerSecond,
    })),
  }
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export interface CpuWindow {
  /** From the first sample to the last, s. */
  seconds: number
  /** % of one core per process type: cumulative CPU from the first sample to the last (processes present in both). */
  byType: Record<string, number>
  /** Sum over the types. */
  total: number
  /** Idle wakeups per second per type: time-weighted mean of the samples after the first. */
  wakeupsByType: Record<string, number>
  /** Processes counted from percentCPUUsage because a cumulative reading was missing. */
  fallbacks: number
}

/**
 * CPU over a phase from its samples (the first taken at its start, the last at its end): each process's cumulative CPU
 * between its first and last reading in the window (for one that lived through the whole phase, from start to end).
 * One without two cumulative readings counts through its percentCPUUsage samples.
 */
export function cpuWindow(samples: readonly CpuSample[]): CpuWindow {
  const first = samples[0]
  const last = samples[samples.length - 1]
  const empty: CpuWindow = { seconds: 0, byType: {}, total: 0, wakeupsByType: {}, fallbacks: 0 }
  if (!first || !last || last.tMs <= first.tMs) return empty
  const seconds = (last.tMs - first.tMs) / 1000
  const byType: Record<string, number> = {}
  const add = (type: string, pct: number): void => {
    byType[type] = (byType[type] ?? 0) + pct
  }
  let fallbacks = 0
  const pids = new Set<number>()
  for (const s of samples) for (const p of s.procs) pids.add(p.pid)
  for (const pid of pids) {
    const readings = samples.flatMap((s) => s.procs.filter((p) => p.pid === pid && p.cumS !== null))
    const a = readings[0]
    const b = readings[readings.length - 1]
    if (a && b && a !== b && a.cumS !== null && b.cumS !== null) {
      add(b.type, (Math.max(0, b.cumS - a.cumS) / seconds) * 100)
      continue
    }
    // Fallback: each later sample's percentCPUUsage covers the interval before it.
    let weighted = 0
    let type: string | null = null
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1]
      const cur = samples[i]
      const p = cur?.procs.find((q) => q.pid === pid)
      if (!prev || !cur || !p) continue
      type = p.type
      weighted += p.pctOneCore * (cur.tMs - prev.tMs)
    }
    if (type !== null) {
      fallbacks++
      add(type, weighted / (last.tMs - first.tMs))
    }
  }
  const wakeupsByType: Record<string, number> = {}
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const cur = samples[i]
    if (!prev || !cur) continue
    const share = (cur.tMs - prev.tMs) / (last.tMs - first.tMs)
    for (const p of cur.procs) wakeupsByType[p.type] = (wakeupsByType[p.type] ?? 0) + p.wakeupsPerS * share
  }
  const total = Object.values(byType).reduce((a, b) => a + b, 0)
  return { seconds, byType, total, wakeupsByType, fallbacks }
}

/** % of one core from two cumulative CPU-time readings (s) `seconds` apart; null if either is missing. */
export function cpuPercent(beforeS: number | null, afterS: number | null, seconds: number): number | null {
  if (beforeS === null || afterS === null || !(seconds > 0)) return null
  return (Math.max(0, afterS - beforeS) / seconds) * 100
}

/**
 * Cumulative CPU time from `ps -o time= -p PID`, in seconds. macOS prints "MMM:SS.cc" (minutes unbounded); also
 * accepts "[[DD-]HH:]MM:SS[.cc]". Null if it can't be read.
 */
export function parsePsCpuTime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(text).trim())
  if (!m) return null
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  return ((days * 24 + hours) * 60 + Number(m[3])) * 60 + Number(m[4])
}

/** The process's cumulative CPU time (s) from ps; null if it can't be read (it exited, ps failed). Never rejects. */
export function psCpuSeconds(pid: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'time=', '-p', String(pid)], { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : parsePsCpuTime(String(stdout)))
    })
  })
}

/** What the measurements ran on: the power source matters (CPU time depends on P- vs E-core scheduling). */
export interface PowerInfo {
  source: 'AC' | 'battery' | null
  /** Battery charge, %; null without a battery reading. */
  batteryPct: number | null
  lowPowerMode: boolean | null
}

/** `pmset -g batt` ("Now drawing from 'Battery Power'" … "12%;") and `pmset -g` ("lowpowermode 0"). */
export function parsePmset(batt: string, settings: string): PowerInfo {
  const from = /drawing from '([^']+)'/.exec(batt)?.[1] ?? null
  const source = from === null ? null : /AC/i.test(from) ? 'AC' : /battery/i.test(from) ? 'battery' : null
  const pct = /(\d+)%;/.exec(batt)?.[1]
  const lpm = /^\s*lowpowermode\s+(\d+)/m.exec(settings)?.[1]
  return {
    source,
    batteryPct: pct === undefined ? null : Number(pct),
    lowPowerMode: lpm === undefined ? null : lpm !== '0',
  }
}

/** Runs `pmset -g batt` and `pmset -g` (read-only queries). Never rejects. */
export async function readPowerInfo(timeoutMs: number): Promise<PowerInfo> {
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile('/usr/bin/pmset', args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? '' : String(stdout)))
    })
  const [batt, settings] = await Promise.all([run(['-g', 'batt']), run(['-g'])])
  return parsePmset(batt, settings)
}
