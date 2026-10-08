// The user's settings and the pet's identity (BITBOT_SPEC.md §15.4, §16 SaveFile.pet and SaveFile.settings): shared by
// main (which owns and saves them, src/main/persistence/), the settings window and onboarding. Plain JSON.

import { DEFAULT_HOTKEYS, type HotkeyAction } from './hotkeys'
import { DEFAULT_PALETTE_ID, isPaletteId } from './palettes'
import type { PaletteId, PetSize } from './types'

/** §16 SaveFile.settings. */
export interface AppSettings {
  hotkeys: Record<HotkeyAction, string>
  /** §10.4 ⌥⌘-click sends the pet to the point (needs Input Monitoring). */
  altCmdClickSend: boolean
  /** §8.6 fade out while a fullscreen app is in front. */
  hideInFullscreen: boolean
  /** 0..1: scales the brain's timing and randomness (0.5: as tuned). */
  restlessness: number
  launchAtLogin: boolean
  /** Phase 4; always false in Phase 1 (shown disabled). */
  sound: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkeys: { ...DEFAULT_HOTKEYS },
  altCmdClickSend: true,
  hideInFullscreen: true,
  restlessness: 0.5,
  launchAtLogin: false,
  sound: false,
}

/** What the user chose about the pet itself (§16 SaveFile.pet, the parts the user sets). */
export interface PetIdentity {
  name: string
  paletteId: PaletteId
  size: PetSize
}

/** §15.1 the name: 1–20 characters after trimming; the suggestion is "Nibs". */
export const PET_NAME_MAX = 20
export const DEFAULT_PET_NAME = 'Nibs'

export const DEFAULT_IDENTITY: PetIdentity = { name: DEFAULT_PET_NAME, paletteId: DEFAULT_PALETTE_ID, size: 'M' }

/** A valid pet name (trimmed, 1–20 characters, no control characters), or null. */
export function cleanPetName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return name.length >= 1 && [...name].length <= PET_NAME_MAX ? name : null
}

export function isPetSize(value: unknown): value is PetSize {
  return value === 'S' || value === 'M' || value === 'L'
}

export function isPetIdentity(value: unknown): value is PetIdentity {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return cleanPetName(v['name']) === v['name'] && isPaletteId(v['paletteId']) && isPetSize(v['size'])
}
