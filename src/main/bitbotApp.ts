// Bitbot itself (BITBOT_SPEC.md §13 milestone 1 "Skeleton"; docs/decisions/overlay.md "Decision"): the composition root
// that turns the tested pieces into the running app.
// - The 30 Hz simulation in main (SimLoop + Locomotion), parked while the pet is hidden, and main's view of what the
//   overlay draws (overlaySession.ts): pet:state only on change, never before the page's pet:ready.
// - The overlay window and its page (PetWindow), the grab area (ElectronHitWindow), decided by PetInteraction (one
//   instance for the app's lifetime).
// - bitbot-helper: the overlay's on-screen check, and the fullscreen and Space-change pushes.
// - The tray icon, the ⌥⌘B hotkey and the activation monitor (the self-reporting focus check).
// - Everything that must end an interaction or make the grab area wait for a fresh on-screen answer: Space changes,
//   app activations, fullscreen apps, helper restarts, display changes, sleep and wake, lock and unlock, the overlay
//   page or the grab area going away, uncaught errors.
// - Show / hide (tray, ⌥⌘B, the pet's menu, a second launch) and quit (tray, SIGINT/SIGTERM, the system).
//
// §2 rules everywhere: when in doubt, fail closed (grab area hidden, click-through on), and never activate Bitbot:
// windows are only ever shown with showInactive(), and app.show() is never called (see showPet()).

import { existsSync } from 'node:fs'
import { app, globalShortcut, Menu, powerMonitor, screen, type BrowserWindow } from 'electron'
import type { Box, PetArea, Point } from '../shared/geometry'
import { DEFAULT_HOTKEYS } from '../shared/hotkeys'
import { IPC } from '../shared/ipc'
import { DEFAULT_PALETTE_ID } from '../shared/palettes'
import type { OverlayStatsMsg, PetCursorMsg, PetHoverResetMsg, PetReadyMsg, PetVisibleMsg } from '../shared/petProtocol'
import { tuning } from '../shared/tuning'
import type { PaletteId, PetSize } from '../shared/types'
import { ActivationMonitor, type ActivationCounters, type FocusEventSource } from './activationMonitor'
import { Debouncer } from './debounce'
import { HelperClient, type HelperExitInfo } from './helper/helperClient'
import { resolveHelperPath } from './helper/paths'
import type { FrontmostFullscreenMsg } from './helper/protocol'
import { Hotkeys } from './hotkeys'
import { petContextMenuTemplate } from './menus/petContextMenu'
import { BitbotTray } from './menus/tray'
import { SignalGate } from './signals'
import { systemClock } from './sim/clock'
import { Locomotion } from './sim/locomotion/locomotion'
import { defaultSimTiming, globalScheduler, SimLoop } from './sim/loop'
import { petAreaFor, type DisplayGeometry } from './sim/world/screenArea'
import { ThrottledLog } from './throttledLog'
import { ElectronHitWindow, type HitWindowCounters } from './windows/hitWindow'
import { windowNumber, windowOnScreen } from './windows/onScreen'
import {
  drawnPoint,
  fullscreenOnDisplay,
  PetStateSender,
  PresentedPoint,
  sameArea,
  type PetSimState,
} from './windows/overlaySession'
import { PetInteraction, type NativeMouseEvent } from './windows/petInteraction'
import { PetWindow } from './windows/petWindow'

/** M1 draws the base form at the default size and palette (§6.1, §6.2); settings (M8) make both choosable. */
const PET: { size: PetSize; paletteId: PaletteId } = { size: 'M', paletteId: DEFAULT_PALETTE_ID }

/** The simulation's clock: pet:state's t and sentAt, PetInteraction and the activation monitor all use it. */
const clock = systemClock

/** Hooks for the M1 dev check (`electron . --check=overlay`, next phase). Production passes none. */
export interface BitbotAppOptions {
  /** The cursor PetInteraction reads, global pt (a synthetic one). Default: screen.getCursorScreenPoint(). */
  cursor?: () => Point
  /**
   * Replaces the native pet menu: called when the pet is right-clicked; must call onClose once when its menu closes.
   * PetInteraction's cancel then only forgets the menu (there is nothing native to close).
   */
  popupMenu?: (onClose: () => void) => void
  /** Where the pet first stands: its ground-contact point's x, global pt (default: the bottom centre of its area). */
  spawnX?: number
  /**
   * A scripted mover: called once per simulation step with the step's nominal time (ms on the simulation's clock,
   * performance.now()'s timeline); a point teleports the pet there (Locomotion.teleport: clamped, falls if in the air,
   * ignored while held), null leaves it alone.
   */
  devMover?: (tMs: number) => Point | null
  /** PetConfig.debug: the overlay keeps renderer counters and answers stats requests. Default false. */
  debug?: boolean
  /** Where the app's log lines go. Default: console.log. */
  log?: (line: string) => void
}

