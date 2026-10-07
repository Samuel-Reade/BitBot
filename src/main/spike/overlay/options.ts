// Command-line options of the Spike A harness (pure; unit-tested).

import { isAbsolute, join, resolve } from 'node:path'
import { DEFAULT_PALETTE_ID, isPaletteId } from '../../../shared/palettes'
import { OVERLAY_MODES, OVERLAY_VARIANTS, isOverlayMode, isOverlayVariant } from '../../../shared/spikeOverlay'
import type { OverlayMode, OverlayVariant } from '../../../shared/spikeOverlay'
import { tuning } from '../../../shared/tuning'
import type { PaletteId, PetSize } from '../../../shared/types'
import type { CliArgs } from '../../cli'

export type A1TimerKind = 'deadline' | 'interval'
export type WindowTypeOption = 'panel' | 'none'

export interface OverlayOptions {
  variant: OverlayVariant
  mode: OverlayMode
  /** Seconds after the window is shown; 0 = run until quit. */
  durationS: number
  windowType: WindowTypeOption
  size: PetSize
  palette: PaletteId
  resultsDir: string
  label: string | null
  /** A1 only: 'deadline' = drift-free absolute deadlines (default), 'interval' = naive setInterval. */
  a1Timer: A1TimerKind
  /** Dev check: at the end, capture our own page cropped to the pet viewport to this PNG. */
  capture: string | null
  /**
   * Render-rate cap for the cost-vs-frame-rate experiment (lead, after the main bench): null = render
   * on every rAF (the default, worst case); N > 0 = wake for a rAF only every 1/N s; 0 = render the
   * first frame, then stop the frame loop entirely (idle baseline of an overlay that draws nothing).
   */
  renderFps: number | null
}

export const OVERLAY_USAGE = [
  'usage: electron . --spike=overlay --variant=A1|A2|B|Bfull --mode=static|walk|synthetic|follow|interactive',
  `         [--duration=SECONDS (0 = until quit, default ${tuning.spikeOverlay.defaultDurationS})] [--window-type=panel|none]`,
  '         [--size=S|M|L] [--palette=<id>] [--results=DIR] [--label=TEXT] [--a1-timer=deadline|interval] [--capture=FILE.png]',
  '         [--render-fps=N (cap the render rate; 0 = draw once, then no frame loop)]',
].join('\n')

const LABEL_RE = /^[A-Za-z0-9._-]{1,80}$/

export interface OptionContext {
  /** app.getAppPath(): default results directory parent. */
  appPath: string
  /** Base for a relative --results. */
  cwd: string
}

/** Parses and validates the harness flags; throws an Error with a readable message on bad input. */
export function parseOverlayOptions(args: CliArgs, ctx: OptionContext): OverlayOptions {
  const variant = args['variant']
  if (!isOverlayVariant(variant)) {
    throw new Error(`--variant must be one of ${OVERLAY_VARIANTS.join(', ')} (got ${variant ?? 'nothing'})`)
  }
  const mode = args['mode']
  if (!isOverlayMode(mode)) {
    throw new Error(`--mode must be one of ${OVERLAY_MODES.join(', ')} (got ${mode ?? 'nothing'})`)
  }

  let durationS: number = tuning.spikeOverlay.defaultDurationS
  if (args['duration'] !== undefined) {
    durationS = Number(args['duration'])
    if (!Number.isFinite(durationS) || durationS < 0) throw new Error(`--duration must be a number >= 0 (got ${args['duration']})`)
  }

  const windowType = args['window-type'] ?? 'panel'
  if (windowType !== 'panel' && windowType !== 'none') throw new Error(`--window-type must be panel or none (got ${windowType})`)

  const size = args['size'] ?? 'M'
  if (size !== 'S' && size !== 'M' && size !== 'L') throw new Error(`--size must be S, M or L (got ${size})`)

  const palette = args['palette'] ?? DEFAULT_PALETTE_ID
  if (!isPaletteId(palette)) throw new Error(`--palette is not a palette id (got ${palette})`)

  const label = args['label'] ?? null
  if (label !== null && !LABEL_RE.test(label)) throw new Error(`--label may only use letters, digits, '.', '_' and '-' (got ${label})`)

  const a1Timer = args['a1-timer'] ?? 'deadline'
  if (a1Timer !== 'deadline' && a1Timer !== 'interval') throw new Error(`--a1-timer must be deadline or interval (got ${a1Timer})`)

  const results = args['results']
  const resultsDir = results ? (isAbsolute(results) ? results : resolve(ctx.cwd, results)) : join(ctx.appPath, 'spike-results')
  const captureArg = args['capture']
  const capture = captureArg ? (isAbsolute(captureArg) ? captureArg : resolve(ctx.cwd, captureArg)) : null

  let renderFps: number | null = null
  if (args['render-fps'] !== undefined) {
    renderFps = Number(args['render-fps'])
    if (!Number.isFinite(renderFps) || renderFps < 0 || renderFps > 240) {
      throw new Error(`--render-fps must be a number from 0 to 240 (got ${args['render-fps']})`)
    }
  }

  return { variant, mode, durationS, windowType, size, palette, resultsDir, label, a1Timer, capture, renderFps }
}

/** `overlay-<variant>-<mode>-<label or local timestamp>.json` */
export function resultsFileName(options: OverlayOptions, startedAt: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}-` +
    `${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`
  return `overlay-${options.variant}-${options.mode}-${options.label ?? stamp}.json`
}
