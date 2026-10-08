// The developer panel's messages (§14.1, dev builds only; channels in ./ipc.ts). Milestone 2 has the character
// pickers: force a behavior state, mood, dust level, facing and face, and switch the idle style; the status shows what
// the pet does and what the overlay renders. Later milestones add their sections (needs, currencies, time scale…).
// Pure; main validates everything the panel sends.

import { isFaceOverride, type FaceOverride } from './faceStates'
import { isBehaviorState, isIdleMode, isMood, type BehaviorState, type IdleMode, type LookDirection, type Mood } from './types'

/** What the dev panel forces. A null state / facing / face means "the simulation's own". */
export interface DevOverrides {
  state: BehaviorState | null
  mood: Mood
  /** 0..1 */
  dust: number
  facing: 1 | -1 | null
  face: FaceOverride | null
  idleMode: IdleMode
  /** The debug view of the world (§14.1: surfaces, visible segments, nav graph, current path) is drawn. */
  showWorld: boolean
  /**
   * The pet wanders by itself (M3's stand-in for the M6 brain: goes to a random reachable place every few seconds).
   * Off: it stays where it is unless sent somewhere.
   */
  wander: boolean
}

/**
 * debug:panel-action — dev panel → main, one-off: 'goRandom' (somewhere reachable), 'goWindow' (onto a window top),
 * 'climbWall' (up the nearest wall or window side), 'stop' (stop where it is).
 */
export const DEV_PANEL_ACTIONS = ['goRandom', 'goWindow', 'climbWall', 'stop'] as const
export type DevPanelAction = (typeof DEV_PANEL_ACTIONS)[number]

export function isDevPanelAction(value: unknown): value is DevPanelAction {
  return typeof value === 'string' && (DEV_PANEL_ACTIONS as readonly string[]).includes(value)
}

/** The world as the simulation sees it, for the panel's status. */
export interface DevWorldStatus {
  /** Eligible windows (§8.2) in the newest snapshot. */
  windows: number
  segments: number
  walls: number
  /** The helper's snapshot rate now, Hz. */
  snapshotHz: number
  /** The surface the pet is on ('ground', 'top:<wid>:<n>', a wall id); null in the air or held. */
  surface: string | null
  /** Where it is going; null: nowhere. */
  goal: { x: number; y: number } | null
}

/** debug:panel-set — dev panel → main: the fields to change (absent = unchanged). */
export type DevPanelSet = Partial<DevOverrides>

/** debug:panel-status — main → dev panel (and the debug:panel-get reply). */
export interface DevPanelStatus {
  overrides: DevOverrides
  /** What pet:state says now (the forced state, or the simulation's). */
  state: BehaviorState
  /** The simulation's own behavior (idle, held, fall, land). */
  simState: BehaviorState
  look: LookDirection | null
  /** The pet is shown (not hidden by the user). */
  visible: boolean
  /** The overlay's counters, renders and frames per second over the last status period; null before the first. */
  rendersPerS: number | null
  framesPerS: number | null
  /** Null before the first snapshot (or without the helper). */
  world: DevWorldStatus | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const KEYS: readonly (keyof DevOverrides)[] = ['state', 'mood', 'dust', 'facing', 'face', 'idleMode', 'showWorld', 'wander']

export function isDevPanelSet(value: unknown): value is DevPanelSet {
  if (!isRecord(value)) return false
  for (const key of Object.keys(value)) if (!(KEYS as readonly string[]).includes(key)) return false
  const v = value as Record<string, unknown>
  if ('state' in v && !(v['state'] === null || isBehaviorState(v['state']))) return false
  if ('mood' in v && !isMood(v['mood'])) return false
  if ('dust' in v && !(typeof v['dust'] === 'number' && v['dust'] >= 0 && v['dust'] <= 1)) return false
  if ('facing' in v && !(v['facing'] === null || v['facing'] === 1 || v['facing'] === -1)) return false
  if ('face' in v && !(v['face'] === null || isFaceOverride(v['face']))) return false
  if ('idleMode' in v && !isIdleMode(v['idleMode'])) return false
  if ('showWorld' in v && typeof v['showWorld'] !== 'boolean') return false
  if ('wander' in v && typeof v['wander'] !== 'boolean') return false
  return true
}

export function isDevOverrides(value: unknown): value is DevOverrides {
  return isDevPanelSet(value) && KEYS.every((key) => key in value)
}
