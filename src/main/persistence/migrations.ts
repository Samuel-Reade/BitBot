// Save file upgrades (BITBOT_SPEC.md §16 "Migrations: an ordered list of (save) => save upgraders keyed by version").
// MIGRATIONS[i] turns a version `from` file into version from + 1; migrate(raw) runs them in order from the file's
// schemaVersion up to CURRENT_SCHEMA_VERSION, then validate.ts checks the result. Phase 1 is version 1 and has no
// upgraders yet; the scaffold is tested with an injected list (test/saveMigrations.test.ts).
//
// Writing an upgrader: take the old file as a plain record and return the new one; change only what the version
// changes and leave every other field as it is (unknown fields are preserved, §16). migrate() hands each upgrader its
// own copy and sets schemaVersion itself.
//
// A file from a newer Bitbot (schemaVersion above this build's) is never upgraded, read as current or overwritten:
// migrate() says 'future' and the store moves it aside before writing (saveStore.ts). Pure.

import { CURRENT_SCHEMA_VERSION } from './saveFile'

export type SaveRecord = Record<string, unknown>

export interface Migration {
  /** The version this upgrader reads; it returns version from + 1. */
  from: number
  up(save: SaveRecord): SaveRecord
}

/** This build's upgraders, oldest first: one per version from 1 to CURRENT_SCHEMA_VERSION − 1. */
export const MIGRATIONS: readonly Migration[] = []

export type MigrateResult =
  /** At the current version (upgraded from `from`, or already there: from = current). */
  | { kind: 'ok'; save: SaveRecord; from: number }
  /** From a newer Bitbot: leave the file alone. */
  | { kind: 'future'; version: number }
  /** Not a save, no usable schemaVersion, or no upgrader for a step (field paths and problem kinds only). */
  | { kind: 'invalid'; reason: string }

/** Upgrades a parsed save file to `current` with `migrations` (default: this build's). Doesn't modify `raw`. */
export function migrate(raw: unknown, migrations: readonly Migration[] = MIGRATIONS, current: number = CURRENT_SCHEMA_VERSION): MigrateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'invalid', reason: 'not an object' }
  const from = (raw as SaveRecord)['schemaVersion']
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) return { kind: 'invalid', reason: 'schemaVersion: not a version' }
  if (from > current) return { kind: 'future', version: from }
  let save = structuredClone(raw) as SaveRecord
  for (let v = from; v < current; v++) {
    const step = migrations.find((m) => m.from === v)
    if (!step) return { kind: 'invalid', reason: `schemaVersion: no upgrade from ${v}` }
    let next: SaveRecord
    try {
      next = step.up(structuredClone(save))
    } catch {
      return { kind: 'invalid', reason: `upgrade from ${v}: failed` }
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return { kind: 'invalid', reason: `upgrade from ${v}: not an object` }
    save = { ...next, schemaVersion: v + 1 }
  }
  return { kind: 'ok', save, from }
}
