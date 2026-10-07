import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FixedStepClock } from '../src/main/spike/overlay/fixedStep'
import { aggregateFootprint, parseFootprintOutput } from '../src/main/spike/overlay/footprint'
import { InteractionController, type PetBox } from '../src/main/spike/overlay/interaction'
import { aggregateMetrics, type MetricsSample } from '../src/main/spike/overlay/metricsAggregate'
import { parseOverlayOptions, resultsFileName } from '../src/main/spike/overlay/options'
import {
  OverlaySim,
  lissajousAt,
  makeLissajousPath,
  releaseVelocity,
  walkStep,
  type SimArea,
  type SimParams,
} from '../src/main/spike/overlay/sim'
import { SignalGate } from '../src/main/spike/overlay/signals'
import { SampleSeries, fractionAbove, percentileSorted, summarize } from '../src/main/spike/overlay/stats'
import { interpolate, isOverlayConfig, isOverlayStateMsg, sampleBuffer } from '../src/shared/spikeOverlay'
import { tuning } from '../src/shared/tuning'
import { analyzeWindowMotion, type ProbeSample } from '../spikes/analysis/lib/judder.mjs'
import { summarizeRun, type LoadedRun } from '../spikes/analysis/lib/report.mjs'
import { phaseLock, summarize as summarizeMjs } from '../spikes/analysis/lib/stats.mjs'
import { benchTarget, parseIoregUtilization, parsePsCpuTime, parsePsPidTimes } from '../spikes/analysis/lib/system.mjs'

// interaction.ts builds the right-click menu with Electron's Menu; nothing else here touches Electron.
vi.mock('electron', () => ({ Menu: { buildFromTemplate: () => ({ popup: () => undefined }) } }))

const AREA: SimArea = { minX: 120, maxX: 1590, minY: 219, groundY: 1022 }
const T = tuning.spikeOverlay
const PARAMS: SimParams = {
  walkSpeed: tuning.move.walkSpeed,
  followSpeed: T.followSpeed,
  gravity: tuning.move.gravity,
  terminalVelocity: tuning.move.terminalVelocity,
  facingDeadband: T.facingDeadband,
  toss: T.toss,
  path: null,
}
const DT = 1 / T.simHz

describe('FixedStepClock', () => {
  it('runs whole steps only, stamped on the fixed grid', () => {
    const clock = new FixedStepClock(10, 0, 5)
    expect(clock.advance(9.99)).toEqual([])
    expect(clock.advance(25)).toEqual([10, 20])
    expect(clock.advance(29)).toEqual([])
    expect(clock.msUntilNextStep(29)).toBeCloseTo(1)
    expect(clock.advance(30)).toEqual([30])
    expect(clock.stepCount).toBe(3)
  })

  it('drops (does not replay) time beyond maxStepsPerAdvance', () => {
    const clock = new FixedStepClock(10, 0, 5)
    expect(clock.advance(100)).toEqual([60, 70, 80, 90, 100])
    expect(clock.droppedSteps).toBe(5)
    expect(clock.latestStepTime).toBe(100)
  })

  it('is drift-free under timer jitter', () => {
    const stepMs = 1000 / 30
    const clock = new FixedStepClock(stepMs, 0, 5)
    let now = 0
    let seed = 7
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    while (now < 60_000) {
      now += clock.msUntilNextStep(now) + rand() * 12 // timers fire 0-12 ms late
      clock.advance(now)
    }
    expect(clock.stepCount).toBe(Math.floor(now / stepMs))
    expect(clock.droppedSteps).toBe(0)
  })
})

describe('interpolation', () => {
  const a = { t: 0, x: 0, y: 10 }
  const b = { t: 100, x: 50, y: 30 }
  it('interpolates and clamps, flagging starvation past the newest state', () => {
    expect(interpolate(a, b, 50)).toEqual({ x: 25, y: 20, starved: false })
    expect(interpolate(a, b, -5)).toEqual({ x: 0, y: 10, starved: false })
    expect(interpolate(a, b, 100.2)).toEqual({ x: 50, y: 30, starved: false })
    expect(interpolate(a, b, 101)).toEqual({ x: 50, y: 30, starved: true })
  })
  it('samples a buffer of states', () => {
    const buf = [a, b, { t: 200, x: 50, y: 130 }]
    expect(sampleBuffer([], 10)).toBeNull()
    expect(sampleBuffer(buf, 150)).toEqual({ x: 50, y: 80, starved: false })
    expect(sampleBuffer(buf, 25)?.x).toBeCloseTo(12.5)
    expect(sampleBuffer(buf, -1)).toEqual({ x: 0, y: 10, starved: false })
    expect(sampleBuffer(buf, 205)?.starved).toBe(true)
  })
})

