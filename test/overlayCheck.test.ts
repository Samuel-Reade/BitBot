import { describe, expect, it } from 'vitest'
import {
  approach,
  canvasArea,
  Chase,
  dragLiftMs,
  dragPatrolAt,
  fallTimeMs,
  lissajousAt,
  makeLissajousPath,
  patrolOffset,
  spanCrossings,
  walkAt,
  type Walk,
  patrolCentreX,
} from '../src/main/dev/checkPaths'
import {
  countDrawnPixels,
  judge,
  newestA2,
  overshoot,
  pairLatencies,
  percentileWithMisses,
  readA2Run,
  rendererDelta,
  verdictLine,
  zOrder,
} from '../src/main/dev/checkVerdicts'
import { aggregateFootprint, parseFootprintOutput } from '../src/main/dev/footprint'
import { cpuPercent, cpuSample, cpuWindow, parsePmset, parsePsCpuTime, type CpuSample, type MetricLike } from '../src/main/dev/metrics'
import { fmt, median, percentileSorted, round, summarize } from '../src/main/dev/stats'
import type { OverlayStatsMsg } from '../src/shared/petProtocol'
import { tuning } from '../src/shared/tuning'

// The dev check's pure helpers (src/main/dev/): statistics, CPU from app-metrics samples, footprint, the scripted
// paths, and the judgments of the verdict. The check itself drives Electron (`electron . --check=overlay`).

const T = tuning.dev.overlayCheck

describe('stats', () => {
  it('summarizes the finite values with linear-interpolated percentiles (Spike A’s definition)', () => {
    const s = summarize([5, 1, 4, 2, 3, Number.NaN])
    expect(s).toMatchObject({ n: 5, mean: 3, min: 1, p50: 3, max: 5 })
    expect(s?.p95).toBeCloseTo(4.8)
    expect(percentileSorted([10, 20], 25)).toBeCloseTo(12.5)
    expect(summarize([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(Number.isNaN(median([]))).toBe(true)
    expect(round(1.23456, 2)).toBe(1.23)
    expect(fmt(null)).toBe('n/a')
    expect(fmt(Number.NaN)).toBe('n/a')
    expect(fmt(2.345, 1)).toBe('2.3')
  })
})

describe('CPU from app metrics', () => {
  const metric = (pid: number, type: MetricLike['type'], cum: number | undefined, pct = 0, wakeups = 0): MetricLike => ({
    pid,
    type,
    cpu: { cumulativeCPUUsage: cum, percentCPUUsage: pct, idleWakeupsPerSecond: wakeups },
  })

  it('reads % of ONE core from cumulative CPU seconds, per process type', () => {
    const samples: CpuSample[] = [
      cpuSample(0, [metric(1, 'Browser', 10), metric(2, 'Tab', 20), metric(3, 'GPU', 30)], 10),
      cpuSample(1000, [metric(1, 'Browser', 10.02, 0, 40), metric(2, 'Tab', 20.05, 0, 10), metric(3, 'GPU', 30.1)], 10),
      cpuSample(2000, [metric(1, 'Browser', 10.04, 0, 60), metric(2, 'Tab', 20.1, 0, 10), metric(3, 'GPU', 30.2)], 10),
    ]
    const w = cpuWindow(samples)
    expect(w.seconds).toBe(2)
    expect(w.byType['Browser']).toBeCloseTo(2)
    expect(w.byType['Tab']).toBeCloseTo(5)
    expect(w.byType['GPU']).toBeCloseTo(10)
    expect(w.total).toBeCloseTo(17)
    expect(w.wakeupsByType['Browser']).toBeCloseTo(50)
    expect(w.fallbacks).toBe(0)
  })

  it('falls back to percentCPUUsage × cores (Electron 44 divides it by the core count) without a cumulative reading', () => {
    // 1.46 normalized on 10 cores = 14.6 % of one core.
    const samples = [
      cpuSample(0, [metric(7, 'Utility', undefined, 0)], 10),
      cpuSample(1000, [metric(7, 'Utility', undefined, 1.46)], 10),
    ]
    const w = cpuWindow(samples)
    expect(w.byType['Utility']).toBeCloseTo(14.6)
    expect(w.fallbacks).toBe(1)
    expect(cpuWindow([]).total).toBe(0)
    expect(cpuWindow([samples[0] as CpuSample]).seconds).toBe(0)
  })

  it('a process that started mid-window counts through its percentCPUUsage samples', () => {
    const samples = [
      cpuSample(0, [metric(1, 'Browser', 1)], 2),
      cpuSample(1000, [metric(1, 'Browser', 1.01), metric(9, 'Tab', 0.5, 5)], 2),
      cpuSample(2000, [metric(1, 'Browser', 1.02), metric(9, 'Tab', 0.6, 5)], 2),
    ]
    const w = cpuWindow(samples)
    expect(w.byType['Browser']).toBeCloseTo(1)
    // 10 % of one core for the second half of the window = 5 % over all of it.
    expect(w.byType['Tab']).toBeCloseTo(5)
  })

  it('reads ps cumulative CPU time and turns two readings into % of one core', () => {
    expect(parsePsCpuTime(' 227:24.35\n')).toBeCloseTo(13644.35)
    expect(parsePsCpuTime('0:01.50')).toBeCloseTo(1.5)
    expect(parsePsCpuTime('1-02:03:04.5')).toBeCloseTo(93784.5)
    expect(parsePsCpuTime('garbage')).toBeNull()
    expect(cpuPercent(1.5, 1.52, 10)).toBeCloseTo(0.2)
    expect(cpuPercent(null, 1, 10)).toBeNull()
    expect(cpuPercent(1, 2, 0)).toBeNull()
  })

  it('reads the power source, battery charge and Low Power Mode from pmset', () => {
    const batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=21299299)\t12%; discharging; 1:28 remaining present: true"
    expect(parsePmset(batt, ' lowpowermode         0\n')).toEqual({ source: 'battery', batteryPct: 12, lowPowerMode: false })
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0\t30%; charging;", ' lowpowermode 1')).toEqual({
      source: 'AC',
      batteryPct: 30,
      lowPowerMode: true,
    })
    expect(parsePmset('', '')).toEqual({ source: null, batteryPct: null, lowPowerMode: null })
  })
})

