// The overlay window, its page and its IPC (docs/decisions/overlay.md "Decision"; messages in src/shared/petProtocol.ts).
// PetWindow owns the overlay BrowserWindow (made by the overlayWindow.ts factory, for the first window and every
// recreation), loads the pet page with its size and palette, answers each page load's pet:config with a new
// configuration (configSeq, a fresh grab-area name, the epoch, debug), allows exactly that grab area's window.open
// (replacing security.ts's deny-all for the overlay only), hands the grab area's window to ElectronHitWindow, tracks
// whether the pet is drawn for the current configSeq (DrawnGate), relays the overlay's messages (validated, and only
// from the current overlay) and reports the page's lifecycle to the app:
// - a cross-document main-frame navigation after the first load (a reload), a renderer crash, a hang, the window
//   closing, or no pet:ready within tuning.overlay.readyTimeoutMs: the page is gone (pageLost) until its next
//   pet:ready, and its grab area is destroyed (after a crash it is crashed but not destroyed);
// - a crash, a reported hang, a closed window or a missing ready also recreates the window after
//   tuning.overlay.recreateDelayMs, backing off up to recreateMaxDelayMs while it keeps failing (recreateDelayMs()).
//   A hang is only caught if Chromium reports it ('unresponsive'), and Chromium's hang monitor runs on input acks: the
//   overlay never takes input, so after its first pet:ready a silent hang is not detected (docs/decisions/overlay.md
//   "M1 code review").
//
// IPC is registered once for the app's lifetime: ipcMain.handle('pet:config') must exist before the page loads.

import {
  BrowserWindow,
  ipcMain,
  type HandlerDetails,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WindowOpenHandlerResponse,
} from 'electron'
import type { PetArea, Rect } from '../../shared/geometry'
import { IPC } from '../../shared/ipc'
import {
  hitWindowName,
  isOverlayStatsMsg,
  isPetDrawnMsg,
  isPetHoverMsg,
  isPetLogMsg,
  isPetPointerMsg,
  isPetReadyMsg,
  type OverlayStatsMsg,
  type PetConfig,
  type PetHoverMsg,
  type PetPointerMsg,
  type PetReadyMsg,
} from '../../shared/petProtocol'
import { tuning } from '../../shared/tuning'
import type { PaletteId, PetSize } from '../../shared/types'
import { loadPage, preloadPath } from '../pages'
import { grabAreaOpenAllowed, HIT_WINDOW_OPTIONS, toNativeMouseEvent, type ElectronHitWindow } from './hitWindow'
import { DrawnGate, recreateDelayMs } from './overlaySession'
import { createOverlayWindow } from './overlayWindow'
import type { NativeMouseEvent } from './petInteraction'

export interface PetWindowEvents {
  /** pet:config: a new page load starts (nothing is drawn for it, and no state may go out, until its pet:ready). */
  newLoad(): void
  /** The current page load's pet:ready (it counts as drawn for msg.configSeq). */
  ready(msg: PetReadyMsg): void
  hover(msg: PetHoverMsg): void
  pointer(msg: PetPointerMsg): void
  stats(msg: OverlayStatsMsg): void
  /** The current page is gone (reloading after its first load, crashed, hung, closed, never ready). */
  pageLost(reason: string): void
  /** A new overlay window exists (the first one, or a recreation): its CGWindowID changed. */
  created(): void
  /** The grab area's native mouse events (its webContents' before-mouse-event). */
  nativeMouse(e: NativeMouseEvent): void
  /** The grab area's window crashed or closed by itself. */
  hitWindowGone(reason: string): void
}

/** The parts of a PetConfig the app decides when it is sent. */
export interface PetConfigFields {
  /** Where the ground-contact point may be; null until the pet's box is known (its first pet:ready). */
  area: PetArea | null
  /** PetInteraction's current epoch. */
  epoch: number
}

