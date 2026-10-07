#!/usr/bin/env node
// One Spike A benchmark run (called by spikes/run-overlay-bench.sh inside the repo build lock).
//   node spikes/analysis/bench-run.mjs --variant=A1|A1i|A2|B|Bfull --mode=walk --duration=20 --label=L --dir=DIR
//        [--pause=2] [--probe=build/tools/probe] [--probe-hz=250] [--no-probe] [-- extra harness args]
//
// A1i is a bench alias: the A1 harness with the naive setInterval timer (--a1-timer=interval); its
// results get the label L-a1i so they sit next to A1's.
//
// 1. Pause/baseline: samples GPU utilization and WindowServer CPU for --pause seconds, plus one
//    final sample at the end of the pause.
// 2. Launches the harness: env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron <repo> --spike=overlay …
// 3. On its "[spike:overlay] wid=N" line: samples `ioreg` GPU utilization every 0.5 s, WindowServer
//    (and probe) CPU time every 1 s, and runs `probe winpos --wid N --hz 250 --seconds D-3`.
// 4. Watchdog: SIGTERM after D+25 s (the harness flushes its results), SIGKILL of the whole process
//    group 8 s later. Nothing is left running.
// Side files next to the harness JSON: <base>.log, .gpu.jsonl, .ws.jsonl, .probe.jsonl, .bench.json
// (base = overlay-<variant>-<mode>-<label>). Reads nothing but GPU/CPU counters and window bounds.

import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { cpus } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { benchTarget, parseIoregUtilization, parsePsPidTimes } from './lib/system.mjs'

const execFileP = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VARIANTS = ['A1', 'A1i', 'A2', 'B', 'Bfull']
const MODES = ['static', 'walk', 'synthetic', 'follow', 'interactive']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const opts = {}
  const extra = []
  let rest = false
  for (const a of argv) {
    if (rest) extra.push(a)
    else if (a === '--') rest = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq === -1) opts[a.slice(2)] = 'true'
      else opts[a.slice(2, eq)] = a.slice(eq + 1)
    }
  }
  return { opts, extra }
}

const { opts, extra } = parseArgs(process.argv.slice(2))
const variant = opts.variant
const mode = opts.mode
const duration = Number(opts.duration ?? 20)
const label = opts.label
if (!VARIANTS.includes(variant) || !MODES.includes(mode) || !(duration > 0) || !label || !/^[A-Za-z0-9._-]+$/.test(label)) {
  console.error(
    'usage: bench-run.mjs --variant=A1|A1i|A2|B|Bfull --mode=static|walk|synthetic|follow|interactive --duration=S>0 --label=L [--dir=DIR] [--no-probe]',
  )
  process.exit(64)
}
const target = benchTarget(variant, label)
const dir = resolve(ROOT, opts.dir ?? 'spike-results')
const pauseS = Number(opts.pause ?? 2)
const probePath = opts.probe ? (isAbsolute(opts.probe) ? opts.probe : resolve(ROOT, opts.probe)) : join(ROOT, 'build/tools/probe')
const probeHz = Number(opts['probe-hz'] ?? 250)
const probeOff = opts['no-probe'] === 'true'
const base = `overlay-${target.variant}-${mode}-${target.label}`
mkdirSync(dir, { recursive: true })
const file = (ext) => join(dir, `${base}${ext}`)

const log = createWriteStream(file('.log'))
const gpuOut = createWriteStream(file('.gpu.jsonl'))
const wsOut = createWriteStream(file('.ws.jsonl'))
const say = (line) => {
  console.log(line)
  log.write(`# ${line}\n`)
}

