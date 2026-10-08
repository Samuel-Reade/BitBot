import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeSaveFs } from '../src/main/persistence/nodeFs'
import { decodeSave, SaveStore, type SaveFs } from '../src/main/persistence/saveStore'
import type { SaveFile } from '../src/main/persistence/saveFile'
import { parseSave } from '../src/main/persistence/validate'
import { tuning } from '../src/shared/tuning'

// The save file on disk (src/main/persistence/saveStore.ts): §16 atomic writes, backups, loading the newest valid
// file, a newer Bitbot's file left alone, erase. On an in-memory file system with fault injection.

const DIR = '/data'
const MAIN = `${DIR}/save.json`
const TMP = `${DIR}/save.json.tmp`
const bak = (i: number): string => `${DIR}/save.json.bak${i}`
const HOUR = 3_600_000

const DAY3_TEXT = readFileSync(join(__dirname, 'fixtures', 'save-day3.json'), 'utf8')
function day3(): SaveFile {
  const s = parseSave(JSON.parse(DAY3_TEXT))
  if (!s) throw new Error('fixture rejected')
  return s
}
const named = (name: string): SaveFile => ({ ...day3(), pet: { ...day3().pet, name } })

class MemFs implements SaveFs {
  readonly files = new Map<string, { data: string; mtimeMs: number }>()
  readonly ops: string[] = []
  /** Throw on the next matching operation ("rename save.json.tmp", "writeFile", ...). */
  failOn: string | null = null

  constructor(private readonly clock: { now(): number }) {}

  private check(op: string, ...paths: string[]): void {
    const line = [op, ...paths.map((p) => p.slice(DIR.length + 1))].join(' ')
    this.ops.push(line)
    if (this.failOn !== null && line.startsWith(this.failOn)) {
      this.failOn = null
      throw new Error(`injected failure: ${line}`)
    }
  }

  readFile(path: string): string {
    this.check('readFile', path)
    const f = this.files.get(path)
    if (!f) throw new Error('ENOENT')
    return f.data
  }
  writeFile(path: string, data: string): void {
    this.check('writeFile', path)
    this.files.set(path, { data, mtimeMs: this.clock.now() })
  }
  rename(from: string, to: string): void {
    this.check('rename', from, to)
    const f = this.files.get(from)
    if (!f) throw new Error('ENOENT')
    this.files.delete(from)
    this.files.set(to, f)
  }
  unlink(path: string): void {
    this.check('unlink', path)
    if (!this.files.delete(path)) throw new Error('ENOENT')
  }
  stat(path: string): { size: number; mtimeMs: number } | null {
    const f = this.files.get(path)
    return f ? { size: f.data.length, mtimeMs: f.mtimeMs } : null
  }
  mkdir(_path: string): void {}
  readdir(path: string): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(`${path}/`)).map((p) => p.slice(path.length + 1))
  }

  put(path: string, data: string | SaveFile): void {
    this.files.set(path, { data: typeof data === 'string' ? data : JSON.stringify(data), mtimeMs: this.clock.now() })
  }
  nameIn(path: string): string | undefined {
    const f = this.files.get(path)
    return f ? (JSON.parse(f.data) as SaveFile).pet.name : undefined
  }
}

function setup(start = Date.parse('2026-10-08T12:00:00.000Z')) {
  const clock = { t: start, now: () => clock.t }
  const fs = new MemFs(clock)
  const logs: string[] = []
  const store = new SaveStore({ fs, dir: DIR, clock, timeZone: 'UTC', log: (l) => logs.push(l) })
  return { clock, fs, store, logs }
}

