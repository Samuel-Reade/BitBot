// The save file on disk (BITBOT_SPEC.md §16): save.json in the app's data directory, written atomically, with the
// last saves kept as save.json.bak1..3, the newest valid one loaded when save.json is corrupt.
//
// load(): save.json, then bak1, bak2, bak3; the first that reads, parses (JSON), upgrades (migrations.ts) and validates
//   (validate.ts) wins; none → a new save (freshSave). A save.json.tmp left by an unfinished write is removed.
//   A save.json from a newer Bitbot (schemaVersion above this build's) is never read or written over: it is renamed
//   to save.json.v<version> (kept for that newer build; a newer backup is just skipped), and loading goes on with the
//   backups.
// write(save): atomic. The JSON goes to save.json.tmp (written and fsynced by SaveFs.writeFile), then, if a rotation
//   is due, the backups shift (bak3 dropped, bak2 → bak3, bak1 → bak2, save.json → bak1), then save.json.tmp is
//   renamed over save.json. A crash at any point leaves the previous save as save.json or, mid-rotation, as bak1:
//   load() finds it either way. A failed write removes the tmp and leaves the files as they were.
// Backups ("keep the last 3 saves", read as: keep 3 older copies far enough apart to be useful): rotating on every
//   60-s autosave would make bak1..3 one to three minutes old, so a bug writing bad data for five minutes would push
//   every good copy out. Rotation happens at most once per tuning.persistence.backupEveryMs (1 h; the first write
//   after launch rotates if the last rotation, read from bak1's age, is that old), so the backups are about 1, 2 and
//   3 hours apart. A clock that jumps back rotates once.
// erase(): §15.4 "Erase all Bitbot data": save.json and every save.json.* (tmp, backups, moved-aside newer saves).
//   Writes stay off afterwards (so the quit save can't bring the data back) until enableWrites().
//
// Synchronous on purpose: the file is tens of KB (a write takes well under a millisecond), and the quit path
// (before-quit) can't await. The file system, directory, clock and log are injected (nodeFs.ts in the app; an
// in-memory fake in tests). Logs and problems name files, fields and problem kinds only: never save contents, never
// bundle IDs.

import { join } from 'node:path'
import { systemTimeZone } from '../economy/days'
import { tuning } from '../../shared/tuning'
import { migrate } from './migrations'
import { CURRENT_SCHEMA_VERSION, freshSave, type SaveFile } from './saveFile'
import { parseSave } from './validate'

export interface SaveFs {
  /** The file's text (UTF-8). Throws if it can't be read. */
  readFile(path: string): string
  /** Creates or replaces the file and flushes it to disk (fsync) before returning. Throws on failure. */
  writeFile(path: string, data: string): void
  /** Atomically replaces `to` with `from`. */
  rename(from: string, to: string): void
  unlink(path: string): void
  /** Size and modification time (epoch ms); null if there is no such file. */
  stat(path: string): { size: number; mtimeMs: number } | null
  /** Creates the directory and its parents; fine if it exists. */
  mkdir(path: string): void
  /** File names in the directory; [] if it doesn't exist. */
  readdir(path: string): string[]
}

export type PersistenceTuning = { readonly [K in keyof typeof tuning.persistence]: number }

export interface SaveStoreOptions {
  fs: SaveFs
  /** The data directory (app.getPath('userData'): per profile). */
  dir: string
  /** Wall-clock epoch ms (Date.now in the app): backup cadence, createdAt and the day of a new save. */
  clock: { now(): number }
  /** IANA zone for a new save's day; default: the system's. */
  timeZone?: string
  log?: (line: string) => void
  tuning?: PersistenceTuning
}

export const SAVE_FILE_NAME = 'save.json'

export type SaveSource = 'main' | `bak${number}` | 'fresh'

export interface LoadResult {
  save: SaveFile
  source: SaveSource
  /** What went wrong or was repaired, per file ("save.json: not JSON"): files, fields and problem kinds only. */
  problems: string[]
}