export interface PetWindowOptions {
  hitWindow: ElectronHitWindow<BrowserWindow>
  /** Where a new overlay window goes: the primary display's bounds, global pt. */
  bounds(): Rect
  size: PetSize
  paletteId: PaletteId
  /** Simulation step, ms (PetConfig.stepMs). */
  stepMs: number
  /** PetConfig.debug: the page keeps counters and answers stats requests (dev check). */
  debug: boolean
  /** The changing parts of every configuration, read when it is sent. */
  configFields(): PetConfigFields
  events: PetWindowEvents
  log(line: string): void
  /** Throttled: for problems that may repeat (malformed messages, denied popups). */
  warn(key: string, line: string): void
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class PetWindow {
  private win: BrowserWindow | null = null
  /** Page loads so far (pet:config requests), over every window. */
  private loads = 0
  /** The grab-area name issued to the current page load; null between loads (every window.open is denied then). */
  private hitName: string | null = null
  /** The current page asked for its configuration (its other messages count only after that). */
  private configured = false
  /** Main-frame cross-document navigations of the current window: the first is its first load. */
  private navigations = 0
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private recreateTimer: ReturnType<typeof setTimeout> | null = null
  /** Losses in a row without a pet:ready in between (backs off the recreation). */
  private failures = 0
  private closed = false
  /** The newest configuration sent (pet:config reply or pet:config-changed). */
  private config: PetConfig | null = null
  private seq = 0
  private readonly drawnGate = new DrawnGate()

  constructor(private readonly opts: PetWindowOptions) {
    this.installIpc()
  }

  /** The overlay window (null between a crash and its recreation, and after destroy()). */
  get window(): BrowserWindow | null {
    const win = this.win
    return win && !win.isDestroyed() ? win : null
  }

  get loadCount(): number {
    return this.loads
  }

  /** The current page load's grab-area name (null before its pet:config and after it went away). */
  get grabAreaName(): string | null {
    return this.hitName
  }

  /** The newest configSeq sent. */
  get configSeq(): number {
    return this.seq
  }

  /** The newest configuration sent (a copy), or null before the first pet:config. */
  get lastConfig(): PetConfig | null {
    return this.config ? structuredClone(this.config) : null
  }

  /** PetInteraction's petDrawn: the current page load is ready and the pet is drawn for the newest configSeq. */
  get petDrawn(): boolean {
    return this.drawnGate.isDrawn(this.seq)
  }

  /** The configuration the page last reported drawn (pet:ready counts); null: none for this load, or lost since. */
  get drawnSeq(): number | null {
    return this.drawnGate.seq
  }

  /**
   * pet:config-changed: a new configSeq with the current fields (display change, the pet's area became known). The
   * pet counts as not drawn until the page reports it drew this configSeq. False if there is no page load to tell
   * (its next pet:config carries the change).
   */
  sendConfigChanged(): boolean {
    const name = this.hitName
    if (name === null) return false
    return this.send(IPC.petConfigChanged, this.nextConfig(name))
  }

  /** Creates the overlay window (hidden) and loads the pet page. No-op while one exists or after destroy(). */
  create(): void {
    if (this.closed || this.window) return
    this.clearRecreateTimer()
    const win = createOverlayWindow(this.opts.bounds(), preloadPath(), (options) => new BrowserWindow(options))
    this.win = win
    this.navigations = 0
    this.configured = false
    this.hitName = null
    this.watch(win)
    this.opts.events.created()
    this.armReadyTimer()
    loadPage(win, 'pet', { size: this.opts.size, palette: this.opts.paletteId }).catch((err: unknown) => {
      // A reload or a recreation aborts a load in progress; only the current window's failure matters.
      if (win === this.win) this.opts.log(`[bitbot] overlay: the pet page did not load (${errorText(err)})`)
    })
  }

  /** Sends to the current overlay page; false (nothing sent) without a live page. Never throws. */
  send(channel: string, payload?: unknown): boolean {
    const win = this.window
    if (!win) return false
    try {
      const wc = win.webContents
      if (wc.isDestroyed() || wc.isCrashed()) return false
      if (payload === undefined) wc.send(channel)
      else wc.send(channel, payload)
      return true
    } catch {
      return false
    }
  }

  /**
   * Shows the overlay without activating Bitbot (never show() or focus()). Only when it isn't visible: showInactive()
   * orders the window to the front of its level, which would lift it above other apps' floating panels again.
   */
  showInactive(): void {
    const win = this.window
    if (win && !win.isVisible()) win.showInactive()
  }

  /** Always ordered out, even if it looks hidden: while macOS hides Bitbot, a window not ordered out would come back with the app. */
  hide(): void {
    this.window?.hide()
  }

  /** Display change: the overlay covers the primary display's new bounds (never setResizable/setFullScreenable: overlayWindow.ts). */
  setBounds(bounds: Rect): void {
    this.window?.setBounds(bounds)
  }

  /** The overlay's content bounds, global pt (frameless: the window's bounds). */
  contentBounds(): Rect | null {
    return this.window?.getContentBounds() ?? null
  }

  /** 'window:<CGWindowID>:0' (no window number until the window was first shown). */
  mediaSourceId(): string | null {
    return this.window?.getMediaSourceId() ?? null
  }

  /** Quit: destroys the grab area and the overlay; nothing is recreated afterwards. */
  destroy(): void {
    this.closed = true
    this.clearReadyTimer()
    this.clearRecreateTimer()
    this.hitName = null
    this.configured = false
    this.opts.hitWindow.destroy()
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  // ───────────────────────────── the window and its page ─────────────────────────────

  private watch(win: BrowserWindow): void {
    const wc = win.webContents
    wc.setWindowOpenHandler((details) => this.openHandler(win, details))
    wc.on('did-create-window', (child, details) => this.adoptGrabArea(win, child, details.frameName))
    wc.on('did-start-navigation', (details) => {
      if (win !== this.win || !details.isMainFrame || details.isSameDocument) return
      this.navigations++
      if (this.navigations === 1) return // the first load
      this.lost('it is reloading')
      this.armReadyTimer()
    })
    wc.on('render-process-gone', (_event, details) => {
      if (win === this.win) this.recreate(`its renderer is gone (${details.reason}, exit code ${details.exitCode})`)
    })
    wc.on('unresponsive', () => {
      if (win === this.win) this.recreate('it stopped responding', { killRenderer: true })
    })
    wc.on('preload-error', (_event, _path, error) => this.opts.log(`[bitbot] overlay: preload error (${errorText(error)})`))
    win.on('closed', () => {
      if (win !== this.win) return // destroyed by us
      this.win = null
      this.recreate('its window closed')
    })
  }

  /** Allows exactly this page load's grab area (security.ts denies every other window.open). */
  private openHandler(win: BrowserWindow, details: HandlerDetails): WindowOpenHandlerResponse {
    if (win === this.win && grabAreaOpenAllowed(details, this.hitName)) {
      const webPreferences = { ...HIT_WINDOW_OPTIONS.webPreferences }
      return { action: 'allow', overrideBrowserWindowOptions: { ...HIT_WINDOW_OPTIONS, webPreferences } }
    }
    this.opts.warn('window.open denied', `[bitbot] overlay: denied a window.open that is not this page load's grab area`)
    return { action: 'deny' }
  }

  private adoptGrabArea(win: BrowserWindow, child: BrowserWindow, frameName: string): void {
    const hit = this.opts.hitWindow
    if (win !== this.win || frameName !== this.hitName) {
      // Never expected: the open handler allows only the current name.
      child.destroy()
      return
    }
    hit.adopt(child, win)
    const cwc = child.webContents
    cwc.on('before-mouse-event', (_event, input) => {
      if (hit.isCurrent(child)) this.opts.events.nativeMouse(toNativeMouseEvent(input))
    })
    cwc.on('render-process-gone', () => {
      if (!hit.isCurrent(child)) return
      this.opts.events.hitWindowGone('its renderer is gone')
      hit.destroy() // crashed but not destroyed
    })
    child.on('closed', () => {
      if (!hit.isCurrent(child)) return // destroyed or replaced by us
      hit.release(child)
      this.opts.events.hitWindowGone('its window closed')
    })
  }

  /** The current page is gone: its grab area too; nothing from it counts until the next pet:config. */
  private lost(reason: string): void {
    this.configured = false
    this.hitName = null
    this.drawnGate.reset()
    // The app cancels first (that closes a menu open over the grab area), then the grab area goes.
    this.opts.events.pageLost(reason)
    this.opts.hitWindow.destroy()
  }

  /**
   * Throws the window away and makes a new one after tuning.overlay.recreateDelayMs (unless quitting). killRenderer: a
   * hung renderer is terminated first, so the new window can't end up in the same stuck process.
   */
  private recreate(reason: string, { killRenderer = false } = {}): void {
    this.lost(reason)
    this.clearReadyTimer()
    const win = this.win
    this.win = null
    try {
      if (win && !win.isDestroyed()) {
        if (killRenderer) win.webContents.forcefullyCrashRenderer()
        win.destroy()
      }
    } catch {
      // Already gone.
    }
    if (this.closed) return
    this.clearRecreateTimer()
    this.failures++
    const delayMs = recreateDelayMs(this.failures, tuning.overlay.recreateDelayMs, tuning.overlay.recreateMaxDelayMs)
    this.opts.log(`[bitbot] overlay: ${reason}; making a new window in ${delayMs} ms`)
    this.recreateTimer = setTimeout(() => {
      this.recreateTimer = null
      this.create()
    }, delayMs)
  }

  private armReadyTimer(): void {
    this.clearReadyTimer()
    const win = this.win
    const timeoutMs = tuning.overlay.readyTimeoutMs
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null
      if (win === this.win) this.recreate(`no pet:ready within ${timeoutMs} ms`)
    }, timeoutMs)
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer)
    this.readyTimer = null
  }

  private clearRecreateTimer(): void {
    if (this.recreateTimer !== null) clearTimeout(this.recreateTimer)
    this.recreateTimer = null
  }

  // ───────────────────────────── IPC ─────────────────────────────

  private installIpc(): void {
    ipcMain.handle(IPC.petConfig, (event) => {
      if (!this.fromOverlay(event)) throw new Error('pet:config from an unknown sender')
      // Every request is a new page load: a fresh grab-area name (an old name would hand back the old window).
      this.loads++
      const name = hitWindowName(this.loads)
      this.hitName = name
      this.configured = true
      this.drawnGate.reset()
      this.opts.events.newLoad()
      return this.nextConfig(name)
    })
    this.listen(IPC.petReady, isPetReadyMsg, (msg) => {
      this.clearReadyTimer()
      this.failures = 0
      // There is no pet:drawn for the configuration a page starts with: its ready says it is drawn.
      this.drawnGate.ready(msg.configSeq)
      this.opts.events.ready(msg)
    })
    this.listen(IPC.petDrawn, isPetDrawnMsg, (msg) => this.drawnGate.drawn(msg))
    this.listen(IPC.petHover, isPetHoverMsg, (msg) => this.opts.events.hover(msg))
    this.listen(IPC.petPointer, isPetPointerMsg, (msg) => this.opts.events.pointer(msg))
    this.listen(IPC.debugOverlayStats, isOverlayStatsMsg, (msg) => this.opts.events.stats(msg))
    // pet:log may come before pet:config (e.g. WebGL failed to start), so it doesn't wait for the configuration.
    ipcMain.on(IPC.petLog, (event, payload: unknown) => {
      if (!this.fromOverlay(event)) return
      if (isPetLogMsg(payload)) this.opts.log(`[bitbot] overlay ${payload.level}: ${payload.message}`)
      else this.opts.warn(`malformed ${IPC.petLog}`, `[bitbot] overlay: ignored a malformed ${IPC.petLog}`)
    })
  }

  /** A message from the current page, after its pet:config, validated; a handler error is reported, never thrown at Electron. */
  private listen<T>(channel: string, valid: (value: unknown) => value is T, handler: (msg: T) => void): void {
    ipcMain.on(channel, (event: IpcMainEvent, payload: unknown) => {
      if (!this.fromOverlay(event) || !this.configured) return
      if (!valid(payload)) {
        this.opts.warn(`malformed ${channel}`, `[bitbot] overlay: ignored a malformed ${channel}`)
        return
      }
      try {
        handler(payload)
      } catch (err) {
        this.opts.warn(`${channel} handler`, `[bitbot] ERROR handling ${channel}: ${errorText(err)}`)
      }
    })
  }

  /** A new configuration (configSeq + 1) for the page load named `hitWindowName`; remembered as the newest. */
  private nextConfig(hitWindowName: string): PetConfig {
    const fields = this.opts.configFields()
    const bounds = this.contentBounds() ?? this.opts.bounds()
    const config: PetConfig = {
      configSeq: ++this.seq,
      overlay: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      area: fields.area ? { ...fields.area } : null,
      stepMs: this.opts.stepMs,
      size: this.opts.size,
      paletteId: this.opts.paletteId,
      hitWindowName,
      epoch: fields.epoch,
      debug: this.opts.debug,
    }
    this.config = config
    return config
  }

  private fromOverlay(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const win = this.window
    return win !== null && event.sender.id === win.webContents.id
  }
}
