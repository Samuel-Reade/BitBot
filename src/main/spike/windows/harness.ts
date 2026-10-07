// Spike B windows harness (BITBOT_SPEC.md §12 Spike B; §5.3 helper, §8.2 eligibility, §8.6 fullscreen,
// §11 helper budget). Throwaway, but it is the evidence for: the helper's window bounds and z-order are
// right on a Retina display and line up with Electron's screen API; app launch notifications arrive;
// the overlay level sits between normal windows and system UI; which process macOS attributes the
// helper's permissions to (dev vs packaged); what the helper costs at 4 and 15 Hz.
//
// Flow: resolve the Window Server pid (§8.2) → start bitbot-helper through HelperClient → (optional)
// debug overlay + coordinate probe window → automated checks (displays, probe positions, overlay bounds,
// ownership, levels, z-order, capture, a latency burst, optional Calculator launch/terminate) → helper
// CPU at 4 Hz then 15 Hz (edge-aligned `ps` cputime, each phase followed by a latency burst) → results.
// The overlay's presence in every snapshot is logged independently of the helper's fullscreen verdict.
// See spikes/README-input-helper.md.
//
// Never steals focus (§2): windows are non-focusable, shown with showInactive() and click-through;
// Calculator is launched with `open -g`. Privacy: logs bounds, layers, pids, bundle ids and app names
// only (never window titles, §2/§5.3).

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type Rectangle,
} from 'electron'
import {
  SPIKE_WINDOWS_IPC,
  isDebugDrawnMsg,
  isDebugReadyMsg,
  type DebugCursorMsg,
  type DebugProbeMsg,
  type DebugReadyMsg,
  type DebugSceneMsg,
  type DebugStatusMsg,
} from '../../../shared/spikeWindows'
import { tuning } from '../../../shared/tuning'
import type { HelperClient, HelperExitInfo } from '../../helper/helperClient'
import {
  HELPER_PROTOCOL_VERSION,
  type AppEventMsg,
  type AppEventType,
  type DiagMsg,
  type DisplayInfo,
  type FrontmostFullscreenMsg,
  type HelloMsg,
  type InputAccessMsg,
  type SnapshotMsg,
} from '../../helper/protocol'
import { loadPage, preloadPath } from '../../pages'
import {
  classifyLevels,
  compareDisplays,
  compareRects,
  firstLayerOrderViolation,
  formatDelta,
  formatRect,
  formatZOrderEntry,
  fullscreenVerdict,
  levelVerdict,
  parseMediaSourceId,
  probePositions,
  type CheckResult,
  type CheckStatus,
  type DisplayComparison,
  type LevelReport,
  type PresenceChange,
  type RectDelta,
} from './checks'
import {
  appIdentity,
  createHelperClient,
  defaultResultsDir,
  helperBinaryPath,
  installSignalHandlers,
  processAlive,
  sleep,
  SpikeLog,
  waitForHello,
  withTimeout,
  type AppIdentity,
} from './common'
import { buildScene, electronRect, helperRect, windowEligibility, type EligibilityRules } from './eligibility'
import { errorText, localStamp } from './format'
import {
  PS_CPU_TIME_QUANTUM_S,
  bestCpuEstimate,
  deltaCpuEstimate,
  edgeCpuEstimate,
  formatCpuEstimate,
  formatCpuPhase,
  formatLatency,
  formatSummary,
  parsePsLine,
  planCpuPhases,
  round,
  summarize,
  type CpuEstimate,
  type CpuTimeReading,
  type LatencyBurst,
  type PsSample,
} from './measure'
import type { WindowsSpikeOptions } from './options'

const T = tuning.spikeWindows
const TAG = '[spike:windows]'
const RESULTS_SCHEMA = 'bitbot-spike-windows/2'
/** The Window Server's process name (macOS platform constant). */
const WINDOW_SERVER_PROCESS = 'WindowServer'
const execFileAsync = promisify(execFile)
const now = (): number => performance.now()

interface CoordinateRow {
  name: string
  requested: { x: number; y: number; w: number; h: number }
  electron: { x: number; y: number; w: number; h: number }
  helper: { x: number; y: number; w: number; h: number } | null
  delta: RectDelta | null
  /** macOS moved/resized the window away from the requested frame (informational). */
  constrained: boolean
  attempts: number
  pass: boolean
}

interface CpuPhaseResult {
  hz: number
  plannedS: number
  wallS: number
  helperPid: number | null
  /** The tighter of `edges` and `delta`: the phase's CPU figure. */
  estimate: CpuEstimate | null
  edges: CpuEstimate | null
  delta: CpuEstimate | null
  /** `ps -o time=` readings (s; cputime rounded to 10 ms) the estimates come from. */
  readings: CpuTimeReading[]
  /**
   * `ps %cpu`: the scheduler's decaying average, printed to 0.1. NOT a CPU figure: it lags rate changes
   * and read 0.6-0.7× the true helper CPU at 4 Hz. Kept as a diagnostic only.
   */
  psPcpuDiagnostic: { samples: number[]; mean: number | null }
  pushes: number
  pushRateHz: number | null
  note: string | null
}

interface FullscreenRecord {
  tRunS: number
  initial: boolean
  value: boolean
  bundleId: string | null
  displayIds: number[]
  overlayOnScreen: boolean | null
}

interface AppEventRecord {
  tRunS: number
  type: AppEventType
  bundleId: string | null
  pid: number
  appName: string | null
}

interface AppTestResult {
  launchedPid: number | null
  appLaunchedMs: number | null
  appTerminatedMs: number | null
  cleanedUpPids: number[]
}

type AppWaiter = (message: AppEventMsg) => void

export class WindowsHarness {
  private readonly log = new SpikeLog(TAG)
  private readonly startedAt = new Date()
  private readonly t0 = now()
  private rules: EligibilityRules = {
    minSize: tuning.world.minWindowSize,
    excludedBundleIds: tuning.world.excludedBundleIds,
    windowServerPids: [],
    ownPids: [process.pid],
    minAlpha: T.eligibleMinAlpha,
  }
  private readonly checks: CheckResult[] = []
  private readonly errors: string[] = []
  private readonly detachers: (() => void)[] = []
  private readonly intervals: ReturnType<typeof setInterval>[] = []
  private readonly timeouts = new Set<ReturnType<typeof setTimeout>>()
  private finishing = false
  private deadlineMs: number | null = null
  private hardStopTimer: ReturnType<typeof setTimeout> | null = null
  private resultsFile = ''
  private identity: AppIdentity | null = null

  private helper: HelperClient | null = null
  private helperPath = ''
  private hello: HelloMsg | null = null
  private diag: DiagMsg | null = null
  private access: InputAccessMsg | null = null
  private helperDisplays: DisplayInfo[] = []
  private readonly helperExits: HelperExitInfo[] = []
  private readonly helperStderr: string[] = []
  private protocolErrors = 0

  private overlay: BrowserWindow | null = null
  private probe: BrowserWindow | null = null
  private overlayWid: number | null = null
  private probeWid: number | null = null
  private overlayOrigin = { x: 0, y: 0 }
  private overlayReady: DebugReadyMsg | null = null
  private probeReady: DebugReadyMsg | null = null
  private readonly readyWaiters = new Map<number, (msg: DebugReadyMsg) => void>()
  private drawnSeq = 0
  private sceneSeq = 0
  private lastScene: DebugSceneMsg | null = null
  private latestSnapshot: SnapshotMsg | null = null
  private pushes = 0

