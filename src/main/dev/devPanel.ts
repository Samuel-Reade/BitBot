// The developer panel (BITBOT_SPEC.md §14.1; dev builds only, opened from tray → "Developer…"): its window, its page
// (src/renderer/devpanel/) and its IPC (messages in src/shared/devPanel.ts). Milestone 2's panel forces the pet's state,
// mood, dust, facing, face and idle style, and shows what the pet does and what the overlay renders.
// - open() creates the window, or raises it if it exists. Only ever called for the user's own click: it is the one
//   Bitbot window that may take focus (§2), and it is never shown on its own.
// - debug:panel-get (invoke) answers the status; debug:panel-set changes the overrides. Both are accepted only from
//   the panel's own page; anything else is ignored and logged (throttled).
// - The status is pushed (debug:panel-status) whenever it changed (the app calls refresh() on every simulation wake
//   and after anything it shows), and every tuning.dev.panel.statusIntervalMs while the panel is open, with the
//   overlay's renders and frames per second over that period. The timer stops when the panel closes.
//
// Construct it only in dev builds: a packaged build registers no handler, so the channels don't exist there.

import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isDevPanelSet, type DevPanelSet, type DevPanelStatus } from '../../shared/devPanel'
import { IPC } from '../../shared/ipc'
import type { OverlayStatsMsg } from '../../shared/petProtocol'
import { tuning } from '../../shared/tuning'
import { loadPage, preloadPath } from '../pages'
import { devPanelWindowOptions, RateMeter, sameDevPanelStatus, type DevPanelAppStatus } from './devPanelModel'

export interface DevPanelOptions {
  /** The app's part of the status, now. */
  status(): DevPanelAppStatus
  /** A validated debug:panel-set from the panel. */
  apply(set: DevPanelSet): void
  /** The overlay's counters (BitbotApp.requestOverlayStats); null if they don't come within timeoutMs. */
  requestOverlayStats(timeoutMs: number): Promise<OverlayStatsMsg | null>
  log(line: string): void
  /** Throttled: for problems that may repeat (messages from the wrong sender, malformed sets). */
  warn(key: string, line: string): void
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class DevPanel {
  private win: BrowserWindow | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly meter = new RateMeter()
  private statsPending = false
  /** The status last pushed to the current page (null: none yet). */
  private pushed: DevPanelStatus | null = null
  private destroyed = false

  constructor(private readonly opts: DevPanelOptions) {
    this.installIpc()
  }

  get isOpen(): boolean {
    return this.window !== null
  }

  /** The user asked for the panel: creates it (shown once its page is ready), or shows and focuses the open one. */
  open(): void {
    if (this.destroyed) return
    const existing = this.window
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    const win = new BrowserWindow(devPanelWindowOptions(preloadPath()))
    this.win = win
    this.pushed = null
    this.meter.reset()
    win.once('ready-to-show', () => {
      if (win !== this.win || win.isDestroyed()) return
      win.show()
      win.focus()
    })
    win.webContents.on('did-start-navigation', (details) => {
      // A reload: the new page asks for the status itself; push again from scratch.
      if (details.isMainFrame && !details.isSameDocument) this.pushed = null
    })
    win.on('closed', () => {
      if (win !== this.win) return
      this.win = null
      this.stopTimer()
      this.meter.reset()
      this.pushed = null
    })
    this.startTimer()
    loadPage(win, 'devPanel').catch((err: unknown) => {
      if (win === this.win) this.opts.log(`[bitbot] dev panel: its page did not load (${errorText(err)})`)
    })
    this.opts.log('[bitbot] dev panel opened')
  }

  /** Something the status shows may have changed: pushed if it did (no-op while the panel is closed). */
  refresh(): void {
    if (!this.window) return
    this.push(false)
  }

  /** Quit: closes the panel; it can't be opened again. */
  destroy(): void {
    this.destroyed = true
    this.stopTimer()
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  private get window(): BrowserWindow | null {
    const win = this.win
    return win && !win.isDestroyed() ? win : null
  }

  private status(): DevPanelStatus {
    return { ...this.opts.status(), ...this.meter.rates }
  }

  /** Pushes the status to the panel's page; unless `always`, only when it differs from the last one pushed. */
  private push(always: boolean): void {
    const win = this.window
    if (!win) return
    const status = this.status()
    if (!always && this.pushed !== null && sameDevPanelStatus(this.pushed, status)) return
    try {
      const wc = win.webContents
      if (wc.isDestroyed() || wc.isCrashed()) return
      wc.send(IPC.debugPanelStatus, status)
      this.pushed = status
    } catch {
      // Closing: the next open starts afresh.
    }
  }

  private startTimer(): void {
    this.stopTimer()
    const intervalMs = tuning.dev.panel.statusIntervalMs
    this.timer = setInterval(() => this.periodic(intervalMs), intervalMs)
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** Every status period: a fresh reading of the overlay's counters, then the status, pushed whether or not it changed. */
  private periodic(intervalMs: number): void {
    if (!this.window || this.statsPending) return
    this.statsPending = true
    this.opts
      .requestOverlayStats(intervalMs)
      .then(
        (stats) => this.meter.update(stats),
        () => this.meter.update(null),
      )
      .finally(() => {
        this.statsPending = false
        this.push(true)
      })
  }

  private installIpc(): void {
    ipcMain.handle(IPC.debugPanelGet, (event) => {
      if (!this.fromPanel(event)) {
        this.opts.warn(`${IPC.debugPanelGet} sender`, `[bitbot] dev panel: ignored ${IPC.debugPanelGet} from another page`)
        throw new Error(`${IPC.debugPanelGet} from an unknown sender`)
      }
      const status = this.status()
      this.pushed = status
      return status
    })
    ipcMain.on(IPC.debugPanelSet, (event: IpcMainEvent, payload: unknown) => {
      if (!this.fromPanel(event)) {
        this.opts.warn(`${IPC.debugPanelSet} sender`, `[bitbot] dev panel: ignored ${IPC.debugPanelSet} from another page`)
        return
      }
      if (!isDevPanelSet(payload)) {
        this.opts.warn(`malformed ${IPC.debugPanelSet}`, `[bitbot] dev panel: ignored a malformed ${IPC.debugPanelSet}`)
        return
      }
      try {
        this.opts.apply(payload)
      } catch (err) {
        this.opts.warn(`${IPC.debugPanelSet} handler`, `[bitbot] ERROR handling ${IPC.debugPanelSet}: ${errorText(err)}`)
      }
      this.push(false)
    })
  }

  private fromPanel(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const win = this.window
    return win !== null && event.sender.id === win.webContents.id
  }
}
