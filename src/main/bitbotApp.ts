// Bitbot itself (BITBOT_SPEC.md §13 milestones 1 "Skeleton" and 2 "Character alive"; docs/decisions/overlay.md
// "Decision"): the composition root that turns the tested pieces into the running app.
// - The 30 Hz simulation in main (SimLoop + Locomotion), parked while the pet is hidden, and main's view of what the
//   overlay draws (overlaySession.ts): pet:state only on change, never before the page's pet:ready. Each step also
//   works out where the eyes look from the cursor position (sim/look.ts; nothing else is read, nothing is kept).
// - Dev builds: the developer panel (tray → "Developer…", dev/devPanel.ts) and its overrides (dev/devOverrides.ts),
//   which pet:state and debug:pet carry to the overlay. Packaged builds have neither: the defaults always apply.
// - The overlay window and its page (PetWindow), the grab area (ElectronHitWindow), decided by PetInteraction (one
//   instance for the app's lifetime).
// - bitbot-helper: the overlay's on-screen check, and the fullscreen and Space-change pushes.
// - The tray icon, the hotkeys (⌥⌘B, ⌥⌘C, ⌥⌘H, ⌥⌘S) and the activation monitor (the self-reporting focus check).
// - Modes (§10.3, M7; sim/modes.ts): Roam / Stay / Hangout from the tray's Mode ▸, the pet's menu and ⌥⌘S; the brain
//   gets the mode and the active spot, Go home goes to the spot. Kept in memory until M8 saves them.
// - Everything that must end an interaction or make the grab area wait for a fresh on-screen answer: Space changes,
//   app activations, fullscreen apps, helper restarts, display changes, sleep and wake, lock and unlock, the overlay
//   page or the grab area going away, uncaught errors.
// - Show / hide (tray, ⌥⌘B, the pet's menu, a second launch) and quit (tray, SIGINT/SIGTERM, the system).
//
// §2 rules everywhere: when in doubt, fail closed (grab area hidden, click-through on), and never activate Bitbot:
// windows are only ever shown with showInactive(), and app.show() is never called (see showPet()).

import { existsSync } from 'node:fs'
import { app, globalShortcut, Menu, powerMonitor, screen, shell, type BrowserWindow } from 'electron'
import type { DevPanelSet } from '../shared/devPanel'
import type { DevInject, EconomySnapshot } from '../shared/economy'
import type { Box, PetArea, Point } from '../shared/geometry'
import { DEFAULT_HOTKEYS } from '../shared/hotkeys'
import { IPC } from '../shared/ipc'
import { DEFAULT_PALETTE_ID } from '../shared/palettes'
import type { OverlayStatsMsg, PetCursorMsg, PetHoverResetMsg, PetReadyMsg, PetVisibleMsg } from '../shared/petProtocol'
import { tuning } from '../shared/tuning'
import type { BehaviorState, LookDirection, Mood, PaletteId, PetReaction, PetReactionKind, PetSize } from '../shared/types'
import { boxFor } from '../shared/world'
import { ActivationMonitor, type ActivationCounters, type FocusEventSource } from './activationMonitor'
import { Debouncer } from './debounce'
import { devPetMsg, DevOverrideState, overriddenFields } from './dev/devOverrides'
import { DevPanel } from './dev/devPanel'
import type { DevPanelAppStatus } from './dev/devPanelModel'
import { HelperClient, type HelperExitInfo } from './helper/helperClient'
import { resolveHelperPath } from './helper/paths'
import type { FrontmostFullscreenMsg, HelperWindow } from './helper/protocol'
import { Hotkeys } from './hotkeys'
import { petContextMenuTemplate } from './menus/petContextMenu'
import { ModeState, type SpotLookup } from './sim/modes'
import { BitbotTray } from './menus/tray'
import { SignalGate } from './signals'
import { systemClock } from './sim/clock'
import { Locomotion } from './sim/locomotion/locomotion'
import { lookDirection } from './sim/look'
import { defaultSimTiming, globalScheduler, SimLoop } from './sim/loop'
import { petAreaFor, type DisplayGeometry } from './sim/world/screenArea'
import { ActivityIngest } from './activityIngest'
import { PetLife } from './petLife'
import { Brain } from './sim/brain/brain'
import { LifeClock } from './sim/lifeClock'
import { Needs } from './sim/needs/needs'
import { Economy } from './economy/economy'
import { InputTap } from './inputTap'
import { WorldDriver } from './sim/worldDriver'
import { worldParamsFor } from './sim/world/worldModel'
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

