// Window-motion smoothness from `probe winpos` samples (approach A1/A2).
//
// The probe polls the window server for the overlay window's frame at a fixed rate (e.g. 250 Hz).
// A "position change" is a sample whose (x, y) differs from the previous sample; it happened
// somewhere in (previous sample time, sample time], so its true time is only known to ±1 probe interval.
//
// Per display frame (length `periodMs`) we count position changes. A smooth mover gets exactly one
// per frame; 0 = the pet visibly stalls for a frame (hitch), ≥2 = a step is never shown (skip).
// Two problems and how they are handled:
//  1. Probe quantization. Counting each change at its interval midpoint adds fake jitter of up to
//     ±half a probe interval, which makes changes near a frame edge flip between frames. So frames are
//     counted with an interval-aware assignment: every change is placed in a frame its interval
//     overlaps, choosing placements that minimise anomalies. That is a LOWER BOUND (it can hide real
//     jitter smaller than the probe interval); over long spans it is exact for rate mismatches (e.g.
//     a 58.8 Hz timer must leave ~2 % of 60 Hz frames empty whatever the placement). The midpoint count
//     is kept as `bestMidpoint` (an upper-ish estimate) for reference.
//  2. Unknown vsync phase. Frames are laid over the timeline at every phase offset (step
//     `phaseStepMs`): `best` = the phase with the fewest anomalies (what perfect vsync alignment would
//     show), `avg` = mean over all phases (an arbitrary alignment). `phaseLock.R` (1 = every change at
//     the same phase of the frame clock, ~0 = spread over the whole frame, i.e. beating) needs no phase.
// Only "moving" frames count: frames whose expected displacement (net movement over the frame and
// `contextFrames` neighbours on each side, divided by the window length in frames) is at least
// `minMovePtPerFrame`. Slower movement legitimately changes the integer position less than once per frame.

import { phaseLock, round, roundSummary, summarize } from './stats.mjs'