describe('OverlaySim', () => {
  it('walks the ground at exactly walkSpeed, turning at the ends', () => {
    const sim = new OverlaySim('walk', AREA, PARAMS)
    let prevX = sim.state.x
    let turns = 0
    let dir = sim.state.walkDir
    for (let i = 0; i < 30 * 40; i++) {
      sim.step(DT, { tS: i * DT, cursor: null, held: null })
      const s = sim.state
      expect(s.y).toBe(AREA.groundY)
      expect(s.x).toBeGreaterThanOrEqual(AREA.minX)
      expect(s.x).toBeLessThanOrEqual(AREA.maxX)
      if (s.walkDir === dir) expect(Math.abs(s.x - prevX)).toBeCloseTo(PARAMS.walkSpeed * DT, 9)
      else turns++
      expect(s.facing).toBe(s.walkDir)
      dir = s.walkDir
      prevX = s.x
    }
    expect(turns).toBeGreaterThanOrEqual(2)
  })

  it('reflects exactly at the walk bounds', () => {
    expect(walkStep(95, 1, 10, 0, 100)).toEqual({ x: 95, dir: -1 })
    expect(walkStep(3, -1, 5, 0, 100)).toEqual({ x: 2, dir: 1 })
  })

  it('synthetic: the target peaks at the configured speed and the pet never exceeds followSpeed', () => {
    const path = makeLissajousPath(AREA, T.synthetic)
    let peak = 0
    const h = 1e-4
    for (let t = 0; t < 120; t += 0.01) {
      const p = lissajousAt(path, t)
      const q = lissajousAt(path, t + h)
      peak = Math.max(peak, Math.hypot(q.x - p.x, q.y - p.y) / h)
      expect(p.x).toBeGreaterThanOrEqual(AREA.minX)
      expect(p.x).toBeLessThanOrEqual(AREA.maxX)
      expect(p.y).toBeGreaterThanOrEqual(AREA.minY)
      expect(p.y).toBeLessThanOrEqual(AREA.groundY)
    }
    expect(peak).toBeGreaterThanOrEqual(T.followSpeed)
    expect(Math.abs(peak - T.synthetic.peakSpeed) / T.synthetic.peakSpeed).toBeLessThan(0.002)

    const sim = new OverlaySim('synthetic', AREA, { ...PARAMS, path })
    let fast = 0
    for (let i = 1; i <= 30 * 30; i++) {
      const { x, y } = sim.state
      sim.step(DT, { tS: i * DT, cursor: null, held: null })
      const v = Math.hypot(sim.state.x - x, sim.state.y - y) / DT
      expect(v).toBeLessThanOrEqual(T.followSpeed + 1e-6)
      if (v > T.followSpeed * 0.99) fast++
    }
    expect(fast).toBeGreaterThan(100) // the chase saturates at followSpeed for a good part of the run
  })

  it('follow: chases the cursor (plus offset) at followSpeed, clamped to the area', () => {
    const sim = new OverlaySim('follow', AREA, PARAMS)
    sim.setFollowOffset({ x: 0, y: 150 })
    const cursor = { x: 300, y: 400 }
    for (let i = 0; i < 30 * 5; i++) sim.step(DT, { tS: i * DT, cursor, held: null })
    expect(sim.state.x).toBeCloseTo(300)
    expect(sim.state.y).toBeCloseTo(550)
    for (let i = 0; i < 30 * 5; i++) sim.step(DT, { tS: i * DT, cursor: { x: 5000, y: 5000 }, held: null })
    expect(sim.state.x).toBeCloseTo(AREA.maxX)
    expect(sim.state.y).toBeCloseTo(AREA.groundY)
  })

  it('toss: falls under gravity (terminal-capped), bounces, lands, then walks again', () => {
    const sim = new OverlaySim('interactive', AREA, PARAMS)
    sim.grab()
    sim.step(DT, { tS: 0, cursor: null, held: { x: 800, y: 400 } })
    expect(sim.state.phase).toBe('held')
    sim.release({ x: 800, y: 400 }, { x: 900, y: -5000 }, false)
    expect(Math.hypot(sim.state.vx, sim.state.vy)).toBeCloseTo(tuning.move.terminalVelocity)
    const phases = new Set<string>()
    let bounced = false
    let prevVy = sim.state.vy
    for (let i = 0; i < 30 * 10; i++) {
      sim.step(DT, { tS: i * DT, cursor: null, held: null })
      const s = sim.state
      phases.add(s.phase)
      expect(s.y).toBeLessThanOrEqual(AREA.groundY)
      expect(s.y).toBeGreaterThanOrEqual(AREA.minY)
      expect(s.vy).toBeLessThanOrEqual(tuning.move.terminalVelocity)
      if (prevVy > 0 && s.vy < 0 && s.phase === 'fall') bounced = true
      prevVy = s.vy
    }
    expect(bounced).toBe(true)
    expect(phases.has('land')).toBe(true)
    expect(sim.state.phase).toBe('walk')
    expect(sim.state.y).toBe(AREA.groundY)
  })

  it('a pet click on the ground just resumes walking in place', () => {
    const sim = new OverlaySim('interactive', AREA, PARAMS)
    const x = sim.state.x
    sim.grab()
    sim.release({ x, y: AREA.groundY }, { x: 0, y: 0 }, true)
    expect(sim.state.phase).toBe('walk')
    expect(sim.state.x).toBe(x)
    expect(sim.state.y).toBe(AREA.groundY)
  })

  it('release velocity uses the trailing window', () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ t: i * 10, x: i * 10, y: 0 }))
    expect(releaseVelocity(samples, 80).x).toBeCloseTo(1000)
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }], 80)).toEqual({ x: 0, y: 0 })
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 200, x: 100, y: 0 }], 80).x).toBeCloseTo(500)
  })
})

