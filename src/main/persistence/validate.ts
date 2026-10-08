// Checks a parsed save file (§16) before the app trusts it: parseSave(json) gives a SaveFile that is safe to restore
// from, or null when the file is corrupt (the store then tries the backups, §16 "on a corrupt file, load the newest
// valid backup"). It expects the current schema; migrations.ts upgrades older files first.
//
// Rejected (null): the file isn't a save, or what the user would miss is unusable. Not an object, the wrong
// schemaVersion, a bad createdAt; a core section (pet, needs, rhythm, economy, behavior, meta) missing or not an
// object; a core value missing or of the wrong type: the identity (name, palette, size, stage, form), a needs level,
// any ledger or rhythm number, a day key, a timestamp, the mode, the hangout list, onboardingComplete. Numbers must be
// finite (no NaN or Infinity).
//
// Repaired, with a note (the default is safe and a backup would cost up to backupEveryMs of progress):
//   - missing or bad settings, hotkeys, cosmetics, position, stayPoint, defaultHomeId, lastSummaryShownDay → defaults;
//   - a missing or bad `life` (the needs model's extras) or field of it → a new pet's values;
//   - missing additions to §16 (todayRaw, todayCredited, sessionBeforeBreakMs) and spark sources → 0;
//   - numbers out of range → clamped (needs 0..100, restlessness and relativeX 0..1, counts ≥ 0);
//   - a bad hangout spot, known app or owned item → dropped; a spot reference that points nowhere → null (and Hangout
//     without an active spot → Roam, as ModeState does);
//   - over the caps (tuning.persistence, economy.historyDays) → the oldest days and apps, the last spots dropped;
//     long names → cut.
// Unknown fields are kept (§16), at the top level and inside every section and spot, so a newer build's additions
// survive a round trip through this one ('__proto__' keys are dropped).
//
// Notes and reasons name the field and the problem only (e.g. "economy.perCurrency.crumbs.today: not a number"),
// never a value or a bundle ID, so they can be logged. Pure.

import { isDay } from '../economy/days'
import { CURRENCIES, SPARK_SOURCES } from '../../shared/economy'
import { HOTKEY_ACTIONS } from '../../shared/hotkeys'
import { NEEDS } from '../../shared/life'
import { PET_MODES, type HangoutSpot, type ModeSettings } from '../../shared/modes'
import { isPaletteId } from '../../shared/palettes'
import { cleanPetName, DEFAULT_SETTINGS, isPetSize, type AppSettings } from '../../shared/settings'
import { tuning } from '../../shared/tuning'
import { ATTACH_POINTS, type PetPosition } from '../../shared/types'
import type { CurrencyLedger, LedgerState } from '../economy/ledger'
import type { RhythmState } from '../economy/rhythm'
import { freshNeedsState, type NutritionBucket } from '../sim/needs/needs'
import { CURRENT_SCHEMA_VERSION, FORM_IDS, PET_STAGES, type NeedsLife, type PetSave, type SaveFile, type SaveMeta } from './saveFile'

type Rec = Record<string, unknown>

const P = tuning.persistence
/** The longest ISO timestamp kept ('+275760-09-13T00:00:00.000Z' is 27; leave room for offsets). */
const MAX_ISO_LENGTH = 40

class Rejected extends Error {}

function reject(path: string, why: string): never {
  throw new Rejected(`${path}: ${why}`)
}

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A copy of r's own fields, for carrying unknown ones through (no '__proto__'). */
function keep(r: Rec): Rec {
  const out: Rec = {}
  for (const [k, v] of Object.entries(r)) if (k !== '__proto__') out[k] = v
  return out
}

// ---- strict readers: a wrong value rejects the file ----

function rec(v: unknown, path: string): Rec {
  if (!isRec(v)) reject(path, v === undefined ? 'missing' : 'not an object')
  return v
}

function finite(v: unknown, path: string): number {
  if (typeof v !== 'number') reject(path, v === undefined ? 'missing' : 'not a number')
  if (!Number.isFinite(v)) reject(path, 'not finite')
  return v
}

function clamped(v: unknown, path: string, min: number, max: number): number {
  return Math.min(max, Math.max(min, finite(v, path)))
}

const nonNeg = (v: unknown, path: string): number => clamped(v, path, 0, Number.MAX_VALUE)
const count = (v: unknown, path: string): number => Math.round(nonNeg(v, path))

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') reject(path, v === undefined ? 'missing' : 'not a boolean')
  return v
}

function day(v: unknown, path: string): string {
  if (!isDay(v)) reject(path, v === undefined ? 'missing' : 'not a day')
  return v
}