function lastIndexAtOrBefore(times, t) {
  let lo = 0
  let hi = times.length - 1
  if (hi < 0 || t < times[0]) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Counts changes per frame for frames starting at t0 + phi + k·P.
 * `intervalAware`: a change with true time in (lo, hi] may go to any frame it overlaps; the greedy
 * gives each frame the first change that can be in it and pushes later changes forward whenever they
 * can still be in a later frame (optimal here because change intervals are disjoint and ordered and
 * shorter than a frame).
 */
function countFrames(changes, frames, intervalAware) {
  const counts = new Array(frames.length).fill(0)
  let j = 0
  for (let k = 0; k < frames.length; k++) {
    const { s, e } = frames[k]
    if (intervalAware) {
      if (k === 0) while (j < changes.length && changes[j].hi <= s) j++
      // First change that can lie in this frame.
      if (j < changes.length && changes[j].lo < e) {
        counts[k]++
        j++
        // Further changes that cannot be pushed past this frame must be in it too.
        while (j < changes.length && changes[j].hi <= e) {
          counts[k]++
          j++
        }
      }
    } else {
      if (k === 0) while (j < changes.length && changes[j].mid < s) j++
      while (j < changes.length && changes[j].mid < e) {
        counts[k]++
        j++
      }
    }
  }
  return counts
}

/**
 * @param {Array<{t:number,x:number|null,y:number|null}>} samples probe lines, t in seconds
 * @param {{periodMs:number, skipS?:number, untilS?:number, minMovePtPerFrame?:number,
 *          phaseStepMs?:number, contextFrames?:number}} opts
 */
export function analyzeWindowMotion(samples, opts) {
  const P = opts.periodMs
  const skipMs = (opts.skipS ?? 0) * 1000
  const untilMs = opts.untilS === undefined ? Number.POSITIVE_INFINITY : opts.untilS * 1000
  const minMove = opts.minMovePtPerFrame ?? 1.5
  const step = opts.phaseStepMs ?? 0.25
  const ctx = opts.contextFrames ?? 3

  const pts = samples
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.x) && Number.isFinite(s.y))
    .map((s) => ({ t: s.t * 1000, x: s.x, y: s.y }))
    .filter((s) => s.t >= skipMs && s.t <= untilMs)
    .sort((a, b) => a.t - b.t)

  const result = {
    periodMs: round(P, 4),
    samples: pts.length,
    probe: null,
    changes: 0,
    changeIntervalMs: null,
    longestGapMs: null,
    phaseLock: null,
    movingFrames: 0,
    updatesPerMovingFrame: null,
    best: null,
    avg: null,
    worstAnomalyPct: null,
    bestMidpoint: null,
  }
  if (pts.length < 2) return result

  const gaps = []
  for (let i = 1; i < pts.length; i++) gaps.push(pts[i].t - pts[i - 1].t)
  const gapStats = summarize(gaps)
  result.probe = { meanIntervalMs: round(gapStats.mean, 3), maxIntervalMs: round(gapStats.max, 3) }

  const changes = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (a.x !== b.x || a.y !== b.y) changes.push({ lo: a.t, hi: b.t, mid: (a.t + b.t) / 2 })
  }
  result.changes = changes.length
  if (changes.length >= 2) {
    const intervals = []
    for (let i = 1; i < changes.length; i++) intervals.push(changes[i].mid - changes[i - 1].mid)
    const s = summarize(intervals)
    result.changeIntervalMs = roundSummary(s, 3)
    result.longestGapMs = round(s.max, 3)
    const lock = phaseLock(
      changes.map((c) => c.mid),
      P,
    )
    result.phaseLock = lock ? { R: round(lock.R, 4), circStdMs: round(lock.circStdMs, 3) } : null
  }

  const times = pts.map((p) => p.t)
  const posAt = (t) => pts[Math.max(0, lastIndexAtOrBefore(times, t))]
  const t0 = pts[0].t
  const tEnd = pts[pts.length - 1].t
  const perPhase = []
  for (let phi = 0; phi < P - 1e-9; phi += step) {
    const frames = []
    for (let k = ctx; ; k++) {
      const s = t0 + phi + k * P
      const e = s + P
      if (e + ctx * P > tEnd) break
      const a = posAt(s - ctx * P)
      const b = posAt(e + ctx * P)
      frames.push({ s, e, moving: Math.hypot(b.x - a.x, b.y - a.y) / (2 * ctx + 1) >= minMove })
    }
    const tally = (counts) => {
      let moving = 0
      let zero = 0
      let multi = 0
      let updates = 0
      for (let k = 0; k < frames.length; k++) {
        if (!frames[k].moving) continue
        moving++
        updates += counts[k]
        if (counts[k] === 0) zero++
        else if (counts[k] >= 2) multi++
      }
      return moving === 0
        ? null
        : { phi, moving, updates, zeroPct: (100 * zero) / moving, multiPct: (100 * multi) / moving, anomalyPct: (100 * (zero + multi)) / moving }
    }
    const aware = tally(countFrames(changes, frames, true))
    const midpoint = tally(countFrames(changes, frames, false))
    if (aware && midpoint) perPhase.push({ aware, midpoint })
  }
  if (perPhase.length === 0) return result

  const pickBest = (key) => perPhase.map((p) => p[key]).reduce((best, p) => (p.anomalyPct < best.anomalyPct ? p : best))
  const best = pickBest('aware')
  const bestMid = pickBest('midpoint')
  const avgOf = (field) => perPhase.reduce((sum, p) => sum + p.aware[field], 0) / perPhase.length
  const pct = (v) => round(v, 2)
  result.movingFrames = best.moving
  result.updatesPerMovingFrame = round(best.updates / best.moving, 3)
  result.best = { phaseMs: round(best.phi, 2), zeroPct: pct(best.zeroPct), multiPct: pct(best.multiPct), anomalyPct: pct(best.anomalyPct) }
  result.avg = { zeroPct: pct(avgOf('zeroPct')), multiPct: pct(avgOf('multiPct')), anomalyPct: pct(avgOf('anomalyPct')) }
  result.worstAnomalyPct = pct(Math.max(...perPhase.map((p) => p.aware.anomalyPct)))
  result.bestMidpoint = { phaseMs: round(bestMid.phi, 2), zeroPct: pct(bestMid.zeroPct), multiPct: pct(bestMid.multiPct), anomalyPct: pct(bestMid.anomalyPct) }
  return result
}