describe('SaveStore.load', () => {
  it('first launch: a fresh save, no problems', () => {
    const { store, clock } = setup()
    const r = store.load()
    expect(r.source).toBe('fresh')
    expect(r.problems).toEqual([])
    expect(r.save.meta.onboardingComplete).toBe(false)
    expect(r.save.createdAt).toBe(new Date(clock.t).toISOString())
  })

  it('reads save.json', () => {
    const { store, fs } = setup()
    fs.put(MAIN, DAY3_TEXT)
    const r = store.load()
    expect(r.source).toBe('main')
    expect(r.save).toEqual(day3())
    expect(r.problems).toEqual([])
  })

  it('a corrupt save.json → bak1, saying why', () => {
    const { store, fs } = setup()
    fs.put(MAIN, '{"schemaVersion":1,"pet":')
    fs.put(bak(1), named('One'))
    fs.put(bak(2), named('Two'))
    const r = store.load()
    expect(r.source).toBe('bak1')
    expect(r.save.pet.name).toBe('One')
    expect(r.problems).toEqual(['save.json: not JSON'])
  })

  it('skips corrupt backups too: the newest valid one wins', () => {
    const { store, fs } = setup()
    fs.put(MAIN, JSON.stringify({ ...day3(), needs: 'full' }))
    fs.put(bak(1), '')
    fs.put(bak(2), JSON.stringify({ ...day3(), schemaVersion: 'one' }))
    fs.put(bak(3), named('Three'))
    const r = store.load()
    expect(r.source).toBe('bak3')
    expect(r.save.pet.name).toBe('Three')
    expect(r.problems).toEqual([
      'save.json: rejected: needs: not an object',
      'save.json.bak1: not JSON',
      'save.json.bak2: schemaVersion: not a version',
    ])
  })

  it('all corrupt → fresh, with every problem listed', () => {
    const { store, fs } = setup()
    fs.put(MAIN, 'garbage')
    fs.put(bak(1), '[]')
    fs.put(bak(2), JSON.stringify({ ...day3(), pet: { ...day3().pet, paletteId: 'neon' } }))
    fs.put(bak(3), 'x'.repeat(tuning.persistence.maxFileBytes + 1))
    const r = store.load()
    expect(r.source).toBe('fresh')
    expect(r.problems).toEqual([
      'save.json: not JSON',
      'save.json.bak1: not an object',
      'save.json.bak2: rejected: pet.paletteId: not a known palette',
      'save.json.bak3: too large',
    ])
  })

  it('a missing save.json with backups (a crash mid-write) loads bak1 and says so', () => {
    const { store, fs } = setup()
    fs.put(bak(1), named('One'))
    const r = store.load()
    expect(r.source).toBe('bak1')
    expect(r.problems).toEqual(['save.json: missing'])
  })

  it('removes a tmp left by an unfinished write and ignores it', () => {
    const { store, fs } = setup()
    fs.put(TMP, named('Half'))
    fs.put(MAIN, named('Whole'))
    const r = store.load()
    expect(r.save.pet.name).toBe('Whole')
    expect(fs.files.has(TMP)).toBe(false)
    expect(r.problems).toEqual(['save.json.tmp: left by an unfinished write, removed'])
  })

  it('lists repairs as problems of the file they came from', () => {
    const { store, fs } = setup()
    const s = JSON.parse(DAY3_TEXT)
    delete s.settings.hotkeys.toggleStay
    fs.put(MAIN, JSON.stringify(s))
    const r = store.load()
    expect(r.source).toBe('main')
    expect(r.problems).toEqual(['save.json: settings.hotkeys.toggleStay: missing, default used'])
  })

  it('never logs save contents or bundle IDs', () => {
    const { store, fs, logs } = setup()
    const s = JSON.parse(DAY3_TEXT)
    s.economy.knownBundleIds['org.secret.App'] = 'never'
    fs.put(MAIN, JSON.stringify(s))
    store.load()
    fs.failOn = 'rename'
    store.write(day3())
    expect(logs).toEqual(['[save] loaded save.json; save.json: economy.knownBundleIds: 1 bad entries dropped', '[save] write failed: could not replace save.json'])
    expect(logs.join('\n')).not.toMatch(/com\.|secret|Pixel|Terminal|never/)
  })
})

describe('SaveStore: a file from a newer Bitbot', () => {
  const future = (): string => JSON.stringify({ ...day3(), schemaVersion: 2, pet: { ...day3().pet, name: 'Future' } })

  it('is moved aside, never read or written over; loading goes on with the backups', () => {
    const { store, fs } = setup()
    fs.put(MAIN, future())
    fs.put(bak(1), named('One'))
    const r = store.load()
    expect(r.source).toBe('bak1')
    expect(r.problems).toEqual(['save.json: from a newer Bitbot (schema 2), moved to save.json.v2'])
    expect(fs.nameIn(`${DIR}/save.json.v2`)).toBe('Future')
    expect(store.write(r.save)).toEqual({ ok: true })
    expect(fs.nameIn(`${DIR}/save.json.v2`)).toBe('Future')
    expect(fs.nameIn(MAIN)).toBe('One')
  })

  it('does not replace an earlier moved-aside file', () => {
    const { store, fs, clock } = setup()
    fs.put(`${DIR}/save.json.v2`, 'older future')
    fs.put(MAIN, future())
    store.load()
    expect(fs.files.get(`${DIR}/save.json.v2`)?.data).toBe('older future')
    expect(fs.nameIn(`${DIR}/save.json.v2-${clock.t}`)).toBe('Future')
  })

  it('a newer backup is skipped and left alone', () => {
    const { store, fs } = setup()
    fs.put(bak(1), future())
    fs.put(bak(2), named('Two'))
    const r = store.load()
    expect(r.source).toBe('bak2')
    expect(r.problems).toContain('save.json.bak1: from a newer Bitbot (schema 2), skipped')
    expect(fs.nameIn(bak(1))).toBe('Future')
  })

  it('if it cannot be moved aside, nothing is written this run', () => {
    const { store, fs } = setup()
    fs.put(MAIN, future())
    fs.failOn = 'rename save.json save.json.v2'
    const r = store.load()
    expect(r.source).toBe('fresh')
    expect(store.write(r.save).ok).toBe(false)
    expect(fs.nameIn(MAIN)).toBe('Future')
  })
})

