// Small, dependency-free statistics helpers for the Spike A harness (pure; unit-tested).
// Percentiles use linear interpolation between closest ranks (numpy's default), the same
// definition as spikes/analysis/lib/stats.mjs so harness and analysis numbers agree.

export interface Summary {
  n: number
  mean: number
  stdev: number
  min: number
  p50: number
  p95: number
  p99: number
  max: number
}

/** p in [0, 100]; `sorted` must be ascending and non-empty. */
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

/** Summary statistics (population stdev), or null for an empty series. */
export function summarize(values: ArrayLike<number>): Summary | null {
  const n = values.length
  if (n === 0) return null
  const sorted = Float64Array.from(values).sort()
  let sum = 0
  for (const v of sorted) sum += v
  const mean = sum / n
  let sq = 0
  for (const v of sorted) sq += (v - mean) * (v - mean)
  return {
    n,
    mean,
    stdev: Math.sqrt(sq / n),
    min: sorted[0] ?? Number.NaN,
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
    max: sorted[n - 1] ?? Number.NaN,
  }
}

/** Fraction (0..1) of values strictly above `threshold`; 0 for an empty series. */
export function fractionAbove(values: ArrayLike<number>, threshold: number): number {
  if (values.length === 0) return 0
  let count = 0
  for (let i = 0; i < values.length; i++) if ((values[i] ?? 0) > threshold) count++
  return count / values.length
}

export function round(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return value
  const f = 10 ** digits
  return Math.round(value * f) / f
}

export function roundSummary(summary: Summary | null, digits = 3): Summary | null {
  if (!summary) return null
  return {
    n: summary.n,
    mean: round(summary.mean, digits),
    stdev: round(summary.stdev, digits),
    min: round(summary.min, digits),
    p50: round(summary.p50, digits),
    p95: round(summary.p95, digits),
    p99: round(summary.p99, digits),
    max: round(summary.max, digits),
  }
}

/** Append-only sample buffer with a hard cap; counts what it had to drop. */
export class SampleSeries {
  private data: Float64Array
  private count = 0
  private droppedCount = 0

  constructor(private readonly cap: number) {
    this.data = new Float64Array(Math.min(cap, 1024))
  }

  push(value: number): void {
    if (this.count >= this.cap) {
      this.droppedCount++
      return
    }
    if (this.count === this.data.length) {
      const grown = new Float64Array(Math.min(this.cap, this.data.length * 2))
      grown.set(this.data)
      this.data = grown
    }
    this.data[this.count++] = value
  }

  get length(): number {
    return this.count
  }

  get dropped(): number {
    return this.droppedCount
  }

  values(): Float64Array {
    return this.data.slice(0, this.count)
  }

  reset(): void {
    this.count = 0
    this.droppedCount = 0
  }
}