function dayOrNull(v: unknown, path: string): string | null {
  return v === null ? null : day(v, path)
}

function iso(v: unknown, path: string): string {
  if (typeof v !== 'string') reject(path, v === undefined ? 'missing' : 'not a string')
  if (v.length > MAX_ISO_LENGTH || !Number.isFinite(Date.parse(v))) reject(path, 'not a timestamp')
  return v
}

function isoOrNull(v: unknown, path: string): string | null {
  return v === null ? null : iso(v, path)
}

function oneOf<T extends string>(v: unknown, list: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) reject(path, v === undefined ? 'missing' : 'not a known value')
  return v as T
}

/** A string without control characters, 1..max long; null otherwise. */
function cleanString(v: unknown, max: number): string | null {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null
}

/** A display name: control characters removed, cut to maxNameLength; null if not a string. */
function displayName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  return [...v.replace(/[\u0000-\u001f\u007f]/g, '')].slice(0, P.maxNameLength).join('')
}

const isBundleId = (v: unknown): v is string => cleanString(v, P.maxBundleIdLength) !== null && v !== '__proto__'

// ---- lenient readers: a missing or wrong value takes the default, with a note ----

class Notes {
  constructor(readonly list: string[]) {}
  add(path: string, what: string): void {
    this.list.push(`${path}: ${what}`)
  }
  /** r[key] read by `read`; missing or rejected → fallback, noted. */
  lenient<T>(r: Rec, key: string, path: string, read: (v: unknown, path: string) => T, fallback: T): T {
    if (!Object.hasOwn(r, key)) {
      this.add(path, 'missing, default used')
      return fallback
    }
    try {
      return read(r[key], path)
    } catch (e) {
      if (!(e instanceof Rejected)) throw e
      this.add(path, `default used (${e.message})`)
      return fallback
    }
  }
}

// ---- sections ----

function parsePet(v: unknown, notes: Notes): PetSave {
  const r = rec(v, 'pet')
  const name = cleanPetName(r['name'])
  if (name === null) reject('pet.name', r['name'] === undefined ? 'missing' : 'not a valid name')
  if (!isPaletteId(r['paletteId'])) reject('pet.paletteId', 'not a known palette')
  if (!isPetSize(r['size'])) reject('pet.size', 'not S, M or L')
  const cosmetics = notes.lenient(r, 'cosmetics', 'pet.cosmetics', (c, path) => parseCosmetics(c, path, notes), { equipped: {}, owned: [] })
  const position = notes.lenient(r, 'position', 'pet.position', parsePosition, null)
  return {
    ...keep(r),
    name,
    paletteId: r['paletteId'],
    size: r['size'],
    stage: oneOf(r['stage'], PET_STAGES, 'pet.stage'),
    formId: oneOf(r['formId'], FORM_IDS, 'pet.formId'),
    cosmetics,
    position,
  }
}

function parseCosmetics(v: unknown, path: string, notes: Notes): PetSave['cosmetics'] {
  const r = rec(v, path)
  const rawEquipped = rec(r['equipped'], `${path}.equipped`)
  const equipped: PetSave['cosmetics']['equipped'] = {}
  for (const point of ATTACH_POINTS) {
    if (!Object.hasOwn(rawEquipped, point)) continue
    const id = cleanString(rawEquipped[point], P.maxIdLength)
    if (id === null) notes.add(`${path}.equipped.${point}`, 'not an item, dropped')
    else equipped[point] = id
  }
  if (!Array.isArray(r['owned'])) reject(`${path}.owned`, 'not a list')
  const all = r['owned'].map((id) => cleanString(id, P.maxIdLength))
  let owned = all.filter((id): id is string => id !== null)
  if (owned.length < all.length) notes.add(`${path}.owned`, `${all.length - owned.length} bad items dropped`)
  if (owned.length > P.maxOwnedItems) {
    notes.add(`${path}.owned`, `over ${P.maxOwnedItems}, the rest dropped`)
    owned = owned.slice(0, P.maxOwnedItems)
  }
  return { ...keep(r), equipped, owned }
}

function parsePosition(v: unknown, path: string): PetPosition | null {
  if (v === null) return null
  const r = rec(v, path)
  const displayId = finite(r['displayId'], `${path}.displayId`)
  if (!Number.isInteger(displayId)) reject(`${path}.displayId`, 'not an integer')
  const facing = r['facing']
  if (facing !== 1 && facing !== -1) reject(`${path}.facing`, 'not 1 or -1')
  return { ...keep(r), displayId, x: finite(r['x'], `${path}.x`), y: finite(r['y'], `${path}.y`), facing }
}

