#!/usr/bin/env node
// Summarizes Spike A overlay runs into Markdown + JSON (BITBOT_SPEC.md §12).
//   node spikes/analysis/summarize.mjs [--dir DIR] [--out PATH]
//     --dir  directory holding overlay-<variant>-<mode>-<label>.json (+ .gpu/.ws/.probe.jsonl, .bench.json)
//            default: spike-results
//     --out  output path without extension (writes PATH.md and PATH.json); default: spike-results/overlay-summary

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRuns, renderMarkdown, rowName, summarizeRun } from './lib/report.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function option(name, fallback) {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === `--${name}`) return argv[i + 1] ?? fallback
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3)
  }
  return fallback
}

const dir = resolve(option('dir', resolve(ROOT, 'spike-results')))
const out = resolve(option('out', resolve(ROOT, 'spike-results/overlay-summary')))

const runs = loadRuns(dir)
if (runs.length === 0) {
  console.error(`summarize: no overlay results in ${dir}`)
  process.exit(1)
}
const rows = runs.map(summarizeRun)
const meta = { generatedAt: new Date().toISOString(), dir }
mkdirSync(dirname(out), { recursive: true })
writeFileSync(`${out}.json`, `${JSON.stringify({ ...meta, runs: rows }, null, 1)}\n`)
writeFileSync(`${out}.md`, renderMarkdown(rows, meta))

for (const r of rows) {
  if (!r.variant) {
    console.log(`${r.base}: ${r.errors.join('; ')}`)
    continue
  }
  const m = r.motion
  console.log(
    [
      `${rowName(r).padEnd(13)} ${r.mode.padEnd(9)} ${r.ok ? 'ok ' : 'ERR'}`,
      `cpu ${r.cpu.total?.mean?.toFixed(1) ?? '—'}%`,
      `mem ${r.memMB ?? '—'} MB (RSS ${r.rssMB ?? '—'})`,
      `raf p95 ${r.renderer?.rafP95 ?? '—'} ms >${r.renderer?.longFrameMs ?? '—'}ms ${r.renderer?.pctLong ?? '—'}%`,
      r.presentation ? `present sd ${r.presentation.intervalStdev} ms lockR ${r.presentation.phaseLockR}` : null,
      m?.best && r.mode !== 'static' ? `judder best ${m.best.anomalyPct}% avg ${m.avg.anomalyPct}%` : null,
      r.gpu ? `gpu ${r.gpu.deviceMean}%` : null,
      r.windowServer ? `ws ${r.windowServer.meanPct}%` : null,
      r.probe?.status ? `probe ${r.probe.status}` : null,
    ]
      .filter(Boolean)
      .join(' | '),
  )
}
console.log(`wrote ${out}.md and ${out}.json`)
