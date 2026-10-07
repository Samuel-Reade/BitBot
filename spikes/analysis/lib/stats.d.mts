// Types for stats.mjs (lets the TypeScript tests import the analysis code).
export interface Summary {
  n: number
  mean: number
  stdev: number
  cv: number
  min: number
  p50: number
  p95: number
  p99: number
  max: number
}
export interface PhaseLock {
  n: number
  R: number
  circStdMs: number
}
export function percentileSorted(sorted: ArrayLike<number>, p: number): number
export function summarize(values: ArrayLike<number>): Summary | null
export function mean(values: ArrayLike<number>): number
export function fractionAbove(values: ArrayLike<number>, threshold: number): number
export function round(value: number | null | undefined, digits?: number): number | null
export function roundSummary<T extends object>(summary: T | null, digits?: number): T | null
export function phaseLock(timesMs: ArrayLike<number>, periodMs: number): PhaseLock | null
export function cumulativeTimes(intervals: ArrayLike<number>): number[]
