// Command-line options of the Spike B input harness (pure; unit-tested in test/spikeB-input.test.ts).

import { tuning } from '../../../shared/tuning'
import type { CliArgs } from '../../cli'
import { parseBool, parseDuration, parseLabel, resolvePathArg } from '../windows/options'

export const INPUT_SOURCES = ['helper', 'uiohook'] as const
export type InputSource = (typeof INPUT_SOURCES)[number]

export interface InputSpikeOptions {
  source: InputSource
  /** Count key presses (helper: keyDown/keyUp tap; uiohook: keydown/keyup listeners). */
  keys: boolean
  /** Count mouse buttons and scrolling. */
  mouse: boolean
  /** helper only: call requestInputAccess first (shows the Input Monitoring prompt when undecided). */
  request: boolean
  /** Seconds; 0 = until Ctrl+C / SIGTERM / quit. */
  durationS: number
  /** helper only: while the tap is not running, re-check the grant (preflight) and retry the tap once granted. */
  retryOnGrant: boolean
  resultsDir: string | null
  label: string | null
}

export const INPUT_USAGE = [
  'usage: electron . --spike=input --source=helper|uiohook [--keys=true|false] [--mouse=true|false]',
  `         [--request] [--duration=SECONDS (0 = until Ctrl+C, default ${tuning.spikeInput.defaultDurationS})]`,
  '         [--retry-on-grant=true|false] [--results=DIR] [--label=TEXT]',
  '  CAN SHOW macOS PERMISSION PROMPTS: run it only for the manual permission tests in spikes/README-input-helper.md.',
].join('\n')

export function parseInputOptions(args: CliArgs, cwd: string): InputSpikeOptions {
  const source = args['source']
  if (!(INPUT_SOURCES as readonly (string | undefined)[]).includes(source)) {
    throw new Error(`--source must be one of ${INPUT_SOURCES.join(', ')} (got ${source ?? 'nothing'})`)
  }
  const keys = parseBool(args['keys'], 'keys', true)
  const mouse = parseBool(args['mouse'], 'mouse', true)
  if (!keys && !mouse) throw new Error('--keys=false and --mouse=false leave nothing to count')
  const request = parseBool(args['request'], 'request', false)
  if (request && source !== 'helper') {
    throw new Error("--request applies to --source=helper only (uiohook's start() shows the Accessibility prompt itself)")
  }
  return {
    source: source as InputSource,
    keys,
    mouse,
    request,
    durationS: parseDuration(args['duration'], tuning.spikeInput.defaultDurationS),
    retryOnGrant: parseBool(args['retry-on-grant'], 'retry-on-grant', true),
    resultsDir: resolvePathArg(args['results'], cwd),
    label: parseLabel(args['label']),
  }
}
