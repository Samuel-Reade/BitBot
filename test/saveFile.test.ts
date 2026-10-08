import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Economy } from '../src/main/economy/economy'
import { CURRENT_SCHEMA_VERSION, freshSave, type SaveFile } from '../src/main/persistence/saveFile'
import { assembleSave, behaviorOf, economyStateOf, identityOf, needsStateOf, settingsOf } from '../src/main/persistence/snapshot'
import { parseSave } from '../src/main/persistence/validate'
import { ModeState } from '../src/main/sim/modes'
import { Needs } from '../src/main/sim/needs/needs'
import { DEFAULT_HOTKEYS } from '../src/shared/hotkeys'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import { tuning } from '../src/shared/tuning'

// The save file (§16): its shape, a new save, validation (src/main/persistence/validate.ts) and assembling a save
// from the live modules (snapshot.ts). The store is in saveStore.test.ts, migrations in saveMigrations.test.ts.

const FIXTURES = join(__dirname, 'fixtures')
const fixture = (name: string): Record<string, any> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const day3 = (): Record<string, any> => fixture('save-day3.json')

function parsed(json: unknown, notes: string[] = []): SaveFile {
  const save = parseSave(json, notes)
  if (!save) throw new Error(`rejected: ${notes.join('; ')}`)
  return save
}

function rejects(mutate: (s: Record<string, any>) => void): string {
  const s = day3()
  mutate(s)
  const notes: string[] = []
  expect(parseSave(s, notes)).toBeNull()
  return notes[notes.length - 1] ?? ''
}

describe('freshSave', () => {
  it('is a new pet before onboarding: defaults everywhere, base stage and form, not placed', () => {
    const s = freshSave(Date.parse('2026-10-05T16:00:00.000Z'), 'UTC')
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(s.meta).toEqual({ lastSummaryShownDay: null, onboardingComplete: false, savedAt: null })
    expect(s.pet).toMatchObject({ name: 'Nibs', paletteId: 'mint', size: 'M', stage: 'base', formId: 'base', position: null })
    expect(s.pet.cosmetics).toEqual({ equipped: {}, owned: [] })
    expect(s.needs).toEqual(tuning.needs.initial)
    expect(s.economy.currentDay).toBe('2026-10-05')
    expect(s.settings).toEqual(DEFAULT_SETTINGS)
    expect(s.behavior.mode).toBe('roam')
  })

  it('uses the 4 AM rollover for the day', () => {
    expect(freshSave(Date.parse('2026-10-05T03:30:00.000Z'), 'UTC').economy.currentDay).toBe('2026-10-04')
  })

  it('matches test/fixtures/save-fresh.json and passes validation unchanged', () => {
    const f = fixture('save-fresh.json')
    expect(freshSave(Date.parse(f['createdAt']), 'UTC')).toEqual(f)
    const notes: string[] = []
    expect(parsed(f, notes)).toEqual(f)
    expect(notes).toEqual([])
  })

  it('does not share objects with the defaults', () => {
    const a = freshSave(0, 'UTC')
    a.settings.hotkeys.toggleStay = 'X'
    a.behavior.hangouts.push({ id: 'spot-1', name: 'x', kind: 'screen', displayId: 1, x: 0, y: 0 })
    expect(freshSave(0, 'UTC').settings.hotkeys.toggleStay).toBe(DEFAULT_HOTKEYS.toggleStay)
    expect(freshSave(0, 'UTC').behavior.hangouts).toEqual([])
  })
})

