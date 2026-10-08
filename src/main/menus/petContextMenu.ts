// The pet's right-click / control-click menu: the M1 subset of BITBOT_SPEC.md §15.3, only "Hide" (Pet, Stay here /
// Roam, Hang out, Go home and Settings… arrive with M4, M7 and M8). Pure: a template for Menu.buildFromTemplate
// (type-only Electron import); the glue pops it up over the grab area (PetInteractionDeps.popupMenu).

import type { MenuItemConstructorOptions } from 'electron'

export interface PetContextMenuActions {
  hide(): void
}

export function petContextMenuTemplate(actions: PetContextMenuActions): MenuItemConstructorOptions[] {
  return [{ label: 'Hide', click: () => actions.hide() }]
}
