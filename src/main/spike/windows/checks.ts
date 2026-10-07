// Pure comparisons behind the Spike B windows harness's PASS/FAIL lines (BITBOT_SPEC.md §12, §5.3).
// No Electron imports: unit-tested in test/spikeB-checks.test.ts.

import type { DebugRect } from '../../../shared/spikeWindows'
import type { DisplayInfo, HelperWindow } from '../../helper/protocol'
import { electronRect, helperRect, type ElectronDisplayLike, type ElectronRect } from './eligibility'

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'INFO'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
}

/**
 * macOS window levels (CGWindowLevelKey values on macOS 13-15). Platform constants, not tunables:
 * kCGNormalWindowLevel 0, kCGFloatingWindowLevel 3 (Electron 'floating'), kCGDockWindowLevel 20,
 * kCGMainMenuWindowLevel 24, kCGStatusWindowLevel 25.
 */
export const CG_LEVEL = { normal: 0, floating: 3, dock: 20, mainMenu: 24, status: 25 } as const

export const DOCK_BUNDLE_ID = 'com.apple.dock'
export const NOTIFICATION_CENTER_BUNDLE_ID = 'com.apple.notificationcenterui'

// ───────────────────────────── window ids ─────────────────────────────

/** CGWindowID from BrowserWindow.getMediaSourceId(), which is 'window:<CGWindowID>:0' on macOS. */
export function parseMediaSourceId(id: string): number | null {
  const match = /^window:(\d+):/.exec(id)
  if (!match?.[1]) return null
  const wid = Number(match[1])
  return Number.isSafeInteger(wid) && wid > 0 ? wid : null
}

// ───────────────────────────── rectangles ─────────────────────────────

export interface RectDelta {
  dx: number
  dy: number
  dw: number
  dh: number
  /** Largest absolute component. */
  max: number
  pass: boolean
}

/** helper − electron, per component; pass when every component is within `tolerance` pt. */
export function compareRects(helper: DebugRect, electron: DebugRect, tolerance: number): RectDelta {
  const dx = helper.x - electron.x
  const dy = helper.y - electron.y
  const dw = helper.w - electron.w
  const dh = helper.h - electron.h
  const max = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh))
  return { dx, dy, dw, dh, max, pass: max <= tolerance }
}

export function formatRect(rect: DebugRect | null): string {
  if (!rect) return '—'
  return `${rect.x},${rect.y} ${rect.w}×${rect.h}`
}

export function formatDelta(delta: RectDelta | null): string {
  if (!delta) return 'Δ —'
  return `Δ(x,y,w,h)=(${delta.dx},${delta.dy},${delta.dw},${delta.dh})`
}

// ───────────────────────────── probe positions ─────────────────────────────

export interface ProbePosition {
  name: string
  x: number
  y: number
}

/**
 * Where the coordinate probe goes: the four work-area corners, the work-area centre, and two spots
 * hanging `offscreenFraction` of the probe past the display's right and bottom edges (a window may be
 * partly off screen; its bounds must still agree).
 */
export function probePositions(
  display: ElectronRect,
  workArea: ElectronRect,
  size: { w: number; h: number },
  offscreenFraction: number,
): ProbePosition[] {
  const left = workArea.x
  const top = workArea.y
  const right = workArea.x + workArea.width - size.w
  const bottom = workArea.y + workArea.height - size.h
  const centerX = Math.round(workArea.x + (workArea.width - size.w) / 2)
  const centerY = Math.round(workArea.y + (workArea.height - size.h) / 2)
  return [
    { name: 'work-area top-left', x: left, y: top },
    { name: 'work-area top-right', x: right, y: top },
    { name: 'work-area bottom-left', x: left, y: bottom },
    { name: 'work-area bottom-right', x: right, y: bottom },
    { name: 'work-area centre', x: centerX, y: centerY },
    {
      name: 'off right edge',
      x: Math.round(display.x + display.width - size.w * (1 - offscreenFraction)),
      y: centerY,
    },
    {
      name: 'off bottom edge',
      x: centerX,
      y: Math.round(display.y + display.height - size.h * (1 - offscreenFraction)),
    },
  ]
}

// ───────────────────────────── displays ─────────────────────────────

export interface DisplayRow {
  electronId: number
  helperId: number | null
  /** How the helper display was paired: by id (expected: Electron's id is the CGDirectDisplayID), or by bounds. */
  matchedBy: 'id' | 'bounds' | null
  electron: DebugRect
  helper: DebugRect | null
  delta: RectDelta | null
  electronPrimary: boolean
  helperMain: boolean | null
  pass: boolean
}

export interface DisplayComparison {
  pass: boolean
  rows: DisplayRow[]
  /** Helper displays no Electron display matched. */
  unmatchedHelperIds: number[]
  detail: string
}

