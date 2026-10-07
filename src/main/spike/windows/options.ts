// Command-line options of the Spike B windows harness (pure; unit-tested in test/spikeB-checks.test.ts).

import { isAbsolute, resolve } from 'node:path'
import { tuning } from '../../../shared/tuning'
import type { CliArgs } from '../../cli'

export type OverlayWindowType = 'panel' | 'none'

export interface WindowsSpikeOptions {
  /** Seconds from startup; 0 = until Ctrl+C / SIGTERM. */
  durationS: number
  /** Launch Calculator in the background and wait for appLaunched / appTerminated. */
  autoAppTest: boolean
  /** Show the debug overlay (outlines over every window). */
  overlay: boolean
  /** 'panel' (the task's NSPanel overlay) or 'none' (a plain NSWindow) for the fullscreen-Space comparison. */
  windowType: OverlayWindowType
  /** Explicit results directory; null = the default for dev / packaged runs. */
  resultsDir: string | null
  /** Results file label (default: local timestamp). */
  label: string | null
  /** Write the overlay's capturePage() PNG here after the checks; null = no capture. */
  capture: string | null
  /**
   * Length of each helper-CPU phase (4 Hz, then 15 Hz), s; the run is extended to fit both. null = split
   * whatever --duration leaves after the checks.
   */
  cpuPhaseS: number | null
}

export const WINDOWS_USAGE = [
  'usage: electron . --spike=windows [--duration=SECONDS (0 = until Ctrl+C, default ' +
    `${tuning.spikeWindows.defaultDurationS})] [--auto-app-test] [--overlay=true|false]`,
  '         [--window-type=panel|none] [--results=DIR] [--label=TEXT] [--capture=FILE.png]',
  '         [--cpu-phase-s=SECONDS (each helper-CPU phase; extends the run; 30 resolves both rates)]',
].join('\n')

const LABEL_RE = /^[A-Za-z0-9._-]{1,80}$/

export function parseBool(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  throw new Error(`--${name} must be true or false (got ${value})`)
}

export function parseDuration(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const seconds = Number(value)
  if (value.trim() === '' || !Number.isFinite(seconds) || seconds < 0) throw new Error(`--duration must be a number >= 0 (got ${value})`)
  return seconds
}

export function parseLabel(value: string | undefined): string | null {
  if (value === undefined) return null
  if (!LABEL_RE.test(value)) throw new Error(`--label may only use letters, digits, '.', '_' and '-' (got ${value})`)
  return value
}

/** --cpu-phase-s: seconds per helper-CPU phase, at least 1; null when not given. */
export function parsePhaseSeconds(value: string | undefined): number | null {
  if (value === undefined) return null
  const seconds = Number(value)
  if (value.trim() === '' || !Number.isFinite(seconds) || seconds < 1) throw new Error(`--cpu-phase-s must be a number >= 1 (got ${value})`)
  return seconds
}

/** Resolves a user-given path against `cwd` (the packaged app's cwd is '/', so prefer absolute paths there). */
export function resolvePathArg(value: string | undefined, cwd: string): string | null {
  if (value === undefined || value === '' || value === 'true') return null
  return isAbsolute(value) ? value : resolve(cwd, value)
}

/** Parses and validates the flags; throws an Error with a readable message on bad input. */
export function parseWindowsOptions(args: CliArgs, cwd: string): WindowsSpikeOptions {
  const windowType = args['window-type'] ?? 'panel'
  if (windowType !== 'panel' && windowType !== 'none') throw new Error(`--window-type must be panel or none (got ${windowType})`)
  return {
    durationS: parseDuration(args['duration'], tuning.spikeWindows.defaultDurationS),
    autoAppTest: parseBool(args['auto-app-test'], 'auto-app-test', false),
    overlay: parseBool(args['overlay'], 'overlay', true),
    windowType,
    resultsDir: resolvePathArg(args['results'], cwd),
    label: parseLabel(args['label']),
    capture: resolvePathArg(args['capture'], cwd),
    cpuPhaseS: parsePhaseSeconds(args['cpu-phase-s']),
  }
}
