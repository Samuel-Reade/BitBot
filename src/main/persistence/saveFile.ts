// The save file's shape (BITBOT_SPEC.md §16) and a new pet's save. One JSON file, save.json, holds everything that
// survives a quit (§13 "quitting and relaunching restores name, palette, mode, spots, needs, and ledger"): the pet's
// identity and place, its needs, the healthy rhythm and the ledger, the modes and spots, the settings and a little
// bookkeeping. Counts and choices only (§2): never key codes, buttons, click positions, window titles or URLs.
// knownBundleIds (which apps were opened, and when) is the one list of apps; Privacy settings show it, Erase removes it.
//
// The sections reuse the live modules' state types, so saving is copying: economy = LedgerState (ledger.ts),
// rhythm = RhythmState (rhythm.ts), behavior = ModeSettings (shared/modes.ts), settings = AppSettings
// (shared/settings.ts). Their documented additions to §16 come along (todayRaw, todayCredited, sessionBeforeBreakMs).
//
// Additions to §16's shape:
//   life      the needs model's state beyond the five levels (NeedsState minus `levels`: continuous activity, time
//             since the last interaction, idle and unused time, the day, the nutrition window), so a relaunch continues
//             stuffed, neglect and fullness where they were. `needs` keeps §16's five levels.
//   pet.position may be null (see PetSave).
// Unknown fields are kept (§16): validate.ts carries any field it doesn't know through, at the top level and inside
// each section, and snapshot.ts keeps them when it assembles the next save.
//
// Pure: the clock reading and the time zone come from the caller.

import { localDay, systemTimeZone } from '../economy/days'
import { freshLedger, type LedgerState } from '../economy/ledger'
import { freshRhythm, type RhythmState } from '../economy/rhythm'
import { freshNeedsState, type NeedsState } from '../sim/needs/needs'
import type { NeedLevels } from '../../shared/life'
import { DEFAULT_MODE_SETTINGS, type ModeSettings } from '../../shared/modes'
import { DEFAULT_IDENTITY, DEFAULT_SETTINGS, type AppSettings } from '../../shared/settings'
import { tuning } from '../../shared/tuning'
import type { AttachPoint, FormId, PaletteId, PetPosition, PetSize } from '../../shared/types'

/** The schema this build reads and writes. A file with a higher version is from a newer Bitbot (migrations.ts). */
export const CURRENT_SCHEMA_VERSION = 1

export const PET_STAGES = ['egg', 'hatchling', 'base', 'final'] as const
/** §16: Phase 1 is always 'base' after onboarding. */
export type PetStage = (typeof PET_STAGES)[number]

export const FORM_IDS = ['base', 'typist', 'navigator', 'hopper', 'keeper'] as const satisfies readonly FormId[]

/** A cosmetic item's ID (Phase 3). */
export type ItemId = string

export interface PetSave {
  name: string
  paletteId: PaletteId
  size: PetSize
  stage: PetStage
  formId: FormId
  /** Phase 3; empty in Phase 1. */
  cosmetics: { equipped: Partial<Record<AttachPoint, ItemId>>; owned: ItemId[] }
  // SPEC-DEVIATION: §16 has no null here. A save made before the pet ever stood (a fresh install, onboarding) has no
  // place to record; null means "not placed yet": the app puts the pet where a new pet appears (the middle of the Dock).
  position: PetPosition | null
}

/** NeedsState without the five levels (they are §16's `needs`). An addition to §16. */
export type NeedsLife = Omit<NeedsState, 'levels'>

export interface SaveMeta {
  /** The day the daily summary bubble (§9.4) last showed, 'YYYY-MM-DD'; null before the first. */
  lastSummaryShownDay: string | null
  /** False until onboarding (§15.1) finishes: a save without it starts onboarding again. */
  onboardingComplete: boolean
}

export interface SaveFile {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  /** When this pet's save was first made, ISO. */
  createdAt: string
  pet: PetSave
  /** §16 needs: hunger, energy, fullness, boredom, dust, each 0..100. */
  needs: NeedLevels
  /** Addition: the rest of the needs model's state (see the header). */
  life: NeedsLife
  rhythm: RhythmState
  economy: LedgerState
  behavior: ModeSettings
  settings: AppSettings
  meta: SaveMeta
}

/**
 * A new save, before onboarding: the default identity (onboarding replaces it), stage and form 'base', nothing owned,
 * not placed, a newly hatched pet's needs, an empty ledger on today's day (4 AM rollover), default modes and settings.
 */
export function freshSave(nowMs: number, timeZone: string = systemTimeZone()): SaveFile {
  const { levels, ...life } = freshNeedsState(tuning.needs)
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    pet: {
      ...DEFAULT_IDENTITY,
      stage: 'base',
      formId: 'base',
      cosmetics: { equipped: {}, owned: [] },
      position: null,
    },
    needs: { ...levels },
    life,
    rhythm: freshRhythm(nowMs),
    economy: freshLedger(localDay(nowMs, timeZone, tuning.economy.dayRolloverHour)),
    behavior: structuredClone(DEFAULT_MODE_SETTINGS),
    settings: structuredClone(DEFAULT_SETTINGS),
    meta: { lastSummaryShownDay: null, onboardingComplete: false },
  }
}
