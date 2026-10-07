// Spike B (BITBOT_SPEC.md §12): helper window-geometry harness. IPC channel names and payloads shared
// by src/main/spike/windowsSpike.ts and src/renderer/spike/debug.ts, which renders two roles:
//   overlay  a transparent, click-through, display-sized window that outlines every window of the
//            newest helper snapshot (green = §8.2 eligible, grey dashed = ineligible), Electron's
//            display bounds and work area, and a cursor crosshair;
//   probe    a small frameless window the harness moves around to compare the helper's bounds with
//            win.getBounds().
// Throwaway: removed together with the harness.
//
// Privacy (§2): window entries carry bounds, layer, pid and bundle id only. Titles are never read.

export const SPIKE_WINDOWS_IPC = {
  /** renderer → main: the page has drawn its first frame. Payload: DebugReadyMsg */
  ready: 'spike:windows:ready',
  /** main → overlay: the newest helper snapshot as window-local rectangles. Payload: DebugSceneMsg */
  scene: 'spike:windows:scene',
  /** main → overlay: cursor position, ~tuning.spikeWindows.cursorHz. Payload: DebugCursorMsg */
  cursor: 'spike:windows:cursor',
  /** main → overlay: HUD text. Payload: DebugStatusMsg */
  status: 'spike:windows:status',
  /** overlay → main: a scene has been drawn. Payload: DebugDrawnMsg */
  drawn: 'spike:windows:drawn',
  /** main → probe: caption text. Payload: DebugProbeMsg */
  probe: 'spike:windows:probe',
} as const

export const DEBUG_PAGE_ROLES = ['overlay', 'probe'] as const
export type DebugPageRole = (typeof DEBUG_PAGE_ROLES)[number]

export function isDebugPageRole(value: unknown): value is DebugPageRole {
  return (DEBUG_PAGE_ROLES as readonly unknown[]).includes(value)
}

/** A rectangle in points (CSS px in the overlay page). */
export interface DebugRect {
  x: number
  y: number
  w: number
  h: number
}

/** Why a window is not a surface (§8.2). Several can apply at once. */
export const INELIGIBLE_REASONS = ['layer', 'offscreen', 'alpha', 'small', 'own', 'excluded'] as const
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number]

export interface DebugWindowItem {
  /** Index in the snapshot: 0 = frontmost (§5.3 keeps the window server's front-to-back order). */
  z: number
  /** CGWindowID. */
  wid: number
  pid: number
  layer: number
  bundleId: string | null
  /** Overlay-local rectangle (global minus the overlay window's origin). */
  rect: DebugRect
  /** Global bounds as the helper reported them. */
  global: DebugRect
  eligible: boolean
  /** Empty exactly when eligible. */
  reasons: IneligibleReason[]
  /** Owned by this Bitbot process. */
  own: boolean
}

export interface DebugDisplayItem {
  id: number
  primary: boolean
  scaleFactor: number
  /** Overlay-local. */
  bounds: DebugRect
  workArea: DebugRect
  /** Global, as Electron's screen API reports them. */
  globalBounds: DebugRect
  globalWorkArea: DebugRect
}

export interface DebugSceneMsg {
  seq: number
  /** Helper snapshot time, unix seconds. */
  ts: number
  /** 'push': polled at the snapshot rate; 'request': fetched by a harness check. */
  source: 'push' | 'request'
  /** Front-to-back. */
  windows: DebugWindowItem[]
  displays: DebugDisplayItem[]
}

/** Cursor in overlay-local (x, y) and global (gx, gy) points. */
export interface DebugCursorMsg {
  x: number
  y: number
  gx: number
  gy: number
}

export interface DebugStatusMsg {
  lines: string[]
}

export interface DebugReadyMsg {
  role: DebugPageRole
  /** window.devicePixelRatio (2 on a Retina display). */
  dpr: number
  /** Page size in CSS px; should equal the window's content size in points. */
  width: number
  height: number
}

export interface DebugDrawnMsg {
  seq: number
}

export interface DebugProbeMsg {
  text: string
}

// ───────────────────────────── type guards (renderer side) ─────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function isDebugRect(value: unknown): value is DebugRect {
  return isRecord(value) && isNum(value['x']) && isNum(value['y']) && isNum(value['w']) && isNum(value['h'])
}

