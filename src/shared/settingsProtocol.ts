// The settings window's messages (BITBOT_SPEC.md §15.4; channels in ./ipc.ts, the window in
// src/main/windows/settingsWindow.ts, the page in src/renderer/settings/). Pure.
// - SettingsView (main → page): everything the page shows, pushed whenever it changed. Main is the source of truth:
//   the page never keeps its own idea of a setting, it re-renders from the newest view.
// - SettingsChange (page → main): one small change per message (one control = one change), validated strictly here
//   (exact fields, known values, names cleaned the same way main cleans them) before main acts on it.
// - The helpers build the view's parts from what main has (modesView, knownAppsView).
//
// SPEC-DEVIATION: §15.4 "default mode" has no field of its own in §16's SaveFile; Bitbot starts in the saved mode
// (behavior.mode). So the settings' "Default mode" is the mode itself: choosing it switches the mode now and it is
// saved, as choosing it in the tray menu does.

import { normalizeAccelerator } from './accelerator'
import { HOTKEY_ACTIONS, type HotkeyAction } from './hotkeys'
import { isPetMode, type HangoutSpot, type ModeSettings, type PetMode } from './modes'
import { isPaletteId } from './palettes'
import { cleanPetName, isPetIdentity, isPetSize, type AppSettings, type PetIdentity } from './settings'
import { tuning } from './tuning'
import type { PaletteId, PetSize } from './types'

