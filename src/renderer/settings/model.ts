// The settings page's pure parts (BITBOT_SPEC.md §15.4; the page is ./main.ts, messages in
// src/shared/settingsProtocol.ts): its sections, the words it shows for a view (hotkey rows, spot rows, the known apps,
// the permission line), the Privacy section's plain lists (§2, §7.1), and the hotkey recorder's step. No DOM, so it is
// unit-tested in test/settings.test.ts.

import { acceleratorFromKey, formatAccelerator, sameAccelerator, type KeyLike, type KeyResult } from '../../shared/accelerator'
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, type HotkeyAction } from '../../shared/hotkeys'
import { HOTKEY_LABELS, type InputMonitoringStatus, type SettingsSection, type SettingsView } from '../../shared/settingsProtocol'

/** The sidebar's labels (SETTINGS_SECTIONS order). */
export const SECTION_LABELS: Readonly<Record<SettingsSection, string>> = {
  pet: 'Pet',
  behavior: 'Behavior',
  controls: 'Controls',
  privacy: 'Privacy',
  general: 'General',
  about: 'About',
}

export interface HotkeyRow {
  action: HotkeyAction
  label: string
  /** "⌥⌘B" */
  keys: string
  registered: boolean
  isDefault: boolean
  /** "Reset" shows the default it goes back to: "⌥⌘B". */
  defaultKeys: string
  /** Shown under the row while the hotkey isn't registered (§10.5 "surface that in settings"); null: it works. */
  problem: string | null
}

export function hotkeyRows(view: SettingsView): HotkeyRow[] {
  return HOTKEY_ACTIONS.map((action) => {
    const h = view.hotkeys[action]
    const keys = formatAccelerator(h.accelerator)
    return {
      action,
      label: HOTKEY_LABELS[action],
      keys,
      registered: h.registered,
      isDefault: sameAccelerator(h.accelerator, DEFAULT_HOTKEYS[action]),
      defaultKeys: formatAccelerator(DEFAULT_HOTKEYS[action]),
      problem: h.registered ? null : `Not working: another app (or macOS) uses ${keys}. Record a different combination.`,
    }
  })
}

/** What one keydown does while recording: Esc cancels, otherwise acceleratorFromKey. */
export function recorderStep(e: KeyLike): KeyResult | { kind: 'cancel' } {
  if (e.code === 'Escape' || e.key === 'Escape') return { kind: 'cancel' }
  return acceleratorFromKey(e)
}

export interface SpotRow {
  id: string
  name: string
  /** "Screen spot" / "Follows the Notes window" */
  detail: string
  /** The spot Bitbot hangs out at now. */
  active: boolean
  isDefaultHome: boolean
  /** Only screen spots can be the default home (an app spot falls back to it, §10.3). */
  canBeDefaultHome: boolean
}

export function spotRows(view: SettingsView): SpotRow[] {
  const m = view.modes
  return m.spots.map((s) => ({
    id: s.id,
    name: s.name,
    detail: s.kind === 'app' ? `Follows the ${s.appName ?? 'app’s'} window` : 'Screen spot',
    active: m.mode === 'hangout' && s.id === m.activeSpotId,
    isDefaultHome: s.kind === 'screen' && s.id === m.defaultHomeId,
    canBeDefaultHome: s.kind === 'screen',
  }))
}

/** The default home's name: its spot's, or the built-in one. */
export function defaultHomeName(view: SettingsView): string {
  const m = view.modes
  return m.spots.find((s) => s.id === m.defaultHomeId && s.kind === 'screen')?.name ?? DOCK_HOME
}

export const DOCK_HOME = 'Middle of the Dock'

export interface PermissionLine {
  text: string
  tone: 'ok' | 'off' | 'unknown'
  /** "Turn on…" is offered. */
  canTurnOn: boolean
}

export function permissionLine(status: InputMonitoringStatus): PermissionLine {
  switch (status) {
    case 'granted':
      return { text: 'Input Monitoring is on: Bitbot counts keys, clicks and scrolling.', tone: 'ok', canTurnOn: false }
    case 'off':
      return {
        text: 'Input Monitoring is off: keys, clicks and scrolling aren’t counted, and ⌥⌘-click does nothing. Everything else works.',
        tone: 'off',
        canTurnOn: true,
      }
    case 'unknown':
      return { text: 'Checking Input Monitoring…', tone: 'unknown', canTurnOn: false }
  }
}

/** §2, §7.1: what Bitbot counts. */
export const PRIVACY_COUNTED: readonly string[] = [
  'How many keys you press (not which ones)',
  'How many clicks you make',
  'How much you scroll (in ticks)',
  'How far the mouse travels',
  'Which apps you open or switch to (their names and bundle IDs, listed below)',
  'When your Mac wakes up, unlocks or goes idle',
]

/** §2: what it never sees. */
export const PRIVACY_NEVER: readonly string[] = [
  'What you type, or which keys you press',
  'What you click on',
  'Window titles, document names or web addresses',
  'Screenshots or what is on your screen',
]

export const PRIVACY_NETWORK = 'Bitbot never connects to the internet. Everything stays on this Mac.'

/** A known app's "last opened" for the list: "Today", "Yesterday", or the date by `format` ('YYYY-MM-DD' days). */
export function dayLabel(day: string, today: string, format: (day: string) => string): string {
  if (day === today) return 'Today'
  const t = Date.parse(`${today}T12:00:00`)
  const d = Date.parse(`${day}T12:00:00`)
  if (Number.isFinite(t) && Number.isFinite(d) && Math.round((t - d) / 86_400_000) === 1) return 'Yesterday'
  return format(day)
}

/** "and 12 more" under a cut-short known apps list; null when it shows them all. */
export function moreAppsText(view: SettingsView): string | null {
  const more = view.knownAppsTotal - view.knownApps.length
  return more > 0 ? `and ${more} more` : null
}