function parseNeeds(v: unknown): SaveFile['needs'] {
  const r = rec(v, 'needs')
  const out = keep(r) as SaveFile['needs']
  for (const need of NEEDS) out[need] = clamped(r[need], `needs.${need}`, 0, 100)
  return out
}

function parseLife(v: unknown, path: string, notes: Notes): NeedsLife {
  const { levels: _levels, ...fresh } = freshNeedsState(tuning.needs)
  const r = rec(v, path)
  const f = tuning.needs.fullness
  const windowS = f.windowMin * 60
  return {
    ...keep(r),
    continuousActiveMs: notes.lenient(r, 'continuousActiveMs', `${path}.continuousActiveMs`, nonNeg, fresh.continuousActiveMs),
    sinceInteractionS: notes.lenient(r, 'sinceInteractionS', `${path}.sinceInteractionS`, (x, p) => (x === null ? null : nonNeg(x, p)), fresh.sinceInteractionS),
    idleRunS: notes.lenient(r, 'idleRunS', `${path}.idleRunS`, nonNeg, fresh.idleRunS),
    unusedS: notes.lenient(r, 'unusedS', `${path}.unusedS`, nonNeg, fresh.unusedS),
    dayKey: notes.lenient(r, 'dayKey', `${path}.dayKey`, dayOrNull, fresh.dayKey),
    dayActive: notes.lenient(r, 'dayActive', `${path}.dayActive`, bool, fresh.dayActive),
    nutritionWindow: notes.lenient(
      r,
      'nutritionWindow',
      `${path}.nutritionWindow`,
      (x, p) => {
        if (!Array.isArray(x)) reject(p, 'not a list')
        return x
          .filter(isRec)
          .map((b): NutritionBucket => ({ ageS: finiteOr(b['ageS'], -1), amount: finiteOr(b['amount'], 0) }))
          .filter((b) => b.ageS >= 0 && b.ageS < windowS && b.amount > 0)
          .slice(-Math.ceil(windowS / f.bucketS) - 1)
      },
      fresh.nutritionWindow,
    ),
  }
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function parseRhythm(v: unknown, notes: Notes): RhythmState {
  const r = rec(v, 'rhythm')
  const rawSparks = rec(r['sparksToday'], 'rhythm.sparksToday')
  const sparksToday = keep(rawSparks) as RhythmState['sparksToday']
  for (const source of SPARK_SOURCES) {
    sparksToday[source] = Object.hasOwn(rawSparks, source) ? nonNeg(rawSparks[source], `rhythm.sparksToday.${source}`) : 0
    if (!Object.hasOwn(rawSparks, source)) notes.add(`rhythm.sparksToday.${source}`, 'missing, 0 used')
  }
  return {
    ...keep(r),
    continuousActiveMs: nonNeg(r['continuousActiveMs'], 'rhythm.continuousActiveMs'),
    lastActiveAt: iso(r['lastActiveAt'], 'rhythm.lastActiveAt'),
    lastBreakAt: isoOrNull(r['lastBreakAt'], 'rhythm.lastBreakAt'),
    streakDays: count(r['streakDays'], 'rhythm.streakDays'),
    lastStreakDay: dayOrNull(r['lastStreakDay'], 'rhythm.lastStreakDay'),
    sparksToday,
    sessionBeforeBreakMs: notes.lenient(r, 'sessionBeforeBreakMs', 'rhythm.sessionBeforeBreakMs', nonNeg, 0),
  }
}

function parseCurrency(v: unknown, path: string, notes: Notes): CurrencyLedger {
  const r = rec(v, path)
  const hourly = r['todayHourly']
  if (!Array.isArray(hourly) || hourly.length !== 24) reject(`${path}.todayHourly`, 'not 24 hours')
  const history = r['dailyHistory']
  if (!Array.isArray(history)) reject(`${path}.dailyHistory`, 'not a list')
  let dailyHistory = history.map((entry, i) => {
    const e = rec(entry, `${path}.dailyHistory[${i}]`)
    return { ...keep(e), day: day(e['day'], `${path}.dailyHistory[${i}].day`), earned: nonNeg(e['earned'], `${path}.dailyHistory[${i}].earned`) }
  })
  const historyDays = tuning.economy.historyDays
  if (dailyHistory.length > historyDays) {
    notes.add(`${path}.dailyHistory`, `over ${historyDays} days, the oldest dropped`)
    dailyHistory = dailyHistory.slice(-historyDays)
  }
  return {
    ...keep(r),
    lifetimeEarned: nonNeg(r['lifetimeEarned'], `${path}.lifetimeEarned`),
    today: nonNeg(r['today'], `${path}.today`),
    todayHourly: hourly.map((h, i) => nonNeg(h, `${path}.todayHourly[${i}]`)),
    dailyHistory,
    wallet: nonNeg(r['wallet'], `${path}.wallet`),
    todayRaw: notes.lenient(r, 'todayRaw', `${path}.todayRaw`, nonNeg, 0),
    todayCredited: notes.lenient(r, 'todayCredited', `${path}.todayCredited`, nonNeg, 0),
  }
}

function parseKnownBundleIds(v: unknown, path: string, notes: Notes): Record<string, string> {
  const r = rec(v, path)
  const entries: [string, string, number][] = []
  let bad = 0
  for (const [id, at] of Object.entries(r)) {
    const t = typeof at === 'string' && at.length <= MAX_ISO_LENGTH ? Date.parse(at) : NaN
    if (isBundleId(id) && Number.isFinite(t)) entries.push([id, at as string, t])
    else bad++
  }
  if (bad > 0) notes.add(path, `${bad} bad entries dropped`)
  if (entries.length > P.maxKnownBundleIds) {
    notes.add(path, `over ${P.maxKnownBundleIds}, the least recently opened dropped`)
    entries.sort((a, b) => b[2] - a[2])
    entries.length = P.maxKnownBundleIds
  }
  return Object.fromEntries(entries.map(([id, at]) => [id, at]))
}

function parseEconomy(v: unknown, notes: Notes): LedgerState {
  const r = rec(v, 'economy')
  const rawPer = rec(r['perCurrency'], 'economy.perCurrency')
  const perCurrency = keep(rawPer) as LedgerState['perCurrency']
  for (const c of CURRENCIES) perCurrency[c] = parseCurrency(rawPer[c], `economy.perCurrency.${c}`, notes)
  return {
    ...keep(r),
    perCurrency,
    nutritionLifetime: nonNeg(r['nutritionLifetime'], 'economy.nutritionLifetime'),
    evolutionProgress: nonNeg(r['evolutionProgress'], 'economy.evolutionProgress'),
    knownBundleIds: notes.lenient(r, 'knownBundleIds', 'economy.knownBundleIds', (x, p) => parseKnownBundleIds(x, p, notes), {}),
    currentDay: day(r['currentDay'], 'economy.currentDay'),
  }
}

/** One hangout spot, or null (dropped). */
function parseSpot(v: unknown): HangoutSpot | null {
  if (!isRec(v)) return null
  const id = cleanString(v['id'], P.maxIdLength)
  const name = displayName(v['name'])
  if (id === null || id === '__proto__' || name === null) return null
  if (v['kind'] === 'screen') {
    const { displayId, x, y } = v
    if (typeof displayId !== 'number' || !Number.isInteger(displayId)) return null
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) return null
    return { ...keep(v), id, name, kind: 'screen', displayId, x, y }
  }
  if (v['kind'] === 'app') {
    const { bundleId, relativeX, fallbackId } = v
    const appName = displayName(v['appName'])
    if (!isBundleId(bundleId) || appName === null) return null
    if (typeof relativeX !== 'number' || !Number.isFinite(relativeX)) return null
    if (fallbackId !== null && cleanString(fallbackId, P.maxIdLength) === null) return null
    return { ...keep(v), id, name, kind: 'app', bundleId, appName, relativeX: Math.min(1, Math.max(0, relativeX)), fallbackId: fallbackId as string | null }
  }
  return null
}