/** The page's sections (§15.4), in sidebar order. open(section) and ?section= pick one. */
export const SETTINGS_SECTIONS = ['pet', 'behavior', 'controls', 'privacy', 'general', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** What each hotkey action is called in settings and its messages (§10.5's table). */
export const HOTKEY_LABELS: Readonly<Record<HotkeyAction, string>> = {
  toggleVisible: 'Show / hide Bitbot',
  comeHere: 'Come here',
  goHome: 'Go home',
  toggleStay: 'Toggle Stay',
}

// ───────────────────────────── the view ─────────────────────────────

export interface SettingsSpotView {
  id: string
  name: string
  kind: 'screen' | 'app'
  /** An app spot's app; null for a screen spot. */
  appName: string | null
}

export interface SettingsModesView {
  mode: PetMode
  /** Hangout's spot; null: none. */
  activeSpotId: string | null
  /** The spot Go home uses when no hangout is active (a screen spot); null: the middle of the Dock. */
  defaultHomeId: string | null
  spots: SettingsSpotView[]
}

/** One global hotkey: its binding and whether it is registered (false: another app owns it, §10.5). */
export interface HotkeyView {
  accelerator: string
  registered: boolean
}

/** Input Monitoring (§7.1): granted, not granted, or not known yet (the helper hasn't answered). */
export type InputMonitoringStatus = 'granted' | 'off' | 'unknown'

/** An app Bitbot has seen opened (§16 knownBundleIds): its bundle ID, its name when known, the day it was last opened. */
export interface KnownAppView {
  bundleId: string
  name: string | null
  /** 'YYYY-MM-DD', local time. */
  lastOpenedDay: string
}

/** Something the page should say after a change that didn't go as asked (a hotkey another app owns). */
export interface SettingsNotice {
  /** The hotkey row it belongs to; null: a general one (shown at the top of the page). */
  action: HotkeyAction | null
  text: string
}

export interface SettingsView {
  identity: PetIdentity
  settings: AppSettings
  modes: SettingsModesView
  hotkeys: Record<HotkeyAction, HotkeyView>
  inputMonitoring: InputMonitoringStatus
  /** app.setLoginItemSettings works only in the installed app: false in dev builds (shown disabled). */
  launchAtLoginAvailable: boolean
  /** The most recently opened first, at most tuning.settingsWindow.knownAppsShown. */
  knownApps: KnownAppView[]
  /** How many apps are known in all (more than knownApps.length when the list was cut short). */
  knownAppsTotal: number
  version: string
  /** Filled in by the settings window (the last change's notice); null: nothing to say. */
  notice: SettingsNotice | null
}

/** What the app provides; the settings window adds the notice. */
export type SettingsAppView = Omit<SettingsView, 'notice'>

/** The modes part of the view from ModeState.settings. */
export function modesView(s: ModeSettings): SettingsModesView {
  return {
    mode: s.mode,
    activeSpotId: s.activeHangoutId,
    defaultHomeId: s.defaultHomeId,
    spots: s.hangouts.map((h: HangoutSpot) => ({ id: h.id, name: h.name, kind: h.kind, appName: h.kind === 'app' ? h.appName : null })),
  }
}

/** 'YYYY-MM-DD' of an ISO time in local time; null when it isn't a time. */
export function localDay(iso: string): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The known apps list (§16: knownBundleIds must be listed in Privacy): from knownBundleIds (bundle ID → last opened,
 * ISO) and the app names main knows, the most recently opened first, at most tuning.settingsWindow.knownAppsShown.
 */
export function knownAppsView(
  known: Readonly<Record<string, string>>,
  nameOf: (bundleId: string) => string | null,
): { knownApps: KnownAppView[]; knownAppsTotal: number } {
  const entries = Object.entries(known)
    .map(([bundleId, iso]) => ({ bundleId, t: Date.parse(iso), day: localDay(iso) }))
    .filter((e): e is { bundleId: string; t: number; day: string } => e.day !== null)
    .sort((a, b) => b.t - a.t || a.bundleId.localeCompare(b.bundleId))
  return {
    knownApps: entries
      .slice(0, tuning.settingsWindow.knownAppsShown)
      .map((e) => ({ bundleId: e.bundleId, name: nameOf(e.bundleId), lastOpenedDay: e.day })),
    knownAppsTotal: Object.keys(known).length,
  }
}

// ───────────────────────────── changes ─────────────────────────────

/** settings:change — page → main, one change per message. */
export type SettingsChange =
  // Pet
  | { kind: 'name'; name: string }
  | { kind: 'palette'; paletteId: PaletteId }
  | { kind: 'size'; size: PetSize }
  /** Put the pet back at its default home. */
  | { kind: 'resetPosition' }
  // Behavior
  /** The mode Bitbot is in and starts in (see the header); Hangout names its spot. */
  | { kind: 'defaultMode'; mode: 'roam' | 'stay' }
  | { kind: 'defaultMode'; mode: 'hangout'; spotId: string }
  /** 0..1 */
  | { kind: 'restlessness'; value: number }
  | { kind: 'renameSpot'; id: string; name: string }
  | { kind: 'deleteSpot'; id: string }
  /** A screen spot, or null: the middle of the Dock. */
  | { kind: 'setDefaultHome'; id: string | null }
  | { kind: 'hideInFullscreen'; on: boolean }
  // Controls
  /** A canonical accelerator (normalizeAccelerator). */
  | { kind: 'hotkey'; action: HotkeyAction; accelerator: string }
  | { kind: 'resetHotkey'; action: HotkeyAction }
  /**
   * The page records a hotkey (on) or stopped (off): main pauses Bitbot's own hotkeys meanwhile, so pressing one of
   * them (or the combination being replaced) reaches the recorder instead of running the action.
   */
  | { kind: 'recordingHotkey'; on: boolean }
  | { kind: 'altCmdClickSend'; on: boolean }
  // Privacy
  /** "Turn on…": the system prompt and/or System Settings' Input Monitoring pane. */
  | { kind: 'requestInputAccess' }
  /** After the page's own confirm step. */
  | { kind: 'eraseAllData'; confirmed: true }
  // General
  | { kind: 'launchAtLogin'; on: boolean }

export type SettingsChangeKind = SettingsChange['kind']

/** A hangout spot's id as main makes them ("spot-3"), within reason for ones loaded from a save. */
const SPOT_ID_MAX = 64

/** A valid hangout spot name (trimmed, 1–tuning.settingsWindow.spotNameMax characters, no control characters), or null. */
export function cleanSpotName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return name.length >= 1 && [...name].length <= tuning.settingsWindow.spotNameMax ? name : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Exactly these fields (plus 'kind'), no others. */
function hasFields(v: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(v)
  return keys.length === fields.length + 1 && fields.every((f) => Object.hasOwn(v, f))
}

function isSpotId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SPOT_ID_MAX
}

function isHotkeyAction(value: unknown): value is HotkeyAction {
  return typeof value === 'string' && (HOTKEY_ACTIONS as readonly string[]).includes(value)
}

const isBool = (value: unknown): value is boolean => typeof value === 'boolean'

/** Strict: the exact shape of one SettingsChange, values in range, names already clean. */
export function isSettingsChange(value: unknown): value is SettingsChange {
  if (!isRecord(value)) return false
  const v = value
  switch (v['kind']) {
    case 'name':
      return hasFields(v, ['name']) && typeof v['name'] === 'string' && cleanPetName(v['name']) === v['name']
    case 'palette':
      return hasFields(v, ['paletteId']) && isPaletteId(v['paletteId'])
    case 'size':
      return hasFields(v, ['size']) && isPetSize(v['size'])
    case 'resetPosition':
    case 'requestInputAccess':
      return hasFields(v, [])
    case 'defaultMode':
      if (v['mode'] === 'hangout') return hasFields(v, ['mode', 'spotId']) && isSpotId(v['spotId'])
      return hasFields(v, ['mode']) && (v['mode'] === 'roam' || v['mode'] === 'stay')
    case 'restlessness': {
      const x = v['value']
      return hasFields(v, ['value']) && typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1
    }
    case 'renameSpot':
      return hasFields(v, ['id', 'name']) && isSpotId(v['id']) && typeof v['name'] === 'string' && cleanSpotName(v['name']) === v['name']
    case 'deleteSpot':
      return hasFields(v, ['id']) && isSpotId(v['id'])
    case 'setDefaultHome':
      return hasFields(v, ['id']) && (v['id'] === null || isSpotId(v['id']))
    case 'hideInFullscreen':
    case 'altCmdClickSend':
    case 'launchAtLogin':
    case 'recordingHotkey':
      return hasFields(v, ['on']) && isBool(v['on'])
    case 'hotkey':
      return hasFields(v, ['action', 'accelerator']) && isHotkeyAction(v['action']) && normalizeAccelerator(v['accelerator']) === v['accelerator']
    case 'resetHotkey':
      return hasFields(v, ['action']) && isHotkeyAction(v['action'])
    case 'eraseAllData':
      return hasFields(v, ['confirmed']) && v['confirmed'] === true
    default:
      return false
  }
}

// ───────────────────────────── view validation (the page checks what it is sent) ─────────────────────────────

function isAppSettings(value: unknown): value is AppSettings {
  if (!isRecord(value)) return false
  const hotkeys = value['hotkeys']
  const r = value['restlessness']
  return (
    isRecord(hotkeys) &&
    HOTKEY_ACTIONS.every((a) => typeof hotkeys[a] === 'string') &&
    isBool(value['altCmdClickSend']) &&
    isBool(value['hideInFullscreen']) &&
    typeof r === 'number' &&
    r >= 0 &&
    r <= 1 &&
    isBool(value['launchAtLogin']) &&
    isBool(value['sound'])
  )
}

function isSpotView(value: unknown): value is SettingsSpotView {
  return (
    isRecord(value) &&
    isSpotId(value['id']) &&
    typeof value['name'] === 'string' &&
    (value['kind'] === 'screen' || value['kind'] === 'app') &&
    (value['appName'] === null || typeof value['appName'] === 'string')
  )
}

function isModesView(value: unknown): value is SettingsModesView {
  return (
    isRecord(value) &&
    isPetMode(value['mode']) &&
    (value['activeSpotId'] === null || isSpotId(value['activeSpotId'])) &&
    (value['defaultHomeId'] === null || isSpotId(value['defaultHomeId'])) &&
    Array.isArray(value['spots']) &&
    value['spots'].every(isSpotView)
  )
}

function isKnownApp(value: unknown): value is KnownAppView {
  return (
    isRecord(value) &&
    typeof value['bundleId'] === 'string' &&
    (value['name'] === null || typeof value['name'] === 'string') &&
    typeof value['lastOpenedDay'] === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value['lastOpenedDay'])
  )
}

