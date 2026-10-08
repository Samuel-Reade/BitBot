import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrate, MIGRATIONS, type Migration } from '../src/main/persistence/migrations'
import { CURRENT_SCHEMA_VERSION } from '../src/main/persistence/saveFile'
import { parseSave } from '../src/main/persistence/validate'

// Save file upgrades (src/main/persistence/migrations.ts, §16): the scaffold, with an injected v1 → v2 → v3 list.

const day3 = (): Record<string, any> => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'save-day3.json'), 'utf8'))

/** A made-up history: v2 renamed pet.name to pet.nickname; v3 added settings.theme and moved it back. */
const FAKE: Migration[] = [
  {
    from: 1,
    up: (s) => {
      const pet = s['pet'] as Record<string, unknown>
      const { name, ...rest } = pet
      return { ...s, pet: { ...rest, nickname: name } }
    },
  },
  {
    from: 2,
    up: (s) => {
      const { nickname, ...pet } = s['pet'] as Record<string, unknown>
      return { ...s, pet: { ...pet, name: nickname }, settings: { ...(s['settings'] as object), theme: 'auto' } }
    },
  },
]

describe('migrate', () => {
  it('this build: version 1, no upgraders yet; a v1 file passes through unchanged', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1)
    expect(MIGRATIONS).toEqual([])
    expect(migrate(day3())).toEqual({ kind: 'ok', save: day3(), from: 1 })
  })

  it('runs the upgraders in order from the file’s version, setting schemaVersion', () => {
    const r = migrate(day3(), FAKE, 3)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.from).toBe(1)
    expect(r.save['schemaVersion']).toBe(3)
    expect((r.save['pet'] as Record<string, unknown>)['name']).toBe('Pixel')
    expect((r.save['pet'] as Record<string, unknown>)['nickname']).toBeUndefined()
    expect((r.save['settings'] as Record<string, unknown>)['theme']).toBe('auto')
  })

  it('starts from a v2 file’s own version', () => {
    const v2 = { ...day3(), schemaVersion: 2, pet: { ...day3()['pet'], name: undefined, nickname: 'Midway' } }
    const r = migrate(v2, FAKE, 3)
    expect(r.kind === 'ok' && r.from).toBe(2)
    expect(r.kind === 'ok' && (r.save['pet'] as Record<string, unknown>)['name']).toBe('Midway')
  })

  it('keeps unknown fields through every step, and the result validates once at the current version', () => {
    const s = day3()
    s['unknownTop'] = { deep: [1, 2] }
    s['economy']['unknownEco'] = 'kept'
    const r = migrate(s, FAKE.slice(0, 1), 2)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.save['unknownTop']).toEqual({ deep: [1, 2] })
    expect((r.save['economy'] as Record<string, unknown>)['unknownEco']).toBe('kept')
    // Back to this build's schema: a v1 → v1 run validates with the unknowns kept.
    const current = migrate(s)
    const save = current.kind === 'ok' ? parseSave(current.save) : null
    expect(save && (save as unknown as Record<string, unknown>)['unknownTop']).toEqual({ deep: [1, 2] })
  })

  it('does not modify the input, and gives each upgrader its own copy', () => {
    const s = day3()
    const before = structuredClone(s)
    migrate(s, [{ from: 1, up: (x) => ((x['pet'] as Record<string, unknown>)['name'] = 'Mutated', x) }], 2)
    expect(s).toEqual(before)
  })

  it('a newer file: future, left alone', () => {
    expect(migrate({ ...day3(), schemaVersion: 4 }, FAKE, 3)).toEqual({ kind: 'future', version: 4 })
    expect(migrate({ ...day3(), schemaVersion: 2 })).toEqual({ kind: 'future', version: 2 })
  })

  it('invalid: not an object, no usable version, a missing step, a failing or bad upgrader', () => {
    expect(migrate('x').kind).toBe('invalid')
    expect(migrate([]).kind).toBe('invalid')
    for (const v of [undefined, 0, -1, 1.5, '1', null]) expect(migrate({ ...day3(), schemaVersion: v }).kind).toBe('invalid')
    expect(migrate(day3(), FAKE.slice(1), 3)).toEqual({ kind: 'invalid', reason: 'schemaVersion: no upgrade from 1' })
    const boom: Migration = {
      from: 1,
      up: () => {
        throw new Error('bug')
      },
    }
    expect(migrate(day3(), [boom], 2)).toEqual({ kind: 'invalid', reason: 'upgrade from 1: failed' })
    expect(migrate(day3(), [{ from: 1, up: () => null as unknown as Record<string, unknown> }], 2)).toEqual({ kind: 'invalid', reason: 'upgrade from 1: not an object' })
  })
})
