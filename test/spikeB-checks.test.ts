import { describe, expect, it } from 'vitest'
import type { DisplayInfo, HelperWindow } from '../src/main/helper/protocol'
import {
  CG_LEVEL,
  classifyLevels,
  compareDisplays,
  compareRects,
  firstLayerOrderViolation,
  formatZOrderEntry,
  fullscreenVerdict,
  levelVerdict,
  parseMediaSourceId,
  probePositions,
  type FullscreenObservation,
  type PresenceChange,
} from '../src/main/spike/windows/checks'
import { bundleIdFromInfoPlist, bundlePathOf, localStamp } from '../src/main/spike/windows/format'
import {
  PS_CPU_TIME_QUANTUM_S,
  bestCpuEstimate,
  budgetVerdict,
  cpuHalfWidthPct,
  cpuPercentFromTimes,
  deltaCpuEstimate,
  edgeCpuEstimate,
  formatCpuEstimate,
  formatCpuPhase,
  formatLatency,
  parseCpuTime,
  parsePsLine,
  percentileSorted,
  planCpuPhases,
  summarize,
  type CpuTimeReading,
  type LatencyBurst,
} from '../src/main/spike/windows/measure'
import { parseWindowsOptions } from '../src/main/spike/windows/options'
import { tuning } from '../src/shared/tuning'

const OWN_PID = 4242
const DISPLAY = { x: 0, y: 0, width: 1710, height: 1107 }
const WORK_AREA = { x: 0, y: 39, width: 1710, height: 983 }

function win(overrides: Partial<HelperWindow> = {}): HelperWindow {
  return { wid: 1, pid: 900, bundleId: 'com.example.app', layer: 0, x: 0, y: 0, w: 400, h: 300, onScreen: true, alpha: 1, ...overrides }
}

// The front-to-back list seen on the M4 with the overlay up (status items, menu bar, Dock, ours, apps).
const DESKTOP: HelperWindow[] = [
  win({ wid: 20, pid: 689, bundleId: 'com.apple.controlcenter', layer: 25, x: 1393, y: 0, w: 42, h: 38 }),
  win({ wid: 5750, pid: 382, bundleId: null, layer: 24, x: 0, y: 0, w: 1710, h: 38 }),
  win({ wid: 11, pid: 688, bundleId: 'com.apple.dock', layer: 20, x: 0, y: 0, w: 1710, h: 1107 }),
  win({ wid: 6600, pid: OWN_PID, bundleId: 'com.github.Electron', layer: 3, x: 0, y: 0, w: 1710, h: 1107 }),
  win({ wid: 6601, pid: OWN_PID, bundleId: 'com.github.Electron', layer: 0, x: 755, y: 471, w: 200, h: 120 }),
  win({ wid: 5729, pid: 682, bundleId: 'com.microsoft.VSCode', layer: 0, x: 323, y: 280, w: 1024, h: 698 }),
]

describe('parseMediaSourceId', () => {
  it("reads the CGWindowID from 'window:<id>:0'", () => {
    expect(parseMediaSourceId('window:6600:0')).toBe(6600)
    expect(parseMediaSourceId('window:12:1')).toBe(12)
  })
  it('rejects anything else', () => {
    expect(parseMediaSourceId('screen:1:0')).toBeNull()
    expect(parseMediaSourceId('window::0')).toBeNull()
    expect(parseMediaSourceId('window:0:0')).toBeNull()
    expect(parseMediaSourceId('')).toBeNull()
  })
})

describe('compareRects', () => {
  it('reports helper − electron per component', () => {
    expect(compareRects({ x: 10, y: 39, w: 200, h: 120 }, { x: 10, y: 39, w: 200, h: 120 }, 0.5)).toEqual({
      dx: 0,
      dy: 0,
      dw: 0,
      dh: 0,
      max: 0,
      pass: true,
    })
    const off = compareRects({ x: 11, y: 37, w: 200, h: 121 }, { x: 10, y: 39, w: 200, h: 120 }, 0.5)
    expect(off).toMatchObject({ dx: 1, dy: -2, dw: 0, dh: 1, max: 2, pass: false })
  })
  it('passes within the tolerance only', () => {
    expect(compareRects({ x: 0.4, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 }, 0.5).pass).toBe(true)
    expect(compareRects({ x: 0.6, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 }, 0.5).pass).toBe(false)
  })
})