describe('stats', () => {
  it('summarizes with linear-interpolated percentiles (same as the .mjs analysis)', () => {
    const xs = [5, 1, 4, 2, 3]
    const s = summarize(xs)
    expect(s).toMatchObject({ n: 5, mean: 3, min: 1, p50: 3, max: 5 })
    expect(s?.p95).toBeCloseTo(4.8)
    expect(percentileSorted([10, 20], 25)).toBeCloseTo(12.5)
    expect(summarizeMjs(xs)?.p95).toBeCloseTo(s?.p95 ?? Number.NaN)
    expect(summarize([])).toBeNull()
    expect(fractionAbove([10, 20, 30], 15)).toBeCloseTo(2 / 3)
  })

  it('caps sample series and counts the drops', () => {
    const series = new SampleSeries(3)
    for (let i = 0; i < 5; i++) series.push(i)
    expect(Array.from(series.values())).toEqual([0, 1, 2])
    expect(series.dropped).toBe(2)
  })
})

describe('aggregateMetrics', () => {
  it('reports per-core CPU per process type, from samples and from cumulative CPU time', () => {
    const sample = (tMs: number, cumA: number, cumB: number, cpuA: number, cpuB: number): MetricsSample => ({
      tMs,
      procs: [
        { pid: 1, type: 'Browser', name: null, cpu: cpuA, cpuNormalized: cpuA / 10, cum: cumA, wakeups: 10, memKB: 102400 },
        { pid: 2, type: 'GPU', name: null, cpu: cpuB, cpuNormalized: cpuB / 10, cum: cumB, wakeups: 5, memKB: 51200 },
      ],
    })
    const samples = [sample(0, 0, 0, 0, 0), sample(1000, 0.1, 0.05, 10, 5), sample(2000, 0.2, 0.1, 10, 5), sample(3000, 0.32, 0.15, 12, 5)]
    const agg = aggregateMetrics(samples, 1000, 3000, 1000)
    expect(agg.samples).toBe(2)
    expect(agg.byType['Browser']?.cpuMean).toBeCloseTo(11)
    expect(agg.byType['Browser']?.cpuMeanCumulative).toBeCloseTo(11)
    expect(agg.byType['GPU']?.cpuMeanCumulative).toBeCloseTo(5)
    expect(agg.total.cpuMeanCumulative).toBeCloseTo(16)
    expect(agg.total.memMeanMB).toBeCloseTo(150)
  })
})

describe('options', () => {
  const ctx = { appPath: '/app', cwd: '/cwd' }
  it('applies defaults and validates', () => {
    const o = parseOverlayOptions({ variant: 'A2', mode: 'walk' }, ctx)
    expect(o).toMatchObject({ durationS: T.defaultDurationS, windowType: 'panel', size: 'M', palette: 'mint', resultsDir: '/app/spike-results', a1Timer: 'deadline' })
    expect(parseOverlayOptions({ variant: 'B', mode: 'static', results: 'out', duration: '0' }, ctx)).toMatchObject({ resultsDir: '/cwd/out', durationS: 0 })
    expect(() => parseOverlayOptions({ variant: 'C', mode: 'walk' }, ctx)).toThrow(/--variant/)
    expect(() => parseOverlayOptions({ variant: 'A1', mode: 'run' }, ctx)).toThrow(/--mode/)
    expect(() => parseOverlayOptions({ variant: 'A1', mode: 'walk', duration: '-1' }, ctx)).toThrow(/--duration/)
    expect(() => parseOverlayOptions({ variant: 'A1', mode: 'walk', label: '../x' }, ctx)).toThrow(/--label/)
    expect(o.renderFps).toBeNull()
    expect(parseOverlayOptions({ variant: 'B', mode: 'static', 'render-fps': '30' }, ctx).renderFps).toBe(30)
    expect(parseOverlayOptions({ variant: 'B', mode: 'static', 'render-fps': '0' }, ctx).renderFps).toBe(0)
    expect(() => parseOverlayOptions({ variant: 'B', mode: 'static', 'render-fps': '-5' }, ctx)).toThrow(/--render-fps/)
    expect(() => parseOverlayOptions({ variant: 'B', mode: 'static', 'render-fps': 'fast' }, ctx)).toThrow(/--render-fps/)
    expect(resultsFileName({ ...o, label: 'bench1' }, new Date())).toBe('overlay-A2-walk-bench1.json')
    expect(resultsFileName(o, new Date(2026, 9, 6, 8, 5, 3))).toBe('overlay-A2-walk-20261006-080503.json')
  })
})

describe('shared payload guards', () => {
  it('accepts well-formed payloads only', () => {
    expect(isOverlayConfig({ variant: 'A1', mode: 'walk', window: { x: 0, y: 0, width: 1, height: 1 }, edge: 240, stepMs: 33.3, interactive: false })).toBe(true)
    expect(isOverlayConfig({ variant: 'A3', mode: 'walk', window: { x: 0, y: 0, width: 1, height: 1 }, edge: 240, stepMs: 33.3, interactive: false })).toBe(false)
    expect(isOverlayStateMsg({ seq: 1, t: 2, sentAt: 1, x: 3, y: 4, facing: -1, phase: 'walk', snap: false })).toBe(true)
    expect(isOverlayStateMsg({ seq: 1, t: 2, sentAt: 1, x: 3, y: 4, facing: 0, phase: 'walk', snap: false })).toBe(false)
    expect(isOverlayStateMsg({ seq: 1, t: 2, x: 3, y: 4, facing: 1, phase: 'walk', snap: false })).toBe(false)
  })
})