describe('parseSave: round trip', () => {
  it('a valid save parses to itself, without notes, and survives JSON', () => {
    const notes: string[] = []
    const s = parsed(day3(), notes)
    expect(notes).toEqual([])
    expect(s).toEqual(day3())
    expect(parsed(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })

  it('keeps unknown fields at the top level and inside every section', () => {
    const s = day3()
    s['futureTop'] = { a: [1, 2] }
    s['pet']['futurePet'] = 'x'
    s['pet']['cosmetics']['futureCos'] = 1
    s['pet']['position']['z'] = 3
    s['needs']['futureNeed'] = 5
    s['life']['futureLife'] = true
    s['rhythm']['futureRhythm'] = 1
    s['rhythm']['sparksToday']['futureSource'] = 2
    s['economy']['futureEco'] = { b: 1 }
    s['economy']['perCurrency']['futureCurrency'] = { lifetimeEarned: 1 }
    s['economy']['perCurrency']['crumbs']['futureField'] = 7
    s['economy']['perCurrency']['crumbs']['dailyHistory'][0]['note'] = 'n'
    s['behavior']['futureBehavior'] = null
    s['behavior']['hangouts'][0]['color'] = 'red'
    s['behavior']['stayPoint']['displayId'] = 1
    s['settings']['futureSetting'] = 'on'
    s['settings']['hotkeys']['futureAction'] = 'Alt+Command+F'
    s['meta']['futureMeta'] = 0
    const out = parsed(s)
    expect(out).toEqual(s)
    expect(parsed(JSON.parse(JSON.stringify(out)))).toEqual(s)
  })

  it('drops __proto__ keys instead of carrying them', () => {
    const text = JSON.stringify(day3())
      .replace(/^\{/, '{"__proto__":{"polluted":1},')
      .replace('"knownBundleIds":{', '"knownBundleIds":{"__proto__":"2026-10-01T00:00:00.000Z",')
    const out = parsed(JSON.parse(text))
    expect(Object.hasOwn(out, '__proto__')).toBe(false)
    expect(Object.hasOwn(out.economy.knownBundleIds, '__proto__')).toBe(false)
    expect((out as unknown as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('parseSave: rejections (corrupt → the store tries the backups)', () => {
  it('rejects what is not a save', () => {
    for (const bad of [null, 42, 'save', [], {}]) expect(parseSave(bad)).toBeNull()
  })

  it('rejects another schema version', () => {
    expect(rejects((s) => (s['schemaVersion'] = 2))).toContain('schemaVersion')
    expect(rejects((s) => delete s['schemaVersion'])).toContain('schemaVersion')
  })

  it('rejects a missing or non-object core section', () => {
    for (const key of ['pet', 'needs', 'rhythm', 'economy', 'behavior', 'meta']) {
      expect(rejects((s) => delete s[key])).toContain(key)
      expect(rejects((s) => (s[key] = [1]))).toContain(key)
    }
  })

  it('rejects a bad identity', () => {
    expect(rejects((s) => (s['pet']['name'] = ''))).toContain('pet.name')
    expect(rejects((s) => (s['pet']['name'] = 'x'.repeat(21)))).toContain('pet.name')
    expect(rejects((s) => (s['pet']['paletteId'] = 'neon'))).toContain('pet.paletteId')
    expect(rejects((s) => (s['pet']['size'] = 'XL'))).toContain('pet.size')
    expect(rejects((s) => (s['pet']['stage'] = 'adult'))).toContain('pet.stage')
    expect(rejects((s) => delete s['pet']['formId'])).toContain('pet.formId')
  })

  it('rejects wrong-typed or non-finite numbers', () => {
    expect(rejects((s) => (s['needs']['hunger'] = '34'))).toContain('needs.hunger')
    expect(rejects((s) => (s['needs']['energy'] = Number.NaN))).toContain('needs.energy')
    expect(rejects((s) => (s['needs']['dust'] = Infinity))).toContain('needs.dust')
    expect(rejects((s) => delete s['needs']['boredom'])).toContain('needs.boredom')
    expect(rejects((s) => (s['economy']['perCurrency']['pellets']['today'] = null))).toContain('economy.perCurrency.pellets.today')
    expect(rejects((s) => (s['economy']['nutritionLifetime'] = -Infinity))).toContain('economy.nutritionLifetime')
    expect(rejects((s) => (s['rhythm']['streakDays'] = '3'))).toContain('rhythm.streakDays')
  })

  it('rejects a broken ledger or rhythm', () => {
    expect(rejects((s) => delete s['economy']['perCurrency']['sparks'])).toContain('economy.perCurrency.sparks')
    expect(rejects((s) => s['economy']['perCurrency']['crumbs']['todayHourly'].pop())).toContain('todayHourly')
    expect(rejects((s) => (s['economy']['perCurrency']['crumbs']['dailyHistory'][1]['day'] = 'yesterday'))).toContain('dailyHistory[1].day')
    expect(rejects((s) => (s['economy']['currentDay'] = '2026-10'))).toContain('economy.currentDay')
    expect(rejects((s) => (s['rhythm']['lastActiveAt'] = 'not a time'))).toContain('rhythm.lastActiveAt')
    expect(rejects((s) => (s['rhythm']['sparksToday'] = null))).toContain('rhythm.sparksToday')
    expect(rejects((s) => (s['createdAt'] = 12))).toContain('createdAt')
  })

  it('rejects a bad mode, hangout list or onboarding flag', () => {
    expect(rejects((s) => (s['behavior']['mode'] = 'party'))).toContain('behavior.mode')
    expect(rejects((s) => (s['behavior']['hangouts'] = {}))).toContain('behavior.hangouts')
    expect(rejects((s) => delete s['meta']['onboardingComplete'])).toContain('meta.onboardingComplete')
  })
})

describe('parseSave: repairs (with a note)', () => {
  function repaired(mutate: (s: Record<string, any>) => void): { save: SaveFile; notes: string[] } {
    const s = day3()
    mutate(s)
    const notes: string[] = []
    const save = parsed(s, notes)
    expect(notes.length).toBeGreaterThan(0)
    return { save, notes }
  }

  it('clamps needs to 0..100 and restlessness to 0..1', () => {
    const { save } = repaired((s) => {
      s['needs']['hunger'] = 140
      s['needs']['dust'] = -3
      s['settings']['restlessness'] = 7
      s['settings']['hotkeys']['comeHere'] = 5
    })
    expect(save.needs.hunger).toBe(100)
    expect(save.needs.dust).toBe(0)
    expect(save.settings.restlessness).toBe(1)
  })

  it('fills a missing hotkey, setting or the whole settings section with defaults', () => {
    expect(repaired((s) => delete s['settings']['hotkeys']['toggleStay']).save.settings.hotkeys.toggleStay).toBe(DEFAULT_HOTKEYS.toggleStay)
    expect(repaired((s) => (s['settings']['hotkeys']['goHome'] = '')).save.settings.hotkeys.goHome).toBe(DEFAULT_HOTKEYS.goHome)
    expect(repaired((s) => delete s['settings']['hideInFullscreen']).save.settings.hideInFullscreen).toBe(true)
    expect(repaired((s) => delete s['settings']).save.settings).toEqual(DEFAULT_SETTINGS)
    expect(repaired((s) => (s['settings'] = 'oops')).save.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('defaults a missing or bad position, cosmetics, life, additions and spark sources', () => {
    expect(repaired((s) => delete s['pet']['position']).save.pet.position).toBeNull()
    expect(repaired((s) => (s['pet']['position']['facing'] = 0)).save.pet.position).toBeNull()
    expect(repaired((s) => (s['pet']['cosmetics'] = 1)).save.pet.cosmetics).toEqual({ equipped: {}, owned: [] })
    const life = repaired((s) => delete s['life']).save.life
    expect(life).toMatchObject({ continuousActiveMs: 0, sinceInteractionS: null, nutritionWindow: [] })
    expect(repaired((s) => delete s['economy']['perCurrency']['treats']['todayRaw']).save.economy.perCurrency.treats.todayRaw).toBe(0)
    expect(repaired((s) => delete s['rhythm']['sessionBeforeBreakMs']).save.rhythm.sessionBeforeBreakMs).toBe(0)
    expect(repaired((s) => delete s['rhythm']['sparksToday']['streak']).save.rhythm.sparksToday.streak).toBe(0)
    expect(repaired((s) => delete s['meta']['lastSummaryShownDay']).save.meta.lastSummaryShownDay).toBeNull()
  })

  it('drops bad hangout spots and clears references to missing ones', () => {
    const { save } = repaired((s) => {
      s['behavior']['hangouts'].push({ id: 'spot-3', name: 'Bad', kind: 'screen', displayId: 1, x: 'left', y: 0 })
      s['behavior']['hangouts'].push({ id: 'spot-1', name: 'Duplicate', kind: 'screen', displayId: 1, x: 0, y: 0 })
      s['behavior']['hangouts'].push({ id: 'spot-4', name: 'Nope', kind: 'window', displayId: 1, x: 0, y: 0 })
      s['behavior']['hangouts'][1]['fallbackId'] = 'spot-9'
      s['behavior']['defaultHomeId'] = 'spot-9'
    })
    expect(save.behavior.hangouts.map((h) => h.id)).toEqual(['spot-1', 'spot-2'])
    expect(save.behavior.hangouts[1]).toMatchObject({ kind: 'app', fallbackId: null })
    expect(save.behavior.defaultHomeId).toBeNull()
  })

  it('turns Hangout without a valid active spot into Roam', () => {
    const { save } = repaired((s) => {
      s['behavior']['mode'] = 'hangout'
      s['behavior']['activeHangoutId'] = 'spot-7'
    })
    expect(save.behavior).toMatchObject({ mode: 'roam', activeHangoutId: null })
    const ok = day3()
    ok['behavior']['mode'] = 'hangout'
    ok['behavior']['activeHangoutId'] = 'spot-2'
    expect(parsed(ok).behavior).toMatchObject({ mode: 'hangout', activeHangoutId: 'spot-2' })
  })

  it('clamps relativeX and cuts long names', () => {
    const { save } = repaired((s) => {
      s['behavior']['hangouts'][1]['relativeX'] = 1.5
      s['behavior']['hangouts'][0]['name'] = 'n'.repeat(500)
      s['behavior']['hangouts'][1]['appName'] = 'Term\u0007inal'
      s['behavior']['hangouts'].push({ id: 'x'.repeat(tuning.persistence.maxIdLength + 1), name: 'long id', kind: 'screen', displayId: 1, x: 0, y: 0 })
    })
    const [screen, app] = save.behavior.hangouts
    expect(save.behavior.hangouts).toHaveLength(2)
    expect(screen?.name).toHaveLength(tuning.persistence.maxNameLength)
    expect(app).toMatchObject({ relativeX: 1, appName: 'Terminal' })
  })

  it('caps dailyHistory at historyDays (oldest dropped), hangouts, known apps (least recent dropped) and owned items', () => {
    const P = tuning.persistence
    const historyDays = tuning.economy.historyDays
    const { save, notes } = repaired((s) => {
      s['economy']['perCurrency']['crumbs']['dailyHistory'] = Array.from({ length: historyDays + 5 }, (_, i) => ({
        day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
        earned: i,
      }))
      s['behavior']['hangouts'] = Array.from({ length: P.maxHangouts + 3 }, (_, i) => ({ id: `spot-${i + 1}`, name: `S${i}`, kind: 'screen', displayId: 1, x: i, y: 0 }))
      s['behavior']['defaultHomeId'] = `spot-${P.maxHangouts + 2}`
      const known: Record<string, string> = {}
      for (let i = 0; i < P.maxKnownBundleIds + 10; i++) known[`com.example.app${i}`] = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
      known['bad id\n'] = '2026-10-01T00:00:00.000Z'
      known['com.example.badtime'] = 'soon'
      s['economy']['knownBundleIds'] = known
      s['pet']['cosmetics']['owned'] = Array.from({ length: P.maxOwnedItems + 1 }, (_, i) => `item${i}`)
    })
    const history = save.economy.perCurrency.crumbs.dailyHistory
    expect(history).toHaveLength(historyDays)
    expect(history[0]?.earned).toBe(5)
    expect(save.behavior.hangouts).toHaveLength(P.maxHangouts)
    expect(save.behavior.defaultHomeId).toBeNull()
    const known = Object.keys(save.economy.knownBundleIds)
    expect(known).toHaveLength(P.maxKnownBundleIds)
    expect(known).not.toContain('com.example.app0')
    expect(known).toContain(`com.example.app${P.maxKnownBundleIds + 9}`)
    expect(save.pet.cosmetics.owned).toHaveLength(P.maxOwnedItems)
    // Notes name fields and problems, never bundle IDs or values.
    expect(notes.join('\n')).not.toMatch(/com\.example|bad id/)
  })

  it('keeps only the nutrition buckets inside the fullness window', () => {
    const windowS = tuning.needs.fullness.windowMin * 60
    const s = day3()
    s['life']['nutritionWindow'] = [{ ageS: windowS + 1, amount: 2 }, { ageS: 10, amount: 0 }, { ageS: 5, amount: 1 }, 'x']
    expect(parsed(s).life.nutritionWindow).toEqual([{ ageS: 5, amount: 1 }])
  })
})

describe('the save holds counts and choices only (§2)', () => {
  /** Every key path in a JSON value; map keys (bundle IDs, attach points) collapsed to '*'. */
  function keyPaths(v: unknown, path = '', out = new Set<string>()): Set<string> {
    if (Array.isArray(v)) v.forEach((x) => keyPaths(x, `${path}[]`, out))
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        const p = path === 'economy.knownBundleIds' || path === 'pet.cosmetics.equipped' ? `${path}.*` : path ? `${path}.${k}` : k
        out.add(p)
        keyPaths(x, p, out)
      }
    }
    return out
  }

  const currency = ['lifetimeEarned', 'today', 'todayHourly', 'dailyHistory', 'dailyHistory[].day', 'dailyHistory[].earned', 'wallet', 'todayRaw', 'todayCredited']
  const EXPECTED = new Set([
    'schemaVersion', 'createdAt',
    'pet', 'pet.name', 'pet.paletteId', 'pet.size', 'pet.stage', 'pet.formId', 'pet.cosmetics', 'pet.cosmetics.equipped', 'pet.cosmetics.owned',
    'pet.position', 'pet.position.displayId', 'pet.position.x', 'pet.position.y', 'pet.position.facing',
    'needs', 'needs.hunger', 'needs.energy', 'needs.fullness', 'needs.boredom', 'needs.dust',
    'life', 'life.continuousActiveMs', 'life.sinceInteractionS', 'life.idleRunS', 'life.unusedS', 'life.dayKey', 'life.dayActive',
    'life.nutritionWindow', 'life.nutritionWindow[].ageS', 'life.nutritionWindow[].amount',
    'rhythm', 'rhythm.continuousActiveMs', 'rhythm.lastActiveAt', 'rhythm.lastBreakAt', 'rhythm.streakDays', 'rhythm.lastStreakDay',
    'rhythm.sparksToday', ...['morningWake', 'welcomeBack', 'healthySession', 'streak', 'neglect'].map((k) => `rhythm.sparksToday.${k}`),
    'rhythm.sessionBeforeBreakMs',
    'economy', 'economy.perCurrency',
    ...['crumbs', 'pellets', 'treats', 'mileage', 'sparks'].flatMap((c) => [`economy.perCurrency.${c}`, ...currency.map((k) => `economy.perCurrency.${c}.${k}`)]),
    'economy.nutritionLifetime', 'economy.evolutionProgress', 'economy.knownBundleIds', 'economy.knownBundleIds.*', 'economy.currentDay',
    'behavior', 'behavior.mode', 'behavior.stayPoint', 'behavior.stayPoint.x', 'behavior.stayPoint.y', 'behavior.activeHangoutId',
    'behavior.defaultHomeId', 'behavior.hangouts',
    ...['id', 'name', 'kind', 'displayId', 'x', 'y', 'bundleId', 'appName', 'relativeX', 'fallbackId'].map((k) => `behavior.hangouts[].${k}`),
    'settings', 'settings.hotkeys', ...Object.keys(DEFAULT_HOTKEYS).map((k) => `settings.hotkeys.${k}`),
    'settings.altCmdClickSend', 'settings.hideInFullscreen', 'settings.restlessness', 'settings.launchAtLogin', 'settings.sound',
    'meta', 'meta.lastSummaryShownDay', 'meta.onboardingComplete', 'meta.savedAt',
  ])

  it('the day-3 fixture has exactly the expected keys (no key codes, titles or click positions)', () => {
    expect([...keyPaths(day3())].sort()).toEqual([...EXPECTED].sort())
  })

  it('a save assembled from live modules fed key presses and clicks has no other keys', () => {
    const base = parsed(day3())
    let now = Date.parse('2026-10-08T19:00:00.000Z')
    const economy = new Economy({ clock: { now: () => now }, timeZone: 'UTC', state: economyStateOf(base) })
    economy.setInputCounting(true)
    for (let i = 0; i < 50; i++) {
      now += 137 + (i % 7) * 41
      economy.key(0x24 + (i % 5), true, false)
      economy.key(0x24 + (i % 5), false, false)
      if (i % 5 === 0) economy.click(0)
      economy.cursor(100 + i * 30, 200 + (i % 3) * 50)
    }
    economy.appLaunched('com.example.New')
    const save = assembleSave(base, { economy: economy.state })
    expect(economy.state.economy.perCurrency.crumbs.todayRaw).toBeGreaterThan(base.economy.perCurrency.crumbs.todayRaw)
    expect([...keyPaths(save)].filter((k) => !EXPECTED.has(k))).toEqual([])
  })
})

describe('snapshot: live modules ↔ save', () => {
  it('restores the modules from a save and assembles the same save back', () => {
    const save = parsed(day3())
    const now = Date.parse('2026-10-08T19:00:00.000Z')
    const economy = new Economy({ clock: { now: () => now }, timeZone: 'UTC', state: economyStateOf(save) })
    const needs = new Needs(tuning.needs, tuning.economy.activity.activeIdleS, needsStateOf(save), 0)
    const modes = new ModeState(behaviorOf(save))
    const back = assembleSave(save, {
      identity: identityOf(save),
      position: save.pet.position,
      needs: needs.state,
      economy: economy.state,
      behavior: modes.settings,
      settings: settingsOf(save),
      meta: save.meta,
    })
    expect(back).toEqual(save)
    expect(identityOf(back)).toEqual({ name: 'Pixel', paletteId: 'lilac', size: 'M' })
    expect(modes.mode).toBe('stay')
    expect(modes.spots).toHaveLength(2)
    expect(needs.state.levels).toEqual(save.needs)
  })

  it('keeps what the parts leave out: Phase 2/3 fields, createdAt, unknown fields, absent parts', () => {
    const raw = day3()
    raw['pet']['cosmetics'] = { equipped: { head_top: 'cap' }, owned: ['cap'] }
    raw['extra'] = 1
    raw['life']['extraLife'] = 2
    const prev = parsed(raw)
    const needs = new Needs(tuning.needs, tuning.economy.activity.activeIdleS, needsStateOf(prev), 0)
    const next = assembleSave(prev, {
      identity: { name: 'Bolt', paletteId: 'peach', size: 'L' },
      needs: { ...needs.state, levels: { ...needs.state.levels, hunger: 90 } },
      meta: { lastSummaryShownDay: '2026-10-09' },
    })
    expect(next.pet).toMatchObject({ name: 'Bolt', paletteId: 'peach', size: 'L', stage: 'base', cosmetics: { owned: ['cap'] } })
    expect(next.pet.position).toEqual(prev.pet.position)
    expect(next.needs.hunger).toBe(90)
    expect(next.meta).toEqual({ lastSummaryShownDay: '2026-10-09', onboardingComplete: true, savedAt: prev.meta.savedAt })
    expect(next.createdAt).toBe(prev.createdAt)
    expect((next as unknown as Record<string, unknown>)['extra']).toBe(1)
    expect((next.life as unknown as Record<string, unknown>)['extraLife']).toBe(2)
    expect(next.economy).toEqual(prev.economy)
    expect(assembleSave(prev, { position: null }).pet.position).toBeNull()
  })

  it('copies: changing the result or the accessors never touches the source', () => {
    const save = parsed(day3())
    const out = assembleSave(save, {})
    out.behavior.hangouts.length = 0
    economyStateOf(save).economy.knownBundleIds['x'] = 'y'
    needsStateOf(save).levels.hunger = 0
    behaviorOf(save).hangouts.length = 0
    settingsOf(save).hotkeys.goHome = 'X'
    expect(save).toEqual(parsed(day3()))
  })
})
