// Shared types used by main, preload and renderers.
// Phase 2+ fields exist here so later phases are additive (see BITBOT_SPEC.md §6.5, §16).

export type PaletteId = 'mint' | 'peach' | 'lilac' | 'lemon' | 'graphite' | 'beige'

export interface Palette {
  id: PaletteId
  name: string
  primary: string
  secondary: string
  outline: string
  accent: string
  screenGlow: string
}

export type PetSize = 'S' | 'M' | 'L'

export type FormId = 'base' | 'typist' | 'navigator' | 'hopper' | 'keeper'

export const ATTACH_POINTS = [
  'head_top',
  'head_side_L',
  'head_side_R',
  'face_screen',
  'back_casing',
  'antenna_tip',
  'hand_L',
  'hand_R',
  'belly',
  'foot_L',
  'foot_R',
] as const
export type AttachPoint = (typeof ATTACH_POINTS)[number]

/** Parts of the base rig (§6.1). Phase 2 forms swap or add parts (e.g. 'keycapFingers', 'cableTail'). */
export type PartId =
  | 'body'
  | 'rearCasing'
  | 'sideVents'
  | 'bezel'
  | 'screen'
  | 'bellyLights'
  | 'bellyKeys'
  | 'antenna'
  | 'arms'
  | 'feet'
  | 'contactShadow'

export interface CharacterSpec {
  formId: FormId
  palette: Palette
  /** Parts to build, in order. The base form uses BASE_PARTS. */
  parts: readonly PartId[]
}

export const BASE_PARTS: readonly PartId[] = [
  'body',
  'rearCasing',
  'sideVents',
  'bezel',
  'screen',
  'bellyLights',
  'bellyKeys',
  'antenna',
  'arms',
  'feet',
  'contactShadow',
]

export type Currency = 'crumbs' | 'pellets' | 'treats' | 'mileage' | 'sparks'
export type Price = Partial<Record<Currency, number>>

/** Behavior states (§10.1). The state machine (M6) owns transitions; M1 uses idle, held and fall. */
export const BEHAVIOR_STATES = [
  'idle',
  'walk',
  'run',
  'jump',
  'climb',
  'sit',
  'sleep',
  'eat',
  'fall',
  'land',
  'held',
  'celebrate',
  'peek',
  'greet',
] as const
export type BehaviorState = (typeof BEHAVIOR_STATES)[number]

export function isBehaviorState(value: unknown): value is BehaviorState {
  return typeof value === 'string' && (BEHAVIOR_STATES as readonly string[]).includes(value)
}

/** Moods (§9.2): the most pressing need picks one. M6 computes it; until then the dev panel sets it. */
export const MOODS = ['happy', 'content', 'hungry', 'sleepy', 'stuffed', 'bored', 'lonely'] as const
export type Mood = (typeof MOODS)[number]

export function isMood(value: unknown): value is Mood {
  return typeof value === 'string' && (MOODS as readonly string[]).includes(value)
}

/** Where the pet's eyes follow the cursor (§6.3 look-left/right/up), from the viewer's side; null: not looking. */
export const LOOK_DIRECTIONS = ['left', 'right', 'up'] as const
export type LookDirection = (typeof LOOK_DIRECTIONS)[number]

export function isLookDirection(value: unknown): value is LookDirection {
  return typeof value === 'string' && (LOOK_DIRECTIONS as readonly string[]).includes(value)
}

/**
 * How the pet idles (docs/decisions/overlay.md, decided (c): prototype both in M2, decide with numbers).
 * 'continuous': §6.4's idle bob and sway all the time, rendered at tuning.render.fps.idle. 'event': mostly still,
 * animating in short bursts (blinks, glances, a breath, an antenna wiggle) and rendering only during them. 'still':
 * only the face moves (blinks, looks), so the outline never changes: the cheapest, and what the dev check uses to time
 * the grab area.
 */
export const IDLE_MODES = ['continuous', 'event', 'still'] as const
export type IdleMode = (typeof IDLE_MODES)[number]

export function isIdleMode(value: unknown): value is IdleMode {
  return typeof value === 'string' && (IDLE_MODES as readonly string[]).includes(value)
}

/** The pet's place in the world (§16 `pet.position`): ground-contact point in global screen points, y down. */
export interface PetPosition {
  displayId: number
  x: number
  y: number
  facing: 1 | -1
}
