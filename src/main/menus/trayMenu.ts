// The tray (menu-bar) menu: the M5 subset of BITBOT_SPEC.md §15.2, in its order (a disabled "Bitbot" header and
// today's earned currencies, Come here, Go home, Hide / Show Bitbot, the Input Monitoring reminder while it is off,
// Developer… in dev builds, Quit; mood, modes and settings arrive with later milestones). Pure: a template for
// Menu.buildFromTemplate (type-only Electron import), rebuilt whenever the state changes.

import type { MenuItemConstructorOptions } from 'electron'
import { CURRENCIES } from '../../shared/economy'
import type { Currency } from '../../shared/types'

export interface TrayMenuState {
  /** The pet is shown (not hidden by the user). */
  visible: boolean
  /**
   * The global shortcuts that registered (Hotkeys.accelerator); null: not shown. A shown accelerator is also a live key
   * equivalent while the menu is open (macOS), harmless because the global shortcut owns the key anyway.
   */
  toggleAccelerator: string | null
  comeHereAccelerator?: string | null
  goHomeAccelerator?: string | null
  /** Today's earned totals (EconomySnapshot currencies[c].earned); null or absent: no "Today:" line. */
  today?: Record<Currency, number> | null
  /** Input Monitoring is not granted (§7.1): the menu shows the gentle reminder (when given turnOnInputMonitoring). */
  inputMonitoringOff?: boolean
}

export interface TrayMenuActions {
  toggleVisible(): void
  /** §10.4 Come here / Go home (M4). Without them the menu has neither item. */
  comeHere?(): void
  goHome?(): void
  /** "Input Monitoring is off — Turn on…" (§7.1, §15.2): the way to grant it. Without it the reminder is not shown. */
  turnOnInputMonitoring?(): void
  /** Opens the developer panel (§14.1). Given only in dev builds: without it the menu has no "Developer…". */
  developer?(): void
  quit(): void
}

/** The "Today:" icons (§15.2). */
const TODAY_ICONS: Record<Currency, string> = { crumbs: '🍞', pellets: '⚪', treats: '🎁', mileage: '🧭', sparks: '✨' }

/**
 * Absorbs float error in a running sum (ten clicks of 0.1 = 0.9999999999999999) so it doesn't show one less than it is;
 * far below the smallest payout, so a total never shows more than was earned.
 */
const FLOAT_SLACK = 1e-9

/** A whole number with thousands separators ("1,240"), rounded down so it never runs ahead of what was earned. */
export function formatWhole(value: number): string {
  const whole = Number.isFinite(value) && value > 0 ? Math.floor(value + FLOAT_SLACK) : 0
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The tray's "Today:" line (§15.2), the five currencies in CURRENCIES order: "Today: 🍞 1,240  ⚪ 310  🎁 6  🧭 22  ✨ 3". */
export function formatToday(today: Record<Currency, number>): string {
  return `Today: ${CURRENCIES.map((c) => `${TODAY_ICONS[c]} ${formatWhole(today[c])}`).join('  ')}`
}

/** An item with its shortcut shown only when that shortcut registered. */
function item(label: string, click: () => void, accelerator: string | null | undefined): MenuItemConstructorOptions {
  const out: MenuItemConstructorOptions = { label, click }
  if (accelerator) out.accelerator = accelerator
  return out
}

export function trayMenuTemplate(state: TrayMenuState, actions: TrayMenuActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [{ label: 'Bitbot', enabled: false }]
  if (state.today) items.push({ label: formatToday(state.today), enabled: false })
  items.push({ type: 'separator' })
  const { comeHere, goHome, turnOnInputMonitoring } = actions
  if (comeHere) items.push(item('Come here', () => comeHere(), state.comeHereAccelerator))
  if (goHome) items.push(item('Go home', () => goHome(), state.goHomeAccelerator))
  items.push(item(state.visible ? 'Hide Bitbot' : 'Show Bitbot', () => actions.toggleVisible(), state.toggleAccelerator))
  items.push({ type: 'separator' })
  if (state.inputMonitoringOff === true && turnOnInputMonitoring) {
    items.push({ label: 'Input Monitoring is off — Turn on…', click: () => turnOnInputMonitoring() })
  }
  if (actions.developer) items.push({ label: 'Developer…', click: () => actions.developer?.() })
  items.push({ label: 'Quit Bitbot', click: () => actions.quit() })
  return items
}