describe('probePositions', () => {
  const positions = probePositions(DISPLAY, WORK_AREA, { w: 200, h: 120 }, 0.5)
  it('covers the work-area corners and centre', () => {
    expect(positions.slice(0, 5)).toEqual([
      { name: 'work-area top-left', x: 0, y: 39 },
      { name: 'work-area top-right', x: 1510, y: 39 },
      { name: 'work-area bottom-left', x: 0, y: 902 },
      { name: 'work-area bottom-right', x: 1510, y: 902 },
      { name: 'work-area centre', x: 755, y: 471 },
    ])
  })
  it('hangs half the probe past the right and bottom display edges', () => {
    expect(positions[5]).toEqual({ name: 'off right edge', x: 1610, y: 471 })
    expect(positions[6]).toEqual({ name: 'off bottom edge', x: 755, y: 1047 })
  })
})

describe('compareDisplays', () => {
  const helper: DisplayInfo[] = [{ id: 1, x: 0, y: 0, w: 1710, h: 1107, main: true }]
  const electron = [{ id: 1, bounds: DISPLAY, workArea: WORK_AREA, scaleFactor: 2 }]

  it('passes when ids, bounds and the main/primary flag agree', () => {
    const result = compareDisplays(helper, electron, 1, 0.5)
    expect(result.pass).toBe(true)
    expect(result.rows[0]).toMatchObject({ electronId: 1, helperId: 1, matchedBy: 'id', pass: true })
  })

  it('falls back to matching by bounds and says the ids differ', () => {
    const result = compareDisplays([{ ...helper[0]!, id: 69733248 }], electron, 1, 0.5)
    expect(result.pass).toBe(true)
    expect(result.rows[0]?.matchedBy).toBe('bounds')
    expect(result.detail).toContain('[ids differ]')
  })

  it('fails on different bounds, a primary mismatch, or an extra helper display', () => {
    expect(compareDisplays([{ ...helper[0]!, h: 1117 }], electron, 1, 0.5).pass).toBe(false)
    expect(compareDisplays([{ ...helper[0]!, main: false }], electron, 1, 0.5).pass).toBe(false)
    const extra = compareDisplays([...helper, { id: 2, x: 1710, y: 0, w: 1920, h: 1080, main: false }], electron, 1, 0.5)
    expect(extra.pass).toBe(false)
    expect(extra.unmatchedHelperIds).toEqual([2])
    expect(compareDisplays([], [], 1, 0.5).pass).toBe(false)
  })

  it('pairs a second display left of the main one (negative x)', () => {
    const two = compareDisplays(
      [
        { id: 1, x: 0, y: 0, w: 1710, h: 1107, main: true },
        { id: 3, x: -1920, y: -200, w: 1920, h: 1080, main: false },
      ],
      [
        ...electron,
        { id: 3, bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, workArea: { x: -1920, y: -175, width: 1920, height: 1055 }, scaleFactor: 1 },
      ],
      1,
      0.5,
    )
    expect(two.pass).toBe(true)
  })
})

