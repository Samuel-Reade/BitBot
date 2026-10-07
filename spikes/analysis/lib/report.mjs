// Loads Spike A runs (harness JSON + bench side files) and turns them into summary rows and Markdown.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeWindowMotion } from './judder.mjs'
import { cumulativeTimes, fractionAbove, phaseLock, round, summarize } from './stats.mjs'

export const RESULTS_SCHEMA = 'bitbot.spike.overlay/1'
const VARIANT_ORDER = ['A1', 'A2', 'B', 'Bfull']
const MODE_ORDER = ['static', 'walk', 'synthetic', 'follow', 'interactive']
const PROCESS_TYPES = ['Browser', 'Tab', 'GPU', 'Utility']
/** Only for results that predate renderer.longFrameMs; each run records the threshold it used (tuning.spikeOverlay.longFrameMs). */
const DEFAULT_LONG_FRAME_MS = 20

/** Sort key: variant, then A1's interval timer and no-panel runs after the defaults. */
function variantRank(results) {
  return (
    VARIANT_ORDER.indexOf(results.variant) * 4 +
    (results.variant === 'A1' && results.options?.a1Timer === 'interval' ? 1 : 0) +
    (results.options?.windowType === 'none' ? 2 : 0)
  )
}

function readJsonLines(file) {
  if (!existsSync(file)) return null
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      out.push(JSON.parse(text))
    } catch {
      // A truncated last line (killed sampler) is expected; skip it.
    }
  }
  return out
}

function readJson(file) {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** All harness results in `dir` (non-recursive) plus their bench side files. */
export function loadRuns(dir) {
  const runs = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith('overlay-') || !name.endsWith('.json') || name.endsWith('.bench.json') || name.startsWith('overlay-summary')) continue
    let results
    try {
      results = readJson(join(dir, name))
    } catch (err) {
      runs.push({ base: name.slice(0, -5), error: `unreadable: ${err.message}` })
      continue
    }
    if (!results || results.schema !== RESULTS_SCHEMA) continue
    const base = name.slice(0, -5)
    const probeLines = readJsonLines(join(dir, `${base}.probe.jsonl`))
    runs.push({
      base,
      results,
      bench: readJson(join(dir, `${base}.bench.json`)),
      gpu: readJsonLines(join(dir, `${base}.gpu.jsonl`)),
      ws: readJsonLines(join(dir, `${base}.ws.jsonl`)),
      probe: probeLines ? probeLines.filter((l) => !l.summary) : null,
      probeSummary: probeLines?.find((l) => l.summary)?.summary ?? null,
    })
  }
  return runs.sort((a, b) => {
    const ra = a.results
    const rb = b.results
    if (!ra || !rb) return a.base.localeCompare(b.base)
    return variantRank(ra) - variantRank(rb) || MODE_ORDER.indexOf(ra.mode) - MODE_ORDER.indexOf(rb.mode) || a.base.localeCompare(b.base)
  })
}

/** Display frame period: nominal from the display, cross-checked against the renderer's rAF. */
function framePeriod(results) {
  const nominal = 1000 / (results.display?.displayFrequency || 60)
  const raf = results.renderer?.rawRafIntervalsMs ?? []
  let frames = 0
  let span = 0
  for (const d of raf) {
    const k = Math.round(d / nominal)
    if (k >= 1) {
      frames += k
      span += d
    }
  }
  const measured = frames > 30 ? span / frames : null
  return { periodMs: nominal, rafPeriodMs: measured }
}

function windowStats(samples, fromS, toS) {
  if (!samples) return null
  const inRun = samples.filter((s) => s.phase !== 'baseline' && s.t >= fromS && s.t <= toS)
  const baseline = samples.filter((s) => s.phase === 'baseline')
  return { inRun, baseline }
}

function gpuSummary(run, fromS, toS) {
  const w = windowStats(run.gpu, fromS, toS)
  if (!w || w.inRun.length === 0) return null
  const pick = (xs, key) => xs.map((s) => s[key]).filter((v) => Number.isFinite(v))
  const dev = summarize(pick(w.inRun, 'device'))
  const ren = summarize(pick(w.inRun, 'renderer'))
  const base = summarize(pick(w.baseline, 'device'))
  return {
    samples: w.inRun.length,
    deviceMean: round(dev?.mean, 1),
    deviceP95: round(dev?.p95, 1),
    rendererMean: round(ren?.mean, 1),
    baselineDeviceMean: round(base?.mean, 1),
  }
}

