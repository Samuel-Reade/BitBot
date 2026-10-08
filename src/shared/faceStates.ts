// The pixel face's vocabulary (§6.3): eyes × mouth × overlays. Shared so main (the dev panel's face picker, its
// validation) and the overlay (face.ts draws them, animator.ts picks them) agree. Pure.

export const EYES_STATES = [
  'open',
  'blink',
  'closed',
  'happy',
  'sad',
  'wide',
  'look-left',
  'look-right',
  'look-up',
  'dizzy',
  'heart',
] as const
export const MOUTH_STATES = ['smile', 'flat', 'wavy', 'open-chew-A', 'open-chew-B', 'o', 'yawn'] as const
/** Drawn in this order (later = on top), whatever order a state lists them in. */
export const FACE_OVERLAYS = ['dust', 'blush', 'static', 'loading', 'zzz', 'heart-pop'] as const
/** Overlays that move: face.ts draws them from FaceState.frame (an animation frame index). */
export const ANIMATED_FACE_OVERLAYS = ['static', 'loading', 'zzz', 'heart-pop'] as const

export type EyesState = (typeof EYES_STATES)[number]
export type MouthState = (typeof MOUTH_STATES)[number]
export type FaceOverlay = (typeof FACE_OVERLAYS)[number]

export interface FaceState {
  readonly eyes: EyesState
  readonly mouth: MouthState
  readonly overlays: readonly FaceOverlay[]
  /**
   * Animation frame index (an integer ≥ 0) for the animated overlays: each one advances one step per frame and loops
   * on its own period. Ignored when no animated overlay is shown, so a static face never redraws for it.
   */
  readonly frame: number
}

export const DEFAULT_FACE_STATE: FaceState = { eyes: 'open', mouth: 'smile', overlays: [], frame: 0 }

/** The dev panel's face picker: the fields it forces (absent = the animator's own). */
export interface FaceOverride {
  eyes?: EyesState
  mouth?: MouthState
  overlays?: readonly FaceOverlay[]
}

export function isEyesState(value: unknown): value is EyesState {
  return typeof value === 'string' && (EYES_STATES as readonly string[]).includes(value)
}
export function isMouthState(value: unknown): value is MouthState {
  return typeof value === 'string' && (MOUTH_STATES as readonly string[]).includes(value)
}
export function isFaceOverlay(value: unknown): value is FaceOverlay {
  return typeof value === 'string' && (FACE_OVERLAYS as readonly string[]).includes(value)
}
export function isAnimatedOverlay(value: FaceOverlay): boolean {
  return (ANIMATED_FACE_OVERLAYS as readonly string[]).includes(value)
}

export function isFaceOverride(value: unknown): value is FaceOverride {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  for (const key of Object.keys(v)) if (key !== 'eyes' && key !== 'mouth' && key !== 'overlays') return false
  if (v['eyes'] !== undefined && !isEyesState(v['eyes'])) return false
  if (v['mouth'] !== undefined && !isMouthState(v['mouth'])) return false
  if (v['overlays'] !== undefined && !(Array.isArray(v['overlays']) && v['overlays'].every(isFaceOverlay))) return false
  return true
}
