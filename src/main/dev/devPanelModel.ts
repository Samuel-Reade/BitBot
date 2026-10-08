// The developer panel's pure parts (BITBOT_SPEC.md §14.1; the window and its IPC are devPanel.ts; messages in
// src/shared/devPanel.ts): its window options, the overlay's render and frame rates from its counters, and when a
// status counts as changed (it is pushed to the panel then, and on every status period). Type-only Electron import
// (unit-tested in test/devPanel.test.ts).

import type { BrowserWindowConstructorOptions } from 'electron'
import type { DevPanelStatus } from '../../shared/devPanel'
import type { OverlayStatsMsg } from '../../shared/petProtocol'
import { tuning } from '../../shared/tuning'
import { sameDevOverrides } from './devOverrides'

/**
 * The panel's window: an ordinary, focusable window (unlike the pet's, §2: the user opened it on purpose, so it may
 * take focus), created hidden and shown once its page is ready. Same sandboxed preload as the pet page. `preload`: the
 * preload script's path (pages.ts preloadPath()).
 */
export function devPanelWindowOptions(preload: string): BrowserWindowConstructorOptions {
  const { width, height } = tuning.dev.panel
  return {
    width,
    height,
    minWidth: width,
    minHeight: Math.round(height / 2),
    show: false,
    title: 'Bitbot Developer',
    fullscreenable: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
    },
  }
}

/** The status without the overlay's rates (the app knows these parts; the panel adds the rates). */
export type DevPanelAppStatus = Omit<DevPanelStatus, 'rendersPerS' | 'framesPerS'>

export interface OverlayRates {
  rendersPerS: number | null
  framesPerS: number | null
}

const NO_RATES: OverlayRates = { rendersPerS: null, framesPerS: null }

/**
 * Renders and frames per second between two readings of the overlay's counters (debug:overlay-stats). The counters
 * start again with every page load, so a reading that went backwards (or no reading) gives no rates until the next.
 */
export class RateMeter {
  private prev: Pick<OverlayStatsMsg, 'at' | 'frames' | 'renders'> | null = null
  private current: OverlayRates = NO_RATES

  get rates(): OverlayRates {
    return { ...this.current }
  }

  /** A new reading (null: the overlay didn't answer). Returns the rates since the previous one. */
  update(stats: OverlayStatsMsg | null): OverlayRates {
    const prev = this.prev
    this.prev = stats ? { at: stats.at, frames: stats.frames, renders: stats.renders } : null
    if (!stats || !prev) {
      this.current = NO_RATES
      return this.rates
    }
    const dtMs = stats.at - prev.at
    const frames = stats.frames - prev.frames
    const renders = stats.renders - prev.renders
    this.current =
      dtMs > 0 && frames >= 0 && renders >= 0 ? { rendersPerS: (renders * 1000) / dtMs, framesPerS: (frames * 1000) / dtMs } : NO_RATES
    return this.rates
  }

  /** Forget the previous reading (the panel closed). */
  reset(): void {
    this.prev = null
    this.current = NO_RATES
  }
}

export function sameDevPanelStatus(a: DevPanelStatus, b: DevPanelStatus): boolean {
  return (
    sameDevOverrides(a.overrides, b.overrides) &&
    a.state === b.state &&
    a.simState === b.simState &&
    a.look === b.look &&
    a.visible === b.visible &&
    a.rendersPerS === b.rendersPerS &&
    a.framesPerS === b.framesPerS &&
    JSON.stringify(a.world) === JSON.stringify(b.world)
  )
}