/** CPU (% of one core) from cumulative CPU-time samples of `key` (WindowServer: cpuS, probe: probeCpuS). */
function cpuFromCumulative(samples, key = 'cpuS') {
  const pts = (samples ?? []).filter((s) => Number.isFinite(s[key]))
  if (pts.length < 2) return null
  const first = pts[0]
  const last = pts[pts.length - 1]
  const mean = last.t > first.t ? ((last[key] - first[key]) / (last.t - first.t)) * 100 : null
  const perInterval = []
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t
    if (dt > 0) perInterval.push(((pts[i][key] - pts[i - 1][key]) / dt) * 100)
  }
  return { mean, p95: summarize(perInterval)?.p95 ?? null, cpuS: last[key] - first[key], spanS: last.t - first.t }
}

function windowServerSummary(run, fromS, toS) {
  const w = windowStats(run.ws, fromS, toS)
  if (!w) return null
  const during = cpuFromCumulative(w.inRun)
  const before = cpuFromCumulative(w.baseline)
  if (!during) return null
  return {
    meanPct: round(during.mean, 1),
    p95Pct: round(during.p95, 1),
    baselinePct: round(before?.mean, 1),
    baselineSpanS: before ? round(before.spanS, 2) : null,
  }
}

/** The window-position probe's own CPU during the measured window (it stops ~3 s before the run ends). */
function probeCpu(run, fromS, toS) {
  const w = windowStats(run.ws, fromS, toS)
  const c = w ? cpuFromCumulative(w.inRun, 'probeCpuS') : null
  return c ? { pctWhileRunning: c.mean, cpuS: c.cpuS } : null
}

/** Whole-machine busy cores (all processes, from os.cpus() counters) during the run and the pause before it. */
function systemBusyCores(run, fromS, toS) {
  const w = windowStats(run.ws, fromS, toS)
  if (!w) return null
  const busy = (xs) => {
    const pts = xs.filter((s) => Number.isFinite(s.sysBusyMs) && Number.isFinite(s.sysTotalMs))
    if (pts.length < 2) return null
    const a = pts[0]
    const b = pts[pts.length - 1]
    const dTotal = b.sysTotalMs - a.sysTotalMs
    return dTotal > 0 ? { cores: ((b.sysBusyMs - a.sysBusyMs) / dTotal) * (b.cores ?? 1), spanS: b.t - a.t } : null
  }
  const during = busy(w.inRun)
  return during === null ? null : { during: during.cores, spanS: during.spanS, baseline: busy(w.baseline)?.cores ?? null }
}

/** Position changes of a window that should not move (B/Bfull probe), or null without probe data. */
function staticWindowChanges(probe) {
  if (!probe || probe.length === 0) return null
  const pts = probe.filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y))
  let changes = 0
  for (let i = 1; i < pts.length; i++) if (pts[i].x !== pts[i - 1].x || pts[i].y !== pts[i - 1].y) changes++
  return changes
}

