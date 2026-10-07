// Types for judder.mjs (lets the TypeScript tests import the analysis code).
import type { Summary } from './stats.mjs'

export interface ProbeSample {
  t: number
  x: number | null
  y: number | null
}

export interface MotionOptions {
  periodMs: number
  skipS?: number
  untilS?: number
  minMovePtPerFrame?: number
  phaseStepMs?: number
  contextFrames?: number
}

export interface FrameAnomalies {
  zeroPct: number
  multiPct: number
  anomalyPct: number
}

export interface MotionResult {
  periodMs: number
  samples: number
  probe: { meanIntervalMs: number; maxIntervalMs: number } | null
  changes: number
  changeIntervalMs: Summary | null
  longestGapMs: number | null
  phaseLock: { R: number; circStdMs: number } | null
  movingFrames: number
  updatesPerMovingFrame: number | null
  best: (FrameAnomalies & { phaseMs: number }) | null
  avg: FrameAnomalies | null
  worstAnomalyPct: number | null
  /** Same counts with each change at its probe-interval midpoint (includes quantization noise). */
  bestMidpoint: (FrameAnomalies & { phaseMs: number }) | null
}

export function analyzeWindowMotion(samples: readonly ProbeSample[], opts: MotionOptions): MotionResult
