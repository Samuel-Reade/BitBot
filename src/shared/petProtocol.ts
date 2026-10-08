// Payloads of the pet overlay's IPC channels (channel names in ./ipc.ts) and their validators. Pure; main validates
// everything it receives from the renderer, and the renderer validates what main sends.
//
// Overlay approach B, hardened (docs/decisions/overlay.md): main owns the simulation and tells the overlay where the
// pet is; the overlay draws it on a small canvas it moves itself, and handles the mouse through a small "grab area"
// window (the hit window) that it opens with window.open, so both live in one renderer process.
//
// Epochs: main numbers every reset of the grab area it makes on its own (grab area hidden or shown, safety net,
// cancel, menu closed, shown/hidden by the user). The overlay stamps pet:hover and pet:pointer with the newest epoch it
// has seen (from pet:config, pet:hover-reset, pet:visible), and main drops messages from an older epoch, so a hover
// or press that was in flight during a reset can never switch the grab area back on.

import { isBox, isPetArea, isPoint, isRect, type Box, type PetArea, type Point, type Rect } from './geometry'
import { isPaletteId } from './palettes'
import { isFaceOverride, type FaceOverride } from './faceStates'
import { isPetAttach, type PetAttach } from './world'
import {
  isBehaviorState,
  isIdleMode,
  isLookDirection,
  isMood,
  type BehaviorState,
  type IdleMode,
  type LookDirection,
  type Mood,
  type PaletteId,
  type PetSize,
} from './types'

/** Prefix of the grab area's window.open target name. Main issues a fresh name per overlay page load. */
export const HIT_WINDOW_NAME_PREFIX = 'bitbot-hit'
/** The grab area's document: an empty page in the overlay's origin and process. */
export const HIT_WINDOW_URL = 'about:blank'

/** `bitbot-hit-<n>` for the n-th overlay page load (n ≥ 1). */
export function hitWindowName(load: number): string {
  return `${HIT_WINDOW_NAME_PREFIX}-${load}`
}

export function isHitWindowName(value: unknown): value is string {
  return typeof value === 'string' && /^bitbot-hit-[1-9]\d*$/.test(value)
}

/** pet:config (invoke reply, once per page load) and pet:config-changed. */
export interface PetConfig {
  /** Increments whenever main sends a new configuration; the overlay reports the one it has drawn (PetDrawnMsg). */
  configSeq: number
  /** Overlay window content bounds, global pt (the primary display's bounds). */
  overlay: Rect
  /** Where the pet's ground-contact point may be. Null until main knows the pet's box (before pet:ready). */
  area: PetArea | null
  /** Simulation step, ms. The overlay renders one step behind main's clock. */
  stepMs: number
  size: PetSize
  paletteId: PaletteId
  /** The window.open name main allows for this page load's grab area (same for every config of one load). */
  hitWindowName: string
  /** Current epoch (see the header). */
  epoch: number
  /** Dev check: also keep the sample lists in debug:overlay-stats (the counters are always kept). */
  debug: boolean
}

/** pet:state — main → overlay. Sent when x, y, facing, state or supportY changed, and with snap after a jump. */
export interface PetStateMsg {
  seq: number
  /** Nominal simulation time of this state on main's monotonic clock, ms. */
  t: number
  /** Main's clock when sent, ms: lets the overlay estimate the clock offset. */
  sentAt: number
  /** Ground-contact point, global pt. */
  x: number
  y: number
  facing: 1 | -1
  state: BehaviorState
  /** Mood (§9.2): picks face defaults and layered cues (§6.4). */
  mood: Mood
  /** Dust level 0..1 (§9.1 dust ÷ 100): grey specks on the body and face (§6.4 "dusty"), visible from tuning.anim.dust.visibleFrom. */
  dust: number
  /** Where the cursor is, for the eyes (§6.3: within ~300 pt; the overlay uses it only in states that look around). */
  look: LookDirection | null
  /** Standing (or in the air) vs climbing a wall on its left / right: the overlay turns the pet onto the wall. */
  attach: PetAttach
  /** y of the surface line under the pet, global pt (the contact shadow is drawn there, §6.1); null: nothing below. */
  supportY: number | null
  /** Do not interpolate from earlier states (first state, release, shown again, display change). */
  snap: boolean
}

