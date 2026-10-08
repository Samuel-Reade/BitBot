// The tray (menu-bar) menu: the M4 subset of BITBOT_SPEC.md §15.2, in its order (a disabled "Bitbot" header, Come here,
// Go home, Hide / Show Bitbot, Developer… in dev builds, Quit; mood, today's currencies, modes, the Input Monitoring
// reminder and settings arrive with later milestones). Pure: a template for Menu.buildFromTemplate (type-only Electron import), rebuilt whenever the state
// changes.

import type { MenuItemConstructorOptions } from 'electron'

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
}

export interface TrayMenuActions {
  toggleVisible(): void
  /** §10.4 Come here / Go home (M4). Without them the menu has neither item. */
  comeHere?(): void
  goHome?(): void
  /** Opens the developer panel (§14.1). Given only in dev builds: without it the menu has no "Developer…". */
  developer?(): void
  quit(): void
}

/** An item with its shortcut shown only when that shortcut registered. */
function item(label: string, click: () => void, accelerator: string | null | undefined): MenuItemConstructorOptions {
  const out: MenuItemConstructorOptions = { label, click }
  if (accelerator) out.accelerator = accelerator
  return out
}

export function trayMenuTemplate(state: TrayMenuState, actions: TrayMenuActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [{ label: 'Bitbot', enabled: false }, { type: 'separator' }]
  const { comeHere, goHome } = actions
  if (comeHere) items.push(item('Come here', () => comeHere(), state.comeHereAccelerator))
  if (goHome) items.push(item('Go home', () => goHome(), state.goHomeAccelerator))
  items.push(item(state.visible ? 'Hide Bitbot' : 'Show Bitbot', () => actions.toggleVisible(), state.toggleAccelerator))
  items.push({ type: 'separator' })
  if (actions.developer) items.push({ label: 'Developer…', click: () => actions.developer?.() })
  items.push({ label: 'Quit Bitbot', click: () => actions.quit() })
  return items
}