function parseBehavior(v: unknown, notes: Notes): ModeSettings {
  const r = rec(v, 'behavior')
  let mode = oneOf(r['mode'], PET_MODES, 'behavior.mode')
  const rawSpots = r['hangouts']
  if (!Array.isArray(rawSpots)) reject('behavior.hangouts', rawSpots === undefined ? 'missing' : 'not a list')
  const hangouts: HangoutSpot[] = []
  const ids = new Set<string>()
  rawSpots.forEach((raw, i) => {
    const spot = parseSpot(raw)
    if (spot === null || ids.has(spot.id)) return notes.add(`behavior.hangouts[${i}]`, spot === null ? 'not a valid spot, dropped' : 'duplicate id, dropped')
    ids.add(spot.id)
    hangouts.push(spot)
  })
  if (hangouts.length > P.maxHangouts) {
    notes.add('behavior.hangouts', `over ${P.maxHangouts}, the rest dropped`)
    hangouts.length = P.maxHangouts
    ids.clear()
    for (const s of hangouts) ids.add(s.id)
  }
  const ref = (key: string): string | null => {
    const id = notes.lenient(r, key, `behavior.${key}`, (x, p) => (x === null ? null : (cleanString(x, P.maxIdLength) ?? reject(p, 'not an id'))), null)
    if (id !== null && !ids.has(id)) {
      notes.add(`behavior.${key}`, 'no such spot, cleared')
      return null
    }
    return id
  }
  for (const spot of hangouts) {
    if (spot.kind === 'app' && spot.fallbackId !== null && (spot.fallbackId === spot.id || !ids.has(spot.fallbackId))) {
      notes.add('behavior.hangouts', 'a fallback to no such spot, cleared')
      spot.fallbackId = null
    }
  }
  const activeHangoutId = ref('activeHangoutId')
  if (mode === 'hangout' && activeHangoutId === null) {
    notes.add('behavior.mode', 'hangout without a spot, roam used')
    mode = 'roam'
  }
  return {
    ...keep(r),
    mode,
    stayPoint: notes.lenient(r, 'stayPoint', 'behavior.stayPoint', (x, p) => {
      if (x === null) return null
      const s = rec(x, p)
      return { ...keep(s), x: finite(s['x'], `${p}.x`), y: finite(s['y'], `${p}.y`) }
    }, null),
    activeHangoutId,
    defaultHomeId: ref('defaultHomeId'),
    hangouts,
  }
}