async function windowServerPid() {
  try {
    const { stdout } = await execFileP('pgrep', ['-x', 'WindowServer'])
    const pid = Number(stdout.trim().split('\n')[0])
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Calls `fn` every `periodMs` (never overlapping), writing {t, phase, ...result} lines. The returned
 * stop() ends the wait at once and can take one last sample (so a phase ends with a sample).
 */
function startSampler(fn, periodMs, out, phase, t0) {
  let stopped = false
  let timer = null
  let wake = null
  const write = (value) => {
    if (value) out.write(`${JSON.stringify({ t: Number(((performance.now() - t0) / 1000).toFixed(4)), phase, ...value })}\n`)
  }
  const loop = async () => {
    while (!stopped) {
      const started = performance.now()
      try {
        const value = await fn()
        if (!stopped) write(value)
      } catch {
        // A failed sample is just a missing point.
      }
      if (stopped) break
      await new Promise((resolveWait) => {
        wake = resolveWait
        timer = setTimeout(resolveWait, Math.max(0, periodMs - (performance.now() - started)))
      })
    }
  }
  const done = loop()
  return async ({ finalSample = false } = {}) => {
    stopped = true
    if (timer) clearTimeout(timer)
    wake?.()
    await done
    if (finalSample) {
      try {
        write(await fn())
      } catch {}
    }
  }
}

const wsPid = await windowServerPid()
let probePid = null
const sampleGpu = async () => {
  const { stdout } = await execFileP('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { maxBuffer: 32 * 1024 * 1024 })
  return parseIoregUtilization(stdout)
}
/** Whole-machine CPU counters (all cores, ms) — busy share tells whether something else was competing. */
function systemCpu() {
  let busy = 0
  let total = 0
  for (const c of cpus()) {
    const { user, nice, sys, idle, irq } = c.times
    busy += user + nice + sys + irq
    total += user + nice + sys + idle + irq
  }
  return { sysBusyMs: busy, sysTotalMs: total, cores: cpus().length }
}
/** `ps -o pid=,time=` for these pids; ps exits 1 when one has exited but still prints the others. */
async function psTimes(pids) {
  try {
    return (await execFileP('ps', ['-o', 'pid=,time=', '-p', pids.join(',')])).stdout
  } catch (err) {
    return typeof err?.stdout === 'string' ? err.stdout : ''
  }
}
const sampleWs = async () => {
  const sys = systemCpu()
  const pids = [wsPid, probePid].filter((p) => p !== null)
  if (pids.length === 0) return sys
  const times = parsePsPidTimes(await psTimes(pids))
  const out = { ...sys }
  if (wsPid !== null && times.has(wsPid)) out.cpuS = times.get(wsPid)
  if (probePid !== null && times.has(probePid)) out.probeCpuS = times.get(probePid)
  return out
}

async function powerState() {
  const out = { source: null, lowPowerMode: null }
  try {
    const { stdout } = await execFileP('pmset', ['-g', 'batt'])
    out.source = /Now drawing from '([^']+)'/.exec(stdout)?.[1] ?? null
  } catch {}
  try {
    const { stdout } = await execFileP('pmset', ['-g'])
    const m = /lowpowermode\s+(\d)/.exec(stdout)
    out.lowPowerMode = m ? m[1] === '1' : null
  } catch {}
  return out
}

const bench = {
  variant,
  harnessVariant: target.variant,
  mode,
  label: target.label,
  durationS: duration,
  startedAt: new Date().toISOString(),
  harnessArgs: [],
  wid: null,
  widAtS: null,
  exitCode: null,
  signal: null,
  timedOut: false,
  baseline: { seconds: pauseS, windowServerPid: wsPid },
  power: await powerState(),
  probe: { status: probeOff ? 'off' : 'skipped', startS: null, exitCode: null, hz: probeHz, seconds: null },
}

// 1. Pause between runs doubles as an idle baseline; it ends with one more sample of each.
{
  const t0 = performance.now()
  const stops = [startSampler(sampleGpu, 500, gpuOut, 'baseline', t0), startSampler(sampleWs, 1000, wsOut, 'baseline', t0)]
  await sleep(pauseS * 1000)
  await Promise.all(stops.map((stop) => stop({ finalSample: true })))
}

// 2. Launch the harness in its own process group (so the watchdog can take down every helper).
//    The bench's own flags come after the extra ones: the harness takes the last value of a flag.
const harnessArgs = [
  ROOT,
  '--spike=overlay',
  ...extra,
  `--variant=${target.variant}`,
  `--mode=${mode}`,
  `--duration=${duration}`,
  `--results=${dir}`,
  `--label=${target.label}`,
  ...target.extraArgs,
]
bench.harnessArgs = harnessArgs
const electronBin = join(ROOT, 'node_modules/.bin/electron')
const launchedAt = performance.now()
const child = spawn('env', ['-u', 'ELECTRON_RUN_AS_NODE', electronBin, ...harnessArgs], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
const pgid = child.pid
let runT0 = null
let stopSamplers = []
let probe = null
let probeExit = null

const groupAlive = () => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

function onWid(wid) {
  if (runT0 !== null) return
  runT0 = performance.now()
  bench.wid = wid
  bench.widAtS = Number(((runT0 - launchedAt) / 1000).toFixed(3))
  stopSamplers = [startSampler(sampleGpu, 500, gpuOut, 'run', runT0), startSampler(sampleWs, 1000, wsOut, 'run', runT0)]
  if (probeOff) return
  if (!existsSync(probePath)) {
    bench.probe.status = 'missing'
    say(`[bench] probe not found at ${probePath}; window-motion metrics skipped`)
    return
  }
  // SPEC-DEVIATION: the task probes A1/A2 only. The probe's 250 Hz window-server queries cost
  // WindowServer ~2-3 % of a core (about the A-vs-B WindowServer gap), so every variant is probed
  // (B/Bfull: their static display-sized window) to keep the WindowServer and other-load numbers
  // comparable. Window-motion metrics are still computed for A1/A2 only.
  const seconds = Math.max(1, duration - 3)
  bench.probe.seconds = seconds
  bench.probe.startS = Number(((performance.now() - runT0) / 1000).toFixed(4))
  bench.probe.status = 'running'
  const probeOut = createWriteStream(file('.probe.jsonl'))
  probe = spawn(probePath, ['winpos', '--wid', String(wid), '--hz', String(probeHz), '--seconds', String(seconds)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  probePid = probe.pid ?? null
  probe.stdout.pipe(probeOut)
  probe.stderr.on('data', (d) => log.write(`# probe: ${d}`))
  probeExit = new Promise((resolveExit) =>
    probe.on('exit', (code) => {
      bench.probe.exitCode = code
      bench.probe.status = code === 0 ? 'ok' : 'failed'
      resolveExit()
    }),
  )
}

for (const stream of [child.stdout, child.stderr]) {
  createInterface({ input: stream }).on('line', (line) => {
    log.write(`${line}\n`)
    const wid = /\[spike:overlay\] wid=(\d+)/.exec(line)
    if (wid) onWid(Number(wid[1]))
    if (line.includes('[spike:overlay]') && /RESULT|ERROR|wrote|warning|wid=/.test(line)) console.log(line)
  })
}

// 'close' (not 'exit') so every stdout line has been read before we wrap up.
const exited = new Promise((resolveExit) =>
  child.on('close', (code, signal) => {
    bench.exitCode = code
    bench.signal = signal
    resolveExit()
  }),
)

// 3. Watchdog.
const watchdog = setTimeout(
  () => {
    bench.timedOut = true
    say(`[bench] watchdog: no exit after ${duration + 25}s, sending SIGTERM`)
    try {
      process.kill(pgid, 'SIGTERM') // cli.js forwards it to Electron, which flushes its results
    } catch {}
    setTimeout(() => {
      if (groupAlive()) {
        say('[bench] watchdog: SIGKILL process group')
        try {
          process.kill(-pgid, 'SIGKILL')
        } catch {}
      }
    }, 8000).unref()
  },
  (duration + 25) * 1000,
)

await exited
clearTimeout(watchdog)
await Promise.all(stopSamplers.map((stop) => stop()))
if (probe && probe.exitCode === null) {
  // The probe stops by itself at D-3 s; if it is still sampling, SIGTERM makes it flush and exit.
  await Promise.race([probeExit, sleep(3000)])
  if (probe.exitCode === null) probe.kill('SIGTERM')
  await Promise.race([probeExit, sleep(3000)])
  if (probe.exitCode === null) probe.kill('SIGKILL')
}
// Helpers (GPU/renderer processes) must not outlive the run.
await sleep(300)
if (groupAlive()) {
  say('[bench] leftover processes in the harness group: SIGKILL')
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {}
}

bench.endedAt = new Date().toISOString()
writeFileSync(file('.bench.json'), `${JSON.stringify(bench, null, 1)}\n`)
say(
  `[bench] ${variant} ${mode}: exit ${bench.exitCode}${bench.signal ? ` (${bench.signal})` : ''}, probe ${bench.probe.status}` +
    `${bench.timedOut ? ', TIMED OUT' : ''}`,
)
await Promise.all([gpuOut, wsOut, log].map((s) => new Promise((r) => s.end(r))))
process.exit(bench.exitCode === 0 ? 0 : 1)
