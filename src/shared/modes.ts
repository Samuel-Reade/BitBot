// The pet's modes and hangout spots (§10.3), in §16's save shape (SaveFile.behavior). Shared: main keeps them
// (src/main/sim/modes.ts), the menus show them, M8 saves them. Pure.

import type { Point } from './geometry'

/** §10.3: Roam (the brain's full range), Stay (stays where it is), Hangout (lives at a spot). */
export const PET_MODES = ['roam', 'stay', 'hangout'] as const
export type PetMode = (typeof PET_MODES)[number]

export function isPetMode(value: unknown): value is PetMode {
  return typeof value === 'string' && (PET_MODES as readonly string[]).includes(value)
}

/**
 * A hangout spot (§10.3, §16 HangoutSpot). 'screen': a fixed point snapped to a surface ("Dock, left side").
 * 'app': on an app's frontmost visible window, relativeX (0–1) along its top, following it; while the app has no visible
 * window the pet goes to fallbackId's spot (null: the default home).
 */
export type HangoutSpot =
  | { id: string; name: string; kind: 'screen'; displayId: number; x: number; y: number }
  | { id: string; name: string; kind: 'app'; bundleId: string; appName: string; relativeX: number; fallbackId: string | null }

/** §16 SaveFile.behavior. */
export interface ModeSettings {
  mode: PetMode
  /** Where Stay keeps the pet (the drop point, §10.4), global pt; null: wherever it is. */
  stayPoint: Point | null
  activeHangoutId: string | null
  /** The spot "Go home" goes to when no hangout is active (settings, M8); null: the middle of the Dock. */
  defaultHomeId: string | null
  hangouts: HangoutSpot[]
}

export const DEFAULT_MODE_SETTINGS: ModeSettings = {
  mode: 'roam',
  stayPoint: null,
  activeHangoutId: null,
  defaultHomeId: null,
  hangouts: [],
}