// ── analysis scripts ─────────────────────────────────────────────────────────────────────────

/** Probe samples (250 Hz) of a window that moves `stepPt` at each of the given update times (ms). */
function probeOf(updatesMs: number[], durationMs: number, stepPt = 2, probeMs = 4): ProbeSample[] {
  const out: ProbeSample[] = []
  let k = 0
  for (let t = 0; t <= durationMs; t += probeMs) {
    while (k < updatesMs.length && (updatesMs[k] ?? Infinity) <= t) k++
    out.push({ t: t / 1000, x: 100 + k * stepPt, y: 500 })
  }
  return out
}

describe('window-motion analysis (judder)', () => {
  const P = 1000 / 60
  const D = 15_000

  it('a vsync-locked 60 Hz mover shows no anomalies at the best phase and strong phase locking', () => {
    let seed = 3
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    const updates = Array.from({ length: Math.floor(D / P) }, (_, i) => i * P + 3 + rand() * 2) // locked, 2 ms jitter
    const m = analyzeWindowMotion(probeOf(updates, D), { periodMs: P })
    expect(m.best?.anomalyPct).toBe(0)
    expect(m.updatesPerMovingFrame).toBeCloseTo(1, 1)
    expect(m.phaseLock?.R ?? 0).toBeGreaterThan(0.8)
    expect(m.changeIntervalMs?.mean).toBeCloseTo(P, 0)
  })

  it('a free-running 58.8 Hz timer (17 ms) leaves ~2% of frames empty at every phase, with no phase locking', () => {
    const updates = Array.from({ length: Math.floor(D / 17) }, (_, i) => i * 17)
    const m = analyzeWindowMotion(probeOf(updates, D), { periodMs: P })
    // 1 − 58.82/60 = 1.96 % of frames cannot get an update, however the probe quantization is resolved.
    expect(m.best?.zeroPct ?? 0).toBeGreaterThan(1.5)
    expect(m.best?.zeroPct ?? 0).toBeLessThan(2.5)
    expect(m.best?.multiPct).toBe(0)
    expect(m.avg?.zeroPct ?? 0).toBeGreaterThan(1.5)
    expect(m.avg?.zeroPct ?? 0).toBeLessThan(2.5)
    // Counting at interval midpoints adds quantization flips on top (why it is only a secondary number).
    expect(m.bestMidpoint?.anomalyPct ?? 0).toBeGreaterThanOrEqual(m.best?.anomalyPct ?? 0)
    expect(m.phaseLock?.R ?? 1).toBeLessThan(0.2)
  })

  it('timer jitter only hurts when the latch point falls inside the jitter window (avg, not best)', () => {
    let seed = 11
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    // A 60 Hz deadline timer firing 0-9 ms late (like an Electron main-process timer): with the frame
    // edge outside the 9 ms window every frame still gets one update; with it inside, hitch/skip pairs.
    const updates = Array.from({ length: Math.floor(D / P) }, (_, i) => i * P + rand() * 9)
    const m = analyzeWindowMotion(probeOf(updates, D), { periodMs: P })
    expect(m.best?.anomalyPct ?? 100).toBeLessThan(1)
    expect(m.avg?.anomalyPct ?? 0).toBeGreaterThan(5)
    expect(m.avg?.zeroPct ?? 0).toBeCloseTo(m.avg?.multiPct ?? -1, 0)
  })

  it('ignores frames that are not moving and reports nothing for a static window', () => {
    const still = analyzeWindowMotion(probeOf([], 3000), { periodMs: P })
    expect(still.changes).toBe(0)
    expect(still.best).toBeNull()
    // 30 pt/s (0.5 pt/frame): legitimately fewer than one integer step per frame, so no "moving" frames.
    const slow = Array.from({ length: 50 }, (_, i) => i * 66.7)
    expect(analyzeWindowMotion(probeOf(slow, 3300, 2), { periodMs: P }).movingFrames).toBe(0)
  })

  it('phaseLock distinguishes locked from spread events', () => {
    expect(phaseLock([0, 10, 20, 30], 10)?.R).toBeCloseTo(1)
    expect(phaseLock([0, 2.5, 5, 7.5], 10)?.R).toBeCloseTo(0)
  })
})

describe('system sampler parsers', () => {
  it('parses ioreg utilization and ps cumulative CPU time', () => {
    const text = '"PerformanceStatistics" = {"Tiler Utilization %"=13,"Renderer Utilization %"=12,"Device Utilization %"=14}'
    expect(parseIoregUtilization(text)).toEqual({ device: 14, renderer: 12, tiler: 13 })
    expect(parseIoregUtilization('nothing')).toEqual({ device: null, renderer: null, tiler: null })
    expect(parsePsCpuTime(' 227:24.35\n')).toBeCloseTo(13644.35)
    expect(parsePsCpuTime('1-02:03:04.5')).toBeCloseTo(93784.5)
    expect(parsePsCpuTime('garbage')).toBeNull()
  })
})

