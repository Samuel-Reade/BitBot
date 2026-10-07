// Statistics helpers for the Spike A analysis scripts (Node, no dependencies).
// Percentiles use linear interpolation between closest ranks — the same definition as the
// harness (src/main/spike/overlay/stats.ts) so numbers computed on either side agree.

/** @param {ArrayLike<number>} sorted ascending, @param {number} p 0..100 */
export function percentileSorted(sorted, p) {
  const n = sorted.length
  if (n === 0) return Number.NaN
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

/** Summary (population stdev; cv = stdev / mean) or null for an empty series. */
export function summarize(values) {
  const xs = Array.from(values).filter((v) => Number.isFinite(v))
  const n = xs.length
  if (n === 0) return null
  const sorted = Float64Array.from(xs).sort()
  let sum = 0
  for (const v of sorted) sum += v
  const mean = sum / n
  let sq = 0
  for (const v of sorted) sq += (v - mean) * (v - mean)
  const stdev = Math.sqrt(sq / n)
  return {
    n,
    mean,
    stdev,
    cv: mean !== 0 ? stdev / mean : Number.NaN,
    min: sorted[0],
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
    max: sorted[n - 1],
  }
}

export function mean(values) {
  const xs = Array.from(values).filter((v) => Number.isFinite(v))
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN
}

/** Fraction (0..1) of values strictly above threshold. */
export function fractionAbove(values, threshold) {
  const xs = Array.from(values)
  if (xs.length === 0) return 0
  return xs.filter((v) => v > threshold).length / xs.length
}

export function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return value ?? null
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/** Rounds every finite number in a (shallow) summary object. */
export function roundSummary(summary, digits = 3) {
  if (!summary) return null
  const out = {}
  for (const [k, v] of Object.entries(summary)) out[k] = typeof v === 'number' && k !== 'n' ? round(v, digits) : v
  return out
}

/**
 * Phase locking of event times to a period: mean resultant length R of exp(i·2π·t/period)
 * (1 = every event at the same phase of the frame clock, ~0 = phases spread evenly, i.e. a
 * free-running clock beating against the display) and the circular stdev in ms.
 * @param {ArrayLike<number>} timesMs
 */
export function phaseLock(timesMs, periodMs) {
  let c = 0
  let s = 0
  let n = 0
  for (const t of Array.from(timesMs)) {
    if (!Number.isFinite(t)) continue
    const a = (2 * Math.PI * t) / periodMs
    c += Math.cos(a)
    s += Math.sin(a)
    n++
  }
  if (n === 0) return null
  const R = Math.hypot(c, s) / n
  const circStdMs = R > 0 ? (Math.sqrt(-2 * Math.log(Math.min(1, R))) * periodMs) / (2 * Math.PI) : Number.POSITIVE_INFINITY
  return { n, R, circStdMs }
}

/** Cumulative sums of intervals, starting at 0 (event times from a list of gaps). */
export function cumulativeTimes(intervals) {
  const out = [0]
  let t = 0
  for (const d of Array.from(intervals)) {
    t += d
    out.push(t)
  }
  return out
}