export type DecodeResult =
  | { kind: 'ok'; save: SaveFile; /** repairs and upgrades */ notes: string[] }
  | { kind: 'future'; version: number }
  | { kind: 'corrupt'; reason: string }

/** A save file's text → a validated current save (JSON, upgrades, validation). Also for the dev panel's fixtures. */
export function decodeSave(text: string): DecodeResult {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'corrupt', reason: 'not JSON' }
  }
  const m = migrate(json)
  if (m.kind === 'future') return m
  if (m.kind === 'invalid') return { kind: 'corrupt', reason: m.reason }
  const notes: string[] = []
  const save = parseSave(m.save, notes)
  if (!save) return { kind: 'corrupt', reason: notes[notes.length - 1] ?? 'rejected' }
  if (m.from < CURRENT_SCHEMA_VERSION) notes.push(`upgraded from schema ${m.from}`)
  return { kind: 'ok', save, notes }
}

export class SaveStore {
  private readonly fs: SaveFs
  private readonly t: PersistenceTuning
  /** When the backups last rotated (epoch ms); null: not known yet (read from bak1 on first need). */
  private lastRotationAt: number | null | undefined = undefined
  private writable = true

  constructor(private readonly opts: SaveStoreOptions) {
    this.fs = opts.fs
    this.t = opts.tuning ?? tuning.persistence
  }

  /** save.json's full path. */
  get path(): string {
    return this.file(SAVE_FILE_NAME)
  }

  /** False after erase() until enableWrites(). */
  get writesEnabled(): boolean {
    return this.writable
  }

  /** The newest valid save: save.json, else the newest valid backup, else a new save (source 'fresh'). */
  load(): LoadResult {
    const problems: string[] = []
    const tmp = this.file(`${SAVE_FILE_NAME}.tmp`)
    if (this.fs.stat(tmp)) {
      this.tryUnlink(tmp)
      problems.push(`${SAVE_FILE_NAME}.tmp: left by an unfinished write, removed`)
    }
    let mainMissing = false
    for (const [source, name] of this.candidates()) {
      const path = this.file(name)
      const st = this.fs.stat(path)
      if (!st) {
        if (source === 'main') mainMissing = true
        continue
      }
      if (st.size > this.t.maxFileBytes) {
        problems.push(`${name}: too large`)
        continue
      }
      let text: string
      try {
        text = this.fs.readFile(path)
      } catch {
        problems.push(`${name}: unreadable`)
        continue
      }
      const d = decodeSave(text)
      if (d.kind === 'future') {
        problems.push(source === 'main' ? `${name}: from a newer Bitbot (schema ${d.version}), ${this.moveAside(d.version)}` : `${name}: from a newer Bitbot (schema ${d.version}), skipped`)
        continue
      }
      if (d.kind === 'corrupt') {
        problems.push(`${name}: ${d.reason}`)
        continue
      }
      if (mainMissing) problems.unshift(`${SAVE_FILE_NAME}: missing`)
      for (const note of d.notes) problems.push(`${name}: ${note}`)
      this.logLoad(source, problems)
      return { save: d.save, source, problems }
    }
    this.logLoad('fresh', problems)
    return { save: freshSave(this.opts.clock.now(), this.opts.timeZone ?? systemTimeZone()), source: 'fresh', problems }
  }

  /** Writes the save atomically, rotating the backups when due. Never throws. */
  write(save: SaveFile): { ok: true } | { ok: false; problem: string } {
    if (!this.writable) return { ok: false, problem: 'writes are off (the save was erased)' }
    const main = this.file(SAVE_FILE_NAME)
    const tmp = this.file(`${SAVE_FILE_NAME}.tmp`)
    try {
      this.fs.mkdir(this.opts.dir)
      this.fs.writeFile(tmp, JSON.stringify(save, null, 2))
    } catch {
      this.tryUnlink(tmp)
      return this.failed(`could not write ${SAVE_FILE_NAME}.tmp`)
    }
    try {
      if (this.fs.stat(main) && this.rotationDue()) this.rotate()
      this.fs.rename(tmp, main)
      return { ok: true }
    } catch {
      this.tryUnlink(tmp)
      return this.failed(`could not replace ${SAVE_FILE_NAME}`)
    }
  }