describe('bench helpers', () => {
  it('parses multi-pid ps CPU times and maps the A1i alias', () => {
    const times = parsePsPidTimes('  123   1:02.50\n  456 227:24.35\nbogus\n')
    expect(times.get(123)).toBeCloseTo(62.5)
    expect(times.get(456)).toBeCloseTo(13644.35)
    expect(times.size).toBe(2)
    expect(benchTarget('A1i', 'L-r1')).toEqual({ variant: 'A1', label: 'L-r1-a1i', extraArgs: ['--a1-timer=interval'] })
    expect(benchTarget('Bfull', 'L')).toEqual({ variant: 'Bfull', label: 'L', extraArgs: [] })
  })
})

// ── harness: signals, memory, interaction ──────────────────────────────────────────────────

describe('SignalGate (Ctrl+C)', () => {
  it('finishes on the first signal, ignores the echo of the same Ctrl+C, force-exits on a later one', () => {
    const gate = new SignalGate(T.signalRepeatGraceMs)
    expect(gate.onSignal(5000)).toBe('finish')
    // The terminal signals the whole process group and electron's cli.js forwards it again.
    expect(gate.onSignal(5004)).toBe('ignore')
    expect(gate.onSignal(5000 + T.signalRepeatGraceMs - 1)).toBe('ignore')
    expect(gate.onSignal(5000 + T.signalRepeatGraceMs)).toBe('force-exit')
  })
})

describe('footprint (Activity Monitor memory)', () => {
  const OUTPUT = [
    '======================================================================',
    'Electron [4001]: 64-bit    Footprint: 36000000 B (16384 bytes per page)',
    '======================================================================',
    '      Dirty         Clean   Reclaimable    Regions    Category',
    ' 20000000 B           0 B           0 B         10    MALLOC_SMALL',
    'Shared with Electron Helper (GPU) [4002]:',
    '    32768 B           0 B           0 B          1    untagged (VM_ALLOCATE)',
    'Auxiliary data:',
    '    phys_footprint: 36070400 B',
    '    phys_footprint_peak: 40000000 B',
    '======================================================================',
    'Electron Helper (GPU) [4002]: 64-bit    Footprint: 108000000 B (16384 bytes per page)',
    '======================================================================',
    'Auxiliary data:',
    '    phys_footprint: 108843008 B',
    '    phys_footprint_peak: 120000000 B',
    '======================================================================',
    'Electron Helper (Renderer) [4003]: 64-bit    Footprint: 48758784 B (16384 bytes per page)',
    '======================================================================',
    '======================================================================',
    'Summary Footprint: 193000000 B',
    '======================================================================',
    ' 50020352 B           0 B           0 B          2    MALLOC_LARGE',
  ].join('\n')

  it('reads phys_footprint and its peak per pid (falling back to the dirty total) and the de-duplicated summary', () => {
    const out = parseFootprintOutput(OUTPUT)
    expect(out.byPid.get(4001)).toEqual({ physBytes: 36070400, peakBytes: 40000000 })
    expect(out.byPid.get(4002)).toEqual({ physBytes: 108843008, peakBytes: 120000000 })
    expect(out.byPid.get(4003)).toEqual({ physBytes: 48758784, peakBytes: null })
    expect(out.summaryBytes).toBe(193000000)
    expect(parseFootprintOutput('footprint: Unable to find any processes').byPid.size).toBe(0)
  })

  it('sums per process type and reports processes it could not read', () => {
    const procs = [
      { pid: 4001, type: 'Browser' },
      { pid: 4002, type: 'GPU' },
      { pid: 4003, type: 'Tab' },
      { pid: 4004, type: 'Utility' },
    ]
    const agg = aggregateFootprint(procs, parseFootprintOutput(OUTPUT))
    expect(agg.byType['Browser']).toEqual({ processes: 1, mb: 34.4, peakMB: 38.1 })
    expect(agg.byType['GPU']?.mb).toBeCloseTo(103.8)
    expect(agg.byType['Tab']).toEqual({ processes: 1, mb: 46.5, peakMB: null })
    expect(agg.totalMB).toBeCloseTo(34.4 + 103.8 + 46.5, 0)
    expect(agg.peakTotalMB).toBeNull() // one process had no peak line
    expect(agg.dedupTotalMB).toBeCloseTo(184.1)
    expect(agg.missingPids).toEqual([4004])
  })
})

