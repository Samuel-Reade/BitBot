// The tray (menu-bar) menu: the M1 subset of BITBOT_SPEC.md §15.2 (a disabled "Bitbot" header, Hide / Show Bitbot,
// Quit; mood, today's currencies, modes, Come here / Go home, settings and the developer panel arrive with later
// milestones). Pure: a template for Menu.buildFromTemplate (type-only Electron import), rebuilt whenever the state
// changes.

import type { MenuItemConstructorOptions } from 'electron'

export interface TrayMenuState {
  /** The pet is shown (not hidden by the user). */
  visible: boolean
  /** The show/hide global shortcut when it registered (Hotkeys.accelerator('toggleVisible')); null: no shortcut shown. */
  toggleAccelerator: string | null
}

export interface TrayMenuActions {
  toggleVisible(): void
  quit(): void
}

export function trayMenuTemplate(state: TrayMenuState, actions: TrayMenuActions): MenuItemConstructorOptions[] {
  const toggle: MenuItemConstructorOptions = {
    label: state.visible ? 'Hide Bitbot' : 'Show Bitbot',
    click: () => actions.toggleVisible(),
  }
  // A menu item's accelerator can't be display-only on macOS (MenuItem registerAccelerator is Linux/Windows only): a
  // shown accelerator is also a live key equivalent while the menu is open. Harmless, because the global shortcut owns
  // ⌥⌘B anyway; so it is shown only when that shortcut registered, never advertising a key that does nothing.
  if (state.toggleAccelerator) toggle.accelerator = state.toggleAccelerator
  return [
    { label: 'Bitbot', enabled: false },
    toggle,
    { type: 'separator' },
    { label: 'Quit Bitbot', click: () => actions.quit() },
  ]
}
