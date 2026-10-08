// The settings window (BITBOT_SPEC.md §15.4; opened from tray → "Settings…" and the pet's menu → "Settings…"): its
// window, its page (src/renderer/settings/) and its IPC (messages in src/shared/settingsProtocol.ts). Built like the dev
// panel (src/main/dev/devPanel.ts):
// - open(section?) creates the window, or restores, shows and focuses the open one, at that section (Pet unless asked:
//   "Manage spots…" opens Behavior, the Input Monitoring reminder could open Privacy). Only ever called for the user's
//   own click: like the dev panel it may take focus then (§2), and it is never shown on its own.
// - settings:get (invoke) answers the view; settings:change carries one SettingsChange. Both are accepted only from the
//   window's own page; anything else (another page, a malformed change) is ignored and logged (throttled).
// - Main is the source of truth: after a change, and whenever the app calls refresh() (anything the view shows may
//   have changed), the view is pushed (settings:view) if it differs from the last one pushed. The page re-renders
//   from it.
// - apply() may return a notice (a hotkey another app owns); the window keeps it in the view until the next change or
//   until the window closes.
// The Electron parts it uses (ipcMain, BrowserWindow, loading the page) are a SettingsWindowPlatform, Electron's by
// default, so the sender check and the pushes are unit-tested with fakes (test/settings.test.ts).

import { BrowserWindow, ipcMain, type BrowserWindowConstructorOptions } from 'electron'
import { IPC } from '../../shared/ipc'
import {
  isSettingsChange,
  sameSettingsView,
  type SettingsAppView,
  type SettingsChange,
  type SettingsNotice,
  type SettingsSection,
  type SettingsView,
} from '../../shared/settingsProtocol'
import { tuning } from '../../shared/tuning'
import { loadPage, preloadPath } from '../pages'

export interface SettingsWindowDeps {
  /** The app's part of the view, now. */
  view(): SettingsAppView
  /** A validated settings:change from the page. May return a notice for the page (see the header). */
  apply(change: SettingsChange): SettingsNotice | null | void
  log(line: string): void
  /** Throttled: for problems that may repeat (messages from the wrong sender, malformed changes). */
  warn(key: string, line: string): void
}

