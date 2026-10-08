// Between the save file and the live modules (BITBOT_SPEC.md §16): the glue restores each module from a loaded save
// with the accessors (identityOf, needsStateOf, economyStateOf, behaviorOf, settingsOf), and assembles the next save
// from the modules' current state with assembleSave(prev, parts).
//
// assembleSave starts from the previous save, so what the live modules don't own carries over: Phase 2/3 fields
// (stage, formId, cosmetics), createdAt, and unknown fields (§16 "unknown fields are preserved"), at the top level
// and inside each section (a module that drops a field it doesn't know, like Needs, doesn't lose it). A part left out
// keeps the previous save's value. Every result is a fresh copy: nothing aliases the live modules or `prev`. Pure.

import type { EconomyState } from '../economy/economy'
import type { NeedsState } from '../sim/needs/needs'
import type { ModeSettings } from '../../shared/modes'
import type { AppSettings, PetIdentity } from '../../shared/settings'
import type { PetPosition } from '../../shared/types'
import type { SaveFile, SaveMeta } from './saveFile'

/** The live state a save is made of; each part optional (absent: the previous save's). */
export interface LiveParts {
  identity?: PetIdentity
  /** null: not placed yet (keeps nothing); absent: the previous position. */
  position?: PetPosition | null
  /** Needs.state */
  needs?: NeedsState
  /** Economy.state */
  economy?: EconomyState
  /** ModeState.settings */
  behavior?: ModeSettings
  settings?: AppSettings
  meta?: Partial<SaveMeta>
}

export function assembleSave(prev: SaveFile, parts: LiveParts): SaveFile {
  const { levels, ...life } = parts.needs ?? { levels: prev.needs, ...prev.life }
  return structuredClone({
    ...prev,
    pet: {
      ...prev.pet,
      ...(parts.identity && { name: parts.identity.name, paletteId: parts.identity.paletteId, size: parts.identity.size }),
      position: parts.position === undefined ? prev.pet.position : parts.position,
    },
    needs: { ...prev.needs, ...levels },
    life: { ...prev.life, ...life },
    rhythm: { ...prev.rhythm, ...parts.economy?.rhythm },
    economy: { ...prev.economy, ...parts.economy?.economy },
    behavior: { ...prev.behavior, ...parts.behavior },
    settings: { ...prev.settings, ...parts.settings },
    meta: { ...prev.meta, ...parts.meta },
  })
}

export function identityOf(save: SaveFile): PetIdentity {
  return { name: save.pet.name, paletteId: save.pet.paletteId, size: save.pet.size }
}

/** For new Needs(params, activeIdleS, needsStateOf(save), lifeClock.now()). */
export function needsStateOf(save: SaveFile): NeedsState {
  return structuredClone({ ...save.life, levels: save.needs })
}

/** For new Economy({ clock, state: economyStateOf(save) }). */
export function economyStateOf(save: SaveFile): EconomyState {
  return structuredClone({ economy: save.economy, rhythm: save.rhythm })
}

/** For new ModeState(behaviorOf(save)). */
export function behaviorOf(save: SaveFile): ModeSettings {
  return structuredClone(save.behavior)
}

export function settingsOf(save: SaveFile): AppSettings {
  return structuredClone(save.settings)
}