describe('SaveStore.write', () => {
  it('writes the tmp, then renames it over save.json (first write: nothing to rotate)', () => {
    const { store, fs } = setup()
    expect(store.write(day3())).toEqual({ ok: true })
    expect(fs.ops).toEqual(['writeFile save.json.tmp', 'rename save.json.tmp save.json'])
    expect(JSON.parse(fs.files.get(MAIN)!.data)).toEqual(day3())
    expect(fs.files.has(TMP)).toBe(false)
  })

  it('round-trips through the disk', () => {
    const { store } = setup()
    const s = { ...day3(), extraFromTheFuture: { kept: true } } as SaveFile
    store.write(s)
    const again = store.load()
    expect(again.source).toBe('main')
    expect(again.save).toEqual(s)
  })

  it('a failure writing the tmp leaves save.json as it was and no tmp', () => {
    const { store, fs } = setup()
    store.write(named('Old'))
    fs.failOn = 'writeFile'
    const r = store.write(named('New'))
    expect(r).toEqual({ ok: false, problem: 'could not write save.json.tmp' })
    expect(fs.nameIn(MAIN)).toBe('Old')
    expect(fs.files.has(TMP)).toBe(false)
  })

  it('a crash before the final rename leaves the old save loadable', () => {
    const { store, fs, clock } = setup()
    store.write(named('Old0'))
    store.write(named('Old')) // the first rotation (bak1 = Old0); the next is an hour away
    fs.failOn = 'rename save.json.tmp'
    expect(store.write(named('New')).ok).toBe(false)
    expect(fs.nameIn(MAIN)).toBe('Old')
    expect(fs.files.has(TMP)).toBe(false)
    // Mid-rotation (save.json already moved to bak1): the old save is bak1.
    clock.t += 2 * HOUR
    store.write(named('Old2'))
    clock.t += 2 * HOUR
    fs.failOn = 'rename save.json.tmp'
    expect(store.write(named('New2')).ok).toBe(false)
    expect(fs.files.has(MAIN)).toBe(false)
    const r = store.load()
    expect(r.source).toBe('bak1')
    expect(r.save.pet.name).toBe('Old2')
  })

  it('a crash after the tmp is written but before anything else: load ignores the tmp', () => {
    const { fs, store } = setup()
    store.write(named('Old'))
    fs.put(TMP, named('New'))
    expect(store.load().save.pet.name).toBe('Old')
  })

  it('rotates the backups at most once per backupEveryMs: bak3 ← bak2 ← bak1 ← save.json', () => {
    const { store, fs, clock } = setup()
    const every = tuning.persistence.backupEveryMs
    store.write(named('A')) // first write: no save.json yet, nothing rotates
    clock.t += 60_000
    store.write(named('B')) // no backup yet: rotates (bak1 = A)
    expect(fs.nameIn(bak(1))).toBe('A')
    for (let i = 0; i < 10; i++) {
      clock.t += 60_000
      store.write(named(`C${i}`)) // autosaves within the hour: save.json only
    }
    expect(fs.nameIn(bak(1))).toBe('A')
    expect(fs.files.has(bak(2))).toBe(false)
    expect(fs.nameIn(MAIN)).toBe('C9')
    clock.t += every
    store.write(named('D'))
    expect([fs.nameIn(bak(1)), fs.nameIn(bak(2))]).toEqual(['C9', 'A'])
    clock.t += every
    store.write(named('E'))
    clock.t += every
    store.write(named('F'))
    expect([fs.nameIn(MAIN), fs.nameIn(bak(1)), fs.nameIn(bak(2)), fs.nameIn(bak(3))]).toEqual(['F', 'E', 'D', 'C9'])
    expect(fs.readdir(DIR).sort()).toEqual(['save.json', 'save.json.bak1', 'save.json.bak2', 'save.json.bak3'])
  })

  it('after a relaunch, reads the last rotation from bak1’s age', () => {
    const { fs, clock } = setup()
    const every = tuning.persistence.backupEveryMs
    fs.put(bak(1), named('Bak'))
    clock.t += 10 * 60_000
    fs.put(MAIN, named('Main'))
    const store = new SaveStore({ fs, dir: DIR, clock, timeZone: 'UTC' })
    store.load()
    store.write(named('Next'))
    expect(fs.nameIn(bak(1))).toBe('Bak')
    clock.t += every
    store.write(named('Later'))
    expect([fs.nameIn(bak(1)), fs.nameIn(bak(2))]).toEqual(['Next', 'Bak'])
  })

  it('a clock jumping back rotates once, then waits again', () => {
    const { store, fs, clock } = setup()
    store.write(named('A'))
    store.write(named('B'))
    clock.t -= 5 * HOUR
    store.write(named('C'))
    expect([fs.nameIn(bak(1)), fs.nameIn(bak(2))]).toEqual(['B', 'A'])
    clock.t += 60_000
    store.write(named('D'))
    expect([fs.nameIn(MAIN), fs.nameIn(bak(1))]).toEqual(['D', 'B'])
  })
})