/** Bitbot's bundle ID (electron-builder.yml appId; decided 2026-10-08): its own app events are not activity. */
const BUNDLE_ID = 'com.bitbot.desktop'

/** System Settings → Privacy & Security → Input Monitoring (§15.1). */
const INPUT_MONITORING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'

/** The simulation's clock: pet:state's t and sentAt, PetInteraction and the activation monitor all use it. */
const clock = systemClock

/** Hooks for the M1 dev check (`electron . --check=overlay`, next phase). Production passes none. */
export interface BitbotAppOptions {
  /** The cursor PetInteraction and the eyes read, global pt (a synthetic one). Default: screen.getCursorScreenPoint(). */
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
  /**
   * The windows the world is built from, instead of the helper's (the dev check's made-up windows: the user's real
   * windows would make its results depend on the desktop). The helper's snapshots still pace the updates.
   */
  windows?: () => readonly HelperWindow[]
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
  /** Changes the dev panel's overrides as the panel would (dev builds; the check measures each idle style with it). */
  setDevOverrides(set: DevPanelSet): void
  /** Rebuilds the world from a fresh snapshot now (after changing options.windows). */
  refreshWorld(): void
  /** The helper's snapshot rate asked for now, Hz (null: none yet). */
  snapshotHz: number | null
  /** §10.3 the mode and the hangout spots (read only: change them as the menus do, with BitbotApp's methods). */
  modes: Pick<ModeState, 'mode' | 'active' | 'spots' | 'settings'>
  /** The newest reaction pet:state carries (petted, dizzy). */
  reaction: PetReaction | null
  /** The economy now (§7). */
  economy: EconomySnapshot
  /** Injects activity as the developer panel would. */
  inject(i: DevInject): void
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
  /** The cursor, global pt (options.cursor or the real one). */
  private readonly cursor: () => Point
  /** The developer panel's overrides; never changed in packaged builds (no panel). */
  private readonly overrides = new DevOverrideState()
  /** The world from bitbot-helper's snapshots, the snapshot rate, wandering, the debug view (sim/worldDriver.ts). */
  private readonly worldDriver: WorldDriver
  /** The economy (§7): every currency, anti-gaming, daily curves, the ledger (src/main/economy/). In memory until M8 saves it. */
  private readonly economy: Economy
  /** Every activity source, fed to the economy (activityIngest.ts). */
  private readonly ingest: ActivityIngest
  /** The helper's input tap, kept in step with the Input Monitoring grant (inputTap.ts). */
  private readonly inputTap: InputTap
  private trayTimer: ReturnType<typeof setInterval> | null = null
  /** The pet's life clock (real time × the dev time scale), needs, brain, and their coordinator (petLife.ts). */
  private readonly lifeClock = new LifeClock(() => Date.now())
  private readonly needs: Needs
  private readonly brain: Brain
  private readonly life: PetLife
  private lifeTimer: ReturnType<typeof setInterval> | null = null
  /** Dev builds only. */
  private readonly devPanel: DevPanel | null

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
  /** This wake's cursor, for its steps' look direction. */
  private wakeCursor: Point | null = null
  /** Where the eyes look (sim/look.ts), as of the newest step. */
  private look: LookDirection | null = null
  /** The newest reaction for pet:state (petted, dizzy), numbered so the overlay plays each once. */
  private reaction: PetReaction | null = null
  /** Where the pet was sent while it couldn't go (in the air, held): it goes when it stands again. */
  private pendingSend: Point | null = null
  /** §10.3 the mode and the hangout spots (M8 saves `modes.settings`). */
  private readonly modes = new ModeState()
  /** App names by bundle ID, from the helper's app events and appInfo (§10.3 "Hang out on <App>"; never window titles). */
  private readonly appNames = new Map<string, string>()
  private readonly appNamesAsked = new Set<string>()
  /** Dev builds: the last movement line logged (logMovement). */
  private lastMovementLine = ''
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
    this.needs = new Needs(tuning.needs, tuning.economy.activity.activeIdleS, undefined, this.lifeClock.now())
    this.brain = new Brain(tuning.brain, tuning.needs, Math.random)
    // §9.3 stuffed halves every payout.
    this.economy = new Economy({
      clock: { now: () => Date.now() },
      stuffedFactor: () => (this.needs.stuffed ? tuning.needs.stuffed.payoutFactor : 1),
    })
    this.life = new PetLife({
      clock: this.lifeClock,
      needs: this.needs,
      brain: this.brain,
      nutritionLifetime: () => this.economy.snapshot().nutritionLifetime,
      dayKey: () => this.economy.snapshot().day,
      systemIdleS: () => powerMonitor.getSystemIdleTime(),
      wallNowMs: () => Date.now(),
      react: (kind) => this.react(kind),
    })
    this.ingest = new ActivityIngest({
      sink: this.economy,
      scheduler: globalScheduler,
      cursor: options.cursor ?? (() => screen.getCursorScreenPoint()),
      systemIdleS: () => powerMonitor.getSystemIdleTime(),
      cursorPollHz: tuning.economy.cursorPollHz,
      idlePollS: tuning.economy.activity.idlePollS,
      ownBundleId: BUNDLE_ID,
      ownPid: process.pid,
      onError: (err, where) => this.throttled.log(`activity ${where}`, `[bitbot] activity (${where}) failed: ${errorText(err)}`),
    })
    this.inputTap = new InputTap({
      granted: async () => (await this.requireHelper().inputAccess()).listen,
      startTap: async () => {
        const tap = await this.requireHelper().startInputTap({ keys: true, mouse: true })
        return { active: tap.active, reason: tap.reason ?? tap.error }
      },
      scheduler: globalScheduler,
      pollS: tuning.app.inputAccessPollS,
      onChange: (counting) => {
        this.ingest.setInputCounting(counting)
        this.tray.refresh()
      },
      log: (line) => this.log(line),
    })
    this.worldDriver = new WorldDriver({
      params: worldParamsFor(tuning.render.bodyHeightPt[PET.size], process.pid),
      setPollRate: (hz) => this.helper?.setPollRate(hz),
      sendDebug: this.dev ? (msg) => void this.petWindow.send(IPC.debugWorld, msg) : null,
      random: Math.random,
    })
    this.applyOverridesToWorld()
    this.states = new PetStateSender((msg) => {
      this.petWindow.send(IPC.petState, msg)
    })
    this.presented = new PresentedPoint(this.stepMs, { t: clock.now(), x: 0, y: 0 })
    this.cursor = options.cursor ?? (() => screen.getCursorScreenPoint())