/** What the window class needs of a BrowserWindow. */
export interface SettingsBrowserWindow {
  readonly webContents: {
    readonly id: number
    send(channel: string, payload: unknown): void
    isDestroyed(): boolean
    isCrashed(): boolean
    on(event: 'did-start-navigation', listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown
  }
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  destroy(): void
  once(event: 'ready-to-show', listener: () => void): unknown
  on(event: 'closed', listener: () => void): unknown
}

export interface SettingsIpcEvent {
  sender: { id: number }
}

/** The Electron parts the window uses (Electron's by default). */
export interface SettingsWindowPlatform {
  handle(channel: string, listener: (event: SettingsIpcEvent, payload: unknown) => unknown): void
  on(channel: string, listener: (event: SettingsIpcEvent, payload: unknown) => void): void
  createWindow(options: BrowserWindowConstructorOptions): SettingsBrowserWindow
  /** Loads the page, at `section` when given (?section=). */
  load(win: SettingsBrowserWindow, section?: SettingsSection): Promise<void>
  preloadPath(): string
}

function electronPlatform(): SettingsWindowPlatform {
  return {
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    on: (channel, listener) => ipcMain.on(channel, listener),
    createWindow: (options) => new BrowserWindow(options),
    load: (win, section) => loadPage(win as BrowserWindow, 'settings', section ? { section } : {}),
    preloadPath,
  }
}

/**
 * An ordinary, focusable window (the user opened it on purpose, §2), created hidden and shown once its page is ready;
 * it may grow but not shrink below tuning.settingsWindow's size. Same sandboxed preload as the other pages.
 */
export function settingsWindowOptions(preload: string): BrowserWindowConstructorOptions {
  const { width, height } = tuning.settingsWindow
  return {
    width,
    height,
    minWidth: width,
    minHeight: height,
    show: false,
    title: 'Bitbot Settings',
    fullscreenable: false,
    maximizable: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
    },
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class SettingsWindow {
  private win: SettingsBrowserWindow | null = null
  /** The view last pushed to the current page (null: none yet). */
  private pushed: SettingsView | null = null
  private notice: SettingsNotice | null = null
  private destroyed = false
  private readonly platform: SettingsWindowPlatform

  constructor(
    private readonly deps: SettingsWindowDeps,
    platform?: SettingsWindowPlatform,
  ) {
    this.platform = platform ?? electronPlatform()
    this.installIpc()
  }

  get isOpen(): boolean {
    return this.window !== null
  }

  /**
   * The user asked for settings: creates the window (shown once its page is ready), or shows and focuses the open one;
   * at `section` when given.
   */
  open(section?: SettingsSection): void {
    if (this.destroyed) return
    const existing = this.window
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      if (section) this.send(existing, IPC.settingsSection, section)
      return
    }
    const win = this.platform.createWindow(settingsWindowOptions(this.platform.preloadPath()))
    this.win = win
    this.pushed = null
    this.notice = null
    win.once('ready-to-show', () => {
      if (win !== this.win || win.isDestroyed()) return
      win.show()
      win.focus()
    })
    win.webContents.on('did-start-navigation', (details) => {
      // A reload: the new page asks for the view itself; push again from scratch.
      if (details.isMainFrame && !details.isSameDocument) this.pushed = null
    })
    win.on('closed', () => {
      if (win !== this.win) return
      this.win = null
      this.pushed = null
      this.notice = null
    })
    this.platform.load(win, section).catch((err: unknown) => {
      if (win === this.win) this.deps.log(`[bitbot] settings: its page did not load (${errorText(err)})`)
    })
    this.deps.log('[bitbot] settings opened')
  }

  /** Something the view shows may have changed: pushed if it did (no-op while the window is closed). */
  refresh(): void {
    if (this.window) this.push()
  }

  /** Quit (or erase and relaunch): closes the window; it can't be opened again. */
  destroy(): void {
    this.destroyed = true
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  private get window(): SettingsBrowserWindow | null {
    const win = this.win
    return win && !win.isDestroyed() ? win : null
  }

  private view(): SettingsView {
    return { ...this.deps.view(), notice: this.notice }
  }

  /** Pushes the view to the page when it differs from the last one pushed. */
  private push(): void {
    const win = this.window
    if (!win) return
    const view = this.view()
    if (this.pushed !== null && sameSettingsView(this.pushed, view)) return
    if (this.send(win, IPC.settingsView, view)) this.pushed = view
  }

  /** False if the page can't take it now (closing, crashed). */
  private send(win: SettingsBrowserWindow, channel: string, payload: unknown): boolean {
    try {
      const wc = win.webContents
      if (wc.isDestroyed() || wc.isCrashed()) return false
      wc.send(channel, payload)
      return true
    } catch {
      // Closing: the next open starts afresh.
      return false
    }
  }

  private installIpc(): void {
    this.platform.handle(IPC.settingsGet, (event) => {
      if (!this.fromPage(event)) {
        this.deps.warn(`${IPC.settingsGet} sender`, `[bitbot] settings: ignored ${IPC.settingsGet} from another page`)
        throw new Error(`${IPC.settingsGet} from an unknown sender`)
      }
      const view = this.view()
      this.pushed = view
      return view
    })
    this.platform.on(IPC.settingsChange, (event, payload) => {
      if (!this.fromPage(event)) {
        this.deps.warn(`${IPC.settingsChange} sender`, `[bitbot] settings: ignored ${IPC.settingsChange} from another page`)
        return
      }
      if (!isSettingsChange(payload)) {
        this.deps.warn(`malformed ${IPC.settingsChange}`, `[bitbot] settings: ignored a malformed ${IPC.settingsChange}`)
        return
      }
      this.notice = null
      try {
        this.notice = this.deps.apply(payload) ?? null
      } catch (err) {
        this.deps.warn(`${IPC.settingsChange} handler`, `[bitbot] ERROR handling ${IPC.settingsChange} (${payload.kind}): ${errorText(err)}`)
      }
      this.push()
    })
  }

  private fromPage(event: SettingsIpcEvent): boolean {
    const win = this.window
    return win !== null && event.sender.id === win.webContents.id
  }
}