/** pet:ready — overlay → main, after its first frame. Sent again by every page load. */
export interface PetReadyMsg {
  /** The configuration this frame was drawn with. */
  configSeq: number
  /** Viewport point (CSS px from the canvas's top-left) where the ground-contact point is drawn. */
  anchor: Point
  /** The pet's projected box relative to the ground-contact point, pt: the union over both facings. */
  petBox: Box
  /** Pet canvas edge, CSS px (= pt). */
  edge: number
  devicePixelRatio: number
  /** Unmasked WebGL renderer string, when the browser exposes it. */
  glRenderer: string | null
  /** window.open returned the grab-area window. */
  hitWindowOpened: boolean
}

/** pet:drawn — overlay → main: the pet is (not) on its canvas for configuration configSeq. */
export interface PetDrawnMsg {
  drawn: boolean
  configSeq: number
}

/** pet:cursor — main → overlay: the cursor, global pt. */
export interface PetCursorMsg {
  x: number
  y: number
}

/** pet:hover-reset — main → overlay. */
export interface PetHoverResetMsg {
  epoch: number
}

/** pet:visible — main → overlay. */
export interface PetVisibleMsg {
  visible: boolean
  epoch: number
}

/** pet:hover — overlay → main: the cursor is / is no longer over the pet's silhouette. */
export interface PetHoverMsg {
  over: boolean
  epoch: number
}

/**
 * pet:pointer — overlay → main: press, release and right-click on the pet. screenX/screenY: the pointer, global pt.
 * groundX/groundY on 'down': where the overlay drew the pet's ground-contact point at that moment, so main holds the
 * pet by exactly the grab offset the overlay uses.
 */
export type PetPointerMsg =
  | { kind: 'down'; button: number; screenX: number; screenY: number; groundX: number; groundY: number; epoch: number }
  | { kind: 'up'; button: number; screenX: number; screenY: number; epoch: number }
  | { kind: 'contextmenu'; screenX: number; screenY: number; epoch: number }

/** pet:ping — main → overlay, every tuning.overlay.watchdog.pingMs while a page is ready: answer with pet:pong. */
export interface PetPingMsg {
  id: number
}

/** pet:pong — overlay → main: the answer to pet:ping `id` (a page that stops answering is recreated). */
export interface PetPongMsg {
  id: number
}

/** debug:pet — main → overlay, dev builds: the dev panel's renderer-side overrides (sent again after every pet:ready). */
export interface DevPetMsg {
  /** Face fields to force; null: the animator's own face. */
  face: FaceOverride | null
  idleMode: IdleMode
}

/** pet:log — overlay → main. */
export interface PetLogMsg {
  level: 'error' | 'warning' | 'info'
  message: string
}

/**
 * debug:overlay-stats — overlay → main (the dev check, the dev panel). Counters since the page loaded (or the last reset) and capped
 * sample lists (ms).
 */