/** One summary row per run. */
export function summarizeRun(run) {
  if (!run.results) return { base: run.base, ok: false, errors: [run.error ?? 'no results'] }
  const r = run.results
  const warmupS = r.measure?.warmupS ?? 2
  const endS = r.measure?.endS ?? Number.POSITIVE_INFINITY
  const { periodMs, rafPeriodMs } = framePeriod(r)
  const notes = []
  if (rafPeriodMs && Math.abs(rafPeriodMs - periodMs) / periodMs > 0.005) {
    notes.push(`rAF period ${rafPeriodMs.toFixed(3)} ms differs from the display's ${periodMs.toFixed(3)} ms`)
  }

  const cpu = {}
  for (const type of [...PROCESS_TYPES, 'total']) {
    const s = type === 'total' ? r.cpu?.total : r.cpu?.byType?.[type]
    cpu[type] = s ? { mean: s.cpuMeanCumulative ?? s.cpuMean, p95: s.cpuP95 } : null
  }

  let renderer = null
  if (r.renderer) {
    const raf = r.renderer.rawRafIntervalsMs ?? []
    const s = summarize(raf)
    const longFrameMs = r.renderer.longFrameMs ?? DEFAULT_LONG_FRAME_MS
    renderer = {
      frames: r.renderer.frames,
      rafMean: round(s?.mean, 2),
      rafP95: round(s?.p95, 2),
      rafP99: round(s?.p99, 2),
      rafMax: round(s?.max, 2),
      longFrameMs,
      pctLong: round(fractionAbove(raf, longFrameMs) * 100, 2),
      renderP95: r.renderer.renderMs?.p95 ?? null,
      callbackP95: r.renderer.callbackMs?.p95 ?? null,
      starved: r.renderer.starvedFrames,
      mousemoves: r.renderer.mousemoves,
    }
  }

  let presentation = null
  if (r.presentation) {
    const p = r.presentation
    const raw = p.rawIntervalsMs ?? []
    const s = summarize(raw)
    const lock = phaseLock(cumulativeTimes(raw), periodMs)
    presentation = {
      driver: p.driver,
      ticks: p.ticks,
      intervalMean: round(s?.mean, 2),
      intervalStdev: round(s?.stdev, 2),
      intervalP95: round(s?.p95, 2),
      intervalP99: round(s?.p99, 2),
      intervalMax: round(s?.max, 2),
      phaseLockR: round(lock?.R, 3),
      setPositionCalls: p.setPosition?.calls ?? 0,
      setPositionP95: p.setPosition?.durationMs?.p95 ?? null,
      starved: p.starved,
      frameLatencyP95: p.frameLatencyMs?.p95 ?? null,
      positionMismatches: p.positionMismatches,
    }
  }

  const a1Deadline = r.variant === 'A1' && (r.options?.a1Timer ?? 'deadline') === 'deadline'
  if (a1Deadline && r.mode !== 'static') {
    notes.push(
      "A1's deadline timer is frequency-matched to the display: lock R and best-phase judder cannot show beating within one run; read the 'avg' judder",
    )
  }

  let motion = null
  let motionNote = null
  let windowChanges = null
  if (r.variant === 'A1' || r.variant === 'A2') {
    if (run.probe && run.probe.length > 0) {
      const probeStartS = run.bench?.probe?.startS ?? 0
      motion = analyzeWindowMotion(run.probe, { periodMs, skipS: Math.max(0, warmupS - probeStartS) })
      if (r.mode === 'static') motionNote = 'static: the window does not move'
      else if (motion.probe && motion.probe.maxIntervalMs > periodMs) {
        notes.push(`probe sampling gap up to ${motion.probe.maxIntervalMs} ms (> one frame): frame metrics are approximate`)
      }
    } else {
      motionNote = run.bench?.probe?.status === 'missing' ? 'probe not built (build/tools/probe)' : 'no probe data'
    }
  } else {
    motionNote = 'n/a: the window does not move'
    windowChanges = staticWindowChanges(run.probe)
    if (windowChanges) notes.push(`the display-sized window moved ${windowChanges}× during the run (expected 0)`)
  }

  const bench = run.bench
  if (bench?.timedOut) notes.push('watchdog killed the run')
  if (bench && bench.exitCode !== 0 && bench.exitCode !== null) notes.push(`harness exit code ${bench.exitCode}`)

  // Measurement conditions. CPU time depends on P- vs E-core scheduling, which load and power shift.
  const windowServer = windowServerSummary(run, warmupS, endS)
  const sys = systemBusyCores(run, warmupS, endS)
  const probeLoad = probeCpu(run, warmupS, endS)
  const bitbotCores = (cpu.total?.mean ?? 0) / 100
  // The probe's CPU averaged over the same span as the whole-machine counters (it stops ~3 s early).
  const probeCores = probeLoad && sys && sys.spanS > 0 ? probeLoad.cpuS / sys.spanS : 0
  const otherLoadCores = sys ? round(sys.during - bitbotCores - (windowServer?.meanPct ?? 0) / 100 - probeCores, 2) : null
  const conditions = {
    power: bench?.power?.source ?? (r.env?.onBattery === true ? 'Battery Power' : r.env?.onBattery === false ? 'AC Power' : null),
    lowPowerMode: bench?.power?.lowPowerMode ?? null,
    thermalState: r.env?.thermalState ?? null,
    loadAvg1m: r.env?.loadAvg1m?.start ?? null,
    systemBusyCores: sys ? round(sys.during, 2) : null,
    baselineBusyCores: sys ? round(sys.baseline, 2) : null,
    otherLoadCores,
  }
  if (conditions.power && conditions.power !== 'AC Power') notes.push(`ran on ${conditions.power}`)
  if (conditions.lowPowerMode) notes.push('Low Power Mode was on')
  if (conditions.thermalState && !['nominal', 'unknown'].includes(conditions.thermalState)) notes.push(`thermal state ${conditions.thermalState}`)
  if (otherLoadCores !== null && otherLoadCores > 0.5) notes.push(`other processes kept ~${otherLoadCores.toFixed(1)} cores busy: CPU numbers are suspect`)

  if (r.memory && !r.memory.footprint) notes.push(`no footprint memory reading (${r.memory.footprintError ?? 'unknown'})`)

  return {
    base: run.base,
    variant: r.variant,
    mode: r.mode,
    label: r.label,
    ok: r.ok === true && (r.errors?.length ?? 0) === 0,
    errors: r.errors ?? [],
    warnings: r.warnings ?? [],
    notes,
    windowType: r.options?.windowType,
    a1Timer: r.variant === 'A1' ? r.options?.a1Timer : null,
    measuredS: r.measure?.measuredS,
    startedAt: r.startedAt,
    periodMs: round(periodMs, 4),
    rafPeriodMs: round(rafPeriodMs, 4),
    cpu,
    /** Activity Monitor "Memory" (phys_footprint) summed over Bitbot's processes at the end of the run: the §11 unit. */
    memMB: r.memory?.footprint?.totalMB ?? null,
    memByType: r.memory?.footprint?.byType ?? null,
    /** Summed resident set size (workingSetSize), mean over the run: NOT the §11 unit. */
    rssMB: r.memory?.rssMeanMB ?? r.cpu?.total?.memMeanMB ?? null,
    wakeups: r.cpu?.total?.wakeupsMean ?? null,
    gpu: gpuSummary(run, warmupS, endS),
    windowServer,
    probe: {
      status: bench?.probe?.status ?? null,
      cpuPctWhileRunning: round(probeLoad?.pctWhileRunning, 1),
      staticWindowChanges: windowChanges,
    },
    conditions,
    renderer,
    presentation,
    motion,
    motionNote,
    interaction: {
      hoverToggles: r.interaction?.clickThroughToggles ?? 0,
      safetyNet: r.interaction?.safetyNet ?? 0,
      safetyNetMissedLeaves: r.interaction?.safetyNetMissedLeaves ?? null,
      activations: r.interaction?.activations ?? 0,
    },
    env: { electron: r.env?.electron, chrome: r.env?.chrome, macos: r.env?.macos, cpu: r.env?.cpu, display: r.display },
  }
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────

const f = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v).toFixed(d))
const pair = (a, b, d = 1) => (a === null || a === undefined ? '—' : `${f(a, d)} / ${f(b, d)}`)