describe('levels', () => {
  const context = { ownPid: OWN_PID, overlayWid: 6600, probeWid: 6601, display: DISPLAY }

  it('finds our layers, the Dock, the menu bar strip and normal windows', () => {
    const report = classifyLevels(DESKTOP, context)
    expect(report.overlay).toEqual({ wid: 6600, layer: 3 })
    expect(report.probe).toEqual({ wid: 6601, layer: 0 })
    expect(report.dockLayers).toEqual([20])
    expect(report.dock).toEqual({ layer: 20, from: 'snapshot' })
    expect(report.menuBar).toEqual({ layer: 24, from: 'snapshot', wid: 5750 })
    expect(report.notificationCenterLayers).toEqual([])
    expect(report.normalWindows).toBe(1)
    expect(report.layers.map((g) => [g.layer, g.count])).toEqual([
      [25, 1],
      [24, 1],
      [20, 1],
      [3, 1],
      [0, 2],
    ])
    expect(report.layers.find((g) => g.layer === 0)?.owners).toEqual(['Bitbot', 'com.microsoft.VSCode'])
    expect(levelVerdict(report).status).toBe('PASS')
  })

  it('fails when the overlay is at the normal level or at/above the Dock', () => {
    const normal = DESKTOP.map((w) => (w.wid === 6600 ? { ...w, layer: 0 } : w))
    expect(levelVerdict(classifyLevels(normal, context)).status).toBe('FAIL')
    const popUp = DESKTOP.map((w) => (w.wid === 6600 ? { ...w, layer: 101 } : w))
    expect(levelVerdict(classifyLevels(popUp, context)).status).toBe('FAIL')
    const dockLevel = DESKTOP.map((w) => (w.wid === 6600 ? { ...w, layer: 20 } : w))
    expect(levelVerdict(classifyLevels(dockLevel, context)).status).toBe('FAIL')
  })

  it('falls back to the CG constants when the Dock or menu bar is not on screen', () => {
    const bare = DESKTOP.filter((w) => w.layer !== 20 && w.layer !== 24)
    const report = classifyLevels(bare, context)
    expect(report.dock).toEqual({ layer: CG_LEVEL.dock, from: 'constant' })
    expect(report.menuBar).toEqual({ layer: CG_LEVEL.mainMenu, from: 'constant', wid: null })
    const verdict = levelVerdict(report)
    expect(verdict.status).toBe('PASS')
    expect(verdict.detail).toContain('CG constant')
  })

  it('ignores the Dock wallpaper (negative desktop layer) and compares with the lowest Dock layer', () => {
    const withMissionControl = [
      ...DESKTOP,
      win({ wid: 90, pid: 688, bundleId: 'com.apple.dock', layer: 18, w: 1710, h: 1107 }),
      win({ wid: 91, pid: 688, bundleId: 'com.apple.dock', layer: -2147483624, w: 1710, h: 1107 }),
    ]
    const report = classifyLevels(withMissionControl, context)
    expect(report.dockLayers).toEqual([20, 18])
    expect(report.dock.layer).toBe(18)
  })

  it('skips the verdict without an overlay', () => {
    const report = classifyLevels(DESKTOP, { ...context, overlayWid: null })
    expect(levelVerdict(report).status).toBe('SKIP')
  })
})

describe('z-order', () => {
  it('accepts a list whose layers never increase front to back', () => {
    expect(firstLayerOrderViolation(DESKTOP)).toBe(-1)
    expect(firstLayerOrderViolation([])).toBe(-1)
  })
  it('reports the first window that is above the one in front of it', () => {
    const swapped = [DESKTOP[0]!, DESKTOP[3]!, DESKTOP[2]!]
    expect(firstLayerOrderViolation(swapped)).toBe(2)
  })
  it('formats an entry with ids, owner, layer and bounds only', () => {
    expect(formatZOrderEntry(DESKTOP[5]!, 5, OWN_PID)).toBe('# 5 wid=5729 pid=682 com.microsoft.VSCode layer=0 323,280 1024×698')
    expect(formatZOrderEntry(DESKTOP[3]!, 3, OWN_PID)).toBe('# 3 wid=6600 pid=4242 Bitbot(com.github.Electron) layer=3 0,0 1710×1107')
    expect(formatZOrderEntry({ ...DESKTOP[1]!, onScreen: false, alpha: 0.25 }, 12, OWN_PID)).toBe(
      '#12 wid=5750 pid=382 (no bundle id) layer=24 0,0 1710×38 offscreen alpha=0.25',
    )
  })
})

