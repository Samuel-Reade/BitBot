// Small statistics helpers for the dev check (src/main/dev/overlayCheck.ts). Pure; unit-tested
// (test/overlayCheck.test.ts). Percentiles interpolate linearly between closest ranks (numpy's default), the definition
// Spike A's harness and analysis used, so the check's numbers compare with docs/decisions/overlay.md. Ported from
// src/main/spike/overlay/stats.ts (spike code is never imported).

export interface Summary {
  n: number
  mean: number
  min: number
  p50: number
  p95: number
  p99: number
  max: number
}

/** p in [0, 100]; `sorted` ascending. NaN for an empty list. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length
  if (n === 0) return Number.NaN
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.min(n - 1, lo + 1)
  const a = sorted[lo] ?? Number.NaN
  const b = sorted[hi] ?? Number.NaN
  return a + (b - a) * (rank - lo)
}

/** Summary of the finite values, or null when there are none. */
export function summarize(values: ArrayLike<number>): Summary | null {
  const finite = Array.from(values).filter((v) => Number.isFinite(v))
  const n = finite.length
  if (n === 0) return null
  const sorted = Float64Array.from(finite).sort()
  let sum = 0
  for (const v of sorted) sum += v
  return {
    n,
    mean: sum / n,
    min: sorted[0] ?? Number.NaN,
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
    max: sorted[n - 1] ?? Number.NaN,
  }
}

/** The median of the finite values (NaN when there are none). */
export function median(values: ArrayLike<number>): number {
  return summarize(values)?.p50 ?? Number.NaN
}

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value
  const f = 10 ** digits
  return Math.round(value * f) / f
}

export function roundSummary(summary: Summary | null, digits = 2): Summary | null {
  if (!summary) return null
  return {
    n: summary.n,
    mean: round(summary.mean, digits),
    min: round(summary.min, digits),
    p50: round(summary.p50, digits),
    p95: round(summary.p95, digits),
    p99: round(summary.p99, digits),
    max: round(summary.max, digits),
  }
}

/** `value` with `digits` decimals, or 'n/a' when it is missing or not finite. */
export function fmt(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits)
}