function parseSettings(v: unknown, path: string, notes: Notes): AppSettings {
  const r = rec(v, path)
  const d = DEFAULT_SETTINGS
  const hotkeys = notes.lenient(r, 'hotkeys', `${path}.hotkeys`, (x, p) => {
    const h = rec(x, p)
    const out = keep(h) as AppSettings['hotkeys']
    for (const action of HOTKEY_ACTIONS) {
      out[action] = notes.lenient(h, action, `${p}.${action}`, (a, ap) => cleanString(a, P.maxHotkeyLength) ?? reject(ap, 'not an accelerator'), d.hotkeys[action])
    }
    return out
  }, { ...d.hotkeys })
  return {
    ...keep(r),
    hotkeys,
    altCmdClickSend: notes.lenient(r, 'altCmdClickSend', `${path}.altCmdClickSend`, bool, d.altCmdClickSend),
    hideInFullscreen: notes.lenient(r, 'hideInFullscreen', `${path}.hideInFullscreen`, bool, d.hideInFullscreen),
    restlessness: notes.lenient(r, 'restlessness', `${path}.restlessness`, (x, p) => clamped(x, p, 0, 1), d.restlessness),
    launchAtLogin: notes.lenient(r, 'launchAtLogin', `${path}.launchAtLogin`, bool, d.launchAtLogin),
    sound: notes.lenient(r, 'sound', `${path}.sound`, bool, d.sound),
  }
}

function parseMeta(v: unknown, notes: Notes): SaveMeta {
  const r = rec(v, 'meta')
  return {
    ...keep(r),
    lastSummaryShownDay: notes.lenient(r, 'lastSummaryShownDay', 'meta.lastSummaryShownDay', dayOrNull, null),
    onboardingComplete: bool(r['onboardingComplete'], 'meta.onboardingComplete'),
    savedAt: notes.lenient(r, 'savedAt', 'meta.savedAt', isoOrNull, null),
  }
}

/**
 * A current-schema save made safe to restore from, or null when it is corrupt. `notes` receives what was repaired
 * and, on null, why the file was rejected (field paths and problem kinds only: safe to log).
 */
export function parseSave(json: unknown, notes: string[] = []): SaveFile | null {
  const n = new Notes(notes)
  try {
    const r = rec(json, 'save')
    if (r['schemaVersion'] !== CURRENT_SCHEMA_VERSION) reject('schemaVersion', `not ${CURRENT_SCHEMA_VERSION}`)
    const { levels: _levels, ...freshLife } = freshNeedsState(tuning.needs)
    return {
      ...keep(r),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: iso(r['createdAt'], 'createdAt'),
      pet: parsePet(r['pet'], n),
      needs: parseNeeds(r['needs']),
      life: n.lenient(r, 'life', 'life', (x, p) => parseLife(x, p, n), freshLife),
      rhythm: parseRhythm(r['rhythm'], n),
      economy: parseEconomy(r['economy'], n),
      behavior: parseBehavior(r['behavior'], n),
      settings: n.lenient(r, 'settings', 'settings', (x, p) => parseSettings(x, p, n), structuredClone(DEFAULT_SETTINGS)),
      meta: parseMeta(r['meta'], n),
    }
  } catch (e) {
    if (!(e instanceof Rejected)) throw e
    notes.push(`rejected: ${e.message}`)
    return null
  }
}