/**
 * DEV ONLY (the dev check): Bitbot's internals at the moment inspect() is called. Objects are the live ones (read
 * them; don't drive them, except through setVisible()); plain values are copies.
 */
export interface BitbotInspection {
  /** The overlay window; null between a crash and its recreation. */
  overlay: BrowserWindow | null
  /** The grab area's window; null until the overlay page opened it, and while it is gone. */
  hitWindow: BrowserWindow | null
  /** Native calls the grab area's window got so far. */
  hitWindowCounters: HitWindowCounters
  interaction: PetInteraction
  /** Null until the first pet:ready (the pet's box decides its area). */
  locomotion: Locomotion | null
  loop: SimLoop
  /** From the newest pet:ready (relative to the ground-contact point, pt); null before the first. */
  petBox: Box | null
  /** From the newest pet:ready: where the ground-contact point is drawn on the canvas, CSS px. */
  anchor: Point | null
  /** The newest configuration sent (pet:config or pet:config-changed). */
  configSeq: number
  /** The configuration the overlay last reported drawn (pet:ready counts); null: none for this page load, or lost. */
  drawnSeq: number | null
  /** What PetInteraction's petDrawn() says now. */
  petDrawn: boolean
  /** The overlay's CGWindowID (null until it was first shown). */
  overlayWid: number | null
  /** Page loads so far (each pet:config is one). */
  loads: number
  /** The page load whose pet:ready came last. */
  readyLoad: number
  helper: HelperClient | null
  activation: ActivationCounters
  hiddenByUser: boolean
  /** app.isHidden(): macOS hid Bitbot (e.g. another app's Hide Others). */
  appHidden: boolean
  /** The helper says a fullscreen app covers the pet's display. */
  frontmostFullscreen: boolean
  /** pet:state messages sent. */
  statesSent: number
  /** Where main thinks the overlay draws the ground-contact point now, global pt. */
  displayedPoint: Point
  /** Shows or hides the pet as the tray / ⌥⌘B would. */
  setVisible(visible: boolean): void
  /**
   * Resolves with the pet:ready of the current page load once it came (at once if it already has), from a load
   * numbered minLoad or later (default 1; pass `loads + 1` to wait for the next one); rejects after timeoutMs.
   */
  waitForReady(timeoutMs: number, minLoad?: number): Promise<PetReadyMsg>
  /** The overlay's renderer counters (only with options.debug); null if they don't come within timeoutMs. */
  requestOverlayStats(timeoutMs: number): Promise<OverlayStatsMsg | null>
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const errorDetail = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err))

function primaryDisplay(): DisplayGeometry {
  const d = screen.getPrimaryDisplay()
  return { id: d.id, bounds: { ...d.bounds }, workArea: { ...d.workArea } }
}

function fmtRect(r: { x: number; y: number; width: number; height: number }): string {
  return `${r.x},${r.y} ${r.width}x${r.height}`
}

export class BitbotApp {
  private readonly opts: BitbotAppOptions
  private readonly dev = !app.isPackaged
  private readonly stepMs: number
  private readonly throttled: ThrottledLog
  private readonly hitWindow: ElectronHitWindow<BrowserWindow>
  private readonly petWindow: PetWindow
  private readonly interaction: PetInteraction
  private readonly loop: SimLoop
  private readonly states: PetStateSender
  private readonly presented: PresentedPoint
  private readonly activation: ActivationMonitor
  private readonly hotkeys = new Hotkeys(globalShortcut)
  private readonly tray: BitbotTray
  private readonly relayout: Debouncer

  private helper: HelperClient | null = null
  private loco: Locomotion | null = null
  private display: DisplayGeometry | null = null
  /** The newest pet:ready (its petBox outlives the page that sent it). */
  private ready: PetReadyMsg | null = null
  private readyLoad = 0
  private hiddenByUser = false
  /** app.isHidden() as last seen on a simulation wake. */
  private appHidden = false
  private fullscreenMsg: FrontmostFullscreenMsg | null = null
  /** The helper says a fullscreen app covers the pet's display. */
  private fullscreen = false
  /** This wake's held point (PetInteraction.sampleHeld), for its steps. */
  private held: Point | null = null
  private menu: { menu: Menu; win: BrowserWindow } | null = null
  /** Dev: native grab-area mouse events still to log for the current press. */
  private nativeLogLeft = 0
  private errorHandlers = false
  private signalHandlers = false
  private started = false
  private quitting = false
  private cleanedUp = false
  private readonly readyWaiters = new Set<(msg: PetReadyMsg, load: number) => void>()
  private readonly statsWaiters = new Set<(msg: OverlayStatsMsg) => void>()