function table(header, rows) {
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

const HEADER = `# Spike A — overlay approach benchmark

How to read this (BITBOT_SPEC.md §12, §5.2, §11; runner and harness: spikes/README-overlay.md):

- **Runs**: each variant × mode ran for the stated time; the first 2 s are warm-up and excluded everywhere.
  A1 = small window moved by a 60 Hz main-process timer (drift-free deadlines); "A1 (interval)" = the same
  with a naive \`setInterval\` (≈58.8 Hz in Electron's main process: the literal "free-running timer" case);
  A2 = small window moved on every renderer requestAnimationFrame; B = display-sized window, small canvas
  moved with a CSS transform; Bfull = display-sized window and canvas, pet placed with
  camera.setViewOffset. Every variant renders on every rAF (no adaptive throttling), so these are
  worst-case costs, not the §11 steady state.
- **CPU %** is percent of ONE core (Activity Monitor style; 100 = one core busy), mean over the run from
  cumulative CPU time, "/ p95" from 1 s samples. Browser = Electron main, Tab = renderer, GPU = GPU
  process, Utility = network/audio services. Total = all Bitbot processes (§11 budget: < 3 % roaming).
  Electron's own \`percentCPUUsage\` is divided by the core count and is NOT used.
- **mem MB** = Activity Monitor's "Memory" (the kernel's phys_footprint) summed over all Bitbot
  processes, read with \`footprint\` once at the end of the run: the unit of the §11 budget (< 300 MB).
  **RSS MB** = summed resident set size (Electron workingSetSize, mean over the run). RSS counts shared
  framework pages once per process and misses GPU memory, so it is NOT comparable with the budget
  (it reads ~1.8× higher here).
- **wakeups/s** = idle CPU wakeups per second summed over Bitbot's processes (Electron
  idleWakeupsPerSecond; a main driver of macOS "Energy Impact"; lower is better).
- **WindowServer %** is the macOS compositor's CPU during the run (same unit); "base" = its CPU over the
  idle pause just before the run (default 2 s; \`ps\` CPU time has 10 ms resolution, so ±0.5 points). It
  includes everything else on screen, so compare runs made back to back.
- **probe** = status of the 250 Hz window-position probe (\`build/tools/probe winpos\`): ok / failed /
  missing (not built) / off (\`-P\`). It runs during the first D−3 s of EVERY variant's run (B/Bfull: on
  their static window) because its window-server queries cost WindowServer ~2-3 points of a core
  themselves — about the size of the A-vs-B difference. So WindowServer % is comparable between runs
  with the same probe status only, and includes that probe cost.
- **GPU %** is ioreg "Device Utilization %" (whole GPU, all apps), sampled every 0.5 s: mean / p95.
- **other load (cores)** = whole-machine busy cores during the run minus Bitbot, WindowServer and the
  probe. Above ~0.5 something else was competing: macOS then moves threads between performance and
  efficiency cores and CPU % for the same work can change several-fold. Trust only runs made on an idle
  Mac on AC power, and prefer the medians across repeats (\`-r N\`) when present.
- **Renderer frames**: intervals between requestAnimationFrame timestamps (vsync-aligned BeginFrames).
  16.7 ms = every frame produced; "% long" = share of intervals above the run's long-frame threshold
  (tuning.spikeOverlay.longFrameMs, 20 ms), i.e. at least one frame skipped.
- **Presentation (A1/A2)**: real time between window moves in main. "lock R" = how constant the moves'
  phase is modulo the display's frame period over the run (1 = always the same point of the frame,
  ≈0 = spread across it). R≈0 proves a rate mismatch that beats within the run (e.g. "A1 (interval)").
  R≈1 does NOT prove vsync alignment: A1's deadline timer runs at 60.000 Hz against the display's
  ~60.002 Hz, so its phase drifts only ~0.6 ms per 15 s (one beat every ~7 min) — within a run it sits at
  a fixed but random point of the frame. A2's moves follow the real vsync. setPosition p95 = time main
  spends in BrowserWindow.setPosition.
- **Window motion (A1/A2, from the probe)**: what the window server actually did.
  "interval" = time between observed position changes (mean ± stdev, CV = stdev/mean; ±2 ms probe
  quantization included). "0 / ≥2 upd" = % of display frames (while moving ≥ 1.5 pt/frame) with no
  position change (a visible hitch) or two or more (a skipped step) — the judder indicator. The vsync
  phase is unknown to the probe, so it is shown at the best alignment, averaged over all alignments, and
  at the worst one ("worst %" = 0 + ≥2 combined). For A1's frequency-matched deadline timer a run's real
  phase is fixed but random, so best and worst bracket what different runs (or minutes) look like and
  "avg" is the long-run expectation: compare A1 with A2 on "avg".
  Frames are counted with an interval-aware assignment (each change may sit anywhere in its 4 ms probe
  interval), so these are lower bounds; rate mismatches (a 58.8 Hz timer → ~2 % empty frames) are exact.
  "gap" = longest time without a position change.
`

/** Display name of a summary row: variant plus non-default A1 timer / window type. */
export function rowName(r) {
  return `${r.variant}${r.a1Timer && r.a1Timer !== 'deadline' ? ` (${r.a1Timer})` : ''}${r.windowType === 'none' ? ' [no panel]' : ''}`
}

/** Markdown report for summary rows. */
export function renderMarkdown(rows, meta) {
  const ok = rows.filter((r) => r.variant)
  const env = ok[0]?.env
  const parts = [HEADER]
  parts.push(
    `Generated ${meta.generatedAt} from \`${meta.dir}\` — ${ok.length} run(s).` +
      (env
        ? ` Electron ${env.electron} (Chrome ${env.chrome}), macOS ${env.macos}, ${env.cpu}, display ` +
          `${env.display?.bounds?.width}×${env.display?.bounds?.height} pt @${env.display?.scaleFactor}x ` +
          `${f(env.display?.displayFrequency, 2)} Hz.`
        : ''),
  )
  const name = rowName

  parts.push('## Resources\n')
  parts.push(
    table(
      [
        'variant',
        'mode',
        's',
        'CPU total',
        'Browser',
        'Tab',
        'GPU proc',
        'Utility',
        'mem MB',
        'RSS MB',
        'wakeups/s',
        'GPU %',
        'WindowServer % (base)',
        'probe',
        'other load (cores)',
        'ok',
      ],
      ok.map((r) => [
        name(r),
        r.mode,
        f(r.measuredS, 1),
        pair(r.cpu.total?.mean, r.cpu.total?.p95),
        pair(r.cpu.Browser?.mean, r.cpu.Browser?.p95),
        pair(r.cpu.Tab?.mean, r.cpu.Tab?.p95),
        pair(r.cpu.GPU?.mean, r.cpu.GPU?.p95),
        f(r.cpu.Utility?.mean),
        f(r.memMB, 0),
        f(r.rssMB, 0),
        f(r.wakeups, 0),
        r.gpu ? pair(r.gpu.deviceMean, r.gpu.deviceP95, 0) : '—',
        r.windowServer ? `${f(r.windowServer.meanPct)} (${f(r.windowServer.baselinePct)})` : '—',
        r.probe?.status ?? '—',
        f(r.conditions?.otherLoadCores, 2),
        r.ok ? 'yes' : `**NO** (${r.errors.length} err)`,
      ]),
    ),
  )

  parts.push('\n## Frame pacing\n')
  parts.push(
    table(
      ['variant', 'mode', 'rAF mean / p95 / p99 ms', '% long', 'render p95 ms', 'starved', 'present mean ± sd ms', 'present p95 / p99', 'lock R', 'setPosition (p95 ms)'],
      ok.map((r) => [
        name(r),
        r.mode,
        r.renderer ? `${f(r.renderer.rafMean, 2)} / ${f(r.renderer.rafP95, 2)} / ${f(r.renderer.rafP99, 2)}` : '—',
        r.renderer ? f(r.renderer.pctLong, 2) : '—',
        r.renderer ? f(r.renderer.renderP95, 2) : '—',
        r.renderer || r.presentation ? `${r.renderer?.starved ?? 0}/${r.presentation?.starved ?? 0}` : '—',
        r.presentation ? `${f(r.presentation.intervalMean, 2)} ± ${f(r.presentation.intervalStdev, 2)}` : '—',
        r.presentation ? `${f(r.presentation.intervalP95, 2)} / ${f(r.presentation.intervalP99, 2)}` : '—',
        r.presentation ? f(r.presentation.phaseLockR, 3) : '—',
        r.presentation ? `${r.presentation.setPositionCalls} (${f(r.presentation.setPositionP95, 2)})` : '—',
      ]),
    ),
  )

  parts.push('\n## Window motion seen by the window server (A1/A2)\n')
  parts.push(
    table(
      [
        'variant',
        'mode',
        'changes',
        'interval mean ± sd ms (CV)',
        'gap ms',
        'moving frames',
        'upd/frame',
        '0 / ≥2 upd % best',
        '0 / ≥2 upd % avg',
        'worst %',
        'midpoint est. % best',
        'lock R',
      ],
      ok
        .filter((r) => r.variant === 'A1' || r.variant === 'A2')
        .map((r) => {
          const m = r.motion
          if (!m || r.mode === 'static' || !m.changeIntervalMs) return [name(r), r.mode, m ? String(m.changes) : '—', r.motionNote ?? '—', '', '', '', '', '', '', '', '']
          return [
            name(r),
            r.mode,
            String(m.changes),
            `${f(m.changeIntervalMs.mean, 2)} ± ${f(m.changeIntervalMs.stdev, 2)} (${f(m.changeIntervalMs.cv, 3)})`,
            f(m.longestGapMs, 1),
            String(m.movingFrames),
            f(m.updatesPerMovingFrame, 3),
            m.best ? `${f(m.best.zeroPct, 2)} / ${f(m.best.multiPct, 2)}` : '—',
            m.avg ? `${f(m.avg.zeroPct, 2)} / ${f(m.avg.multiPct, 2)}` : '—',
            f(m.worstAnomalyPct, 2),
            m.bestMidpoint ? `${f(m.bestMidpoint.zeroPct, 2)} / ${f(m.bestMidpoint.multiPct, 2)}` : '—',
            m.phaseLock ? f(m.phaseLock.R, 3) : '—',
          ]
        }),
    ),
  )

  const groups = new Map()
  for (const r of ok) {
    const key = `${name(r)}|${r.mode}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  if ([...groups.values()].some((g) => g.length > 1)) {
    const med = (xs) => {
      const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
      if (v.length === 0) return null
      const m = v.length >> 1
      return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
    }
    parts.push('\n## Medians across repeats\n')
    parts.push(
      table(
        [
          'variant',
          'mode',
          'runs',
          'CPU total',
          'Browser',
          'Tab',
          'GPU proc',
          'mem MB',
          'WindowServer %',
          'GPU %',
          'rAF p99 ms',
          '% long',
          'present sd ms',
          '0/≥2 upd % avg',
          '0/≥2 upd % best',
        ],
        [...groups.values()].map((g) => {
          const r0 = g[0]
          return [
            name(r0),
            r0.mode,
            String(g.length),
            f(med(g.map((r) => r.cpu.total?.mean))),
            f(med(g.map((r) => r.cpu.Browser?.mean))),
            f(med(g.map((r) => r.cpu.Tab?.mean))),
            f(med(g.map((r) => r.cpu.GPU?.mean))),
            f(med(g.map((r) => r.memMB)), 0),
            f(med(g.map((r) => r.windowServer?.meanPct))),
            f(med(g.map((r) => r.gpu?.deviceMean)), 0),
            f(med(g.map((r) => r.renderer?.rafP99)), 2),
            f(med(g.map((r) => r.renderer?.pctLong)), 2),
            f(med(g.map((r) => r.presentation?.intervalStdev)), 2),
            f(med(g.map((r) => (r.mode === 'static' ? null : r.motion?.avg?.anomalyPct))), 2),
            f(med(g.map((r) => (r.mode === 'static' ? null : r.motion?.best?.anomalyPct))), 2),
          ]
        }),
      ),
    )
  }

  parts.push('\n## Interaction counters and notes\n')
  for (const r of rows) {
    if (!r.variant) {
      parts.push(`- \`${r.base}\`: ${r.errors.join('; ')}`)
      continue
    }
    const c = r.conditions ?? {}
    const bits = [
      `${c.power ?? 'power ?'}${c.thermalState ? `, thermal ${c.thermalState}` : ''}${c.loadAvg1m !== null && c.loadAvg1m !== undefined ? `, load ${c.loadAvg1m}` : ''}`,
      `click-through toggles ${r.interaction.hoverToggles}`,
      `safety net ${r.interaction.safetyNet}${r.interaction.safetyNetMissedLeaves !== null ? ` (missed leaves ${r.interaction.safetyNetMissedLeaves})` : ''}`,
      `app activations ${r.interaction.activations}`,
      `mousemoves seen ${r.renderer?.mousemoves ?? '—'}`,
    ]
    if (r.memByType) {
      bits.push(`footprint MB ${Object.entries(r.memByType).map(([type, v]) => `${type} ${f(v.mb, 0)}`).join(', ')}`)
    }
    if (r.probe?.cpuPctWhileRunning !== null && r.probe?.cpuPctWhileRunning !== undefined) bits.push(`probe CPU ${f(r.probe.cpuPctWhileRunning)} %`)
    if (r.motionNote && r.variant.startsWith('A')) bits.push(r.motionNote)
    for (const n of r.notes) bits.push(n)
    for (const e of r.errors.slice(0, 3)) bits.push(`ERROR: ${e}`)
    if (r.warnings.length) bits.push(`${r.warnings.length} warning(s): ${r.warnings.slice(0, 2).join('; ')}`)
    parts.push(`- \`${r.base}\`: ${bits.join(' · ')}`)
  }
  return `${parts.join('\n')}\n`
}
