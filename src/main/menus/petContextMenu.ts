// The pet's right-click / control-click menu: the M4 subset of BITBOT_SPEC.md §15.3, in its order: Pet, Go home, Hide
// (Stay here / Roam, Hang out and Settings… arrive with M7 and M8). Pure: a template for Menu.buildFromTemplate
// (type-only Electron import); the glue pops it up over the grab area (PetInteractionDeps.popupMenu).

import type { MenuItemConstructorOptions } from 'electron'

export interface PetContextMenuActions {
  /** Petting (§10.4), as a click on the pet. */
  pet(): void
  goHome(): void
  hide(): void
}

export function petContextMenuTemplate(actions: PetContextMenuActions): MenuItemConstructorOptions[] {
  return [
    { label: 'Pet', click: () => actions.pet() },
    { label: 'Go home', click: () => actions.goHome() },
    { type: 'separator' },
    { label: 'Hide', click: () => actions.hide() },
  ]
}