/** Electron screen.getAllDisplays() bounds vs the helper's CGDisplayBounds, paired by id (or bounds). */
export function compareDisplays(
  helper: readonly DisplayInfo[],
  electron: readonly ElectronDisplayLike[],
  primaryId: number,
  tolerance: number,
): DisplayComparison {
  const used = new Set<number>()
  const rows: DisplayRow[] = electron.map((display) => {
    const bounds = electronRect(display.bounds)
    let match = helper.find((h) => h.id === display.id && !used.has(h.id))
    let matchedBy: DisplayRow['matchedBy'] = match ? 'id' : null
    if (!match) {
      match = helper.find((h) => !used.has(h.id) && compareRects(helperRect(h), bounds, tolerance).pass)
      matchedBy = match ? 'bounds' : null
    }
    if (match) used.add(match.id)
    const helperBounds = match ? helperRect(match) : null
    const delta = helperBounds ? compareRects(helperBounds, bounds, tolerance) : null
    const electronPrimary = display.id === primaryId
    const helperMain = match ? match.main : null
    return {
      electronId: display.id,
      helperId: match?.id ?? null,
      matchedBy,
      electron: bounds,
      helper: helperBounds,
      delta,
      electronPrimary,
      helperMain,
      pass: delta !== null && delta.pass && helperMain === electronPrimary,
    }
  })
  const unmatchedHelperIds = helper.filter((h) => !used.has(h.id)).map((h) => h.id)
  const pass = rows.length > 0 && rows.every((row) => row.pass) && unmatchedHelperIds.length === 0
  const parts = rows.map(
    (row) =>
      `display ${row.electronId}${row.electronPrimary ? ' (primary)' : ''}: electron ${formatRect(row.electron)} ` +
      `helper ${row.helperId === null ? 'none' : `${row.helperId}${row.helperMain ? ' (main)' : ''} ${formatRect(row.helper)}`}` +
      `${row.matchedBy === 'bounds' ? ' [ids differ]' : ''} ${formatDelta(row.delta)}`,
  )
  if (unmatchedHelperIds.length > 0) parts.push(`helper displays without an Electron display: ${unmatchedHelperIds.join(', ')}`)
  return { pass, rows, unmatchedHelperIds, detail: parts.join('; ') }
}

// ───────────────────────────── levels ─────────────────────────────

export interface LayerGroup {
  layer: number
  count: number
  /** Distinct owners: bundle ids, '(no bundle id)' for the window server, 'Bitbot' for ours. */
  owners: string[]
}

export interface LevelReport {
  overlay: { wid: number; layer: number } | null
  probe: { wid: number; layer: number } | null
  /** Distinct non-negative layers of the Dock's windows (empty when none is on screen). */
  dockLayers: number[]
  /** The Dock layer the verdict compares against (lowest Dock layer, or the CG constant). */
  dock: { layer: number; from: 'snapshot' | 'constant' }
  /** The menu bar: the window server's display-wide strip at the top (bundle id null). */
  menuBar: { layer: number; from: 'snapshot' | 'constant'; wid: number | null }
  notificationCenterLayers: number[]
  /** Other apps' layer-0 windows. */
  normalWindows: number
  /** Every layer present, highest first. */
  layers: LayerGroup[]
}

export interface LevelContext {
  ownPid: number
  overlayWid: number | null
  probeWid: number | null
  /** Primary display bounds (global, Electron style): where the menu bar strip lives. */
  display: ElectronRect
}

const sortDesc = (values: Iterable<number>): number[] => [...new Set(values)].sort((a, b) => b - a)

export function classifyLevels(windows: readonly HelperWindow[], context: LevelContext): LevelReport {
  const own = (wid: number | null): { wid: number; layer: number } | null => {
    if (wid === null) return null
    const found = windows.find((window) => window.wid === wid)
    return found ? { wid, layer: found.layer } : null
  }
  const dockLayers = sortDesc(windows.filter((w) => w.bundleId === DOCK_BUNDLE_ID && w.layer >= 0).map((w) => w.layer))
  const lowestDock = dockLayers[dockLayers.length - 1]
  const d = context.display
  const strip = windows.find(
    (w) =>
      w.bundleId === null &&
      w.layer === CG_LEVEL.mainMenu &&
      Math.abs(w.x - d.x) <= 1 &&
      Math.abs(w.y - d.y) <= 1 &&
      Math.abs(w.w - d.width) <= 1 &&
      w.h < d.height / 4,
  )
  const anyMainMenu = windows.find((w) => w.layer === CG_LEVEL.mainMenu)
  const menuBarWindow = strip ?? anyMainMenu
  const groups = new Map<number, { count: number; owners: Set<string> }>()
  for (const w of windows) {
    const group = groups.get(w.layer) ?? { count: 0, owners: new Set<string>() }
    group.count += 1
    group.owners.add(w.pid === context.ownPid ? 'Bitbot' : (w.bundleId ?? '(no bundle id)'))
    groups.set(w.layer, group)
  }
  return {
    overlay: own(context.overlayWid),
    probe: own(context.probeWid),
    dockLayers,
    dock: lowestDock !== undefined ? { layer: lowestDock, from: 'snapshot' } : { layer: CG_LEVEL.dock, from: 'constant' },
    menuBar: menuBarWindow
      ? { layer: menuBarWindow.layer, from: 'snapshot', wid: menuBarWindow.wid }
      : { layer: CG_LEVEL.mainMenu, from: 'constant', wid: null },
    notificationCenterLayers: sortDesc(windows.filter((w) => w.bundleId === NOTIFICATION_CENTER_BUNDLE_ID).map((w) => w.layer)),
    normalWindows: windows.filter((w) => w.layer === CG_LEVEL.normal && w.pid !== context.ownPid).length,
    layers: sortDesc(groups.keys()).map((layer) => {
      const group = groups.get(layer)
      return { layer, count: group?.count ?? 0, owners: [...(group?.owners ?? [])].sort() }
    }),
  }
}

