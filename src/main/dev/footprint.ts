// Memory for the dev check (src/main/dev/overlayCheck.ts): each process's physical footprint, what Activity Monitor's
// "Memory" column shows and the unit of §11's memory budget. Ported from Spike A (src/main/spike/overlay/footprint.ts;
// spike code is never imported). The parser and the aggregation are pure and unit-tested (test/overlayCheck.test.ts).
//
// app.getAppMetrics() only offers workingSetSize, the resident set size (RSS). RSS counts shared framework pages once
// per process and leaves out GPU/IOSurface memory, so summed over Bitbot's processes it overstates the Activity Monitor
// total (Spike A: 343 MB RSS vs 191 MB footprint). macOS's `footprint` prints the kernel's per-process ledger value
// (`phys_footprint`); it reads the current user's processes without a permission and never prompts. It walks every
// region of each process, so the check runs it once, after the measured phases. Only numbers are kept from its output
// (it also lists mapped file paths of our own processes).

import { execFile } from 'node:child_process'
import { round } from './stats'

export const FOOTPRINT_BIN = '/usr/bin/footprint'

export interface ProcessFootprint {
  /** Kernel ledger phys_footprint, bytes; falls back to the header's footprint total. */
  physBytes: number | null
  /** Lifetime peak of phys_footprint, bytes. */
  peakBytes: number | null
}

export interface FootprintOutput {
  byPid: Map<number, ProcessFootprint>
  /** footprint's de-duplicated total over all given processes (memory they share counted once), bytes. */
  summaryBytes: number | null
}

/** Parses `footprint -f bytes -p PID [-p PID …]` text output. */
export function parseFootprintOutput(text: string): FootprintOutput {
  const byPid = new Map<number, ProcessFootprint>()
  let summaryBytes: number | null = null
  let current: ProcessFootprint | null = null
  for (const line of text.split('\n')) {
    // "Electron Helper (GPU) [1234]: 64-bit    Footprint: 108789760 B (16384 bytes per page)"
    const header = /\[(\d+)\]: \d+-bit\s+Footprint: (\d+) B/.exec(line)
    if (header) {
      current = { physBytes: Number(header[2]), peakBytes: null }
      byPid.set(Number(header[1]), current)
      continue
    }
    const summary = /^\s*Summary Footprint: (\d+) B/.exec(line)
    if (summary) {
      summaryBytes = Number(summary[1])
      current = null
      continue
    }
    if (!current) continue
    const peak = /^\s*phys_footprint_peak: (\d+) B/.exec(line)
    if (peak) {
      current.peakBytes = Number(peak[1])
      continue
    }
    const phys = /^\s*phys_footprint: (\d+) B/.exec(line)
    if (phys) current.physBytes = Number(phys[1])
  }
  return { byPid, summaryBytes }
}

export interface FootprintRun {
  output: FootprintOutput | null
  error: string | null
}

/** Runs `footprint` for the given processes. Never rejects. */
export function runFootprint(pids: readonly number[], timeoutMs: number): Promise<FootprintRun> {
  const args = ['-f', 'bytes']
  for (const pid of pids) args.push('-p', String(pid))
  return new Promise((resolve) => {
    execFile(FOOTPRINT_BIN, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = parseFootprintOutput(String(stdout))
      if (output.byPid.size > 0) resolve({ output, error: null })
      else resolve({ output: null, error: err ? err.message : `no data (${String(stderr).trim().slice(0, 200)})` })
    })
  })
}

export interface FootprintAggregate {
  /** Sum of the processes' phys_footprint, MB. */
  totalMB: number
  /** Sum of their lifetime peaks, MB (null if footprint printed no peak for one of them). */
  peakTotalMB: number | null
  /** footprint's de-duplicated total (memory shared between the processes counted once), MB. */
  dedupTotalMB: number | null
  byType: Record<string, { processes: number; mb: number; peakMB: number | null }>
  /** Processes footprint did not report (exited, or not readable). */
  missingPids: number[]
}

/** Per-process-type totals of a footprint run, over `procs` only (the run may cover more processes). */
export function aggregateFootprint(procs: readonly { pid: number; type: string }[], output: FootprintOutput): FootprintAggregate {
  const mb = (bytes: number): number => round(bytes / 1048576, 1)
  const types = new Map<string, { processes: number; bytes: number; peak: number | null }>()
  const missingPids: number[] = []
  let total = 0
  let peak: number | null = 0
  for (const proc of procs) {
    const values = output.byPid.get(proc.pid)
    if (!values || values.physBytes === null) {
      missingPids.push(proc.pid)
      continue
    }
    const acc = types.get(proc.type) ?? { processes: 0, bytes: 0, peak: 0 }
    acc.processes++
    acc.bytes += values.physBytes
    acc.peak = acc.peak === null || values.peakBytes === null ? null : acc.peak + values.peakBytes
    types.set(proc.type, acc)
    total += values.physBytes
    peak = peak === null || values.peakBytes === null ? null : peak + values.peakBytes
  }
  const byType: FootprintAggregate['byType'] = {}
  for (const [type, acc] of types) {
    byType[type] = { processes: acc.processes, mb: mb(acc.bytes), peakMB: acc.peak === null ? null : mb(acc.peak) }
  }
  return {
    totalMB: mb(total),
    peakTotalMB: peak === null ? null : mb(peak),
    dedupTotalMB: output.summaryBytes === null ? null : mb(output.summaryBytes),
    byType,
    missingPids,
  }
}