function isNotice(value: unknown): value is SettingsNotice {
  return isRecord(value) && (value['action'] === null || isHotkeyAction(value['action'])) && typeof value['text'] === 'string'
}

export function isSettingsView(value: unknown): value is SettingsView {
  if (!isRecord(value)) return false
  const hotkeys = value['hotkeys']
  const total = value['knownAppsTotal']
  return (
    isPetIdentity(value['identity']) &&
    isAppSettings(value['settings']) &&
    isModesView(value['modes']) &&
    isRecord(hotkeys) &&
    HOTKEY_ACTIONS.every((a) => {
      const h = hotkeys[a]
      return isRecord(h) && typeof h['accelerator'] === 'string' && isBool(h['registered'])
    }) &&
    (value['inputMonitoring'] === 'granted' || value['inputMonitoring'] === 'off' || value['inputMonitoring'] === 'unknown') &&
    isBool(value['launchAtLoginAvailable']) &&
    Array.isArray(value['knownApps']) &&
    value['knownApps'].every(isKnownApp) &&
    typeof total === 'number' &&
    Number.isInteger(total) &&
    total >= 0 &&
    typeof value['version'] === 'string' &&
    (value['notice'] === null || isNotice(value['notice']))
  )
}

/** Views are plain JSON: equal when their JSON is (the window pushes only a changed view). */
export function sameSettingsView(a: SettingsView, b: SettingsView): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