  constructor(options: BitbotAppOptions = {}) {
    this.opts = options
    const timing = defaultSimTiming()
    this.stepMs = timing.stepMs
    this.throttled = new ThrottledLog({
      now: () => clock.now(),
      intervalMs: tuning.app.errorLogIntervalMs,
      maxKeys: tuning.app.errorLogKeys,
      write: (line) => this.log(line),
    })
    this.hitWindow = new ElectronHitWindow<BrowserWindow>({
      forwardMouseMoves: tuning.hitArea.forwardMouseMoves,
      log: (line) => this.log(`[bitbot] ${line}`),
    })
    this.states = new PetStateSender((msg) => {
      this.petWindow.send(IPC.petState, msg)
    })
    this.presented = new PresentedPoint(this.stepMs, { t: clock.now(), x: 0, y: 0 })

    const injectedMenu = options.popupMenu
    this.interaction = new PetInteraction({
      hitWindow: this.hitWindow,
      locomotion: {
        grab: () => {
          if (!this.loco) throw new Error('the pet has no place yet')
          this.loco.grab()
        },
        release: (at) => this.loco?.release(at),
      },
      tuning: tuning.hitArea,
      now: () => clock.now(),
      cursor: options.cursor ?? (() => screen.getCursorScreenPoint()),
      displayedPoint: (nowMs) => drawnPoint(this.presented, nowMs, this.heldPoint()),
      petBox: () => this.ready?.petBox ?? null,
      overlayShown: () => !this.hiddenByUser && !app.isHidden(),
      petDrawn: () => this.petWindow.petDrawn,
      frontmostFullscreen: () => this.fullscreen,
      checkOverlayOnScreen: () => windowOnScreen(this.helper, this.overlayWid()),
      popupMenu: (onClose) => {
        const closed = (): void => {
          onClose()
          this.observe()
        }
        if (injectedMenu) injectedMenu(closed)
        else this.popupPetMenu(closed)
      },
      closeMenu: () => {
        if (!injectedMenu) this.closePetMenu()
      },
      onSnap: () => this.snap(),
      sendHoverReset: (epoch) => {
        this.petWindow.send(IPC.petHoverReset, { epoch } satisfies PetHoverResetMsg)
      },
      sendCursor: (p) => {
        this.petWindow.send(IPC.petCursor, { x: p.x, y: p.y } satisfies PetCursorMsg)
      },
      log: (line) => this.log(`[bitbot] ${line}`),
    })

    this.loop = new SimLoop({
      clock,
      ...timing,
      beforeSteps: (wakeMs) => {
        this.held = this.interaction.sampleHeld(wakeMs)
        this.observe()
      },
      onStep: (dtS, t) => this.step(dtS, t),
      afterSteps: (wakeMs) => {
        this.watchAppHidden()
        this.interaction.tick(wakeMs)
        this.observe()
      },
      onError: (err, where) => this.failClosed(`the simulation's ${where} hook threw`, err),
    })

    this.petWindow = new PetWindow({
      hitWindow: this.hitWindow,
      bounds: () => (this.display ?? primaryDisplay()).bounds,
      size: PET.size,
      paletteId: PET.paletteId,
      stepMs: this.stepMs,
      debug: options.debug === true,
      configFields: () => ({ area: this.petArea(), epoch: this.interaction.epoch }),
      log: (line) => this.log(line),
      warn: (key, line) => this.throttled.log(key, line),
      events: {
        // A new page load: no state goes out until its pet:ready.
        newLoad: () => this.states.setReady(false),
        ready: (msg) => this.onReady(msg),
        hover: (msg) => {
          this.interaction.handleHover(msg)
          this.observe()
        },
        pointer: (msg) => {
          this.interaction.handlePointer(msg)
          this.observe()
        },
        stats: (msg) => {
          for (const waiter of [...this.statsWaiters]) waiter(msg)
        },
        pageLost: (reason) => this.onPageLost(reason),
        created: () => {
          // A new window: a new CGWindowID, whose on-screen state nobody has asked about.
          this.interaction.invalidateOnScreen()
          this.observe()
        },
        nativeMouse: (e) => this.onNativeMouse(e),
        hitWindowGone: (reason) => this.cancel(`the grab area went away: ${reason}`),
      },
    })

    const focusEvents: FocusEventSource = {
      // Electron's overloads take one event name each; the listeners ignore their arguments.
      on: (name, listener) => {
        app.on(name as 'did-become-active', listener)
      },
      off: (name, listener) => {
        app.off(name as 'did-become-active', listener)
      },
    }
    this.activation = new ActivationMonitor({
      source: focusEvents,
      now: () => clock.now(),
      scheduler: globalScheduler,
      label: () => this.interaction.label,
      log: (line) => this.log(line),
      verdictDelayMs: tuning.app.activationVerdictDelayMs,
      lookBackMs: tuning.app.activationLookBackMs,
      eventCap: tuning.app.activationEventCap,
    })

    this.tray = new BitbotTray({
      actions: { toggleVisible: () => this.toggleVisible('tray menu'), quit: () => void this.quit('tray menu') },
      toggleAccelerator: () => this.hotkeys.accelerator('toggleVisible'),
    })
    this.relayout = new Debouncer(tuning.overlay.displayChangeDebounceMs, () => this.guarded('display re-layout', () => this.layOut()))
  }