describe('SaveStore.erase', () => {
  it('removes save.json, the tmp, the backups and moved-aside files, nothing else; writes stay off', () => {
    const { store, fs } = setup()
    fs.put(MAIN, named('A'))
    fs.put(TMP, 'x')
    for (let i = 1; i <= 3; i++) fs.put(bak(i), named(`B${i}`))
    fs.put(`${DIR}/save.json.v2`, 'future')
    fs.put(`${DIR}/Preferences`, 'electron')
    expect(store.erase()).toEqual({ ok: true, problems: [] })
    expect(fs.readdir(DIR)).toEqual(['Preferences'])
    expect(store.writesEnabled).toBe(false)
    expect(store.write(day3()).ok).toBe(false)
    expect(fs.readdir(DIR)).toEqual(['Preferences'])
    expect(store.load().source).toBe('fresh')
    store.enableWrites()
    expect(store.write(day3()).ok).toBe(true)
    expect(fs.files.has(MAIN)).toBe(true)
  })

  it('reports files it could not remove', () => {
    const { store, fs } = setup()
    fs.put(MAIN, named('A'))
    fs.failOn = 'unlink save.json'
    expect(store.erase()).toEqual({ ok: false, problems: ['save.json: could not remove'] })
  })
})

describe('decodeSave (also for the dev panel’s fixture saves)', () => {
  it('reads both fixtures', () => {
    for (const name of ['save-fresh.json', 'save-day3.json']) {
      const d = decodeSave(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
      expect(d.kind).toBe('ok')
    }
  })

  it('says corrupt or future', () => {
    expect(decodeSave('{')).toEqual({ kind: 'corrupt', reason: 'not JSON' })
    expect(decodeSave('{"schemaVersion":7}')).toEqual({ kind: 'future', version: 7 })
    expect(decodeSave('{"schemaVersion":1}')).toMatchObject({ kind: 'corrupt' })
  })
})

describe('nodeSaveFs (the real file system)', () => {
  it('writes, loads, rotates and erases in a real directory; the save is private to the user', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bitbot-save-'))
    try {
      const clock = { t: Date.parse('2026-10-08T12:00:00.000Z'), now: () => clock.t }
      const dataDir = join(dir, 'Bitbot-test')
      const store = new SaveStore({ fs: nodeSaveFs, dir: dataDir, clock, timeZone: 'UTC' })
      expect(store.load().source).toBe('fresh')
      expect(store.write(named('A'))).toEqual({ ok: true })
      expect(store.write(named('B'))).toEqual({ ok: true })
      expect(statSync(store.path).mode & 0o777).toBe(0o600)
      expect(readdirSync(dataDir).sort()).toEqual(['save.json', 'save.json.bak1'])
      const r = new SaveStore({ fs: nodeSaveFs, dir: dataDir, clock, timeZone: 'UTC' }).load()
      expect(r.source).toBe('main')
      expect(r.save.pet.name).toBe('B')
      expect(store.erase().ok).toBe(true)
      expect(readdirSync(dataDir)).toEqual([])
      expect(nodeSaveFs.readdir(join(dir, 'missing'))).toEqual([])
      expect(nodeSaveFs.stat(join(dir, 'missing'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