describe('measure', () => {
  it('computes nearest-rank percentiles', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentileSorted(sorted, 0.5)).toBe(5)
    expect(percentileSorted(sorted, 0.95)).toBe(10)
    expect(percentileSorted([7], 0.95)).toBe(7)
    expect(percentileSorted([], 0.5)).toBeNaN()
  })

  it('summarizes, skipping non-finite values', () => {
    expect(summarize([3, 1, 2, Number.NaN])).toEqual({ n: 3, mean: 2, min: 1, p50: 2, p95: 3, max: 3 })
    expect(summarize([])).toBeNull()
  })

  it("parses macOS ps cumulative CPU times", () => {
    expect(parseCpuTime('0:00.17')).toBeCloseTo(0.17)
    expect(parseCpuTime('4:54.43')).toBeCloseTo(294.43)
    expect(parseCpuTime('293:12.00')).toBeCloseTo(17_592)
    expect(parseCpuTime('1:02:03.45')).toBeCloseTo(3723.45)
    expect(parseCpuTime('2-01:00:00')).toBe(2 * 86_400 + 3600)
    expect(parseCpuTime('abc')).toBeNull()
    expect(parseCpuTime('')).toBeNull()
  })

  it('parses a `ps -o %cpu=,time=` line', () => {
    expect(parsePsLine('  0.1   0:00.17\n')).toEqual({ cpuPct: 0.1, cpuTimeS: 0.17 })
    expect(parsePsLine('0,6 0:00.06')).toEqual({ cpuPct: 0.6, cpuTimeS: 0.06 })
    expect(parsePsLine('')).toBeNull()
    expect(parsePsLine('0.1')).toBeNull()
  })

  it('splits the remaining time into a 4 Hz and a 15 Hz phase', () => {
    const rates = { normal: tuning.world.snapshotHz.normal, attached: tuning.world.snapshotHz.attached }
    const limits = { minPhaseS: 5, defaultPhaseS: 30 }
    const timed = { untilQuit: false, fixedPhaseS: null }
    expect(planCpuPhases(19.4, rates, limits, timed)).toEqual([
      { hz: 4, seconds: 9 },
      { hz: 15, seconds: 9 },
    ])
    expect(planCpuPhases(8, rates, limits, timed)).toEqual([{ hz: 4, seconds: 8 }])
    expect(planCpuPhases(4.9, rates, limits, timed)).toEqual([])
    expect(planCpuPhases(Number.NaN, rates, limits, timed)).toEqual([])
    expect(planCpuPhases(Number.POSITIVE_INFINITY, rates, limits, { untilQuit: true, fixedPhaseS: null })).toEqual([
      { hz: 4, seconds: 30 },
      { hz: 15, seconds: 30 },
    ])
  })

  it('gives each phase exactly --cpu-phase-s, whatever time is left', () => {
    const rates = { normal: 4, attached: 15 }
    const limits = { minPhaseS: 5, defaultPhaseS: 30 }
    for (const untilQuit of [false, true]) {
      expect(planCpuPhases(2, rates, limits, { untilQuit, fixedPhaseS: 25 })).toEqual([
        { hz: 4, seconds: 25 },
        { hz: 15, seconds: 25 },
      ])
    }
  })

  it('turns two CPU-time readings into a percentage', () => {
    expect(cpuPercentFromTimes(0.02, 0.1, 10)).toBeCloseTo(0.8)
    expect(cpuPercentFromTimes(0.1, 0.02, 10)).toBeNull()
    expect(cpuPercentFromTimes(0, 0.1, 0)).toBeNull()
  })
})

// ───────────────────────────── helper CPU estimators ─────────────────────────────

const Q = PS_CPU_TIME_QUANTUM_S

/**
 * Cumulative CPU time (s) of a process that runs `burstS` at 100% every 1/hz s (like the helper's poll
 * tick): continuous and non-decreasing, as real CPU time is.
 */
function burstyCpu(hz: number, burstS: number, offsetS: number, c0: number): (t: number) => number {
  const period = 1 / hz
  return (t) => {
    const k = Math.floor((t - offsetS) / period)
    return c0 + k * burstS + Math.min(Math.max(t - offsetS - k * period, 0), burstS)
  }
}

