// The pet's right-click / control-click menu: the M7 subset of BITBOT_SPEC.md §15.3, in its order: Pet, Stay here /
// Roam, Hang out here, Hang out on <App> (when it stands on an app's window), Go home, Hide, Settings… (M8, when
// given). On a window, "Hang out here" reads "Hang out here (this spot)" (§10.3). Pure: a template for
// Menu.buildFromTemplate (type-only Electron import); the glue pops it up over the grab area (PetInteractionDeps.popupMenu).

import type { MenuItemConstructorOptions } from 'electron'
import type { PetMode } from '../../shared/modes'

export interface PetContextMenuState {
  mode: PetMode
  /** The name of the app whose window the pet stands on; null: not on an app's window. */
  onApp: string | null
}

export interface PetContextMenuActions {
  /** Petting (§10.4), as a click on the pet. */
  pet(): void
  stayHere(): void
  roam(): void
  hangOutHere(): void
  hangOutOnApp(): void
  goHome(): void
  hide(): void
  /** Opens the settings window (§15.3 "Settings…", M8). Without it the menu has no "Settings…". */
  settings?(): void
}

export function petContextMenuTemplate(state: PetContextMenuState, actions: PetContextMenuActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: 'Pet', click: () => actions.pet() },
    state.mode === 'stay' ? { label: 'Roam', click: () => actions.roam() } : { label: 'Stay here', click: () => actions.stayHere() },
    { label: state.onApp ? 'Hang out here (this spot)' : 'Hang out here', click: () => actions.hangOutHere() },
  ]
  if (state.onApp) items.push({ label: `Hang out on ${state.onApp}`, click: () => actions.hangOutOnApp() })
  items.push({ label: 'Go home', click: () => actions.goHome() }, { type: 'separator' }, { label: 'Hide', click: () => actions.hide() })
  if (actions.settings) items.push({ label: 'Settings…', click: () => actions.settings?.() })
  return items
}