describe('InteractionController', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Pet drawn with its ground point at `ground`; box 120 x 160 pt around it. */
  function setup(interactive = true) {
    let t = 1000
    let cursor = { x: 800, y: 950 }
    const ground = { x: 800, y: 1022 }
    const box: PetBox = { left: -60, top: -150, right: 60, bottom: 10 }
    const ignoreCalls: boolean[] = []
    const win = {
      isDestroyed: () => false,
      setIgnoreMouseEvents: (ignore: boolean) => {
        ignoreCalls.push(ignore)
      },
      hide: () => undefined,
      showInactive: () => undefined,
    }
    const sim = new OverlaySim('interactive', AREA, PARAMS)
    const logs: string[] = []
    let hoverResets = 0
    let snaps = 0
    const ctl = new InteractionController({
      win: win as unknown as BrowserWindow,
      interactive,
      tuning: T,
      sim,
      focus: () => null,
      now: () => t,
      elapsedS: (ms) => ms / 1000,
      cursor: () => ({ ...cursor }),
      displayedPoint: () => ({ ...ground }),
      petBox: () => box,
      log: (line) => logs.push(line),
      onSnap: () => {
        snaps++
      },
      sendHoverReset: () => {
        hoverResets++
      },
      quit: () => undefined,
    })
    return {
      ctl,
      sim,
      ground,
      ignoreCalls,
      logs,
      at: (ms: number) => {
        t = ms
      },
      moveCursor: (x: number, y: number) => {
        cursor = { x, y }
      },
      counts: () => ({ hoverResets, snaps }),
    }
  }

  it('toggles click-through on hover changes', () => {
    const h = setup()
    h.ctl.handleHover(true)
    expect(h.ctl.mouseEventsEnabled).toBe(true)
    h.ctl.handleHover(false)
    expect(h.ctl.mouseEventsEnabled).toBe(false)
    expect(h.ignoreCalls).toEqual([false, true])
    expect(h.ctl.stats).toMatchObject({ hoverOn: 1, hoverOff: 1, clickThroughToggles: 2, safetyNet: 0 })
  })

  it('safety net: a cursor flicked off the pet before the first safety tick is a missed leave', () => {
    const h = setup()
    h.ctl.handleHover(true) // cursor on the pet at hover-on
    h.at(1010)
    h.moveCursor(1200, 600) // off the pet; the renderer's leave never arrives
    h.ctl.safetyTick(1020) // first tick after hover-on
    expect(h.ctl.stats.safetyNet).toBe(1)
    expect(h.ctl.stats.safetyNetFirings[0]).toMatchObject({ cursorMoved: true, raced: false })
    expect(h.ctl.stats.safetyNetMissedLeaves).toBe(1)
    expect(h.ctl.mouseEventsEnabled).toBe(false) // click-through forced back on
    expect(h.counts().hoverResets).toBe(1)
  })

  it('safety net: the pet walking away from a still cursor is not a missed leave', () => {
    const h = setup()
    h.ctl.handleHover(true)
    for (let k = 1; k <= 5; k++) h.ctl.safetyTick(1000 + k * 33) // cursor still, pet under it
    expect(h.ctl.stats.safetyNet).toBe(0)
    h.ground.x += 300 // the pet walked off; no mouse event exists for that
    h.ctl.safetyTick(1200)
    expect(h.ctl.stats.safetyNetFirings[0]?.cursorMoved).toBe(false)
    expect(h.ctl.stats.safetyNetMissedLeaves).toBe(0)
  })

  it('safety net: a renderer leave arriving just after a firing marks it raced', () => {
    const h = setup()
    h.ctl.handleHover(true)
    h.moveCursor(1200, 600)
    h.ctl.safetyTick(1033)
    expect(h.ctl.stats.safetyNetMissedLeaves).toBe(1)
    h.at(1033 + T.safetyNetRaceMs - 1)
    h.ctl.handleHover(false) // the leave was already in flight
    expect(h.ctl.stats.safetyNetFirings[0]?.raced).toBe(true)
    expect(h.ctl.stats.safetyNetMissedLeaves).toBe(0)

    const late = setup()
    late.ctl.handleHover(true)
    late.moveCursor(1200, 600)
    late.ctl.safetyTick(1033)
    late.at(1033 + T.safetyNetRaceMs + 1)
    late.ctl.handleHover(false)
    expect(late.ctl.stats.safetyNetFirings[0]?.raced).toBe(false)
    expect(late.ctl.stats.safetyNetMissedLeaves).toBe(1)
  })

  it('drag and toss: follows the cursor with the grab offset, releases with the cursor velocity', () => {
    vi.useFakeTimers()
    const h = setup()
    h.ctl.handleHover(true)
    h.ctl.handlePointer({ kind: 'down', button: 0, screenX: 800, screenY: 950 })
    expect(h.ctl.isHeld).toBe(true)
    expect(h.sim.state.phase).toBe('held')
    // Cursor moves 10 pt right and 5 pt up every 10 ms (1000 pt/s, -500 pt/s).
    for (let k = 1; k <= 12; k++) {
      h.at(1000 + k * 10)
      h.moveCursor(800 + k * 10, 950 - k * 5)
      const held = h.ctl.sampleHeld(1000 + k * 10)
      expect(held).toEqual({ x: 800 + k * 10, y: 1022 - k * 5 }) // grab offset (0, -72) preserved
    }
    h.ctl.handlePointer({ kind: 'up', button: 0, screenX: 920, screenY: 890 })
    expect(h.ctl.isHeld).toBe(false)
    expect(h.sim.state.phase).toBe('fall')
    expect(h.sim.state.vx).toBeCloseTo(1000, 0)
    expect(h.sim.state.vy).toBeCloseTo(-500, 0)
    expect(h.ctl.stats.drags).toBe(1)
    expect(h.counts().snaps).toBe(1)
    vi.advanceTimersByTime(T.focusVerdictDelayMs)
    expect(h.ctl.stats.verdicts).toHaveLength(1)
    expect(h.ctl.stats.verdicts[0]?.becameActive).toBe(false)
    expect(h.logs.some((l) => l.includes('-> Bitbot became the active app: NO (PASS)'))).toBe(true)
  })

  it('after a toss the cursor history restarts at release (pet falling away from a still cursor is no missed leave)', () => {
    vi.useFakeTimers()
    const h = setup()
    h.ctl.handleHover(true)
    h.ctl.handlePointer({ kind: 'down', button: 0, screenX: 800, screenY: 950 })
    for (let k = 1; k <= 5; k++) {
      h.at(1000 + k * 20)
      h.moveCursor(800 + k * 40, 950)
      h.ctl.sampleHeld(1000 + k * 20)
    }
    h.ground.x = 1000 // pet drawn under the cursor at release; cursor still over it
    h.ctl.handlePointer({ kind: 'up', button: 0, screenX: 1000, screenY: 950 })
    expect(h.ctl.mouseEventsEnabled).toBe(true)
    h.ground.x = 1400 // tossed away from the still cursor
    h.ctl.safetyTick(1110)
    expect(h.ctl.stats.safetyNetFirings[0]?.cursorMoved).toBe(false)
    expect(h.ctl.stats.safetyNetMissedLeaves).toBe(0)
  })

  it('a press that barely moves is a pet click', () => {
    vi.useFakeTimers()
    const h = setup()
    h.ctl.handleHover(true)
    h.ctl.handlePointer({ kind: 'down', button: 0, screenX: 800, screenY: 950 })
    h.at(1100)
    h.moveCursor(801, 951) // < petClickMaxMovePt
    h.ctl.sampleHeld(1100)
    h.ctl.handlePointer({ kind: 'up', button: 0, screenX: 801, screenY: 951 })
    expect(h.ctl.stats).toMatchObject({ pets: 1, drags: 0 })
    expect(h.sim.state.phase).toBe('walk')
  })

  it('outside interactive mode pointer messages are only counted', () => {
    const h = setup(false)
    h.ctl.handleHover(true)
    h.ctl.handlePointer({ kind: 'down', button: 0, screenX: 800, screenY: 950 })
    h.ctl.handlePointer({ kind: 'contextmenu', screenX: 800, screenY: 950 })
    expect(h.ctl.isHeld).toBe(false)
    expect(h.ctl.stats).toMatchObject({ pointerIgnored: 2, drags: 0, menus: 0 })
  })
})