/** §5.2 / §12: the overlay sits above normal windows and below the Dock and the menu bar. */
export function levelVerdict(report: LevelReport): CheckResult {
  const name = 'level'
  if (!report.overlay) return { name, status: 'SKIP', detail: 'no overlay window in the snapshot (--overlay=false?)' }
  const ours = report.overlay.layer
  const ok = ours > CG_LEVEL.normal && ours < report.dock.layer && ours < report.menuBar.layer
  const from = (source: 'snapshot' | 'constant'): string => (source === 'constant' ? ' (not on screen; CG constant)' : '')
  return {
    name,
    status: ok ? 'PASS' : 'FAIL',
    detail:
      `overlay layer ${ours} vs normal windows ${CG_LEVEL.normal}, Dock ${report.dock.layer}${from(report.dock.from)}, ` +
      `menu bar ${report.menuBar.layer}${from(report.menuBar.from)}`,
  }
}

// ───────────────────────────── fullscreen (§8.6) ─────────────────────────────

/** A frontmostFullscreen state the helper reported, and whether the overlay was on screen shortly after. */
export interface FullscreenObservation {
  tRunS: number
  value: boolean
  bundleId: string | null
  /** null = not checked (no overlay, or the run ended first). */
  overlayOnScreen: boolean | null
}

/**
 * The overlay entering or leaving the helper's on-screen window list, seen in any snapshot. Recorded
 * independently of the helper's fullscreen verdict, so a missed fullscreen detection still shows up.
 */
export interface PresenceChange {
  tRunS: number
  present: boolean
  /** First observation after the overlay appeared (not a change). */
  initial: boolean
  /** The helper's newest frontmostFullscreen value at that moment (null = none reported yet). */
  helperFullscreen: boolean | null
}

/** 'hidden in fullscreen Spaces': judged on the helper-reported states, cross-checked with presence changes. */
export function fullscreenVerdict(
  observations: readonly FullscreenObservation[],
  presence: readonly PresenceChange[],
  windowType: string,
): CheckResult {
  const name = 'hidden in fullscreen Spaces'
  const unexplained = presence.filter((p) => !p.present && p.helperFullscreen !== true)
  const unexplainedText =
    unexplained.length > 0
      ? `; the overlay also left the on-screen list ${unexplained.length}× while the helper did NOT report fullscreen ` +
        `(at ${unexplained.map((p) => `+${p.tRunS.toFixed(1)} s`).join(', ')}): a missed detection if a fullscreen app was frontmost then`
      : ''
  const checked = observations.filter((o) => o.value && o.overlayOnScreen !== null)
  if (checked.length === 0) {
    if (unexplained.length > 0) {
      return {
        name,
        status: 'WARN',
        detail: `the helper reported no fullscreen state${unexplainedText} (its detection is unverified on this notched display)`,
      }
    }
    return {
      name,
      status: 'SKIP',
      detail:
        'the helper reported no fullscreen state while the overlay existed, and the overlay never left the on-screen list ' +
        '(the helper\'s detection is unverified on this notched display; to test: --duration=0, put an app in fullscreen and ' +
        'back, then Ctrl+C, and compare the "overlay presence" lines with what you did)',
    }
  }
  const leaked = checked.filter((o) => o.overlayOnScreen)
  return {
    name,
    status: leaked.length === 0 ? 'PASS' : 'FAIL',
    detail:
      `${checked.length - leaked.length}/${checked.length} helper-reported fullscreen states had the overlay off screen ` +
      `(window-type=${windowType}${windowType === 'panel' ? '; Spike A: an Electron panel always ORs in FullScreenAuxiliary, compare --window-type=none' : ''})` +
      unexplainedText,
  }
}

// ───────────────────────────── z-order ─────────────────────────────

/** Index of the first window whose layer is higher than the one in front of it, or -1 (sorted). */
export function firstLayerOrderViolation(windows: readonly HelperWindow[]): number {
  for (let i = 1; i < windows.length; i++) {
    const front = windows[i - 1]
    const back = windows[i]
    if (front && back && back.layer > front.layer) return i
  }
  return -1
}

export function formatZOrderEntry(window: HelperWindow, z: number, ownPid: number): string {
  const owner = window.pid === ownPid ? `Bitbot(${window.bundleId ?? 'no bundle id'})` : (window.bundleId ?? '(no bundle id)')
  return (
    `#${String(z).padStart(2)} wid=${window.wid} pid=${window.pid} ${owner} layer=${window.layer} ` +
    `${formatRect(helperRect(window))}${window.onScreen ? '' : ' offscreen'}${window.alpha < 1 ? ` alpha=${window.alpha}` : ''}`
  )
}