  /**
   * Uncaught errors → logged (throttled) and fail closed. Call before app ready: an uncaught error must never reach
   * Electron's error dialog, which would activate Bitbot (§2). (The signal handlers come with start().)
   */
  installErrorHandlers(): void {
    if (this.errorHandlers) return
    this.errorHandlers = true
    process.on('uncaughtException', (err) => this.failClosed('uncaught exception', err))
    process.on('unhandledRejection', (reason) => this.failClosed('unhandled promise rejection', reason))
  }

  /** Starts Bitbot (after app ready, with the Dock icon hidden and security installed). */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.installErrorHandlers()
    this.installSignalHandlers()
    // Agent app (§3): no application menu, so no key equivalents either.
    Menu.setApplicationMenu(null)
    const display = primaryDisplay()
    this.display = display
    const b = display.bounds
    this.presented.restart(clock.now(), { x: b.x + b.width / 2, y: display.workArea.y + display.workArea.height })
    this.activation.start()
    this.startHelper()
    this.registerHotkeys()
    this.tray.create(this.isPetVisible())
    this.log('[bitbot] tray icon created')
    this.watchSystem()
    app.on('before-quit', (event) => {
      // Something else asked to quit (e.g. logging out): clean up first, then quit for real.
      if (this.cleanedUp) return
      event.preventDefault()
      void this.quit('app.quit() from outside Bitbot, e.g. logging out')
    })
    app.on('will-quit', () => this.hotkeys.unregisterAll())
    this.petWindow.create()
    this.log(
      `[bitbot] running (${this.dev ? 'dev' : 'packaged'} build, Electron ${process.versions.electron}): display ${display.id} ` +
        `${fmtRect(display.bounds)}, work area ${fmtRect(display.workArea)}`,
    )
  }

  /** Shows the pet if the user (or macOS) hid it. Never activates Bitbot. */
  showPet(source: string): void {
    if (this.quitting || !this.started) return
    const hiddenByMacOS = app.isHidden()
    if (!this.hiddenByUser && !hiddenByMacOS) {
      this.log(`[bitbot] ${source}: the pet is already shown`)
      return
    }
    this.hiddenByUser = false
    this.cancel(`shown by the user: ${source}`)
    // Hidden by macOS (another app's Hide Others, or anything that runs NSApp hide:), measured on Electron 44.6 /
    // macOS 15.6 with this overlay's window settings: showInactive() on the overlay unhides Bitbot and restores all its
    // windows WITHOUT activating it (no did-become-active, the frontmost app unchanged). app.show() ([NSApp unhide:])
    // activates Bitbot (did-become-active; Bitbot became the frontmost app), even when nothing was hidden, so it is
    // never called (§2). Another process can't hide an agent app at all (NSRunningApplication.hide() returns false),
    // so Hide Others probably never hides Bitbot; if anything does, watchAppHidden() notices and the tray offers
    // "Show Bitbot".
    this.petWindow.showInactive()
    if (app.isHidden()) this.log('[bitbot] WARNING macOS still hides Bitbot after showInactive(): the pet stays hidden')
    if (this.loco) this.loop.start()
    this.snap()
    this.interaction.invalidateOnScreen()
    this.observe()
    this.petWindow.send(IPC.petVisible, { visible: true, epoch: this.interaction.epoch } satisfies PetVisibleMsg)
    this.appHidden = app.isHidden()
    this.tray.update(this.isPetVisible())
    this.log(`[bitbot] pet shown (${source})${hiddenByMacOS ? '; macOS had hidden Bitbot' : ''}`)
  }

  /** Hides the pet (the tray, ⌥⌘B, the pet's menu): the grab area at once, then the overlay; the simulation parks. */
  hidePet(source: string): void {
    if (this.quitting || !this.started || this.hiddenByUser) return
    this.hiddenByUser = true
    this.cancel(`hidden by the user: ${source}`)
    // overlayShown() is false now: this decides again at once (the loop is about to park) and hides the grab area.
    this.interaction.invalidateOnScreen()
    this.observe()
    this.petWindow.send(IPC.petVisible, { visible: false, epoch: this.interaction.epoch } satisfies PetVisibleMsg)
    this.petWindow.hide()
    // SPEC-DEVIATION: §8.6 keeps the simulation running at a low rate while hidden (needs and economy still tick).
    // Nothing ticks in M1, so the loop is parked; M6 adds the low-rate tick.
    this.loop.stop()
    this.tray.update(false)
    this.log(`[bitbot] pet hidden (${source})`)
  }

  toggleVisible(source: string): void {
    if (this.isPetVisible()) this.hidePet(source)
    else this.showPet(source)
  }

  /** Quits cleanly: loop, interaction, hotkeys, tray, helper (bounded wait), windows; then app.quit(). Idempotent. */
  async quit(reason: string): Promise<void> {
    if (this.quitting) return
    this.quitting = true
    this.log(`[bitbot] quitting (${reason})`)
    const fallback = setTimeout(() => app.exit(0), tuning.app.helperStopTimeoutMs + tuning.app.quitFallbackMs)
    fallback.unref()
    this.guarded('quit: loop', () => this.loop.stop())
    this.guarded('quit: cancel', () => this.cancel('quitting'))
    this.guarded('quit: displays', () => this.relayout.cancel())
    this.guarded('quit: hotkeys', () => this.hotkeys.unregisterAll())
    this.guarded('quit: tray', () => this.tray.destroy())
    this.guarded('quit: activation monitor', () => this.activation.stop())
    await this.stopHelper()
    this.guarded('quit: windows', () => this.petWindow.destroy())
    this.cleanedUp = true
    this.log('[bitbot] bye')
    app.quit()
  }

  /** DEV ONLY: see BitbotInspection. */
  inspect(): BitbotInspection {
    const ready = this.ready
    return {
      overlay: this.petWindow.window,
      hitWindow: this.hitWindow.window,
      hitWindowCounters: this.hitWindow.counters,
      interaction: this.interaction,
      locomotion: this.loco,
      loop: this.loop,
      petBox: ready ? { ...ready.petBox } : null,
      anchor: ready ? { ...ready.anchor } : null,
      configSeq: this.petWindow.configSeq,
      drawnSeq: this.petWindow.drawnSeq,
      petDrawn: this.petWindow.petDrawn,
      overlayWid: this.overlayWid(),
      loads: this.petWindow.loadCount,
      readyLoad: this.readyLoad,
      helper: this.helper,
      activation: this.activation.counters,
      hiddenByUser: this.hiddenByUser,
      appHidden: app.isHidden(),
      frontmostFullscreen: this.fullscreen,
      statesSent: this.states.sent,
      displayedPoint: drawnPoint(this.presented, clock.now(), this.heldPoint()),
      setVisible: (visible) => (visible ? this.showPet('dev check') : this.hidePet('dev check')),
      waitForReady: (timeoutMs, minLoad = 1) => this.waitForReady(timeoutMs, minLoad),
      requestOverlayStats: (timeoutMs) => this.requestOverlayStats(timeoutMs),
    }
  }

  // ───────────────────────────── simulation ─────────────────────────────

  private step(dtS: number, t: number): void {
    const loco = this.loco
    if (!loco) return
    const mover = this.opts.devMover
    if (mover) {
      const p = mover(t)
      if (p) loco.teleport(p)
    }
    loco.step(dtS, this.held)
    this.presented.push(t, loco.state)
    this.states.offer(this.simState(loco), t, clock.now())
  }

  private simState(loco: Locomotion): PetSimState {
    const s = loco.state
    // M1 never turns (facing +1, the default 3/4 yaw): walking and turning come with M3.
    return { x: s.x, y: s.y, facing: 1, state: s.behavior, supportY: loco.supportY }
  }

  /** A held pet's newest step (the overlay draws a held pet under the cursor, which that step followed); null unless held. */
  private heldPoint(): Point | null {
    const s = this.loco?.state
    return s && s.behavior === 'held' ? { x: s.x, y: s.y } : null
  }

  /** The pet jumped (release, cancel, shown, display change, page ready): restart the interpolation, send a snap state. */
  private snap(): void {
    const loco = this.loco
    if (!loco) return
    const t = this.loop.latestStepTime
    this.presented.restart(t, loco.state)
    this.states.requestSnap()
    this.states.offer(this.simState(loco), t, clock.now())
  }

  /** The pet's area on the primary display (§8.1, §8.7); null until the overlay measured the pet. */
  private petArea(): PetArea | null {
    const box = this.ready?.petBox
    const display = this.display
    return box && display ? petAreaFor(display, box) : null
  }

  // ───────────────────────────── the overlay page ─────────────────────────────

  private onReady(msg: PetReadyMsg): void {
    this.ready = msg
    this.readyLoad = this.petWindow.loadCount
    const display = this.display ?? primaryDisplay()
    const area = petAreaFor(display, msg.petBox)
    if (!this.loco) {
      const x = this.opts.spawnX
      this.loco = new Locomotion(area, tuning.move, x !== undefined && Number.isFinite(x) ? { x, y: area.groundY } : undefined)
    } else {
      this.loco.setArea(area)
    }
    // The first page learns the pet's area here (its box decides it); the grab area waits until it drew with it.
    if (!sameArea(this.petWindow.lastConfig?.area ?? null, area)) this.petWindow.sendConfigChanged()
    this.states.setReady(true)
    if (this.hiddenByUser) {
      this.petWindow.send(IPC.petVisible, { visible: false, epoch: this.interaction.epoch } satisfies PetVisibleMsg)
    } else {
      // Not while macOS hides Bitbot: showInactive() would unhide it (see showPet()).
      if (!app.isHidden()) this.petWindow.showInactive()
      this.loop.start()
    }
    this.snap()
    this.interaction.invalidateOnScreen()
    this.observe()
    const box = msg.petBox
    this.log(
      `[bitbot] overlay ready (page load ${this.readyLoad}, window ${this.overlayWid() ?? 'not shown'}): pet box ` +
        `${box.left.toFixed(1)},${box.top.toFixed(1)} → ${box.right.toFixed(1)},${box.bottom.toFixed(1)} pt, ` +
        `${msg.devicePixelRatio}x, GPU ${msg.glRenderer ?? 'unknown'}, grab area ${msg.hitWindowOpened ? 'opened' : 'NOT opened'}`,
    )
    if (!msg.hitWindowOpened) this.log("[bitbot] WARNING the overlay could not open its grab area: the pet can't be grabbed")
    for (const waiter of [...this.readyWaiters]) waiter(msg, this.readyLoad)
  }

  private onPageLost(reason: string): void {
    this.states.setReady(false)
    this.cancel(`the overlay page went away: ${reason}`)
    this.interaction.invalidateOnScreen()
    this.observe()
  }

  private overlayWid(): number | null {
    const id = this.petWindow.mediaSourceId()
    return id === null ? null : windowNumber(id)
  }

  // ───────────────────────────── interaction ─────────────────────────────

  /** After every call into PetInteraction: the activation monitor sees presses and menus begin and end. */
  private observe(): void {
    this.activation.observe(this.interaction.label)
  }

  private cancel(reason: string): void {
    this.interaction.cancel(reason)
    this.observe()
  }

  private onNativeMouse(e: NativeMouseEvent): void {
    if (this.dev) this.logNativeMouse(e)
    this.interaction.handleNativeMouse(e)
    this.observe()
  }

  /**
   * Dev builds: the first few native events of each press. A drag needs Electron to report 'leftbuttondown' on its
   * moves; without it every drag would end at its first move (PetInteraction reads a move without it as a lost mouseup).
   */
  private logNativeMouse(e: NativeMouseEvent): void {
    if (e.type === 'mouseDown' && e.button === 'left') this.nativeLogLeft = tuning.app.nativeMouseLogPerPress
    if (this.nativeLogLeft <= 0) return
    this.nativeLogLeft--
    if (e.type === 'mouseUp') this.nativeLogLeft = 0
    this.log(
      `[bitbot] grab area native ${e.type}${e.button ? ` ${e.button}` : ''}: leftbuttondown=${e.leftButtonDown} ` +
        `(interaction: ${this.interaction.label})`,
    )
  }

  /** The native pet menu (§15.3, M1: only "Hide") over the grab area, at the cursor. */
  private popupPetMenu(onClose: () => void): void {
    const win = this.hitWindow.window
    if (!win) throw new Error('there is no grab area to open the menu over')
    const menu = Menu.buildFromTemplate(
      petContextMenuTemplate({
        hide: () => {
          this.activation.menuChoice('Hide')
          this.hidePet('pet menu')
        },
      }),
    )
    let open = true
    const closed = (): void => {
      if (!open) return
      open = false
      if (this.menu?.menu === menu) this.menu = null
      onClose()
    }
    menu.once('menu-will-close', closed)
    this.menu = { menu, win }
    menu.popup({ window: win, callback: closed })
  }

  private closePetMenu(): void {
    const open = this.menu
    if (!open) return
    try {
      if (!open.win.isDestroyed()) open.menu.closePopup(open.win)
    } catch {
      // Closed already.
    }
  }

  // ───────────────────────────── visibility ─────────────────────────────

  /** Shown as far as the user can see: not hidden by them, and macOS isn't hiding Bitbot. */
  private isPetVisible(): boolean {
    return !this.hiddenByUser && !app.isHidden()
  }

  /** Every simulation wake: did macOS hide (or show) Bitbot? There is no event for it. */
  private watchAppHidden(): void {
    const hidden = app.isHidden()
    if (hidden === this.appHidden) return
    this.appHidden = hidden
    if (hidden) {
      this.log('[bitbot] macOS hid Bitbot (Hide Others?): the pet stays hidden until it is shown (tray menu or ⌥⌘B)')
      this.cancel('macOS hid Bitbot')
    } else {
      this.log('[bitbot] macOS showed Bitbot again')
    }
    this.interaction.invalidateOnScreen()
    this.observe()
    this.tray.update(this.isPetVisible())
  }

  // ───────────────────────────── helper ─────────────────────────────

  private startHelper(): void {
    const binaryPath = resolveHelperPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    })
    if (!existsSync(binaryPath)) {
      // Fail closed: without the helper the overlay is never confirmed on screen, so the grab area never shows.
      this.log("[bitbot] bitbot-helper not built: run npm run build:helper (until then the pet can't be grabbed)")
      return
    }
    // M1 asks for snapshots only for the overlay's on-screen check, while the cursor is near the pet; no push polling
    // (setPollRate) until the world model needs window surfaces (M3).
    const helper = new HelperClient({
      binaryPath,
      onListenerError: (err) => this.failClosed('a bitbot-helper event handler threw', err),
    })
    helper.on('hello', (m) => this.log(`[bitbot] helper hello: pid ${m.pid}, protocol ${m.version}`))
    helper.on('protocolError', (e) => {
      if (e.reason === 'versionMismatch') {
        this.log(`[bitbot] bitbot-helper speaks protocol ${e.actual}, Bitbot expects ${e.expected}: run npm run build:helper`)
      } else {
        this.throttled.log(`helper ${e.reason}`, `[bitbot] helper protocol problem: ${e.reason} (a ${e.length}-character line)`)
      }
    })
    helper.on('stderr', (line) => this.throttled.log(`helper stderr ${line}`, `[bitbot-helper] ${line}`))
    helper.on('exit', (info) => this.onHelperExit(info))
    helper.on('restart', (info) => {
      this.log(`[bitbot] helper restarted (attempt ${info.attempt}, pid ${info.pid ?? 'unknown'})`)
      this.interaction.invalidateOnScreen()
      this.observe()
    })
    helper.on('frontmostFullscreen', (m) => {
      this.fullscreenMsg = m
      this.applyFullscreen()
    })
    helper.on('spaceChanged', () => {
      // Never observed on a device yet (protocol 3): logged in dev so the manual checks show it.
      if (this.dev) this.log('[bitbot] helper: the active Space changed')
      this.cancel('the active Space changed')
      this.interaction.invalidateOnScreen(tuning.hitArea.spaceSettleMs)
      this.observe()
    })
    helper.on('appActivated', () => {
      this.interaction.invalidateOnScreen()
      this.observe()
    })
    this.helper = helper
    helper.start()
  }

  private onHelperExit(info: HelperExitInfo): void {
    const why = info.error ?? (info.signal !== null ? `signal ${info.signal}` : `exit code ${info.code ?? 'unknown'}`)
    this.log(`[bitbot] helper exited (${why})${info.willRestart ? `; restarting in ${info.restartInMs ?? '?'} ms` : ''}`)
    // Unknown until the restarted helper reports again; the on-screen check says null (fail closed) meanwhile.
    this.fullscreenMsg = null
    this.applyFullscreen()
    this.interaction.invalidateOnScreen()
    this.observe()
  }

  /** The helper's fullscreen push, for the primary display: true cancels any interaction; any change re-checks. */
  private applyFullscreen(): void {
    const msg = this.fullscreenMsg
    const display = this.display
    const value = msg !== null && display !== null && fullscreenOnDisplay(msg, display.id)
    if (value === this.fullscreen) return
    this.fullscreen = value
    this.log(`[bitbot] a fullscreen app ${value ? 'covers' : 'no longer covers'} the pet's display`)
    if (value) this.cancel('a fullscreen app is in front')
    this.interaction.invalidateOnScreen()
    this.observe()
  }

  private async stopHelper(): Promise<void> {
    const helper = this.helper
    if (!helper) return
    const timeoutMs = tuning.app.helperStopTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs)
    })
    const stopped = helper.stop().then(
      () => false,
      () => false,
    )
    if (await Promise.race([stopped, timedOut])) {
      this.log(`[bitbot] bitbot-helper did not stop within ${timeoutMs} ms (it exits with Bitbot)`)
    }
    clearTimeout(timer)
  }

  // ───────────────────────────── system events ─────────────────────────────

  private registerHotkeys(): void {
    const result = this.hotkeys.register({ toggleVisible: () => this.toggleVisible('⌥⌘B') })
    for (const action of result.registered) this.log(`[bitbot] hotkey registered: ${DEFAULT_HOTKEYS[action]} (${action})`)
    for (const action of result.failed) {
      this.log(`[bitbot] hotkey NOT registered: ${DEFAULT_HOTKEYS[action]} (${action}); another app may own it`)
    }
  }

  private watchSystem(): void {
    powerMonitor.on('lock-screen', () => this.cancel('the screen locked'))
    powerMonitor.on('suspend', () => this.cancel('the Mac is going to sleep'))
    powerMonitor.on('user-did-resign-active', () => this.cancel('the user session became inactive'))
    powerMonitor.on('resume', () => this.redraw('woke from sleep'))
    powerMonitor.on('unlock-screen', () => this.redraw('the screen unlocked'))
    powerMonitor.on('user-did-become-active', () => this.redraw('the user session became active'))
    app.on('child-process-gone', (_event, details) => {
      if (details.type !== 'GPU') return
      this.log(`[bitbot] the GPU process is gone (${details.reason}); redrawing the pet`)
      this.petWindow.send(IPC.petRedraw)
    })
    screen.on('display-added', () => this.displaysChanged('a display was added'))
    screen.on('display-removed', () => this.displaysChanged('a display was removed'))
    screen.on('display-metrics-changed', () => this.displaysChanged('display metrics changed'))
  }

  /** Wake, unlock: draw again (the GPU may have lost the frame) and re-check the overlay's on-screen state. */
  private redraw(why: string): void {
    this.petWindow.send(IPC.petRedraw)
    this.interaction.invalidateOnScreen()
    this.observe()
    if (this.dev) this.log(`[bitbot] ${why}: redrawing the pet`)
  }

  /** Display events come in bursts: end any interaction and hide the grab area now, lay out once they settle. */
  private displaysChanged(what: string): void {
    this.cancel(`the displays changed (${what})`)
    this.interaction.invalidateOnScreen()
    this.observe()
    this.relayout.trigger()
  }

  /** The overlay covers the (new) primary display, the pet gets its new area, the page its new configuration. */
  private layOut(): void {
    if (this.quitting) return
    const display = primaryDisplay()
    this.display = display
    this.petWindow.setBounds(display.bounds)
    const area = this.petArea()
    if (this.loco && area) this.loco.setArea(area)
    this.applyFullscreen() // the primary display may be another one now
    this.petWindow.sendConfigChanged()
    this.snap()
    this.interaction.invalidateOnScreen()
    this.observe()
    this.log(
      `[bitbot] displays changed: overlay ${fmtRect(display.bounds)}, work area ${fmtRect(display.workArea)}` +
        (area ? `, ground y ${area.groundY}` : ''),
    )
  }

  // ───────────────────────────── errors and signals ─────────────────────────────

  /**
   * SIGINT/SIGTERM → a clean quit; the echo of a terminal Ctrl+C is ignored (signals.ts). Installed after app ready on
   * purpose: Chromium installs its own SIGINT/SIGTERM handlers during startup, replacing any Node installed before them.
   * Chromium's quit too, but its handler resets itself to the default after the first signal, so the echo a few ms
   * later would kill Bitbot in the middle of its clean-up. Installed after ready, Node's handlers replace Chromium's.
   */
  private installSignalHandlers(): void {
    if (this.signalHandlers) return
    this.signalHandlers = true
    const gate = new SignalGate(tuning.app.signalRepeatGraceMs)
    const onSignal = (signal: NodeJS.Signals) => (): void => {
      const action = gate.onSignal(clock.now())
      if (action === 'quit') void this.quit(signal)
      else if (action === 'force-exit') {
        this.log(`[bitbot] ${signal} again: exiting at once`)
        app.exit(130)
      }
    }
    process.on('SIGINT', onSignal('SIGINT'))
    process.on('SIGTERM', onSignal('SIGTERM'))
  }

  /** An error nobody else handles: logged (throttled), and the grab area fails closed. */
  private failClosed(what: string, err: unknown): void {
    try {
      const first = this.throttled.log(`${what}: ${errorText(err)}`, `[bitbot] ERROR ${what}: ${errorDetail(err)}`)
      if (!this.started) return
      // Once per streak: cancel logs a line every time.
      if (first) this.cancel(`${what}; failing closed`)
      this.interaction.invalidateOnScreen()
      this.observe()
    } catch {
      // The error handler itself must never throw.
    }
  }

  private guarded(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.failClosed(what, err)
    }
  }

  private log(line: string): void {
    const write = this.opts.log ?? console.log
    try {
      write(line)
    } catch {
      // Nowhere left to report it.
    }
  }

  // ───────────────────────────── dev check ─────────────────────────────

  private waitForReady(timeoutMs: number, minLoad: number): Promise<PetReadyMsg> {
    const ready = this.ready
    if (ready && this.readyLoad >= minLoad && this.readyLoad === this.petWindow.loadCount && this.states.isReady) {
      return Promise.resolve(ready)
    }
    return new Promise<PetReadyMsg>((resolve, reject) => {
      const waiter = (msg: PetReadyMsg, load: number): void => {
        if (load < minLoad) return
        this.readyWaiters.delete(waiter)
        clearTimeout(timer)
        resolve(msg)
      }
      const timer = setTimeout(() => {
        this.readyWaiters.delete(waiter)
        reject(new Error(`no pet:ready from page load ${minLoad} or later within ${timeoutMs} ms`))
      }, timeoutMs)
      this.readyWaiters.add(waiter)
    })
  }

  private requestOverlayStats(timeoutMs: number): Promise<OverlayStatsMsg | null> {
    return new Promise<OverlayStatsMsg | null>((resolve) => {
      const done = (msg: OverlayStatsMsg | null): void => {
        this.statsWaiters.delete(waiter)
        clearTimeout(timer)
        resolve(msg)
      }
      const waiter = (msg: OverlayStatsMsg): void => done(msg)
      const timer = setTimeout(() => done(null), timeoutMs)
      this.statsWaiters.add(waiter)
      if (!this.petWindow.send(IPC.debugOverlayStatsRequest)) done(null)
    })
  }
}