// ── analysis: per-run summary ─────────────────────────────────────────────────────────────────

describe('summarizeRun', () => {
  const P = 1000 / 60
  const WARMUP = 2
  const END = 12

  /** Harness results JSON (only the fields the summary reads). */
  function results(variant: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const raf = [...Array.from({ length: 590 }, () => P), 22, 22, 22, 22, 22, 33.3, 33.3, 33.3, 33.3, 33.3]
    return {
      schema: 'bitbot.spike.overlay/1',
      variant,
      mode: 'walk',
      label: 't',
      ok: true,
      errors: [],
      warnings: [],
      options: { a1Timer: 'deadline', windowType: 'panel' },
      measure: { warmupS: WARMUP, endS: END, measuredS: END - WARMUP },
      display: { displayFrequency: 60, bounds: { width: 1710, height: 1107 }, scaleFactor: 2 },
      env: { onBattery: false, thermalState: 'nominal', loadAvg1m: { start: 2 } },
      renderer: { frames: 600, rawRafIntervalsMs: raf, longFrameMs: 25, starvedFrames: 0, mousemoves: 0 },
      presentation:
        variant === 'A1' ? { driver: 'timer-deadline', ticks: 600, rawIntervalsMs: Array.from({ length: 599 }, () => P), starved: 0 } : null,
      cpu: {
        total: { cpuMeanCumulative: 20, cpuMean: 21, cpuP95: 25, memMeanMB: 343, wakeupsMean: 120 },
        byType: { Browser: { cpuMeanCumulative: 12, cpuP95: 14 }, Tab: { cpuMeanCumulative: 5, cpuP95: 6 } },
      },
      memory: { footprint: { totalMB: 191, byType: { Browser: { processes: 1, mb: 34.4, peakMB: 40 } } }, footprintError: null, rssMeanMB: 343 },
      interaction: { clickThroughToggles: 0, safetyNet: 0, safetyNetMissedLeaves: 0, activations: 0 },
      ...extra,
    }
  }

  /** ws.jsonl lines: WindowServer at 30 % of a core, probe at 4 % until D-3, whole machine `busyCores` busy. */
  function wsLines(busyCores: number): Record<string, unknown>[] {
    const cores = 10
    const lines: Record<string, unknown>[] = []
    for (let t = 0; t <= 2.001; t += 1) lines.push({ t, phase: 'baseline', cpuS: 100 + 0.1 * t, sysBusyMs: 0, sysTotalMs: 0, cores })
    // Warm-up sample with a wild value: must not count.
    lines.push({ t: 0.5, phase: 'run', cpuS: 50, probeCpuS: 0, sysBusyMs: 0, sysTotalMs: 0, cores })
    for (let t = 2; t <= END; t += 1) {
      const line: Record<string, unknown> = {
        t,
        phase: 'run',
        cpuS: 200 + 0.3 * t,
        sysBusyMs: busyCores * 1000 * t,
        sysTotalMs: cores * 1000 * t,
        cores,
      }
      if (t <= END - 3) line['probeCpuS'] = 1 + 0.04 * t
      lines.push(line)
    }
    lines.push({ t: END + 1, phase: 'run', cpuS: 999, sysBusyMs: 99e9, sysTotalMs: 1e5, cores }) // after the end
    return lines
  }

  function gpuLines(): Record<string, unknown>[] {
    const lines: Record<string, unknown>[] = [{ t: 0, phase: 'baseline', device: 5 }, { t: 1, phase: 'baseline', device: 5 }]
    for (let t = 0; t <= END + 1; t += 0.5) lines.push({ t, phase: 'run', device: t < WARMUP ? 90 : t > END ? 99 : 10 })
    return lines
  }

  /** 250 Hz probe from probe start (bench startS 0.5): erratic during warm-up, a vsync-locked 2 pt/frame mover after. */
  function probeLines(): Record<string, unknown>[] {
    const lines: Record<string, unknown>[] = []
    for (let i = 0; i * 4 <= (END - 3) * 1000; i++) {
      const tMs = i * 4
      const runMs = tMs + 500
      const x = runMs < WARMUP * 1000 ? 100 + ((i * 37) % 23) : 100 + 2 * Math.floor((runMs - 3) / P)
      lines.push({ t: tMs / 1000, x, y: 1000, w: 240, h: 240, onScreen: true })
    }
    return lines
  }

  const bench = (status: string, source = 'AC Power'): Record<string, unknown> => ({
    probe: { status, startS: 0.5 },
    power: { source, lowPowerMode: false },
    exitCode: 0,
    timedOut: false,
  })

  it('uses only the measured window for GPU, WindowServer, probe and system counters', () => {
    const run: LoadedRun = { base: 'overlay-A1-walk-t', results: results('A1'), bench: bench('ok'), gpu: gpuLines(), ws: wsLines(1), probe: probeLines() }
    const row = summarizeRun(run)
    expect(row.ok).toBe(true)
    expect(row.gpu?.deviceMean).toBe(10)
    expect(row.gpu?.baselineDeviceMean).toBe(5)
    expect(row.windowServer?.meanPct).toBeCloseTo(30)
    expect(row.windowServer?.baselinePct).toBeCloseTo(10)
    expect(row.windowServer?.baselineSpanS).toBeCloseTo(2)
    expect(row.probe).toMatchObject({ status: 'ok', staticWindowChanges: null })
    expect(row.probe?.cpuPctWhileRunning).toBeCloseTo(4)
    // 1 busy core − 0.20 Bitbot − 0.30 WindowServer − probe (0.04 × 7 s over the 10 s span).
    expect(row.conditions?.otherLoadCores).toBeCloseTo(1 - 0.2 - 0.3 - 0.028, 2)
    expect(row.memMB).toBe(191)
    expect(row.rssMB).toBe(343)
    expect(row.notes?.some((n) => n.includes('other processes'))).toBe(false)
  })

  it('skips the warm-up part of the probe, offset by when the probe started', () => {
    const row = summarizeRun({ base: 'b', results: results('A1'), bench: bench('ok'), gpu: gpuLines(), ws: wsLines(1), probe: probeLines() })
    const m = row.motion
    // Probe t is relative to its start (0.5 s into the run): samples before probe t = 1.5 s are warm-up.
    const expected = probeLines().filter((l) => (l['t'] as number) >= WARMUP - 0.5).length
    expect(m?.samples).toBe(expected)
    expect(m?.best?.anomalyPct).toBe(0) // the erratic warm-up jumps were excluded
    expect(m?.updatesPerMovingFrame).toBeCloseTo(1, 1)
  })

  it("uses the run's own long-frame threshold and flags conditions", () => {
    const row = summarizeRun({ base: 'b', results: results('A1'), bench: bench('ok', 'Battery Power'), gpu: gpuLines(), ws: wsLines(3), probe: probeLines() })
    expect(row.renderer?.['longFrameMs']).toBe(25)
    expect(row.renderer?.['pctLong']).toBeCloseTo(0.83, 2) // the 33.3 ms intervals only, not the 22 ms ones
    expect(row.notes).toContain('ran on Battery Power')
    expect(row.notes?.some((n) => n.startsWith('other processes kept ~2.5 cores busy'))).toBe(true)
    expect(row.notes?.some((n) => n.includes('frequency-matched'))).toBe(true) // A1 deadline caveat
  })

  it('B/Bfull: no motion analysis, but the probe confirms the window stayed put', () => {
    const still = probeLines().map((l) => ({ ...l, x: 0, y: 0 }))
    const row = summarizeRun({ base: 'b', results: results('B'), bench: bench('ok'), gpu: gpuLines(), ws: wsLines(1), probe: still })
    expect(row.motion).toBeNull()
    expect(row.motionNote).toMatch(/does not move/)
    expect(row.probe?.staticWindowChanges).toBe(0)
    expect(row.notes?.some((n) => n.includes('frequency-matched'))).toBe(false)
    const moved = summarizeRun({ base: 'b', results: results('B'), bench: bench('ok'), gpu: gpuLines(), ws: wsLines(1), probe: probeLines() })
    expect(moved.notes?.some((n) => n.includes('display-sized window moved'))).toBe(true)
  })

  it('without a probe the row says so', () => {
    const row = summarizeRun({ base: 'b', results: results('A2'), bench: bench('off'), gpu: gpuLines(), ws: wsLines(1), probe: null })
    expect(row.probe?.status).toBe('off')
    expect(row.motion).toBeNull()
    expect(row.motionNote).toBe('no probe data')
  })
})