/** `ps` readings every `everyS` (each takes execS, reading mid-way), printed rounded to 10 ms like macOS ps. */
function psReadings(cpu: (t: number) => number, durationS: number, everyS: number, execS = 0.004): CpuTimeReading[] {
  const readings: CpuTimeReading[] = []
  for (let t = 100; t <= 100 + durationS; t += everyS + execS) {
    readings.push({ startS: t, endS: t + execS, cpuS: Math.round(cpu(t + execS / 2) / Q) * Q })
  }
  return readings
}

/** Exact CPU rate (%) between the first and the last 10 ms step the edge estimator uses (bisection on cpu). */
function trueRateOverEdges(cpu: (t: number) => number, readings: readonly CpuTimeReading[]): number {
  const steps: { lo: number; hi: number; threshold: number }[] = []
  for (let j = 1; j < readings.length; j++) {
    const a = readings[j - 1]!
    const b = readings[j]!
    if (b.cpuS - a.cpuS > Q / 2) steps.push({ lo: a.startS, hi: b.endS, threshold: b.cpuS - Q / 2 })
  }
  const crossing = ({ lo, hi, threshold }: { lo: number; hi: number; threshold: number }): number => {
    let [l, h] = [lo, hi]
    for (let i = 0; i < 60; i++) {
      const m = (l + h) / 2
      if (cpu(m) >= threshold) h = m
      else l = m
    }
    return h
  }
  const first = steps[0]!
  const last = steps[steps.length - 1]!
  return ((last.threshold - first.threshold) / (crossing(last) - crossing(first))) * 100
}