describe('footprint', () => {
  const OUTPUT = [
    'Electron [4001]: 64-bit    Footprint: 36000000 B (16384 bytes per page)',
    '    phys_footprint: 36070400 B',
    '    phys_footprint_peak: 40000000 B',
    'Electron Helper (GPU) [4002]: 64-bit    Footprint: 108000000 B (16384 bytes per page)',
    '    phys_footprint: 108843008 B',
    '    phys_footprint_peak: 120000000 B',
    'bitbot-helper [4005]: 64-bit    Footprint: 5000000 B (16384 bytes per page)',
    'Summary Footprint: 150000000 B',
  ].join('\n')

  it('sums phys_footprint per type over the given processes only, and lists the ones it could not read', () => {
    const out = parseFootprintOutput(OUTPUT)
    expect(out.byPid.get(4005)).toEqual({ physBytes: 5000000, peakBytes: null })
    const electron = aggregateFootprint(
      [
        { pid: 4001, type: 'Browser' },
        { pid: 4002, type: 'GPU' },
        { pid: 4003, type: 'Tab' },
      ],
      out,
    )
    expect(electron.byType['Browser']).toEqual({ processes: 1, mb: 34.4, peakMB: 38.1 })
    expect(electron.totalMB).toBeCloseTo(34.4 + 103.8, 0)
    expect(electron.missingPids).toEqual([4003])
    expect(electron.dedupTotalMB).toBeCloseTo(143.1)
    expect(aggregateFootprint([{ pid: 4005, type: 'helper' }], out).totalMB).toBeCloseTo(4.8)
  })
})