  /** §15.4 "Erase all Bitbot data": removes save.json and every save.json.* file; writes stay off until enableWrites(). */
  erase(): { ok: boolean; problems: string[] } {
    this.writable = false
    const problems: string[] = []
    let names: string[]
    try {
      names = this.fs.readdir(this.opts.dir)
    } catch {
      return { ok: false, problems: ['the data directory: unreadable'] }
    }
    for (const name of names) {
      if (name !== SAVE_FILE_NAME && !name.startsWith(`${SAVE_FILE_NAME}.`)) continue
      try {
        this.fs.unlink(this.file(name))
      } catch {
        problems.push(`${name}: could not remove`)
      }
    }
    this.lastRotationAt = null
    this.log(problems.length === 0 ? '[save] erased' : `[save] erase incomplete: ${problems.join('; ')}`)
    return { ok: problems.length === 0, problems }
  }

  /** Writes back on after erase() (a new pet starts in this run). */
  enableWrites(): void {
    this.writable = true
  }

  private candidates(): [SaveSource, string][] {
    const list: [SaveSource, string][] = [['main', SAVE_FILE_NAME]]
    for (let i = 1; i <= this.t.backups; i++) list.push([`bak${i}`, `${SAVE_FILE_NAME}.bak${i}`])
    return list
  }

  private rotationDue(): boolean {
    const now = this.opts.clock.now()
    if (this.lastRotationAt === undefined) this.lastRotationAt = this.fs.stat(this.file(`${SAVE_FILE_NAME}.bak1`))?.mtimeMs ?? null
    const last = this.lastRotationAt
    return last === null || now < last || now - last >= this.t.backupEveryMs
  }

  /** bak(n) dropped, bak(i) → bak(i+1), save.json → bak1. */
  private rotate(): void {
    const bak = (i: number): string => this.file(`${SAVE_FILE_NAME}.bak${i}`)
    const n = this.t.backups
    if (this.fs.stat(bak(n))) this.fs.unlink(bak(n))
    for (let i = n - 1; i >= 1; i--) if (this.fs.stat(bak(i))) this.fs.rename(bak(i), bak(i + 1))
    this.fs.rename(this.file(SAVE_FILE_NAME), bak(1))
    this.lastRotationAt = this.opts.clock.now()
  }

  /** Renames a newer Bitbot's save.json out of the way (never over another file); says where it went. */
  private moveAside(version: number): string {
    let name = `${SAVE_FILE_NAME}.v${version}`
    if (this.fs.stat(this.file(name))) name = `${name}-${Math.round(this.opts.clock.now())}`
    try {
      this.fs.rename(this.file(SAVE_FILE_NAME), this.file(name))
      return `moved to ${name}`
    } catch {
      // Left in place, writing over it would destroy it: stay read-only this run.
      this.writable = false
      return 'could not move it aside; not saving this run'
    }
  }

  private file(name: string): string {
    return join(this.opts.dir, name)
  }

  private tryUnlink(path: string): void {
    try {
      if (this.fs.stat(path)) this.fs.unlink(path)
    } catch {
      // Best effort: a stale tmp is replaced by the next write anyway.
    }
  }

  private failed(problem: string): { ok: false; problem: string } {
    this.log(`[save] write failed: ${problem}`)
    return { ok: false, problem }
  }

  private logLoad(source: SaveSource, problems: string[]): void {
    const from = source === 'main' ? SAVE_FILE_NAME : source === 'fresh' ? 'a new save' : `${SAVE_FILE_NAME}.${source}`
    this.log(`[save] loaded ${from}${problems.length > 0 ? `; ${problems.join('; ')}` : ''}`)
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }
}