function isDebugWindowItem(value: unknown): value is DebugWindowItem {
  if (!isRecord(value)) return false
  const { z, wid, pid, layer, bundleId, rect, global, eligible, reasons, own } = value
  return (
    isNum(z) &&
    isNum(wid) &&
    isNum(pid) &&
    isNum(layer) &&
    (bundleId === null || typeof bundleId === 'string') &&
    isDebugRect(rect) &&
    isDebugRect(global) &&
    typeof eligible === 'boolean' &&
    Array.isArray(reasons) &&
    reasons.every((reason) => (INELIGIBLE_REASONS as readonly unknown[]).includes(reason)) &&
    typeof own === 'boolean'
  )
}

function isDebugDisplayItem(value: unknown): value is DebugDisplayItem {
  if (!isRecord(value)) return false
  const { id, primary, scaleFactor, bounds, workArea, globalBounds, globalWorkArea } = value
  return (
    isNum(id) &&
    typeof primary === 'boolean' &&
    isNum(scaleFactor) &&
    isDebugRect(bounds) &&
    isDebugRect(workArea) &&
    isDebugRect(globalBounds) &&
    isDebugRect(globalWorkArea)
  )
}

export function isDebugSceneMsg(value: unknown): value is DebugSceneMsg {
  if (!isRecord(value)) return false
  const { seq, ts, source, windows, displays } = value
  return (
    isNum(seq) &&
    isNum(ts) &&
    (source === 'push' || source === 'request') &&
    Array.isArray(windows) &&
    windows.every(isDebugWindowItem) &&
    Array.isArray(displays) &&
    displays.every(isDebugDisplayItem)
  )
}

export function isDebugCursorMsg(value: unknown): value is DebugCursorMsg {
  return isRecord(value) && isNum(value['x']) && isNum(value['y']) && isNum(value['gx']) && isNum(value['gy'])
}

export function isDebugStatusMsg(value: unknown): value is DebugStatusMsg {
  return isRecord(value) && Array.isArray(value['lines']) && value['lines'].every((line) => typeof line === 'string')
}

export function isDebugReadyMsg(value: unknown): value is DebugReadyMsg {
  return (
    isRecord(value) &&
    isDebugPageRole(value['role']) &&
    isNum(value['dpr']) &&
    isNum(value['width']) &&
    isNum(value['height'])
  )
}

export function isDebugDrawnMsg(value: unknown): value is DebugDrawnMsg {
  return isRecord(value) && isNum(value['seq'])
}

export function isDebugProbeMsg(value: unknown): value is DebugProbeMsg {
  return isRecord(value) && typeof value['text'] === 'string'
}

// ───────────────────────────── labels (pure; unit-tested) ─────────────────────────────

/** Label text for one window: z-index, CGWindowID, layer, owner bundle id, size, and why it is ineligible. */
export function windowLabel(item: Pick<DebugWindowItem, 'z' | 'wid' | 'layer' | 'bundleId' | 'global' | 'reasons' | 'own'>): string {
  const owner = item.own ? `Bitbot ${item.bundleId ?? ''}`.trimEnd() : (item.bundleId ?? '(no bundle id)')
  const why = item.reasons.length > 0 ? ` ✕ ${item.reasons.join(',')}` : ''
  return `#${item.z} wid ${item.wid} L${item.layer} ${owner} ${Math.round(item.global.w)}×${Math.round(item.global.h)}${why}`
}

/**
 * Places a label box at `preferred`, clamped inside `area`; while it overlaps an already placed box it
 * moves down one label height (wrapping to the top of `area`), at most `maxShifts` times. The result
 * may still overlap when every tried slot is taken. Front windows are placed first, so they win.
 */
export function placeLabel(
  preferred: { x: number; y: number },
  size: { w: number; h: number },
  placed: readonly DebugRect[],
  area: DebugRect,
  maxShifts: number,
): DebugRect {
  const clampX = (x: number): number => Math.max(area.x, Math.min(x, area.x + area.w - size.w))
  const clampY = (y: number): number => Math.max(area.y, Math.min(y, area.y + area.h - size.h))
  let box: DebugRect = { x: clampX(preferred.x), y: clampY(preferred.y), w: size.w, h: size.h }
  for (let shift = 0; shift < maxShifts && placed.some((other) => rectsOverlap(box, other)); shift++) {
    let y = box.y + size.h + 1
    if (y + size.h > area.y + area.h) y = area.y
    box = { ...box, y: clampY(y) }
  }
  return box
}

export function rectsOverlap(a: DebugRect, b: DebugRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