describe('helper CPU from quantized ps readings', () => {
  it('bounds the true CPU rate between its first and last 10 ms steps, at 4 and 15 Hz, for any phase offset', () => {
    for (const hz of [4, 15]) {
      for (let k = 0; k < 10; k++) {
        const cpu = burstyCpu(hz, 0.00055, k * 0.023, k * 0.0017)
        const readings = psReadings(cpu, 30, 0.2)
        const edges = edgeCpuEstimate(readings, Q)
        expect(edges?.method).toBe('edges')
        const truth = trueRateOverEdges(cpu, readings)
        expect(edges!.lowPct).toBeLessThanOrEqual(truth)
        expect(edges!.highPct).toBeGreaterThanOrEqual(truth)
        // ~0.22% / ~0.83%: 30 s at 200 ms sampling resolves it to about ±0.01 points.
        expect(cpuHalfWidthPct(edges!)).toBeLessThan(hz === 4 ? 0.005 : 0.02)
      }
    }
  })

  it('bounds the first-to-last estimate by one quantum and prefers the tighter edge estimate', () => {
    const cpu = burstyCpu(4, 0.00055, 0.01, 0.004)
    const readings = psReadings(cpu, 30, 0.2)
    const delta = deltaCpuEstimate(readings, Q)!
    const first = readings[0]!
    const last = readings[readings.length - 1]!
    const t0 = (first.startS + first.endS) / 2
    const t1 = (last.startS + last.endS) / 2
    const truth = ((cpu(t1) - cpu(t0)) / (t1 - t0)) * 100
    expect(delta.method).toBe('delta')
    expect(delta.lowPct).toBeLessThanOrEqual(truth)
    expect(delta.highPct).toBeGreaterThanOrEqual(truth)
    expect(cpuHalfWidthPct(delta)).toBeGreaterThan(0.03) // ±10 ms over 30 s
    expect(bestCpuEstimate(readings, Q)?.method).toBe('edges')
  })

  it('needs two steps for an edge estimate and reports short phases as unresolved', () => {
    const cpu = burstyCpu(4, 0.00055, 0, 0.0001)
    const short = psReadings(cpu, 3, 0.2) // ~6.6 ms of CPU: at most one step
    expect(edgeCpuEstimate(short, Q)).toBeNull()
    const best = bestCpuEstimate(short, Q)
    expect(best?.method).toBe('delta')
    expect(formatCpuEstimate(best, 0.05)).toMatch(/^n\/a \(below resolution: /)
    expect(budgetVerdict(best, 0.5, 0.05)).toBe('unresolved')
    expect(formatCpuEstimate(null, 0.05)).toBe('n/a (no usable readings)')
  })

  it('rejects unusable reading sets', () => {
    expect(deltaCpuEstimate([], Q)).toBeNull()
    expect(deltaCpuEstimate([{ startS: 0, endS: 0.01, cpuS: 1 }], Q)).toBeNull()
    expect(deltaCpuEstimate([{ startS: 0, endS: 0.01, cpuS: 1 }, { startS: 1, endS: 1.01, cpuS: 0.5 }], Q)).toBeNull()
    expect(bestCpuEstimate([], Q)).toBeNull()
  })

  it('formats a resolved estimate and compares its bounds with the budget', () => {
    const fifteen = bestCpuEstimate(psReadings(burstyCpu(15, 0.00055, 0, 0), 30, 0.2), Q)
    expect(formatCpuEstimate(fifteen, 0.05)).toMatch(/^0\.8\d\d% \(0\.8\d\d–0\.8\d\d%, edges over 2\d\.\d s\)$/)
    expect(budgetVerdict(fifteen, 0.5, 0.05)).toBe('over')
    expect(formatCpuPhase({ hz: 15, estimate: fifteen, pushes: 450, wallS: 30, note: null }, 0.05, 0.5)).toMatch(
      /^15 Hz: 0\.8\d\d% .* → OVER the 0\.5% budget; 450 pushes in 30\.0 s$/,
    )
    const four = bestCpuEstimate(psReadings(burstyCpu(4, 0.00055, 0, 0), 30, 0.2), Q)
    expect(budgetVerdict(four, 0.5, 0.05)).toBe('within')
    const straddling = { method: 'edges' as const, pct: 0.5, lowPct: 0.48, highPct: 0.52, spanS: 20, cpuS: 0.1 }
    expect(budgetVerdict(straddling, 0.5, 0.05)).toBe('inconclusive')
  })
})

describe('round-trip latency bursts', () => {
  const burst = (label: string, pollHz: number, snapshot: number[]): LatencyBurst => ({
    label,
    tRunS: 1,
    pollHz,
    windows: 16,
    snapshotSamplesMs: snapshot,
    pingSamplesMs: [0.02, 0.03],
  })

  it('prints the run config, every burst and all bursts pooled', () => {
    const text = formatLatency([burst('after the checks', 4, [0.3, 0.4]), burst('end of the 15 Hz phase', 15, [1, 2])], 'overlay on')
    expect(text).toMatch(/^overlay on; after the checks @4 Hz, 16 windows: snapshot p50 0\.30 ms/)
    expect(text).toContain('| end of the 15 Hz phase @15 Hz, 16 windows: snapshot p50 1.00 ms')
    expect(text).toContain('| all 2 bursts: snapshot p50 0.40 ms p95 2.00 ms max 2.00 ms (n=4)')
  })

  it('handles a single burst or none', () => {
    expect(formatLatency([burst('a', 4, [0.5])], 'cfg')).not.toContain('all ')
    expect(formatLatency([], 'cfg')).toBe('cfg; no bursts measured')
  })
})

describe('fullscreen verdict (§8.6)', () => {
  const seen = (tRunS: number, value: boolean, overlayOnScreen: boolean | null): FullscreenObservation => ({
    tRunS,
    value,
    bundleId: 'com.apple.Notes',
    overlayOnScreen,
  })
  const presence = (tRunS: number, present: boolean, helperFullscreen: boolean | null, initial = false): PresenceChange => ({
    tRunS,
    present,
    initial,
    helperFullscreen,
  })

  it('skips, saying the helper reported nothing, when neither source saw a fullscreen state', () => {
    const verdict = fullscreenVerdict([seen(0.1, false, null)], [presence(0.5, true, false, true)], 'panel')
    expect(verdict.status).toBe('SKIP')
    expect(verdict.detail).toMatch(/^the helper reported no fullscreen state while the overlay existed/)
  })

  it('warns when the overlay left the on-screen list while the helper did not report fullscreen', () => {
    const verdict = fullscreenVerdict([seen(0.1, false, null)], [presence(0.5, true, false, true), presence(12, false, false)], 'none')
    expect(verdict.status).toBe('WARN')
    expect(verdict.detail).toContain('+12.0 s')
  })

  it('passes or fails on the helper-reported states', () => {
    expect(fullscreenVerdict([seen(5, true, false)], [presence(5.3, false, true)], 'none').status).toBe('PASS')
    const leaked = fullscreenVerdict([seen(5, true, true)], [], 'panel')
    expect(leaked.status).toBe('FAIL')
    expect(leaked.detail).toContain('FullScreenAuxiliary')
  })
})

describe('windows options', () => {
  it('defaults', () => {
    expect(parseWindowsOptions({ spike: 'windows' }, '/repo')).toEqual({
      durationS: tuning.spikeWindows.defaultDurationS,
      autoAppTest: false,
      overlay: true,
      windowType: 'panel',
      resultsDir: null,
      label: null,
      capture: null,
      cpuPhaseS: null,
    })
  })

  it('parses every flag (bare flags read as true; relative paths resolve against cwd)', () => {
    const options = parseWindowsOptions(
      {
        duration: '25',
        'auto-app-test': 'true',
        overlay: 'false',
        'window-type': 'none',
        results: 'out/x',
        label: 'run-1',
        capture: '/tmp/a.png',
        'cpu-phase-s': '30',
      },
      '/repo',
    )
    expect(options).toEqual({
      durationS: 25,
      autoAppTest: true,
      overlay: false,
      windowType: 'none',
      resultsDir: '/repo/out/x',
      label: 'run-1',
      capture: '/tmp/a.png',
      cpuPhaseS: 30,
    })
    expect(parseWindowsOptions({ duration: '0' }, '/').durationS).toBe(0)
  })

  it('rejects bad values', () => {
    expect(() => parseWindowsOptions({ duration: '-1' }, '/')).toThrow(/--duration/)
    expect(() => parseWindowsOptions({ duration: 'x' }, '/')).toThrow(/--duration/)
    expect(() => parseWindowsOptions({ duration: '' }, '/')).toThrow(/--duration/)
    expect(() => parseWindowsOptions({ overlay: 'maybe' }, '/')).toThrow(/--overlay/)
    expect(() => parseWindowsOptions({ 'window-type': 'popup' }, '/')).toThrow(/--window-type/)
    expect(() => parseWindowsOptions({ label: '../x' }, '/')).toThrow(/--label/)
    expect(() => parseWindowsOptions({ 'cpu-phase-s': '0' }, '/')).toThrow(/--cpu-phase-s/)
    expect(() => parseWindowsOptions({ 'cpu-phase-s': 'true' }, '/')).toThrow(/--cpu-phase-s/)
  })
})

describe('format', () => {
  it('stamps local time', () => {
    expect(localStamp(new Date(2026, 9, 6, 8, 5, 3))).toBe('20261006-080503')
  })

  it('reads CFBundleIdentifier from an XML Info.plist', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '\t<key>CFBundleExecutable</key>\n\t<string>Bitbot</string>',
      '\t<key>CFBundleIdentifier</key>\n\t<string>com.bitbot.desktop</string>',
      '</dict></plist>',
    ].join('\n')
    expect(bundleIdFromInfoPlist(xml)).toBe('com.bitbot.desktop')
    expect(bundleIdFromInfoPlist('<plist><dict></dict></plist>')).toBeNull()
  })

  it('finds the .app bundle of an executable', () => {
    expect(bundlePathOf('/Users/x/BitBot/dist/mac-arm64/Bitbot.app/Contents/MacOS/Bitbot')).toBe('/Users/x/BitBot/dist/mac-arm64/Bitbot.app')
    expect(bundlePathOf('/A.app/Contents/Frameworks/B.app/Contents/MacOS/B')).toBe('/A.app/Contents/Frameworks/B.app')
    expect(bundlePathOf('/usr/local/bin/node')).toBeNull()
  })
})