describe('paths', () => {
  it('patrols back and forth from the centre at constant speed', () => {
    // 120 pt/s, ±100 pt: +100 at 0.833 s, back at 1.667 s, −100 at 2.5 s, home at 3.333 s.
    expect(patrolOffset(0, 100, 120)).toBe(0)
    expect(patrolOffset(500, 100, 120)).toBeCloseTo(60)
    expect(patrolOffset(1250, 100, 120)).toBeCloseTo(50)
    expect(patrolOffset(2500, 100, 120)).toBeCloseTo(-100)
    expect(patrolOffset(3333.34, 100, 120)).toBeCloseTo(0, 1)
    expect(patrolOffset(-5, 100, 120)).toBe(0)
    const walk: Walk = { centerX: 800, groundY: 1000, amplitudePt: 100, speedPtS: 120, startMs: 1000 }
    expect(walkAt(walk, 500)).toEqual({ x: 800, y: 1000 })
    expect(walkAt(walk, 1500).x).toBeCloseTo(860)
    // Never past the patrol's ends, never faster than its speed.
    for (let t = 1000; t < 9000; t += 7) {
      const a = walkAt(walk, t).x
      const b = walkAt(walk, t + 7).x
      expect(Math.abs(a - 800)).toBeLessThanOrEqual(100 + 1e-9)
      expect(Math.abs(b - a)).toBeLessThanOrEqual((120 * 7) / 1000 + 1e-9)
    }
  })

  it('builds Spike A’s Lissajous path inside the canvas area with exactly the peak speed', () => {
    const area = canvasArea({ x: 0, y: 39, width: 1710, height: 983 }, 240, { x: 120, y: 180 })
    expect(area).toEqual({ minX: 120, maxX: 1590, minY: 219, groundY: 1022 })
    const path = makeLissajousPath(area, T.chase)
    let peak = 0
    let prev = lissajousAt(path, 0)
    for (let i = 1; i <= 40_000; i++) {
      const tS = i / 1000
      const p = lissajousAt(path, tS)
      peak = Math.max(peak, Math.hypot(p.x - prev.x, p.y - prev.y) * 1000)
      expect(p.x).toBeGreaterThanOrEqual(area.minX)
      expect(p.x).toBeLessThanOrEqual(area.maxX)
      expect(p.y).toBeGreaterThanOrEqual(area.minY)
      expect(p.y).toBeLessThanOrEqual(area.groundY)
      prev = p
    }
    expect(peak).toBeCloseTo(T.chase.peakSpeed, -1)
  })

  it('chases the target at no more than its speed per step, starting on it', () => {
    const area = { minX: 120, maxX: 1590, minY: 219, groundY: 1022 }
    const path = makeLissajousPath(area, T.chase)
    const chase = new Chase(path, 600, 0)
    const stepS = 1 / 30
    let p = chase.step(0, stepS)
    expect(p).toEqual(lissajousAt(path, 0))
    for (let k = 1; k < 300; k++) {
      const q = chase.step(k * stepS * 1000, stepS)
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThanOrEqual(600 * stepS + 1e-9)
      p = q
    }
    expect(approach({ x: 0, y: 0 }, { x: 3, y: 4 }, 10)).toEqual({ x: 3, y: 4 })
    expect(approach({ x: 0, y: 0 }, { x: 30, y: 40 }, 5)).toEqual({ x: 3, y: 4 })
  })

  it('drag patrol: lifts straight up at its speed, then patrols at the lifted height', () => {
    const d = { start: { x: 800, y: 960 }, liftPt: 220, amplitudePt: 300, speedPtS: 600 }
    expect(dragLiftMs(d)).toBeCloseTo(366.67, 1)
    expect(dragPatrolAt(d, 0)).toEqual({ x: 800, y: 960 })
    expect(dragPatrolAt(d, 183.33).y).toBeCloseTo(850, 0)
    expect(dragPatrolAt(d, dragLiftMs(d))).toEqual({ x: 800, y: 740 })
    expect(dragPatrolAt(d, dragLiftMs(d) + 250)).toEqual({ x: 950, y: 740 })
  })

  it('times a fall from the simulation’s own steps', () => {
    const step = 1000 / 30
    // 288 pt at 2600 pt/s² (Euler, velocity first): lands on the 14th step.
    expect(fallTimeMs(288, tuning.move, step)).toBeCloseTo(14 * step)
    expect(fallTimeMs(0, tuning.move, step)).toBe(0)
    expect(fallTimeMs(1, tuning.move, step)).toBeCloseTo(step)
  })

  it('finds when a still point enters and leaves a moving span', () => {
    // The span [−50, +50] around a pet moving right at 0.1 pt/ms from x = 0: a point at x = 100 is inside from 500 to 1500 ms.
    const crossings = spanCrossings((t) => t * 0.1, 100, { left: -50, right: 50 }, 0, 2000, 1)
    expect(crossings).toEqual([
      { tMs: 500, kind: 'enter' },
      { tMs: 1501, kind: 'leave' },
    ])
    expect(spanCrossings((t) => t, 0, { left: -1, right: 1 }, 10, 5, 1)).toEqual([])
  })
})

