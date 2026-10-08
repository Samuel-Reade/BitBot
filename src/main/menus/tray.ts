// The menu-bar icon (BITBOT_SPEC.md §15.2): the procedural template image of the CRT silhouette (trayIcon.ts, so no
// image asset ships), the tooltip "Bitbot", and the menu (trayMenu.ts), rebuilt whenever the pet is shown or hidden
// so it offers the right one of "Hide Bitbot" / "Show Bitbot". The menu works with another app frontmost: opening a
// status item's menu doesn't activate Bitbot.

import { Menu, nativeImage, Tray, type NativeImage } from 'electron'
import { alphaToBgra, TRAY_ICON_PT, trayIconAlpha } from './trayIcon'
import type { HotkeyAction } from '../../shared/hotkeys'
import type { Currency } from '../../shared/types'
import { formatToday, trayMenuTemplate, type TrayMenuActions } from './trayMenu'

/** The template image at 1× and 2× (macOS tints a template for the menu bar's appearance; only its alpha counts). */
export function trayImage(): NativeImage {
  const image = nativeImage.createEmpty()
  for (const scaleFactor of [1, 2]) {
    const size = TRAY_ICON_PT * scaleFactor
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: Buffer.from(alphaToBgra(trayIconAlpha(scaleFactor))) })
  }
  image.setTemplateImage(true)
  return image
}

export interface BitbotTrayOptions {
  actions: TrayMenuActions
  /** A global shortcut when it registered (Hotkeys.accelerator), shown next to its item; null: none. */
  accelerator(action: HotkeyAction): string | null
  /** Today's earned totals for the "Today:" line (§15.2); null: none yet. */
  today(): Record<Currency, number> | null
  /** Input Monitoring is not granted: the gentle reminder line (§7.1). */
  inputMonitoringOff(): boolean
}

export class BitbotTray {
  private tray: Tray | null = null
  private visible = true
  /** What the menu shows besides `visible` (whole numbers): rebuilt only when it changes. */
  private shownKey = ''

  constructor(private readonly opts: BitbotTrayOptions) {}

  get created(): boolean {
    return this.tray !== null && !this.tray.isDestroyed()
  }

  /** Creates the icon (after app ready). `visible`: whether the pet is shown, for the menu. Idempotent. */
  create(visible: boolean): void {
    if (this.created) return
    const tray = new Tray(trayImage())
    tray.setToolTip('Bitbot')
    this.tray = tray
    this.update(visible)
  }

  /** Rebuilds the menu for the pet shown (`visible`) or hidden. */
  update(visible: boolean): void {
    this.visible = visible
    this.rebuild(true)
  }

  /** Rebuilds the menu only if what it shows changed (today's whole numbers, the reminder): call it as often as you like. */
  refresh(): void {
    this.rebuild(false)
  }

  private rebuild(force: boolean): void {
    const tray = this.tray
    if (!tray || tray.isDestroyed()) return
    const today = this.opts.today()
    const inputMonitoringOff = this.opts.inputMonitoringOff()
    const key = `${this.visible}|${inputMonitoringOff}|${today ? formatToday(today) : ''}`
    if (!force && key === this.shownKey) return
    this.shownKey = key
    const a = (action: HotkeyAction): string | null => this.opts.accelerator(action)
    const template = trayMenuTemplate(
      {
        visible: this.visible,
        toggleAccelerator: a('toggleVisible'),
        comeHereAccelerator: a('comeHere'),
        goHomeAccelerator: a('goHome'),
        today,
        inputMonitoringOff,
      },
      this.opts.actions,
    )
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  destroy(): void {
    const tray = this.tray
    this.tray = null
    if (tray && !tray.isDestroyed()) tray.destroy()
  }
}