export interface OverlayStatsMsg {
  /** Renderer clock (performance.now()) when the stats were taken, ms. */
  at: number
  /** requestAnimationFrame callbacks run. */
  frames: number
  /** WebGL renders (pet.render()). */
  renders: number
  /** Frames with nothing newer to interpolate toward. */
  starvedFrames: number
  /** Frame intervals above tuning.overlay.longFrameMs. */
  longFrames: number
  rafIntervalsMs: number[]
  /** Hit-window mousemove event time → the frame that drew the pet for it, ms. */
  inputToFrameMs: number[]
  cursorMsgs: number
  cursorMsgsIgnored: number
  hitTests: number
  hoverMsgs: number
  pointerMsgs: number
  contextLosses: number
  /** A sample list hit its cap. */
  truncated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isCount(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && Number.isInteger(value)
}

function isPetSize(value: unknown): value is PetSize {
  return value === 'S' || value === 'M' || value === 'L'
}

export function isPetConfig(value: unknown): value is PetConfig {
  return (
    isRecord(value) &&
    isCount(value['configSeq']) &&
    isRect(value['overlay']) &&
    (value['area'] === null || isPetArea(value['area'])) &&
    isFiniteNumber(value['stepMs']) &&
    value['stepMs'] > 0 &&
    isPetSize(value['size']) &&
    isPaletteId(value['paletteId']) &&
    isHitWindowName(value['hitWindowName']) &&
    isCount(value['epoch']) &&
    typeof value['debug'] === 'boolean'
  )
}

export function isPetStateMsg(value: unknown): value is PetStateMsg {
  return (
    isRecord(value) &&
    isFiniteNumber(value['seq']) &&
    isFiniteNumber(value['t']) &&
    isFiniteNumber(value['sentAt']) &&
    isFiniteNumber(value['x']) &&
    isFiniteNumber(value['y']) &&
    (value['facing'] === 1 || value['facing'] === -1) &&
    isBehaviorState(value['state']) &&
    isMood(value['mood']) &&
    isFiniteNumber(value['dust']) &&
    value['dust'] >= 0 &&
    value['dust'] <= 1 &&
    (value['look'] === null || isLookDirection(value['look'])) &&
    isPetAttach(value['attach']) &&
    (value['supportY'] === null || isFiniteNumber(value['supportY'])) &&
    typeof value['snap'] === 'boolean'
  )
}

export function isPetReadyMsg(value: unknown): value is PetReadyMsg {
  return (
    isRecord(value) &&
    isCount(value['configSeq']) &&
    isPoint(value['anchor']) &&
    isBox(value['petBox']) &&
    isFiniteNumber(value['edge']) &&
    value['edge'] > 0 &&
    isFiniteNumber(value['devicePixelRatio']) &&
    value['devicePixelRatio'] > 0 &&
    (value['glRenderer'] === null || typeof value['glRenderer'] === 'string') &&
    typeof value['hitWindowOpened'] === 'boolean'
  )
}

export function isPetDrawnMsg(value: unknown): value is PetDrawnMsg {
  return isRecord(value) && typeof value['drawn'] === 'boolean' && isCount(value['configSeq'])
}

export function isPetCursorMsg(value: unknown): value is PetCursorMsg {
  return isPoint(value)
}

export function isPetHoverResetMsg(value: unknown): value is PetHoverResetMsg {
  return isRecord(value) && isCount(value['epoch'])
}

export function isPetVisibleMsg(value: unknown): value is PetVisibleMsg {
  return isRecord(value) && typeof value['visible'] === 'boolean' && isCount(value['epoch'])
}

export function isPetHoverMsg(value: unknown): value is PetHoverMsg {
  return isRecord(value) && typeof value['over'] === 'boolean' && isCount(value['epoch'])
}

export function isPetPointerMsg(value: unknown): value is PetPointerMsg {
  if (!isRecord(value) || !isCount(value['epoch'])) return false
  if (!isFiniteNumber(value['screenX']) || !isFiniteNumber(value['screenY'])) return false
  switch (value['kind']) {
    case 'contextmenu':
      return true
    case 'up':
      return isFiniteNumber(value['button'])
    case 'down':
      return isFiniteNumber(value['button']) && isFiniteNumber(value['groundX']) && isFiniteNumber(value['groundY'])
    default:
      return false
  }
}

export function isPetLogMsg(value: unknown): value is PetLogMsg {
  return (
    isRecord(value) &&
    (value['level'] === 'error' || value['level'] === 'warning' || value['level'] === 'info') &&
    typeof value['message'] === 'string'
  )
}

export function isPetPingMsg(value: unknown): value is PetPingMsg {
  return isRecord(value) && isCount(value['id'])
}

export function isPetPongMsg(value: unknown): value is PetPongMsg {
  return isRecord(value) && isCount(value['id'])
}

export function isDevPetMsg(value: unknown): value is DevPetMsg {
  return isRecord(value) && (value['face'] === null || isFaceOverride(value['face'])) && isIdleMode(value['idleMode'])
}

function isNumberList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber)
}

export function isOverlayStatsMsg(value: unknown): value is OverlayStatsMsg {
  return (
    isRecord(value) &&
    isFiniteNumber(value['at']) &&
    isCount(value['frames']) &&
    isCount(value['renders']) &&
    isCount(value['starvedFrames']) &&
    isCount(value['longFrames']) &&
    isNumberList(value['rafIntervalsMs']) &&
    isNumberList(value['inputToFrameMs']) &&
    isCount(value['cursorMsgs']) &&
    isCount(value['cursorMsgsIgnored']) &&
    isCount(value['hitTests']) &&
    isCount(value['hoverMsgs']) &&
    isCount(value['pointerMsgs']) &&
    isCount(value['contextLosses']) &&
    typeof value['truncated'] === 'boolean'
  )
}