describe('verdicts', () => {
  it('pairs each crossing with the first unused toggle of its kind inside the window', () => {
    const crossings = [
      { tMs: 1000, kind: 'enter' as const },
      { tMs: 2000, kind: 'leave' as const },
      { tMs: 3000, kind: 'enter' as const },
      { tMs: 4000, kind: 'leave' as const },
    ]
    const toggles = [
      { tMs: 990, on: true }, // 10 ms early: the halo
      { tMs: 2030, on: false },
      { tMs: 2040, on: true }, // flicker
      { tMs: 4700, on: false }, // too late
    ]
    const pairs = pairLatencies(crossings, toggles, 50, 500)
    expect(pairs.enterMs).toEqual([-10])
    expect(pairs.leaveMs).toEqual([30])
    // The enter at 3000 finds no 'on' in [2950, 3500] (2040 is too early); the leave at 4000 none in time.
    expect(pairs.missedEnter).toBe(1)
    expect(pairs.missedLeave).toBe(1)
    expect(pairs.unpaired).toBe(2)
  })

  it('counts misses as the window in the percentile (a lower bound), null without samples', () => {
    expect(percentileWithMisses([10, 20, 30], 0, 500, 50)).toBe(20)
    expect(percentileWithMisses([10, 20, 30], 1, 500, 95)).toBeCloseTo(429.5)
    expect(percentileWithMisses([], 0, 500, 95)).toBeNull()
  })

  it('measures how far a box sticks out of a rect, and drawn pixels by alpha', () => {
    const outer = { x: 0, y: 0, width: 100, height: 100 }
    expect(overshoot(outer, { x: 10, y: 10, width: 80, height: 80 })).toBe(0)
    expect(overshoot(outer, { x: 30, y: -4, width: 80, height: 50 })).toBe(10)
    expect(countDrawnPixels(Uint8Array.from([0, 0, 0, 0, 9, 9, 9, 200, 9, 9, 9, 8]), 8)).toBe(1)
  })

  it('finds the overlay and the grab area in the helper’s front-to-back list', () => {
    const windows = [
      { wid: 1, layer: 25, onScreen: true },
      { wid: 70, layer: 3, onScreen: true },
      { wid: 60, layer: 3, onScreen: true },
      { wid: 5, layer: 0, onScreen: true },
    ]
    expect(zOrder(windows, 60, 70)).toEqual({
      overlay: { index: 2, layer: 3, onScreen: true },
      grab: { index: 1, layer: 3, onScreen: true },
      between: 0,
    })
    expect(zOrder(windows, 70, 1).between).toBe(0)
    expect(zOrder(windows, 60, 5).between).toBeNull() // behind the overlay
    expect(zOrder(windows, 60, null)).toMatchObject({ grab: null, between: null })
  })

  it('judges max and below limits; report-only and missing limits never gate', () => {
    expect(judge('x', 3, 3, 'ms').pass).toBe(true)
    expect(judge('x', 3, 3, 'ms', { rule: 'below' }).pass).toBe(false)
    expect(judge('x', null, 3, 'ms').pass).toBe(false)
    const missing = judge('main CPU', 2.5, Number.NaN, '%', { rule: 'below', gate: false, detail: 'no A2 run' })
    expect(missing.pass).toBe(false)
    expect(verdictLine(missing)).toBe('N/A (report-only) main CPU: 2.50 % (no limit to compare with); no A2 run')
    expect(verdictLine(judge('drag p95', 15.24, 18.67, 'ms'))).toBe('PASS drag p95: 15.2 ms (limit ≤ 18.7 ms)')
    expect(verdictLine(judge('frames', 3, 0, 'frames'))).toBe('FAIL frames: 3.0 frames (limit ≤ 0.0 frames)')
  })

  it('takes the renderer counters of one phase from two snapshots of the same page load', () => {
    const stats = (frames: number, raf: number[], input: number[]): OverlayStatsMsg => ({
      at: 0,
      frames,
      renders: 1,
      starvedFrames: 0,
      longFrames: 0,
      rafIntervalsMs: raf,
      inputToFrameMs: input,
      cursorMsgs: frames,
      cursorMsgsIgnored: 0,
      hitTests: 0,
      hoverMsgs: 0,
      pointerMsgs: 0,
      contextLosses: 0,
      truncated: false,
    })
    const d = rendererDelta(stats(10, [16, 17], [5]), stats(70, [16, 17, 16.7, 16.6, 33], [5, 8, 12]), 1)
    expect(d).toMatchObject({ frames: 60, framesPerS: 60, renders: 0, cursorMsgs: 60 })
    expect(d?.rafMs).toMatchObject({ n: 3, max: 33 })
    expect(d?.inputToFrameMs).toMatchObject({ n: 2, min: 8, max: 12 })
    // A reload in between (counters went back), or a missing snapshot: no delta.
    expect(rendererDelta(stats(70, [], []), stats(10, [], []), 1)).toBeNull()
    expect(rendererDelta(null, stats(10, [], []), 1)).toBeNull()
  })

  it('reads Spike A’s A2 results and picks the newest good run of the session', () => {
    const result = (mode: string, startedAt: string, ok = true): unknown => ({
      schema: 'bitbot.spike.overlay/1',
      variant: 'A2',
      mode,
      startedAt,
      ok,
      cpu: { byType: { Browser: { cpuMeanCumulative: 10.9 }, Tab: { cpuMeanCumulative: 9.2 } }, total: { cpuMeanCumulative: 30.6 } },
      env: { onBattery: true, loadAvg1m: { start: 3.6, end: 4.2 } },
    })
    const run = readA2Run(result('walk', '2026-10-07T04:41:15.636Z'), 'a.json')
    expect(run).toMatchObject({ mode: 'walk', byType: { Browser: 10.9, Tab: 9.2 }, total: 30.6, onBattery: true, ok: true })
    expect(readA2Run({ ...(result('walk', '2026-10-07T04:41:15Z') as object), variant: 'B' }, 'b.json')).toBeNull()
    expect(readA2Run(result('static', '2026-10-07T04:41:15Z'), 'c.json')).toBeNull()
    expect(readA2Run('nonsense', 'd.json')).toBeNull()
    const at = Date.parse('2026-10-07T12:00:00Z')
    const runs = [
      readA2Run(result('walk', '2026-10-07T11:40:00Z'), 'old.json'),
      readA2Run(result('walk', '2026-10-07T11:50:00Z'), 'new.json'),
      readA2Run(result('walk', '2026-10-07T11:55:00Z', false), 'failed.json'),
      readA2Run(result('walk', '2026-10-07T09:00:00Z'), 'yesterday.json'),
      readA2Run(result('synthetic', '2026-10-07T11:58:00Z'), 'syn.json'),
    ].filter((r) => r !== null)
    expect(newestA2(runs, 'walk', at, 30 * 60_000)?.file).toBe('new.json')
    expect(newestA2(runs, 'synthetic', at, 30 * 60_000)?.file).toBe('syn.json')
    expect(newestA2(runs, 'walk', at, 5 * 60_000)).toBeNull()
  })
})

