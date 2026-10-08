// Command-line options of the Spike B input harness (pure; unit-tested in test/spikeB-input.test.ts).

import { tuning } from '../../../shared/tuning'
import type { CliArgs } from '../../cli'
import { parseBool, parseDuration, parseLabel, resolvePathArg } from '../windows/options'

// bitbot-helper's listen-only tap is the only source (it replaced uiohook-napi: see
// docs/decisions/input-and-helper.md §1). --source=helper stays required, as before, so the
// documented commands keep working and a stale --source=uiohook fails instead of running the helper.
export type InputSource = 'helper'

export interface InputSpikeOptions {
  source: InputSource
  /** Count key presses (the tap's keyDown/keyUp events). */
  keys: boolean
  /** Count mouse buttons and scrolling. */
  mouse: boolean
  /** Call requestInputAccess first (shows the Input Monitoring prompt when undecided). */
  request: boolean
  /** Seconds; 0 = until Ctrl+C / SIGTERM / quit. */
  durationS: number
  /** While the tap is not running, re-check the grant (preflight) and retry the tap once granted. */
  retryOnGrant: boolean
  resultsDir: string | null
  label: string | null
}

export const INPUT_USAGE = [
  'usage: electron . --spike=input --source=helper [--keys=true|false] [--mouse=true|false]',
  `         [--request] [--duration=SECONDS (0 = until Ctrl+C, default ${tuning.spikeInput.defaultDurationS})]`,
  '         [--retry-on-grant=true|false] [--results=DIR] [--label=TEXT]',
  '  CAN SHOW macOS PERMISSION PROMPTS: run it only for the manual permission tests in spikes/README-input-helper.md.',
].join('\n')

export function parseInputOptions(args: CliArgs, cwd: string): InputSpikeOptions {
  const source = args['source']
  if (source !== 'helper') throw new Error(`--source must be helper (got ${source ?? 'nothing'})`)
  const keys = parseBool(args['keys'], 'keys', true)
  const mouse = parseBool(args['mouse'], 'mouse', true)
  if (!keys && !mouse) throw new Error('--keys=false and --mouse=false leave nothing to count')
  const request = parseBool(args['request'], 'request', false)
  return {
    source,
    keys,
    mouse,
    request,
    durationS: parseDuration(args['duration'], tuning.spikeInput.defaultDurationS),
    retryOnGrant: parseBool(args['retry-on-grant'], 'retry-on-grant', true),
    resultsDir: resolvePathArg(args['results'], cwd),
    label: parseLabel(args['label']),
  }
}
