// Pure §8.2 window eligibility and the debug-overlay scene built from a helper snapshot (Spike B).
// No Electron imports: unit-tested in test/spikeB-eligibility.test.ts. The world model (milestone 3)
// is expected to reuse `windowEligibility` as is.

import type {
  DebugDisplayItem,
  DebugRect,
  DebugSceneMsg,
  DebugWindowItem,
  IneligibleReason,
} from '../../../shared/spikeWindows'
import type { HelperWindow } from '../../helper/protocol'

export interface EligibilityRules {
  /** tuning.world.minWindowSize: both edges must be at least this big (pt). */
  minSize: { readonly w: number; readonly h: number }
  /** tuning.world.excludedBundleIds (compared case-insensitively: bundle ids are case-insensitive). */
  excludedBundleIds: readonly string[]
  /**
   * Process ids of the Window Server (`pgrep -x WindowServer`). §8.2 excludes its windows (the menu bar
   * strip, …), but it is not an app: the helper reports bundleId null for them, so the bundle list cannot
   * name it and the rule goes by pid. Empty = unknown (see windowEligibility).
   */
  windowServerPids: readonly number[]
  /** Bitbot's own process ids (the main process owns every BrowserWindow). */
  ownPids: readonly number[]
  /** A window must be more opaque than this (§8.2: alpha > 0.5). */
  minAlpha: number
}

export interface Eligibility {
  eligible: boolean
  /** Empty exactly when eligible; in the order of §8.2's rule. */
  reasons: IneligibleReason[]
}

/**
 * §8.2: layer == 0, onScreen, alpha > minAlpha, width ≥ minSize.w and height ≥ minSize.h, not owned by
 * Bitbot, and not owned by an excluded owner: a bundle in excludedBundleIds or the Window Server
 * ('excluded' covers both, as §8.2 lists the Window Server among the excluded owners).
 */
export function windowEligibility(window: HelperWindow, rules: EligibilityRules): Eligibility {
  const reasons: IneligibleReason[] = []
  if (window.layer !== 0) reasons.push('layer')
  if (!window.onScreen) reasons.push('offscreen')
  if (!(window.alpha > rules.minAlpha)) reasons.push('alpha')
  if (window.w < rules.minSize.w || window.h < rules.minSize.h) reasons.push('small')
  if (rules.ownPids.includes(window.pid)) reasons.push('own')
  // SPEC-DEVIATION (§8.2 "not owned by … Window Server"): only as complete as rules.windowServerPids.
  // When the caller cannot resolve the Window Server's pid (empty list), its windows are excluded by the
  // layer rule alone: every Window Server window seen on macOS 15.6 sits at layer 24 (menu bar strip) or
  // at desktop levels, never at layer 0. Asking the helper to flag them would remove the pgrep.
  const excludedBundle = window.bundleId !== null && isExcludedBundle(window.bundleId, rules.excludedBundleIds)
  if (excludedBundle || rules.windowServerPids.includes(window.pid)) reasons.push('excluded')
  return { eligible: reasons.length === 0, reasons }
}

export function isExcludedBundle(bundleId: string, excluded: readonly string[]): boolean {
  const id = bundleId.toLowerCase()
  return excluded.some((entry) => entry.toLowerCase() === id)
}

/** Electron-style rectangle (screen.Display bounds/workArea, BrowserWindow.getBounds()). */
export interface ElectronRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ElectronDisplayLike {
  id: number
  bounds: ElectronRect
  workArea: ElectronRect
  scaleFactor: number
}

export const helperRect = (window: { x: number; y: number; w: number; h: number }): DebugRect => ({
  x: window.x,
  y: window.y,
  w: window.w,
  h: window.h,
})

export const electronRect = (rect: ElectronRect): DebugRect => ({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })

/** Global points → window-local points for a window whose content origin is `origin` (global). */
export function globalToLocal(rect: DebugRect, origin: { x: number; y: number }): DebugRect {
  return { x: rect.x - origin.x, y: rect.y - origin.y, w: rect.w, h: rect.h }
}

export interface SceneContext {
  seq: number
  source: DebugSceneMsg['source']
  /** Global origin of the overlay window's content (its getContentBounds() x/y). */
  origin: { x: number; y: number }
  rules: EligibilityRules
  displays: readonly ElectronDisplayLike[]
  primaryDisplayId: number
}

/** Everything the overlay draws for one snapshot, already in overlay-local coordinates. */
export function buildScene(windows: readonly HelperWindow[], ts: number, context: SceneContext): DebugSceneMsg {
  const items: DebugWindowItem[] = windows.map((window, z) => {
    const { eligible, reasons } = windowEligibility(window, context.rules)
    const global = helperRect(window)
    return {
      z,
      wid: window.wid,
      pid: window.pid,
      layer: window.layer,
      bundleId: window.bundleId,
      rect: globalToLocal(global, context.origin),
      global,
      eligible,
      reasons,
      own: context.rules.ownPids.includes(window.pid),
    }
  })
  const displays: DebugDisplayItem[] = context.displays.map((display) => {
    const globalBounds = electronRect(display.bounds)
    const globalWorkArea = electronRect(display.workArea)
    return {
      id: display.id,
      primary: display.id === context.primaryDisplayId,
      scaleFactor: display.scaleFactor,
      bounds: globalToLocal(globalBounds, context.origin),
      workArea: globalToLocal(globalWorkArea, context.origin),
      globalBounds,
      globalWorkArea,
    }
  })
  return { seq: context.seq, ts, source: context.source, windows: items, displays }
}