describe('tuning.dev.overlayCheck', () => {
  it('keeps the scripted motion where the check expects it', () => {
    // The parked cursor is cleared at the patrol's turns but stays near: the box half-width is ~86 pt for size M.
    expect(T.walkParkedSpanPt).toBeLessThan(86 + tuning.hitArea.nearMarginPt)
    // A round trip is not a whole number of steps: the crossings drift through the phases of the simulation's wake.
    const stepsPerTrip = ((4 * T.walkParkedSpanPt) / tuning.move.walkSpeed) * tuning.sim.hz
    expect(Math.abs(stepsPerTrip - Math.round(stepsPerTrip))).toBeGreaterThan(0.2)
    // Near the pet, off it, within the near margin even when the cursor circles.
    expect(T.nearCursor.gapPt - T.nearCursor.wobblePt).toBeGreaterThan(0)
    expect(T.nearCursor.gapPt + T.nearCursor.wobblePt).toBeLessThanOrEqual(tuning.hitArea.nearMarginPt)
    // Binary search: the last probe still moves the cursor enough for main to send a new cursor sample.
    expect((86 + tuning.hitArea.safetyMarginPt / 2) / 2 ** T.calibration.steps).toBeGreaterThan(tuning.hitArea.cursorStreamMinMovePt)
    expect(T.calibration.probeMs).toBeGreaterThan(1000 / tuning.sim.hz)
    // The chase saturates, like Spike A's synthetic mode.
    expect(T.chase.peakSpeed).toBeGreaterThan(T.chase.speed)
    // Drag moves land at every phase of a 60 Hz frame.
    expect((1000 / 60) % T.dragPatrol.eventIntervalMs).not.toBe(0)
  })
})

describe('patrolCentreX: a drag patrol clear of the resting mouse', () => {
  it('home when the mouse is clear of the sweep', () => {
    expect(patrolCentreX(855, 1600, 50, 1660, 434, 20)).toBe(855)
  })
  it('the nearest centre at least reach + margin from the mouse, inside the area', () => {
    // The mouse at 1198 (inside the sweep of 855 ± 434): the left option 744 fits, the right (1652) doesn't.
    expect(patrolCentreX(855, 1198, 50, 1660, 434, 20)).toBe(744)
    expect(patrolCentreX(855, 600, 50, 1660, 434, 20)).toBe(1054)
  })
  it('home when no centre fits (a narrow display)', () => {
    expect(patrolCentreX(500, 500, 0, 1000, 434, 20)).toBe(500)
  })
})