  private readonly appWaiters = new Set<AppWaiter>()
  private readonly appEvents: AppEventRecord[] = []
  /** Apps this run launched (and so may terminate). */
  private readonly launchedPids = new Set<number>()
  /** Newest appActivated (context for the overlay-presence lines). */
  private lastActivated: { bundleId: string | null; tRunS: number } | null = null
  private readonly fullscreen: FullscreenRecord[] = []
  /** Newest frontmostFullscreen value from the helper (null until its initial state arrives). */
  private lastHelperFullscreen: boolean | null = null
  /** Whether the overlay is in the newest snapshot's on-screen list (null until it first could be). */
  private overlayPresent: boolean | null = null
  private readonly presenceChanges: PresenceChange[] = []
  private readonly coordinateRows: CoordinateRow[] = []
  private overlayBounds: CoordinateRow | null = null
  private displayComparison: DisplayComparison | null = null
  private levels: LevelReport | null = null
  private zOrder: string[] = []
  private readonly latencyBursts: LatencyBurst[] = []
  private latencyRecorded = false
  private readonly cpuPhases: CpuPhaseResult[] = []
  private appTest: AppTestResult | null = null
  private capturePath: string | null = null

  constructor(private readonly options: WindowsSpikeOptions) {}

  async run(): Promise<void> {
    const o = this.options
    const resultsDir = o.resultsDir ?? defaultResultsDir()
    const base = `windows-${o.label ?? localStamp(this.startedAt)}`
    this.resultsFile = join(resultsDir, `${base}.json`)
    this.log.mirrorTo(join(resultsDir, `${base}.log`))
    this.installHandlers()
    try {
      const id = appIdentity()
      this.identity = id
      this.log.line(
        `start duration=${o.durationS > 0 ? `${o.durationS}s` : 'until quit'} overlay=${o.overlay} window-type=${o.windowType} ` +
          `auto-app-test=${o.autoAppTest} capture=${o.capture ?? 'no'} cpu-phase-s=${o.cpuPhaseS ?? 'auto'}`,
      )
      this.log.line(
        `app isPackaged=${id.isPackaged} pid=${id.pid} ppid=${id.ppid} bundleId=${id.bundleId ?? '-'} bundle=${id.bundlePath ?? '-'} ` +
          `execPath=${id.execPath} electron=${id.versions.electron ?? '-'} arch=${id.arch}`,
      )
      this.log.line(`app appPath=${id.appPath} resourcesPath=${id.resourcesPath} logs=${id.logsPath} cwd=${id.cwd}`)
      this.log.line(`results → ${this.resultsFile}`)
      if (o.durationS > 0) {
        this.deadlineMs = this.t0 + o.durationS * 1000
        this.scheduleHardStop()
      }

      await this.resolveWindowServer()
      await this.startHelper()
      if (this.finishing) return
      await this.startWindows()
      if (this.finishing) return
      await this.runChecks()
      if (this.finishing) return
      await this.runCpuPhases()
      if (this.finishing) return
      this.recordLatency()
      if (this.deadlineMs === null) {
        this.log.line('checks done; running until Ctrl+C / SIGTERM')
        return
      }
      while (!this.finishing && now() < this.deadlineMs) await sleep(Math.min(250, this.deadlineMs - now()))
      await this.finish('duration')
    } catch (err) {
      if (this.finishing) return
      this.error(`run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      await this.finish('error')
    }
  }

  // ───────────────────────────── helper ─────────────────────────────

  /**
   * §8.2 excludes Window Server windows, which the helper reports with bundleId null: the eligibility
   * rule excludes them by pid. WindowServer runs for the whole login session, so one lookup suffices.
   */
  private async resolveWindowServer(): Promise<void> {
    const pids = await pgrep(WINDOW_SERVER_PROCESS)
    this.rules = { ...this.rules, windowServerPids: pids }
    if (pids.length > 0) {
      this.log.line(`Window Server pid ${pids.join(',')}: its windows are §8.2-excluded by pid (the helper gives them no bundle id)`)
    } else {
      // SPEC-DEVIATION (§8.2): see windowEligibility; without the pid only the layer rule excludes them.
      this.record('Window Server pid', 'WARN', `pgrep -x ${WINDOW_SERVER_PROCESS} found nothing: its windows are excluded only by the layer rule`)
    }
  }

  private async startHelper(): Promise<void> {
    this.helperPath = helperBinaryPath()
    const helper = createHelperClient(this.helperPath, (err) => this.error(`helper listener failed: ${errorText(err)}`))
    this.helper = helper
    this.detachers.push(
      helper.on('exit', (info) => {
        this.helperExits.push(info)
        this.log.line(
          `helper exit code=${info.code} signal=${info.signal ?? '-'} error=${info.error ?? '-'} uptime=${info.uptimeMs}ms ` +
            `willRestart=${info.willRestart}${info.restartInMs !== null ? ` in ${info.restartInMs}ms` : ''}`,
        )
      }),
      helper.on('restart', (info) => this.log.line(`helper restart attempt=${info.attempt} pid=${info.pid ?? '-'}`)),
      helper.on('stderr', (line) => {
        if (this.helperStderr.length < 200) this.helperStderr.push(line)
        this.log.line(`helper stderr: ${line}`)
      }),
      helper.on('protocolError', (info) => {
        this.protocolErrors += 1
        this.log.line(`helper protocolError ${JSON.stringify(info)}`)
      }),
      helper.on('snapshot', (snapshot) => {
        this.pushes += 1
        this.onSnapshot(snapshot, 'push')
      }),
      helper.on('appLaunched', (message) => this.onAppEvent(message)),
      helper.on('appActivated', (message) => this.onAppEvent(message)),
      helper.on('appTerminated', (message) => this.onAppEvent(message)),
      helper.on('frontmostFullscreen', (message) => this.onFullscreen(message)),
    )

    const hello = waitForHello(helper, T.helloTimeoutMs)
    helper.start()
    try {
      this.hello = await hello
    } catch (err) {
      this.record('helper hello', 'FAIL', `${errorText(err)} (binary ${this.helperPath}; dev: run bash helper/build-helper.sh)`)
      throw err
    }
    const h = this.hello
    this.record(
      'helper hello',
      h.version === HELPER_PROTOCOL_VERSION ? 'PASS' : 'FAIL',
      `protocol ${h.version} (client expects ${HELPER_PROTOCOL_VERSION}), pid ${h.pid}, ${round(now() - this.t0, 0)} ms after start, binary ${this.helperPath}`,
    )

    const diag = await helper.diag()
    this.diag = diag
    this.log.line(
      `helper diag pid=${diag.pid} ppid=${diag.ppid} responsiblePid=${diag.responsiblePid ?? '-'} ` +
        `responsiblePath=${diag.responsiblePath ?? '-'} executablePath=${diag.executablePath ?? '-'} version=${diag.version}`,
    )
    this.checkAttribution(diag)

    this.access = await helper.inputAccess()
    this.log.line(
      `helper inputAccess (preflight only, never prompts) listen=${this.access.listen} post=${this.access.post} ` +
        `accessibility=${this.access.accessibility} — attributed to responsiblePid ${diag.responsiblePid ?? '-'}`,
    )

    this.helperDisplays = (await helper.displays()).displays
    helper.setPollRate(tuning.world.snapshotHz.normal)
  }

  /**
   * Which process TCC charges the helper's permission checks to (the Spike B attribution question).
   * Packaged and started by LaunchServices (`open`, Finder; parent pid 1) it must be Bitbot.app itself.
   * Started from a terminal, macOS charges the terminal / IDE app instead, packaged or not.
   */
  private checkAttribution(diag: DiagMsg): void {
    const id = this.identity
    const responsible = diag.responsiblePath ?? '(unknown)'
    const who = `helper's responsible process is pid ${diag.responsiblePid ?? '-'} ${responsible}`
    if (!id?.isPackaged) {
      this.record('TCC attribution', 'INFO', `dev run: ${who} (the app that launched Electron, not Bitbot)`)
      return
    }
    const bundle = id.bundlePath
    const ok = bundle !== null && responsible.startsWith(`${bundle}/`)
    const fromLaunchServices = id.ppid === 1
    const status: CheckStatus = ok ? 'PASS' : fromLaunchServices ? 'FAIL' : 'WARN'
    this.record(
      'TCC attribution',
      status,
      `packaged run (parent pid ${id.ppid}${fromLaunchServices ? ', launchd: started by open/Finder' : ', started from a terminal'}): ` +
        `${who}; expected inside ${bundle ?? '(no bundle)'}` +
        (ok || fromLaunchServices ? '' : ' — a terminal-started app is charged to the terminal app; start it with `open` or from Finder'),
    )
  }

  // ───────────────────────────── windows ─────────────────────────────

  private async startWindows(): Promise<void> {
    this.attachIpc()
    const primary = screen.getPrimaryDisplay()
    const display = primary.bounds

    if (this.options.overlay) {
      const overlay = this.createOverlayWindow(display)
      this.overlay = overlay
      const ready = this.waitReady(overlay)
      await loadPage(overlay, 'spikeDebug', { role: 'overlay' })
      overlay.showInactive()
      this.overlayReady = await ready
      const content = overlay.getContentBounds()
      this.overlayOrigin = { x: content.x, y: content.y }
      this.overlayWid = parseMediaSourceId(overlay.getMediaSourceId())
      this.log.line(
        `overlay wid=${this.overlayWid ?? '-'} bounds=${formatRect(electronRect(overlay.getBounds()))} ` +
          `(display ${formatRect(electronRect(display))}) page ${this.overlayReady.width}×${this.overlayReady.height} css px ` +
          `dpr=${this.overlayReady.dpr} (display scaleFactor ${primary.scaleFactor})`,
      )
      const sizeOk = this.overlayReady.width === content.width && this.overlayReady.height === content.height
      const dprOk = this.overlayReady.dpr === primary.scaleFactor
      this.record(
        'retina scale',
        sizeOk && dprOk ? 'PASS' : 'FAIL',
        `overlay page ${this.overlayReady.width}×${this.overlayReady.height} css px for a ${content.width}×${content.height} pt window; ` +
          `devicePixelRatio ${this.overlayReady.dpr} vs display scaleFactor ${primary.scaleFactor} (1 css px = 1 pt)`,
      )
      this.every(() => this.sendCursor(), 1000 / T.cursorHz)
      this.every(() => this.sendStatus(), T.statusIntervalMs)
    } else {
      this.record('retina scale', 'SKIP', '--overlay=false')
    }

    const wa = primary.workArea
    const start = {
      x: Math.round(wa.x + (wa.width - T.probe.width) / 2),
      y: Math.round(wa.y + (wa.height - T.probe.height) / 2),
    }
    const probe = this.createProbeWindow(start)
    this.probe = probe
    const probeReady = this.waitReady(probe)
    await loadPage(probe, 'spikeDebug', { role: 'probe' })
    probe.showInactive()
    this.probeReady = await probeReady
    this.probeWid = parseMediaSourceId(probe.getMediaSourceId())
    this.log.line(`probe wid=${this.probeWid ?? '-'} bounds=${formatRect(electronRect(probe.getBounds()))}`)
    this.sendProbeCaption('Bitbot coordinate probe')

    // A fullscreen app that was already frontmost at startup: check the overlay against it too.
    const last = this.fullscreen[this.fullscreen.length - 1]
    if (last?.value) this.scheduleOverlayPresenceCheck(last)
  }

  private webPreferences(): BrowserWindowConstructorOptions['webPreferences'] {
    return { preload: preloadPath(), sandbox: true, contextIsolation: true, backgroundThrottling: false }
  }

  /** §5.2 common settings, display-sized, floating level, click-through (Spike A's window.ts findings apply). */
  private createOverlayWindow(bounds: Rectangle): BrowserWindow {
    const options: BrowserWindowConstructorOptions = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      fullscreenable: false,
      hiddenInMissionControl: true,
      // Not in §5.2's list: without these AppKit keeps the frame below the menu bar and rounds the
      // corners, so the overlay would not cover the display's full bounds.
      enableLargerThanScreen: true,
      roundedCorners: false,
      webPreferences: this.webPreferences(),
    }
    if (this.options.windowType === 'panel') options.type = 'panel'
    const win = new BrowserWindow(options)
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true })
    win.setIgnoreMouseEvents(true)
    this.attachWebContentsEvents(win, 'overlay')
    return win
  }

  /** A small normal-level frameless window: its bounds are what the helper must report. */
  private createProbeWindow(at: { x: number; y: number }): BrowserWindow {
    const win = new BrowserWindow({
      x: at.x,
      y: at.y,
      width: T.probe.width,
      height: T.probe.height,
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      fullscreenable: false,
      hiddenInMissionControl: true,
      // The off-edge positions must not be pulled back on screen by AppKit.
      enableLargerThanScreen: true,
      roundedCorners: false,
      webPreferences: this.webPreferences(),
    })
    win.setIgnoreMouseEvents(true)
    this.attachWebContentsEvents(win, 'probe')
    return win
  }

  private attachWebContentsEvents(win: BrowserWindow, role: string): void {
    win.webContents.on('render-process-gone', (_event, details) => this.error(`${role} renderer gone: ${details.reason}`))
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') this.log.line(`${role} console ${event.level}: ${event.message}`)
    })
  }

  private attachIpc(): void {
    const onReady = (event: IpcMainEvent, payload: unknown): void => {
      if (!isDebugReadyMsg(payload)) return
      const resolve = this.readyWaiters.get(event.sender.id)
      if (resolve) {
        this.readyWaiters.delete(event.sender.id)
        resolve(payload)
      }
    }
    const onDrawn = (_event: IpcMainEvent, payload: unknown): void => {
      if (isDebugDrawnMsg(payload)) this.drawnSeq = Math.max(this.drawnSeq, payload.seq)
    }
    ipcMain.on(SPIKE_WINDOWS_IPC.ready, onReady)
    ipcMain.on(SPIKE_WINDOWS_IPC.drawn, onDrawn)
    this.detachers.push(
      () => ipcMain.off(SPIKE_WINDOWS_IPC.ready, onReady),
      () => ipcMain.off(SPIKE_WINDOWS_IPC.drawn, onDrawn),
    )
  }

  /** Resolves with the page's ready message. Call before loading the page; await after showing it. */
  private waitReady(win: BrowserWindow): Promise<DebugReadyMsg> {
    const id = win.webContents.id
    const promise = new Promise<DebugReadyMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(id)
        reject(new Error(`debug page did not report ready within ${T.rendererReadyMs} ms`))
      }, T.rendererReadyMs)
      this.readyWaiters.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
    // The caller awaits it after loadPage(); if loadPage throws first, this rejection is not unhandled.
    promise.catch(() => undefined)
    return promise
  }

  private onSnapshot(snapshot: SnapshotMsg, source: DebugSceneMsg['source']): void {
    this.latestSnapshot = snapshot
    this.trackOverlayPresence(snapshot)
    const overlay = this.overlay
    if (!overlay || overlay.isDestroyed() || !this.overlayReady) return
    const displays = screen.getAllDisplays()
    const scene = buildScene(snapshot.windows, snapshot.ts, {
      seq: ++this.sceneSeq,
      source,
      origin: this.overlayOrigin,
      rules: this.rules,
      displays: displays.map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor })),
      primaryDisplayId: screen.getPrimaryDisplay().id,
    })
    this.lastScene = scene
    overlay.webContents.send(SPIKE_WINDOWS_IPC.scene, scene)
  }

  /**
   * Logs every time the overlay enters or leaves the helper's on-screen list, from every snapshot and
   * independently of the helper's fullscreen verdict (§8.6): a fullscreen app the helper failed to detect
   * still shows up here, next to the user's action.
   */
  private trackOverlayPresence(snapshot: SnapshotMsg): void {
    const wid = this.overlayWid
    if (wid === null) return
    const present = snapshot.windows.some((w) => w.wid === wid)
    if (this.overlayPresent === present) return
    const initial = this.overlayPresent === null
    this.overlayPresent = present
    const change: PresenceChange = { tRunS: round(this.runSeconds(), 3), present, initial, helperFullscreen: this.lastHelperFullscreen }
    this.presenceChanges.push(change)
    const activated = this.lastActivated
    this.log.line(
      `overlay presence ${initial ? 'initial' : 'change'}: ${present ? 'IN' : 'NOT in'} the helper's on-screen list at +${change.tRunS.toFixed(1)} s ` +
        `(helper frontmostFullscreen=${this.lastHelperFullscreen ?? 'not reported yet'}; last appActivated ` +
        `${activated ? `${activated.bundleId ?? '-'} at +${activated.tRunS.toFixed(1)} s` : 'none this run'})`,
    )
  }

  private sendCursor(): void {
    const overlay = this.overlay
    if (!overlay || overlay.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const message: DebugCursorMsg = {
      x: point.x - this.overlayOrigin.x,
      y: point.y - this.overlayOrigin.y,
      gx: point.x,
      gy: point.y,
    }
    overlay.webContents.send(SPIKE_WINDOWS_IPC.cursor, message)
  }

  private sendStatus(): void {
    const overlay = this.overlay
    if (!overlay || overlay.isDestroyed()) return
    const snapshot = this.latestSnapshot
    const scene = this.lastScene
    const remaining = this.deadlineMs === null ? null : Math.max(0, Math.ceil((this.deadlineMs - now()) / 1000))
    const eligible = scene ? scene.windows.filter((w) => w.eligible).length : 0
    const checks = this.checks.filter((c) => c.status === 'PASS' || c.status === 'FAIL')
    const message: DebugStatusMsg = {
      lines: [
        `Bitbot Spike B · helper window debug overlay (click-through) · ${remaining === null ? 'Ctrl+C to end' : `ends in ${remaining} s`}`,
        `snapshot ${snapshot ? new Date(snapshot.ts * 1000).toLocaleTimeString() : '—'} · poll ${this.helper?.pollRate ?? 0} Hz · ` +
          `${snapshot?.windows.length ?? 0} windows · ${eligible} eligible · helper pid ${this.helper?.pid ?? '—'}`,
        'green = eligible surface (§8.2) · grey dashed = ineligible (✕ reasons) · blue = display bounds · orange = work area · red = cursor',
        checks.length > 0 ? `checks: ${checks.map((c) => `${c.name} ${c.status}`).join(' · ')}` : 'checks: running…',
      ],
    }
    overlay.webContents.send(SPIKE_WINDOWS_IPC.status, message)
  }

  private sendProbeCaption(text: string): void {
    const probe = this.probe
    if (!probe || probe.isDestroyed()) return
    const message: DebugProbeMsg = { text }
    probe.webContents.send(SPIKE_WINDOWS_IPC.probe, message)
  }

  private async requestSnapshot(): Promise<SnapshotMsg> {
    const helper = this.requireHelper()
    const snapshot = await helper.snapshot()
    this.onSnapshot(snapshot, 'request')
    return snapshot
  }

  private requireHelper(): HelperClient {
    if (!this.helper) throw new Error('helper not started')
    return this.helper
  }

  // ───────────────────────────── checks ─────────────────────────────

  private async runChecks(): Promise<void> {
    this.checkUiohookPackaging()
    this.checkDisplays()
    await this.checkCoordinates()
    if (this.finishing) return
    await this.checkOverlayBounds()
    if (this.finishing) return
    // Park the probe in the middle so the level / z-order snapshot and the capture show it on screen.
    await this.moveProbe('work-area centre (parked)', this.centredProbe())
    const snapshot = await this.requestSnapshot()
    this.checkOwnership(snapshot)
    this.checkLevels(snapshot)
    this.checkZOrder(snapshot)
    if (this.options.capture) await this.capture(this.options.capture)
    if (this.finishing) return
    await this.measureLatencyBurst('after the checks')
    if (this.finishing) return
    if (this.options.autoAppTest) await this.runAppTest()
    else this.record('app launch/terminate events', 'SKIP', 'not requested (--auto-app-test); app events are still logged live')
  }

  /**
   * Static half of "uiohook-napi works in a packaged app": the package resolves from the app root and its
   * native prebuild sits outside the archive (asarUnpack). Resolve only: the module is never loaded here
   * (loading it opens an IOHIDSystem connection; start() can prompt). --spike=input loads and starts it.
   */
  private checkUiohookPackaging(): void {
    const name = 'uiohook-napi packaging (resolved, not loaded)'
    try {
      const entry = createRequire(join(app.getAppPath(), 'package.json')).resolve('uiohook-napi')
      const packageDir = dirname(dirname(entry))
      const prebuild = join(packageDir, 'prebuilds', `darwin-${process.arch}`, 'uiohook-napi.node')
      const native = app.isPackaged ? prebuild.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`) : prebuild
      const present = existsSync(native)
      this.record(name, present ? 'PASS' : 'FAIL', `resolves to ${entry}; native prebuild ${present ? 'present' : 'MISSING'} at ${native}`)
    } catch (err) {
      this.record(name, 'FAIL', `cannot resolve uiohook-napi from ${app.getAppPath()}: ${errorText(err)}`)
    }
  }

  private checkDisplays(): void {
    const electron = screen.getAllDisplays()
    const primaryId = screen.getPrimaryDisplay().id
    const comparison = compareDisplays(
      this.helperDisplays,
      electron.map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor })),
      primaryId,
      T.boundsTolerancePt,
    )
    this.displayComparison = comparison
    for (const d of electron) {
      this.log.line(
        `electron display id=${d.id}${d.id === primaryId ? ' primary' : ''} bounds=${formatRect(electronRect(d.bounds))} ` +
          `workArea=${formatRect(electronRect(d.workArea))} scaleFactor=${d.scaleFactor} ${d.displayFrequency} Hz internal=${d.internal}`,
      )
    }
    for (const d of this.helperDisplays) {
      this.log.line(`helper display id=${d.id}${d.main ? ' main' : ''} bounds=${formatRect(helperRect(d))} (CGDisplayBounds)`)
    }
    this.record('displays (helper vs Electron)', comparison.pass ? 'PASS' : 'FAIL', comparison.detail)
  }

  private centredProbe(): { x: number; y: number } {
    const wa = screen.getPrimaryDisplay().workArea
    return { x: Math.round(wa.x + (wa.width - T.probe.width) / 2), y: Math.round(wa.y + (wa.height - T.probe.height) / 2) }
  }

  private async moveProbe(name: string, at: { x: number; y: number }): Promise<void> {
    const probe = this.probe
    if (!probe || probe.isDestroyed()) return
    probe.setBounds({ x: at.x, y: at.y, width: T.probe.width, height: T.probe.height })
    this.sendProbeCaption(`Bitbot coordinate probe · ${name}`)
    await sleep(T.probe.settleMs)
  }

  /** Moves the probe to each position and compares the helper's bounds with win.getBounds(). */
  private async checkCoordinates(): Promise<void> {
    const name = 'coordinates (probe window)'
    const probe = this.probe
    const wid = this.probeWid
    if (!probe || wid === null) {
      this.record(name, 'FAIL', 'the probe window has no CGWindowID (getMediaSourceId)')
      return
    }
    const primary = screen.getPrimaryDisplay()
    const size = { w: T.probe.width, h: T.probe.height }
    for (const position of probePositions(primary.bounds, primary.workArea, size, T.probe.offscreenFraction)) {
      if (this.finishing) return
      await this.moveProbe(position.name, position)
      const requested = { x: position.x, y: position.y, w: size.w, h: size.h }
      let attempts = 0
      let electron = electronRect(probe.getBounds())
      let helper: CoordinateRow['helper'] = null
      let delta: RectDelta | null = null
      for (;;) {
        attempts += 1
        const snapshot = await this.requestSnapshot()
        electron = electronRect(probe.getBounds())
        const entry = snapshot.windows.find((w) => w.wid === wid)
        helper = entry ? helperRect(entry) : null
        delta = helper ? compareRects(helper, electron, T.boundsTolerancePt) : null
        if (delta?.pass || attempts >= T.probe.attempts || this.finishing) break
        await sleep(T.probe.retryMs)
      }
      const constrained = !compareRects(electron, requested, T.boundsTolerancePt).pass
      const pass = delta?.pass ?? false
      this.coordinateRows.push({ name: position.name, requested, electron, helper, delta, constrained, attempts, pass })
      this.log.line(
        `${pass ? 'PASS' : 'FAIL'} coord ${position.name}: electron getBounds ${formatRect(electron)} helper ${formatRect(helper)} ` +
          `${formatDelta(delta)} attempts=${attempts}${constrained ? ` (macOS moved it from the requested ${formatRect(requested)})` : ''}`,
      )
    }
    const passed = this.coordinateRows.filter((row) => row.pass).length
    const total = this.coordinateRows.length
    const worst = Math.max(0, ...this.coordinateRows.map((row) => row.delta?.max ?? Number.POSITIVE_INFINITY))
    this.record(
      name,
      passed === total && total > 0 ? 'PASS' : 'FAIL',
      `${passed}/${total} positions match within ${T.boundsTolerancePt} pt (largest |Δ| ${Number.isFinite(worst) ? worst : 'n/a'} pt)`,
    )
  }

  private async checkOverlayBounds(): Promise<void> {
    const name = 'coordinates (overlay window)'
    const overlay = this.overlay
    const wid = this.overlayWid
    if (!overlay) {
      this.record(name, 'SKIP', '--overlay=false')
      return
    }
    if (wid === null) {
      this.record(name, 'FAIL', 'the overlay has no CGWindowID (getMediaSourceId)')
      return
    }
    const snapshot = await this.requestSnapshot()
    const entry = snapshot.windows.find((w) => w.wid === wid)
    const electron = electronRect(overlay.getBounds())
    const display = electronRect(screen.getPrimaryDisplay().bounds)
    const helper = entry ? helperRect(entry) : null
    const delta = helper ? compareRects(helper, electron, T.boundsTolerancePt) : null
    const coversDisplay = compareRects(electron, display, T.boundsTolerancePt).pass
    this.overlayBounds = {
      name: 'overlay',
      requested: display,
      electron,
      helper,
      delta,
      constrained: !coversDisplay,
      attempts: 1,
      pass: delta?.pass ?? false,
    }
    this.record(
      name,
      delta?.pass ? 'PASS' : 'FAIL',
      `electron ${formatRect(electron)} helper ${formatRect(helper)} ${formatDelta(delta)}; ` +
        `${coversDisplay ? 'covers' : 'does NOT cover'} the display bounds ${formatRect(display)}`,
    )
  }

  /** Our windows belong to the main process pid (the §8.2 "not Bitbot's own pid" rule relies on it). */
  private checkOwnership(snapshot: SnapshotMsg): void {
    const ours = [this.probeWid, this.overlayWid].filter((wid): wid is number => wid !== null)
    const entries = snapshot.windows.filter((w) => ours.includes(w.wid))
    const probeEntry = snapshot.windows.find((w) => w.wid === this.probeWid)
    const ownedByMain = entries.length === ours.length && entries.every((w) => w.pid === process.pid)
    const probeVerdict = probeEntry ? windowEligibility(probeEntry, this.rules) : null
    const probeOwnReason = probeVerdict?.reasons.includes('own') ?? false
    this.record(
      'window ownership (§8.2 own pid)',
      ownedByMain && probeOwnReason ? 'PASS' : 'FAIL',
      `${entries.length}/${ours.length} of our windows found, owner pid(s) ${[...new Set(entries.map((w) => w.pid))].join(',') || '-'} ` +
        `vs main pid ${process.pid}; probe (layer ${probeEntry?.layer ?? '-'}, ${T.probe.width}×${T.probe.height}) ineligible because ` +
        `${probeVerdict ? probeVerdict.reasons.join(',') || 'nothing (eligible!)' : 'missing'}`,
    )
  }

  private checkLevels(snapshot: SnapshotMsg): void {
    const report = classifyLevels(snapshot.windows, {
      ownPid: process.pid,
      overlayWid: this.overlayWid,
      probeWid: this.probeWid,
      display: screen.getPrimaryDisplay().bounds,
    })
    this.levels = report
    this.log.line(
      `LEVELS ours: overlay=${report.overlay ? `L${report.overlay.layer} (wid ${report.overlay.wid})` : '-'} ` +
        `probe=${report.probe ? `L${report.probe.layer} (wid ${report.probe.wid})` : '-'} | Dock ${report.dockLayers.length > 0 ? report.dockLayers.join('/') : 'none on screen'} | ` +
        `menu bar L${report.menuBar.layer} (${report.menuBar.from === 'snapshot' ? `wid ${report.menuBar.wid ?? '-'}` : 'not on screen'}) | ` +
        `Notification Center ${report.notificationCenterLayers.length > 0 ? report.notificationCenterLayers.join('/') : 'none on screen'} | ` +
        `other apps' layer-0 windows: ${report.normalWindows}`,
    )
    for (const group of report.layers) {
      this.log.line(`LEVELS layer ${group.layer}: ${group.count} window(s) — ${group.owners.join(', ')}`)
    }
    const verdict = levelVerdict(report)
    this.record(verdict.name, verdict.status, verdict.detail)
  }

  private checkZOrder(snapshot: SnapshotMsg): void {
    const windows = snapshot.windows
    this.zOrder = windows.slice(0, T.zOrderDumpCount).map((w, z) => formatZOrderEntry(w, z, process.pid))
    this.log.line(`Z-ORDER (front to back, first ${this.zOrder.length} of ${windows.length}):`)
    for (const line of this.zOrder) this.log.line(`  ${line}`)
    const appWindows = windows
      .map((w, z) => ({ w, z }))
      .filter(({ w }) => w.layer === 0)
      .map(({ w, z }) => `#${z} ${w.pid === process.pid ? 'Bitbot' : (w.bundleId ?? '(no bundle id)')} ${formatRect(helperRect(w))}`)
    this.log.line(`Z-ORDER layer-0 windows front to back: ${appWindows.join(' > ') || 'none'}`)
    const violation = firstLayerOrderViolation(windows)
    const overlayZ = windows.findIndex((w) => w.wid === this.overlayWid)
    const firstNormalZ = windows.findIndex((w) => w.layer === 0)
    const probeZ = windows.findIndex((w) => w.wid === this.probeWid)
    const probeRank = windows.filter((w, z) => w.layer === 0 && z < probeZ).length
    const overlayInFront = overlayZ === -1 || firstNormalZ === -1 || overlayZ < firstNormalZ
    this.record(
      'z-order',
      violation === -1 && overlayInFront ? 'PASS' : 'FAIL',
      `layers ${violation === -1 ? 'never increase front to back' : `increase at #${violation}`}; overlay at #${overlayZ === -1 ? '-' : overlayZ} ` +
        `${overlayInFront ? 'in front of' : 'BEHIND'} the first layer-0 window (#${firstNormalZ === -1 ? '-' : firstNormalZ}); ` +
        `probe #${probeZ === -1 ? '-' : probeZ} is layer-0 window number ${probeZ === -1 ? '-' : probeRank + 1} (1 = frontmost; ` +
        'it was ordered front with showInactive, so 1 unless another window came forward since)',
    )
  }

  private async capture(path: string): Promise<void> {
    const name = 'overlay capture'
    const overlay = this.overlay
    if (!overlay || overlay.isDestroyed()) {
      this.record(name, 'SKIP', '--overlay=false')
      return
    }
    const seq = this.sceneSeq
    const deadline = now() + T.captureTimeoutMs
    while (this.drawnSeq < seq && now() < deadline) await sleep(20)
    const drawn = this.drawnSeq >= seq
    try {
      const image = await overlay.webContents.capturePage()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, image.toPNG())
      const size = image.getSize()
      this.capturePath = path
      this.record(
        name,
        drawn ? 'INFO' : 'WARN',
        `${size.width}×${size.height} px of scene #${seq}${drawn ? '' : ' (draw not confirmed)'} → ${path} (webContents.capturePage, no permission)`,
      )
    } catch (err) {
      this.record(name, 'FAIL', `capturePage failed: ${errorText(err)}`)
    }
  }

  /**
   * One burst of sequential snapshot and ping requests (after a few untimed warm-up requests). Bursts
   * run after the checks and at the end of each CPU phase (outside its CPU window), because sub-ms round
   * trips vary with how busy the Mac is: one burst is not a figure.
   */
  private async measureLatencyBurst(label: string): Promise<void> {
    const helper = this.requireHelper()
    const { samples, warmup } = T.latencyBurst
    for (let i = 0; i < warmup && !this.finishing; i++) {
      await helper.snapshot()
      await helper.ping()
    }
    const snapshotMs: number[] = []
    const pingMs: number[] = []
    let windows: number | null = null
    for (let i = 0; i < samples && !this.finishing; i++) {
      const start = now()
      const snapshot = await helper.snapshot()
      snapshotMs.push(round(now() - start, 4))
      windows = snapshot.windows.length
    }
    for (let i = 0; i < samples && !this.finishing; i++) {
      const start = now()
      await helper.ping()
      pingMs.push(round(now() - start, 4))
    }
    const burst: LatencyBurst = {
      label,
      tRunS: round(this.runSeconds(), 3),
      pollHz: helper.pollRate,
      windows,
      snapshotSamplesMs: snapshotMs,
      pingSamplesMs: pingMs,
    }
    this.latencyBursts.push(burst)
    this.log.line(
      `latency burst "${label}" @${burst.pollHz} Hz: snapshot ${formatSummary(summarize(snapshotMs), ' ms')}; ` +
        `ping ${formatSummary(summarize(pingMs), ' ms', 3)}`,
    )
  }

  private latencyConfig(): string {
    const o = this.options
    return (
      `run config: overlay ${o.overlay ? `on (${o.windowType})` : 'off'}, duration ${o.durationS > 0 ? `${o.durationS} s` : 'until quit'}, ` +
      `cpu-phase-s ${o.cpuPhaseS ?? 'auto'}, ${app.isPackaged ? 'packaged' : 'dev'}; sequential requests, ${T.latencyBurst.samples} ` +
      `of each kind per burst after ${T.latencyBurst.warmup} untimed`
    )
  }

  /** Records the latency INFO line once (after the CPU phases, or at finish when the run ends early). */
  private recordLatency(): void {
    if (this.latencyRecorded || this.latencyBursts.length === 0) return
    this.latencyRecorded = true
    this.record(
      'round-trip latency',
      'INFO',
      `${formatLatency(this.latencyBursts, this.latencyConfig())} — compare only runs with identical flags`,
    )
  }

  // ───────────────────────────── app events ─────────────────────────────

  private onAppEvent(message: AppEventMsg): void {
    const tRunS = this.runSeconds()
    this.appEvents.push({
      tRunS,
      type: message.type,
      bundleId: message.bundleId,
      pid: message.pid,
      appName: message.appName,
    })
    if (message.type === 'appActivated') this.lastActivated = { bundleId: message.bundleId, tRunS }
    this.log.line(`app ${message.type} bundleId=${message.bundleId ?? '-'} pid=${message.pid} name=${message.appName ?? '-'}`)
    for (const waiter of [...this.appWaiters]) waiter(message)
  }

  private waitForAppEvent(
    type: AppEventType,
    matches: (message: AppEventMsg) => boolean,
    timeoutMs: number,
  ): { promise: Promise<AppEventMsg | null>; cancel: () => void } {
    let settle: (message: AppEventMsg | null) => void = () => {}
    const promise = new Promise<AppEventMsg | null>((resolve) => {
      settle = resolve
    })
    const waiter: AppWaiter = (message) => {
      if (message.type === type && matches(message)) done(message)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    const done = (message: AppEventMsg | null): void => {
      clearTimeout(timer)
      this.appWaiters.delete(waiter)
      settle(message)
    }
    this.appWaiters.add(waiter)
    return { promise, cancel: () => done(null) }
  }

  /**
   * --auto-app-test: `open -g -a Calculator` (background launch, never activated), wait for appLaunched,
   * terminate it, wait for appTerminated. Skipped when Calculator is already running: the harness never
   * touches an app it did not launch. It terminates the pid from appLaunched rather than `pkill -x`
   * (same effect, but cannot hit a Calculator the user opens meanwhile); `pkill -x` is only the fallback
   * when appLaunched never arrived.
   */
  private async runAppTest(): Promise<void> {
    const name = 'app launch/terminate events'
    const { appName, bundleId, eventTimeoutMs } = T.appTest
    const isTarget = (message: AppEventMsg): boolean => message.bundleId?.toLowerCase() === bundleId.toLowerCase()
    const before = await pgrep(appName)
    if (before.length > 0) {
      this.record(name, 'SKIP', `${appName} is already running (pid ${before.join(',')}); not touching an app this run did not launch`)
      return
    }
    const result: AppTestResult = { launchedPid: null, appLaunchedMs: null, appTerminatedMs: null, cleanedUpPids: [] }
    this.appTest = result
    const launched = this.waitForAppEvent('appLaunched', isTarget, eventTimeoutMs)
    const launchStart = now()
    this.log.line(`app test: open -g -a ${appName}`)
    try {
      await execFileAsync('open', ['-g', '-a', appName])
    } catch (err) {
      launched.cancel()
      this.record(name, 'FAIL', `open -g -a ${appName} failed: ${errorText(err)}`)
      return
    }
    const launchMsg = await launched.promise
    if (launchMsg) {
      result.launchedPid = launchMsg.pid
      result.appLaunchedMs = round(now() - launchStart, 1)
      this.launchedPids.add(launchMsg.pid)
    } else {
      for (const pid of await pgrep(appName)) this.launchedPids.add(pid)
    }
    if (this.finishing) return

    const pids = [...this.launchedPids]
    const terminated = this.waitForAppEvent(
      'appTerminated',
      (message) => pids.includes(message.pid) || (pids.length === 0 && isTarget(message)),
      eventTimeoutMs,
    )
    const terminateStart = now()
    if (launchMsg) {
      this.log.line(`app test: SIGTERM pid ${launchMsg.pid} (${appName})`)
      try {
        process.kill(launchMsg.pid, 'SIGTERM')
      } catch (err) {
        this.log.line(`app test: SIGTERM failed: ${errorText(err)}`)
      }
    } else {
      this.log.line(`app test: no appLaunched within ${eventTimeoutMs} ms; pkill -x ${appName}`)
      await execFileAsync('pkill', ['-x', appName]).catch(() => undefined)
    }
    const terminateMsg = await terminated.promise
    if (terminateMsg) result.appTerminatedMs = round(now() - terminateStart, 1)
    // The notification can precede the process's final exit by a moment; only force what lingers.
    await waitUntil(() => pids.every((pid) => !processAlive(pid)), T.appTest.killGraceMs)
    result.cleanedUpPids = await this.cleanUpLaunchedApps()

    const pass = launchMsg !== null && terminateMsg !== null
    this.record(
      name,
      pass ? 'PASS' : 'FAIL',
      `appLaunched ${launchMsg ? `after ${result.appLaunchedMs} ms (pid ${launchMsg.pid}, ${launchMsg.appName ?? '-'})` : `NOT received within ${eventTimeoutMs} ms`}; ` +
        `appTerminated ${terminateMsg ? `after ${result.appTerminatedMs} ms` : `NOT received within ${eventTimeoutMs} ms`}` +
        `${result.cleanedUpPids.length > 0 ? `; force-cleaned pid ${result.cleanedUpPids.join(',')}` : ''}`,
    )
  }

  /**
   * Terminates any app this run launched that is still running (SIGTERM, then SIGKILL) and forgets pids
   * that have exited, so a reused pid is never signalled. Returns the pids it had to signal.
   */
  private async cleanUpLaunchedApps(): Promise<number[]> {
    const alive = [...this.launchedPids].filter((pid) => processAlive(pid))
    for (const pid of this.launchedPids) if (!alive.includes(pid)) this.launchedPids.delete(pid)
    if (alive.length === 0) return []
    for (const pid of alive) safeKill(pid, 'SIGTERM')
    await waitUntil(() => alive.every((pid) => !processAlive(pid)), T.appTest.killGraceMs)
    for (const pid of alive) if (processAlive(pid)) safeKill(pid, 'SIGKILL')
    for (const pid of alive) this.launchedPids.delete(pid)
    return alive
  }

  // ───────────────────────────── fullscreen ─────────────────────────────

  private onFullscreen(message: FrontmostFullscreenMsg): void {
    const record: FullscreenRecord = {
      tRunS: this.runSeconds(),
      initial: this.fullscreen.length === 0,
      value: message.value,
      bundleId: message.bundleId,
      displayIds: [...message.displayIds],
      overlayOnScreen: null,
    }
    this.fullscreen.push(record)
    this.lastHelperFullscreen = message.value
    this.log.line(
      `fullscreen ${record.initial ? 'initial state' : 'change'}: value=${message.value} bundleId=${message.bundleId ?? '-'} ` +
        `displayIds=[${message.displayIds.join(',')}]`,
    )
    if (this.overlayWid !== null) this.scheduleOverlayPresenceCheck(record)
  }

  /** §8.6: while another app is in a fullscreen Space our overlay should not be in the on-screen list. */
  private scheduleOverlayPresenceCheck(record: FullscreenRecord): void {
    this.later(async () => {
      if (this.finishing || this.overlayWid === null) return
      try {
        const snapshot = await this.requestSnapshot()
        const present = snapshot.windows.some((w) => w.wid === this.overlayWid)
        record.overlayOnScreen = present
        const ok = record.value ? !present : present
        this.log.line(
          `${ok ? 'PASS' : 'FAIL'} fullscreen visibility: frontmostFullscreen=${record.value} → overlay ${present ? 'IS' : 'is not'} ` +
            `in the on-screen list (expected ${record.value ? 'absent' : 'present'}; window-type=${this.options.windowType})`,
        )
      } catch (err) {
        this.log.line(`fullscreen visibility check failed: ${errorText(err)}`)
      }
    }, T.fullscreenCheckDelayMs)
  }

  private fullscreenCheck(): CheckResult {
    if (!this.overlay) return { name: 'hidden in fullscreen Spaces', status: 'SKIP', detail: '--overlay=false' }
    return fullscreenVerdict(this.fullscreen, this.presenceChanges, this.options.windowType)
  }

  // ───────────────────────────── helper CPU ─────────────────────────────

  /**
   * Helper CPU at the normal (4 Hz) and the attached (15 Hz) snapshot rate (§11: helper < 0.5%). Node
   * cannot read another process's exact CPU time, so the figure comes from `ps -o time=` (cumulative,
   * rounded to 10 ms) sampled every T.cpu.sampleMs and edge-aligned (measure.ts): bounds that hold for
   * any true value, typically ±0.01 points over 20-30 s. `ps %cpu` is kept only as a labelled diagnostic.
   */
  private async runCpuPhases(): Promise<void> {
    const name = 'helper CPU'
    const rates = { normal: tuning.world.snapshotHz.normal, attached: tuning.world.snapshotHz.attached }
    const fixedPhaseS = this.options.cpuPhaseS
    const remainingS = this.deadlineMs === null ? Number.POSITIVE_INFINITY : (this.deadlineMs - now()) / 1000 - 0.5
    const plan = planCpuPhases(remainingS, rates, T.cpu, { untilQuit: this.deadlineMs === null, fixedPhaseS })
    if (plan.length === 0) {
      this.record(
        name,
        'SKIP',
        `only ${round(Math.max(0, remainingS), 1)} s left after the checks (need ${T.cpu.minPhaseS} s per phase; use --cpu-phase-s=30)`,
      )
      return
    }
    if (fixedPhaseS !== null && this.deadlineMs !== null) {
      // Each phase: settle + measurement + its latency burst (well under a second).
      const neededMs = plan.reduce((sum, phase) => sum + T.cpu.settleMs + phase.seconds * 1000 + 1000, 0)
      const extendTo = now() + neededMs
      if (extendTo > this.deadlineMs) {
        this.log.line(`--cpu-phase-s=${fixedPhaseS}: run extended by ${((extendTo - this.deadlineMs) / 1000).toFixed(1)} s to fit both phases`)
        this.deadlineMs = extendTo
        this.scheduleHardStop()
      }
    }
    for (const phase of plan) {
      if (this.finishing) return
      this.cpuPhases.push(await this.measureCpuPhase(phase.hz, phase.seconds))
      if (this.finishing) return
      await this.measureLatencyBurst(`end of the ${phase.hz} Hz phase`)
    }
    this.requireHelper().setPollRate(rates.normal)
    const { maxHalfWidthPct, helperBudgetPct } = T.cpu
    const phases = this.cpuPhases.map((p) => formatCpuPhase(p, maxHalfWidthPct, helperBudgetPct))
    const diagnostic = this.cpuPhases
      .map((p) => `${p.hz} Hz ${p.psPcpuDiagnostic.mean === null ? '-' : p.psPcpuDiagnostic.mean.toFixed(2)}%`)
      .join(', ')
    this.record(
      name,
      'INFO',
      `${phases.join('; ')} · from ps cputime (10 ms steps) every ${T.cpu.sampleMs} ms, edge-aligned; the bounds hold for any ` +
        `true value · ps %cpu mean, a lagging decaying average and NOT a CPU figure: ${diagnostic}`,
    )
  }

  private async measureCpuPhase(hz: number, seconds: number): Promise<CpuPhaseResult> {
    const helper = this.requireHelper()
    helper.setPollRate(hz)
    this.log.line(`CPU phase: ${hz} Hz for ${seconds} s (ps cputime every ${T.cpu.sampleMs} ms, after ${T.cpu.settleMs} ms to settle)`)
    await sleep(T.cpu.settleMs)
    const pid = helper.pid ?? null
    const readings: CpuTimeReading[] = []
    const pcpu: number[] = []
    // Unix seconds from the monotonic clock (comparable with external samplers, immune to clock steps).
    const unixS = (): number => (performance.timeOrigin + now()) / 1000
    const take = async (): Promise<void> => {
      if (pid === null) return
      const startS = unixS()
      const sample = await psSample(pid)
      const endS = unixS()
      if (!sample) return
      readings.push({ startS: round(startS, 4), endS: round(endS, 4), cpuS: sample.cpuTimeS })
      pcpu.push(sample.cpuPct)
    }
    const start = now()
    const pushes0 = this.pushes
    const end = start + seconds * 1000
    await take()
    while (!this.finishing && now() < end) {
      await sleep(Math.min(T.cpu.sampleMs, Math.max(0, end - now())))
      await take()
    }
    const wallS = (now() - start) / 1000
    const pushes = this.pushes - pushes0
    const restarted = helper.pid !== pid
    const usable = restarted ? [] : readings
    const result: CpuPhaseResult = {
      hz,
      plannedS: seconds,
      wallS: round(wallS, 3),
      helperPid: pid,
      estimate: bestCpuEstimate(usable, PS_CPU_TIME_QUANTUM_S),
      edges: edgeCpuEstimate(usable, PS_CPU_TIME_QUANTUM_S),
      delta: deltaCpuEstimate(usable, PS_CPU_TIME_QUANTUM_S),
      readings,
      psPcpuDiagnostic: {
        samples: pcpu,
        mean: pcpu.length > 0 ? round(pcpu.reduce((a, b) => a + b, 0) / pcpu.length, 3) : null,
      },
      pushes,
      pushRateHz: wallS > 0 ? round(pushes / wallS, 3) : null,
      note: restarted ? 'helper restarted during the phase: no estimate' : null,
    }
    const { maxHalfWidthPct } = T.cpu
    this.log.line(
      `CPU ${hz} Hz: ${formatCpuEstimate(result.estimate, maxHalfWidthPct)} | edges ${formatCpuEstimate(result.edges, Number.POSITIVE_INFINITY)} | ` +
        `first→last ${formatCpuEstimate(result.delta, Number.POSITIVE_INFINITY)} | ${readings.length} ps readings, cputime ` +
        `${readings[0]?.cpuS ?? '-'} → ${readings[readings.length - 1]?.cpuS ?? '-'} s | ps %cpu mean ${result.psPcpuDiagnostic.mean ?? '-'} ` +
        `(diagnostic) | ${pushes} pushes in ${wallS.toFixed(2)} s${result.note ? ` [${result.note}]` : ''}`,
    )
    return result
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  private installHandlers(): void {
    this.detachers.push(
      installSignalHandlers(
        T.signalRepeatGraceMs,
        (signal) => {
          if (this.finishing) this.log.line(`${signal}: already finishing; send it again to exit at once`)
          else void this.finish(`signal:${signal}`)
        },
        (signal) => {
          this.log.line(`${signal} again: exiting at once, results NOT written`)
          app.exit(130)
        },
      ),
    )
    // Also keeps Electron from showing its main-process error dialog, which would steal focus (§2).
    const onException = (err: Error): void => {
      this.error(`uncaught exception: ${err.stack ?? err.message}`)
      void this.finish('fatal')
    }
    const onRejection = (reason: unknown): void => {
      this.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
    }
    process.on('uncaughtException', onException)
    process.on('unhandledRejection', onRejection)
    this.detachers.push(
      () => process.off('uncaughtException', onException),
      () => process.off('unhandledRejection', onRejection),
    )
  }

  private async finish(reason: string): Promise<void> {
    if (this.finishing) return
    this.finishing = true
    this.log.line(`finishing (${reason})`)
    for (const interval of this.intervals.splice(0)) clearInterval(interval)
    for (const timeout of this.timeouts) clearTimeout(timeout)
    this.timeouts.clear()
    for (const waiter of [...this.appWaiters]) this.appWaiters.delete(waiter)

    const leftoverApps = await this.cleanUpLaunchedApps()
    if (leftoverApps.length > 0) this.log.line(`terminated leftover app pid(s) ${leftoverApps.join(',')} launched by this run`)

    const helper = this.helper
    const helperPid = helper?.pid ?? null
    let helperStopped = true
    if (helper) {
      helperStopped = await withTimeout(
        helper.stop().then(() => true),
        T.helperStopTimeoutMs,
        false,
      )
    }
    if (helperPid !== null && processAlive(helperPid)) {
      safeKill(helperPid, 'SIGKILL')
      this.error(`helper pid ${helperPid} was still alive after stop(); SIGKILLed`)
      helperStopped = false
    }

    this.recordLatency()
    this.checks.push(this.fullscreenCheck())
    if (this.errors.length > 0) this.record('harness errors', 'FAIL', this.errors.slice(0, 3).join(' | '))

    for (const detach of this.detachers.splice(0)) {
      try {
        detach()
      } catch {
        // Teardown is best effort.
      }
    }
    for (const win of [this.probe, this.overlay]) if (win && !win.isDestroyed()) win.destroy()

    let code = 0
    try {
      const results = this.buildResults(reason, helperStopped)
      mkdirSync(dirname(this.resultsFile), { recursive: true })
      writeFileSync(this.resultsFile, `${JSON.stringify(results, null, 1)}\n`)
      this.printSummary()
      this.log.line(`RESULT ${results.summary}`)
      this.log.line(`wrote ${this.resultsFile}`)
      code = results.counts.FAIL > 0 ? 2 : 0
    } catch (err) {
      this.log.line(`ERROR could not write results: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      code = 1
    }
    if (code === 0) {
      setTimeout(() => app.exit(0), T.quitFallbackMs).unref()
      app.quit()
    } else {
      app.exit(code)
    }
  }

  private printSummary(): void {
    this.log.line('===== SUMMARY =====')
    for (const check of this.checks) this.log.line(`${check.status.padEnd(4)} ${check.name}: ${check.detail}`)
  }

  private buildResults(reason: string, helperStopped: boolean) {
    const counts: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0, INFO: 0 }
    for (const check of this.checks) counts[check.status] += 1
    const summary =
      `${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.WARN} WARN · ${counts.SKIP} SKIP · ${counts.INFO} INFO` +
      ` (${reason}, ${this.runSeconds().toFixed(1)} s)`
    return {
      schema: RESULTS_SCHEMA,
      summary,
      counts,
      reason,
      startedAt: this.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      runSeconds: round(this.runSeconds(), 3),
      options: this.options,
      app: this.identity,
      logFile: this.log.filePath,
      checks: this.checks,
      helper: {
        path: this.helperPath,
        hello: this.hello,
        diag: this.diag,
        inputAccess: this.access,
        exits: this.helperExits,
        stderr: this.helperStderr,
        protocolErrors: this.protocolErrors,
        stoppedCleanly: helperStopped,
        snapshotPushes: this.pushes,
      },
      displays: {
        electron: screenDisplaysSafe(),
        helper: this.helperDisplays,
        comparison: this.displayComparison,
      },
      overlay: this.overlay
        ? { wid: this.overlayWid, windowType: this.options.windowType, ready: this.overlayReady, bounds: this.overlayBounds }
        : null,
      probe: { wid: this.probeWid, ready: this.probeReady, size: { w: T.probe.width, h: T.probe.height } },
      windowServerPids: this.rules.windowServerPids,
      coordinates: this.coordinateRows,
      levels: this.levels,
      zOrder: this.zOrder,
      latency: { config: this.latencyConfig(), bursts: this.latencyBursts },
      cpu: {
        method:
          '`ps -o %cpu=,time= -p <helper pid>` every sampleMs; estimate = tighter of edge-aligned (between the first and last 10 ms ' +
          'steps of cputime) and first-to-last (±10 ms) with bounds that hold for any true value; psPcpuDiagnostic is a decaying ' +
          'average, not a CPU figure',
        sampleMs: T.cpu.sampleMs,
        quantumS: PS_CPU_TIME_QUANTUM_S,
        maxHalfWidthPct: T.cpu.maxHalfWidthPct,
        helperBudgetPct: T.cpu.helperBudgetPct,
        phases: this.cpuPhases,
      },
      appEvents: this.appEvents,
      appTest: this.appTest,
      fullscreen: this.fullscreen,
      overlayPresence: this.presenceChanges,
      capture: this.capturePath,
      errors: this.errors,
    }
  }

  // ───────────────────────────── utilities ─────────────────────────────

  private record(name: string, status: CheckStatus, detail: string): void {
    this.checks.push({ name, status, detail })
    this.log.line(`${status} ${name}: ${detail}`)
  }

  private error(message: string): void {
    this.errors.push(message)
    this.log.line(`ERROR ${message}`)
  }

  private runSeconds(): number {
    return (now() - this.t0) / 1000
  }

  private every(fn: () => void, ms: number): void {
    this.intervals.push(
      setInterval(() => {
        try {
          fn()
        } catch (err) {
          this.error(`timer failed: ${errorText(err)}`)
        }
      }, ms),
    )
  }

  /** (Re)arms the forced finish T.hardStopGraceS after the current deadline (a hung check). */
  private scheduleHardStop(): void {
    if (this.deadlineMs === null) return
    if (this.hardStopTimer !== null) {
      clearTimeout(this.hardStopTimer)
      this.timeouts.delete(this.hardStopTimer)
    }
    const timer = setTimeout(
      () => {
        this.timeouts.delete(timer)
        void this.finish('hard-stop')
      },
      Math.max(0, this.deadlineMs - now()) + T.hardStopGraceS * 1000,
    )
    this.hardStopTimer = timer
    this.timeouts.add(timer)
  }

  private later(fn: () => void | Promise<void>, ms: number): void {
    const timer = setTimeout(() => {
      this.timeouts.delete(timer)
      void fn()
    }, ms)
    this.timeouts.add(timer)
  }
}

function screenDisplaysSafe(): unknown {
  try {
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      internal: d.internal,
      displayFrequency: d.displayFrequency,
    }))
  } catch {
    return null
  }
}

async function psSample(pid: number): Promise<PsSample | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', '%cpu=,time=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    })
    return parsePsLine(stdout)
  } catch {
    return null
  }
}

async function pgrep(name: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', name], { encoding: 'utf8' })
    return stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = now() + timeoutMs
  while (!condition()) {
    if (now() >= deadline) return false
    await sleep(50)
  }
  return true
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}