    const injectedMenu = options.popupMenu
    this.interaction = new PetInteraction({
      hitWindow: this.hitWindow,
      locomotion: {
        grab: () => {
          if (!this.loco) throw new Error('the pet has no place yet')
          this.pendingSend = null // the user has it now
          this.life.interaction('drag')
          this.loco.grab()
        },
        release: (at, how) => {
          this.loco?.release(at, how)
          if (how === 'click') {
            this.react('petted')
            this.life.interaction('pet')
          }
        },
      },
      tuning: tuning.hitArea,
      now: () => clock.now(),
      cursor: () => this.cursor(),
      displayedPoint: (nowMs) => drawnPoint(this.presented, nowMs, this.heldPoint()),
      // Turned with the pet while it climbs (boxFor), so the grab area and the safety net follow it onto a wall.
      petBox: () => (this.ready ? boxFor(this.ready.petBox, this.loco?.state.attach ?? 'floor') : null),
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
        this.wakeCursor = this.cursor()
      },
      onStep: (dtS, t) => this.step(dtS, t),
      afterSteps: (wakeMs) => {
        this.watchAppHidden()
        this.worldDriver.tick(wakeMs, this.loco)
        this.tickBrain()
        if (this.dev) this.logMovement()
        this.interaction.tick(wakeMs)
        this.observe()
        this.devPanel?.refresh()
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

    this.devPanel = this.dev
      ? new DevPanel({
          status: () => this.devPanelStatus(),
          apply: (set) => this.applyDevPanelSet(set),
          action: (action) => this.worldDriver.action(action, this.loco),
          inject: (i) => this.ingest.inject(i),
          requestOverlayStats: (timeoutMs) => this.requestOverlayStats(timeoutMs),
          log: (line) => this.log(line),
          warn: (key, line) => this.throttled.log(key, line),
        })
      : null
    const devPanel = this.devPanel
    this.tray = new BitbotTray({
      actions: {
        toggleVisible: () => this.toggleVisible('tray menu'),
        comeHere: () => this.comeHere('tray menu'),
        goHome: () => this.goHome('tray menu'),
        setMode: (mode) => this.setMode(mode, 'tray menu'),
        selectSpot: (id) => this.selectSpot(id),
        forgetSpot: (id) => this.forgetSpot(id),
        turnOnInputMonitoring: () => void this.turnOnInputMonitoring(),
        // Dev builds only: the menu has no "Developer…" without it.
        ...(devPanel ? { developer: () => this.guarded('dev panel', () => devPanel.open()) } : {}),
        quit: () => void this.quit('tray menu'),
      },
      accelerator: (action) => this.hotkeys.accelerator(action),
      today: () => {
        const c = this.economy.snapshot().currencies
        return { crumbs: c.crumbs.earned, pellets: c.pellets.earned, treats: c.treats.earned, mileage: c.mileage.earned, sparks: c.sparks.earned }
      },
      inputMonitoringOff: () => this.helper !== null && !this.inputTap.isCounting,
      mode: () => ({
        current: this.modes.mode,
        spots: this.modes.spots.map((s) => ({ id: s.id, name: s.name })),
        activeSpotId: this.modes.active?.id ?? null,
      }),
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
    this.ingest.start()
    // The tray's "Today:" line follows the economy (rebuilt only when a whole number changes).
    this.trayTimer = setInterval(() => this.guarded('tray refresh', () => this.tray.refresh()), tuning.app.trayRefreshMs)
    this.trayTimer.unref()
    this.lifeTimer = setInterval(() => this.guarded('life tick', () => this.tickLife()), 1000 / tuning.needs.hiddenTickHz)
    this.lifeTimer.unref()
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
    this.worldDriver.setHidden(false, clock.now(), this.loco)
    this.refreshWorld()
    this.snap()
    this.interaction.invalidateOnScreen()
    this.observe()
    this.petWindow.send(IPC.petVisible, { visible: true, epoch: this.interaction.epoch } satisfies PetVisibleMsg)
    this.appHidden = app.isHidden()
    this.tray.update(this.isPetVisible())
    this.devPanel?.refresh()
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
    // §8.6 "while hidden, the simulation continues at low rate": the 30 Hz loop parks; the needs keep ticking on their own
    // timer (tuning.needs.hiddenTickHz) and the economy on its activity sources.
    this.loop.stop()
    this.worldDriver.setHidden(true, clock.now(), this.loco)
    this.tray.update(false)
    this.devPanel?.refresh()
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
    this.guarded('quit: activity', () => {
      this.ingest.stop()
      this.inputTap.stop()
      if (this.trayTimer !== null) clearInterval(this.trayTimer)
      this.trayTimer = null
      if (this.lifeTimer !== null) clearInterval(this.lifeTimer)
      this.lifeTimer = null
    })
    await this.stopHelper()
    this.guarded('quit: dev panel', () => this.devPanel?.destroy())
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
      setDevOverrides: (set) => this.applyDevPanelSet(set),
      refreshWorld: () => this.refreshWorld(),
      snapshotHz: this.worldDriver.snapshotHz,
      modes: this.modes,
      reaction: this.reaction ? { ...this.reaction } : null,
      economy: this.economy.snapshot(),
      inject: (i) => this.ingest.inject(i),
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
    for (const e of loco.drainEvents()) {
      if (e.kind === 'toss' && this.dev) this.log(`[bitbot] pet: tossed at ${Math.hypot(e.vx, e.vy).toFixed(0)} pt/s`)
      // §10.4 "it lands, maybe dizzy if thrown hard".
      if (e.kind === 'land' && e.tossSpeed !== null && e.tossSpeed >= tuning.move.toss.dizzySpeed) this.react('dizzy')
    }
    const pending = this.pendingSend
    if (pending && (loco.state.behavior === 'idle' || loco.state.behavior === 'land') && loco.goTo(pending)) this.pendingSend = null
    this.presented.push(t, loco.state)
    const box = this.ready?.petBox
    const cursor = this.wakeCursor
    this.look = box && cursor ? lookDirection(cursor, loco.state, box, this.look, tuning.anim.look) : null
    this.states.offer(this.simState(loco), t, clock.now())
  }

  /** pet:state's fields: the simulation's, with the dev panel's overrides (dev/devOverrides.ts) applied. */
  private simState(loco: Locomotion): PetSimState {
    const s = loco.state
    const f = this.shownFields()
    return {
      x: s.x,
      y: s.y,
      facing: f.facing,
      state: f.state,
      mood: f.mood,
      dust: f.dust,
      look: this.look,
      attach: s.attach,
      reaction: this.reaction,
      supportY: loco.supportY,
    }
  }

  /** Dev builds: one line whenever the pet's behavior, surface or goal changes (window ids and points only, never titles). */
  private logMovement(): void {
    const loco = this.loco
    if (!loco) return
    const s = loco.state
    const g = loco.goal
    const line = `${s.behavior} on ${s.surface ?? 'nothing'}${g ? ` → ${g.x.toFixed(0)},${g.y.toFixed(0)}` : ''}`
    if (line === this.lastMovementLine) return
    this.lastMovementLine = line
    this.log(`[bitbot] pet: ${line} at ${s.x.toFixed(0)},${s.y.toFixed(0)}`)
  }

  /** The running helper; throws without one (InputTap catches it as "not granted"). */
  private requireHelper(): HelperClient {
    const helper = this.helper
    if (!helper) throw new Error('bitbot-helper is not running')
    return helper
  }

  /**
   * The tray's "Input Monitoring is off — Turn on…" (§7.1, §15.1): asks for it (macOS shows its prompt once, the first
   * time), then opens its pane in System Settings. InputTap notices the grant by itself and starts counting.
   */
  private async turnOnInputMonitoring(): Promise<void> {
    try {
      await this.helper?.requestInputAccess()
    } catch (err) {
      this.throttled.log('request input access', `[bitbot] asking for Input Monitoring failed: ${errorText(err)}`)
    }
    await shell.openExternal(INPUT_MONITORING_PANE).catch((err: unknown) => this.log(`[bitbot] could not open System Settings: ${errorText(err)}`))
  }

  /** A reaction the overlay plays once (petting: §10.4; boredom −30 comes with the needs model, M6). */
  private react(kind: PetReactionKind): void {
    this.reaction = { kind, seq: (this.reaction?.seq ?? 0) + 1 }
    if (this.dev) this.log(`[bitbot] pet: ${kind}`)
  }

  /** §10.4 Come here: walks or climbs to the reachable point nearest the cursor. */
  comeHere(source: string): void {
    const loco = this.loco
    if (!loco || !this.isPetVisible()) return
    const cursor = this.opts.cursor ? this.opts.cursor() : screen.getCursorScreenPoint()
    this.sendTo(cursor, `come here (${source})`)
  }

  /** §10.4 Go home: to the active hangout spot, else the default home on the ground. */
  goHome(source: string): void {
    const loco = this.loco
    if (!loco || !this.isPetVisible()) return
    this.sendTo(this.modes.home(this.spotLookup(loco.area)), `go home (${source})`)
  }

  /** §10.3 Roam, or Stay where it is now (it stops walking; commands and drops still move it). */
  setMode(mode: 'roam' | 'stay', source: string): void {
    const loco = this.loco
    this.modes.setMode(mode, loco ? { x: loco.state.x, y: loco.state.y } : undefined)
    if (mode === 'stay') this.stayPut()
    this.modeChanged(`${mode} (${source})`)
  }

  /** §10.5 ⌥⌘S: Stay, or back to the mode before it. */
  toggleStay(source: string): void {
    const loco = this.loco
    this.modes.toggleStay(loco ? { x: loco.state.x, y: loco.state.y } : undefined)
    if (this.modes.mode === 'stay') this.stayPut()
    this.modeChanged(`toggle Stay → ${this.modes.mode} (${source})`)
  }

  /** "Hang out here" (§10.3): a screen spot where the pet stands (on the surface under it while in the air). */
  hangOutHere(source: string): void {
    const loco = this.loco
    if (!loco) return
    const p = { x: loco.state.x, y: loco.state.surface !== null ? loco.state.y : (loco.supportY ?? loco.area.groundY) }
    const spot = this.modes.hangOutHere(p, (this.display ?? primaryDisplay()).id, loco.area)
    this.modeChanged(`hang out at "${spot.name}" (${source})`)
  }

  /** "Hang out on <App>" (§10.3): an app-anchored spot where the pet stands along that app's window top. */
  hangOutOnApp(source: string): void {
    const on = this.worldDriver.standingOn(this.loco)
    if (!on) return
    const spot = this.modes.hangOutOnApp(on.bundleId, this.appNameFor(on.bundleId, on.pid), on.relativeX)
    this.modeChanged(`hang out on "${spot.name}" (${source})`)
  }

  selectSpot(id: string): void {
    if (this.modes.selectSpot(id)) this.modeChanged(`hang out at "${this.modes.active?.name ?? id}" (tray menu)`)
  }

  forgetSpot(id: string): void {
    this.modes.forgetSpot(id)
    this.modeChanged(`forgot a spot (tray menu)`)
  }

  /** Stay: stops where it is (in the air it lands first, then stays). */
  private stayPut(): void {
    this.pendingSend = null
    this.loco?.stop()
  }

  private modeChanged(why: string): void {
    this.life.modeChanged()
    this.tray.refresh()
    if (this.dev) this.log(`[bitbot] mode: ${why}`)
  }

  /** The default home (§10.4): the middle of the Dock unless settings choose a spot (M8). */
  private defaultHome(a: PetArea): Point {
    return { x: a.minX + tuning.brain.homeX * (a.maxX - a.minX), y: a.groundY }
  }

  private spotLookup(a: PetArea): SpotLookup {
    return { appSpot: (bundleId, relativeX) => this.worldDriver.appSpot(bundleId, relativeX), defaultHome: this.defaultHome(a) }
  }

  /**
   * An app's name for "Hang out on <App>": from the helper's app events, else asked of the helper once (for next time)
   * with the bundle ID's last part meanwhile ("com.apple.Notes" → "Notes").
   */
  private appNameFor(bundleId: string, pid: number): string {
    const known = this.appNames.get(bundleId)
    if (known) return known
    const helper = this.helper
    if (helper?.isRunning && !this.appNamesAsked.has(bundleId)) {
      this.appNamesAsked.add(bundleId)
      helper.appInfo(pid).then(
        (info) => {
          if (info.appName && info.bundleId === bundleId) this.appNames.set(bundleId, info.appName)
        },
        () => this.appNamesAsked.delete(bundleId),
      )
    }
    return bundleId.split('.').pop() || bundleId
  }

  private rememberAppName(bundleId: string | null, appName: string | null): void {
    if (bundleId && appName) this.appNames.set(bundleId, appName)
  }

  /** Sends the pet to `p` (or the reachable place nearest it); a pet in the air or held goes once it can. */
  private sendTo(p: Point, why: string): void {
    const loco = this.loco
    if (!loco) return
    // A command (§9.1 an interaction): the brain lets go of its own plan first.
    this.life.interaction('command')
    const ok = loco.goTo(p)
    this.pendingSend = ok ? null : { ...p }
    if (this.dev) this.log(`[bitbot] ${why}: ${ok ? 'on its way' : 'it goes once it can'}`)
  }

  /** Asks the helper for a snapshot now (the pet was shown or created: the world may be stale), off the push schedule. */
  private refreshWorld(): void {
    const helper = this.helper
    if (!helper?.isRunning) return
    helper.snapshot().then(
      (m) => this.guarded('window snapshot', () => this.worldDriver.onSnapshot(this.worldWindows(m.windows), clock.now(), this.loco)),
      (err: unknown) => this.throttled.log('world refresh', `[bitbot] window snapshot failed: ${errorText(err)}`),
    )
  }

  /** The windows the world uses: the helper's, or the dev check's made-up ones (options.windows). */
  private worldWindows(fromHelper: readonly HelperWindow[]): readonly HelperWindow[] {
    return this.opts.windows ? this.opts.windows() : fromHelper
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
    const world = this.worldDriver.setScene(display, msg.petBox, this.loco, clock.now())
    this.worldDriver.pageReady()
    if (!this.loco) {
      const x = this.opts.spawnX
      this.loco = new Locomotion(world, tuning.move, x !== undefined && Number.isFinite(x) ? { x, y: area.groundY } : undefined)
    } else {
      this.loco.setWorld(world, clock.now())
    }
    // The first page learns the pet's area here (its box decides it); the grab area waits until it drew with it.
    if (!sameArea(this.petWindow.lastConfig?.area ?? null, area)) this.petWindow.sendConfigChanged()
    this.states.setReady(true)
    // A fresh page starts with the overlay's defaults.
    this.sendDevPet()
    if (this.hiddenByUser) {
      this.petWindow.send(IPC.petVisible, { visible: false, epoch: this.interaction.epoch } satisfies PetVisibleMsg)
    } else {
      // Not while macOS hides Bitbot: showInactive() would unhide it (see showPet()).
      if (!app.isHidden()) this.petWindow.showInactive()
      this.loop.start()
    }
    this.refreshWorld()
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

  /** The native pet menu (§15.3, the M7 subset: petContextMenu.ts) over the grab area, at the cursor. */
  private popupPetMenu(onClose: () => void): void {
    const win = this.hitWindow.window
    if (!win) throw new Error('there is no grab area to open the menu over')
    const on = this.worldDriver.standingOn(this.loco)
    const menu = Menu.buildFromTemplate(
      petContextMenuTemplate({ mode: this.modes.mode, onApp: on ? this.appNameFor(on.bundleId, on.pid) : null }, {
        pet: () => {
          this.activation.menuChoice('Pet')
          this.react('petted')
          this.life.interaction('pet')
        },
        stayHere: () => {
          this.activation.menuChoice('Stay here')
          this.setMode('stay', 'pet menu')
        },
        roam: () => {
          this.activation.menuChoice('Roam')
          this.setMode('roam', 'pet menu')
        },
        hangOutHere: () => {
          this.activation.menuChoice('Hang out here')
          this.hangOutHere('pet menu')
        },
        hangOutOnApp: () => {
          this.activation.menuChoice('Hang out on app')
          this.hangOutOnApp('pet menu')
        },
        goHome: () => {
          this.activation.menuChoice('Go home')
          this.goHome('pet menu')
        },
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
    helper.on('hello', (m) => {
      this.log(`[bitbot] helper hello: pid ${m.pid}, protocol ${m.version}`)
      this.inputTap.helperReady()
    })
    // Keys, clicks and scrolls (§7.1, counted; never logged), and §10.4 Send to cursor: only ⌥⌘-clicks carry a location.
    helper.on('input', (m) => {
      this.ingest.input(m)
      if (tuning.app.altCmdClickSend && m.kind === 'mouseDown' && m.button === 0 && m.alt && m.cmd && m.x !== null && m.y !== null) {
        this.guarded('⌥⌘-click', () => this.sendTo({ x: m.x as number, y: m.y as number }, '⌥⌘-click'))
      }
    })
    helper.on('appLaunched', (m) => {
      this.ingest.appLaunched(m.bundleId, m.pid)
      this.rememberAppName(m.bundleId, m.appName)
      // §10.2 run to the new app's window and eat (not for Bitbot itself).
      if (m.bundleId && m.pid !== process.pid && m.bundleId !== BUNDLE_ID) this.life.appLaunched(m.bundleId, this.worldDriver.windowTopFor(m.bundleId))
    })
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
    helper.on('appActivated', (m) => {
      this.interaction.invalidateOnScreen()
      this.observe()
      this.ingest.appActivated(m.bundleId, m.pid)
      this.rememberAppName(m.bundleId, m.appName)
    })
    // The world (§8): pushed at the rate WorldDriver sets (none until the pet exists, none while hidden).
    helper.on('snapshot', (m) => this.guarded('window snapshot', () => this.worldDriver.onSnapshot(this.worldWindows(m.windows), clock.now(), this.loco)))
    this.helper = helper
    helper.start()
  }

  private onHelperExit(info: HelperExitInfo): void {
    const why = info.error ?? (info.signal !== null ? `signal ${info.signal}` : `exit code ${info.code ?? 'unknown'}`)
    this.log(`[bitbot] helper exited (${why})${info.willRestart ? `; restarting in ${info.restartInMs ?? '?'} ms` : ''}`)
    this.inputTap.helperGone()
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
    const result = this.hotkeys.register({
      toggleVisible: () => this.toggleVisible('⌥⌘B'),
      comeHere: () => this.comeHere('⌥⌘C'),
      goHome: () => this.goHome('⌥⌘H'),
      toggleStay: () => this.toggleStay('⌥⌘S'),
    })
    for (const action of result.registered) this.log(`[bitbot] hotkey registered: ${DEFAULT_HOTKEYS[action]} (${action})`)
    for (const action of result.failed) {
      this.log(`[bitbot] hotkey NOT registered: ${DEFAULT_HOTKEYS[action]} (${action}); another app may own it`)
    }
  }

  private watchSystem(): void {
    powerMonitor.on('lock-screen', () => this.cancel('the screen locked'))
    powerMonitor.on('suspend', () => {
      this.cancel('the Mac is going to sleep')
      this.life.suspend()
    })
    powerMonitor.on('user-did-resign-active', () => this.cancel('the user session became inactive'))
    powerMonitor.on('resume', () => {
      // Timers and the overlay's renderer both paused during the sleep: the pings missed meanwhile don't count.
      this.petWindow.resetWatchdog()
      this.redraw('woke from sleep')
      this.life.resume()
      this.ingest.wake()
    })
    powerMonitor.on('unlock-screen', () => {
      this.redraw('the screen unlocked')
      this.ingest.wake()
    })
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
    const box = this.ready?.petBox
    if (box) this.worldDriver.setScene(display, box, this.loco, clock.now())
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

  // ───────────────────────────── developer panel ─────────────────────────────

  /** The app's part of the panel's status. */
  private devPanelStatus(): DevPanelAppStatus {
    const behavior = this.loco?.state.behavior ?? 'idle'
    const f = this.shownFields()
    return {
      overrides: this.overrides.overrides,
      state: f.state,
      simState: behavior,
      look: this.look,
      visible: this.isPetVisible(),
      world: this.worldDriver.status(this.loco),
      economy: this.economy.snapshot(),
      life: this.loco ? this.life.snapshot(this.overrides.current.timeScale) : null,
    }
  }

  /** A validated debug:panel-set. pet:state carries the change with the next step (or the snap when shown again). */
  private applyDevPanelSet(set: DevPanelSet): void {
    const change = this.overrides.apply(set)
    if (change.petChanged) this.sendDevPet()
    this.applyOverridesToWorld()
  }

  /** The debug view while "show world" is on (dev builds); the life clock's time scale (1 in packaged builds). */
  private applyOverridesToWorld(): void {
    const o = this.overrides.current
    this.worldDriver.setShowWorld(this.dev && o.showWorld)
    this.lifeClock.setScale(this.dev ? o.timeScale : 1)
  }

  /**
   * pet:state's state, facing, mood and dust (§10.1 resolveState over the brain's activity; the needs' mood and dust),
   * with the dev panel's overrides where it forces something.
   */
  private shownFields(): { state: BehaviorState; facing: 1 | -1; mood: Mood; dust: number } {
    const o = this.overrides.current
    const s = this.loco?.state
    const behavior = s?.behavior ?? 'idle'
    const f = overriddenFields(o, { behavior, facing: s?.facing ?? 1, mood: this.life.mood(), dust: this.life.dust })
    return { state: this.life.stateFor(behavior, o.state), facing: f.facing, mood: f.mood, dust: f.dust }
  }

  /** Each simulation wake: a launched app's window, the stuffed speed, the brain (when it acts by itself). */
  private tickBrain(): void {
    const loco = this.loco
    if (!loco) return
    const launch = this.life.pendingLaunch
    if (launch) {
      const top = this.worldDriver.windowTopFor(launch)
      if (top) this.life.launchTarget(top)
    }
    loco.setSpeedFactor(this.life.stuffed ? tuning.move.stuffedSpeedFactor : 1)
    const o = this.overrides.current
    const mode = this.modes.mode
    const spot = mode === 'hangout' ? this.modes.active : null
    const lookup = this.spotLookup(loco.area)
    const centre = spot ? this.modes.spotPoint(spot, lookup).point : null
    this.life.tickBrain(loco, {
      cursor: this.opts.cursor ? this.opts.cursor() : screen.getCursorScreenPoint(),
      home: centre ?? this.defaultHome(loco.area),
      foodSpot: this.worldDriver.foodSpot(),
      enabled: o.wander && o.state === null && this.pendingSend === null,
      mode,
      hangout: centre ? { centre, radiusPt: tuning.brain.hangoutRadiusPt } : null,
    })
    // §10.4 Stay: wherever it comes to rest (a drop, a command, a fall) is where it stays.
    const s = loco.state
    if (mode === 'stay' && s.behavior === 'idle' && s.surface !== null) this.modes.stayAt({ x: s.x, y: s.y })
  }

  /** The life tick (tuning.needs.hiddenTickHz, shown or hidden): needs, sleep, economy events, the asleep snapshot rate. */
  private tickLife(): void {
    this.life.advance()
    for (const e of this.economy.drainEvents()) this.life.economyEvent(e)
    this.worldDriver.setAsleep(this.life.asleep, clock.now(), this.loco)
  }

  /** debug:pet (dev builds only): the overrides the overlay applies itself. */
  private sendDevPet(): void {
    if (!this.dev) return
    this.petWindow.send(IPC.debugPet, devPetMsg(this.overrides.current))
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
