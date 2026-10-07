import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { app, ipcMain, powerMonitor, screen, type BrowserWindow, type Display, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../../shared/ipc'
import {
  SPIKE_OVERLAY_IPC,
  isOverlayFrameMsg,
  isOverlayLogMsg,
  isOverlayReadyMsg,
  isOverlayRendererStats,
  interpolate,
  type OverlayConfig,
  type OverlayFrameMsg,
  type OverlayReadyMsg,
  type OverlayRendererStats,
  type OverlayStateMsg,
  type Rect,
  type TimedPoint,
} from '../../../shared/spikeOverlay'
import { tuning } from '../../../shared/tuning'
import { loadPage } from '../../pages'
import { AppMetricsSampler } from './appMetrics'
import { FixedStepClock } from './fixedStep'
import { FocusMonitor, type FocusEvent } from './focus'
import { aggregateFootprint, runFootprint } from './footprint'
import { InteractionController, isPetPointerMsg, type PetBox } from './interaction'
import { TAG, out } from './log'
import { aggregateMetrics } from './metricsAggregate'
import { resultsFileName, type OverlayOptions } from './options'
import {
  RESULTS_SCHEMA,
  summaryLine,
  type CaptureResults,
  type FootprintResults,
  type OverlayResults,
  type PresentationResults,
  type RendererResults,
} from './results'
import { SignalGate } from './signals'
import { OverlaySim, makeLissajousPath, type Point, type SimArea } from './sim'
import { SampleSeries, fractionAbove, round, roundSummary, summarize } from './stats'
import { createOverlayWindow, describeWindow, windowNumber, type OverlayWindowState } from './window'

// Spike A harness (BITBOT_SPEC.md §12, §5.1, §5.2). Mirrors the production pipeline: a fixed-step
// 30 Hz simulation in main owns the pet's ground-contact point; presentation interpolates one step
// behind. A1/A2 move a small window (main timer / renderer rAF); B/Bfull stream states to a
// display-sized window whose renderer interpolates and moves the pet itself.

const T = tuning.spikeOverlay
const now = (): number => performance.now()

export class OverlayHarness {
  private readonly stepMs = 1000 / T.simHz
  private readonly isA: boolean
  private readonly edge: number
  private readonly startedAt = new Date()
  private readonly loadAtStart = loadavg()[0] ?? 0
  private anchor: Point
  private petBox: PetBox | null = null
  private ready: OverlayReadyMsg | null = null
  private readyResolve: ((msg: OverlayReadyMsg) => void) | null = null
  private display: Display | null = null
  private sim: OverlaySim | null = null
  private win: BrowserWindow | null = null
  private requestedBounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private windowState: OverlayWindowState | null = null
  private wid: number | null = null

  // Clock and the two newest sim states (interpolation pair).
  private originMs = 0
  private clock: FixedStepClock | null = null
  private prev: TimedPoint = { t: 0, x: 0, y: 0 }
  private curr: TimedPoint = { t: 0, x: 0, y: 0 }
  private stateSeq = 0
  private stateMsgsSent = 0

  private simTimer: NodeJS.Timeout | null = null
  private a1Timer: NodeJS.Timeout | null = null
  private a1Interval: NodeJS.Timeout | null = null
  private warmupTimer: NodeJS.Timeout | null = null
  private durationTimer: NodeJS.Timeout | null = null

  // Measurements (only recorded while `measuring`).
  private measuring = false
  private measureStartMs: number | null = null
  /** Last sim wake that computed at least one step. */
  private lastStepWakeMs: number | null = null
  private readonly wakeIntervals = new SampleSeries(T.rawSampleCap)
  private readonly wakeLateness = new SampleSeries(T.rawSampleCap)
  private readonly stepWork = new SampleSeries(T.rawSampleCap)
  private stepsPerWake: Record<string, number> = {}
  private readonly presentIntervals = new SampleSeries(T.rawSampleCap)
  private readonly setPosDurations = new SampleSeries(T.rawSampleCap)
  private readonly frameLatency = new SampleSeries(T.rawSampleCap)
  private presentTicks = 0
  private setPosCalls = 0
  private setPosUnchanged = 0
  private setPosErrors = 0
  private presentStarved = 0
  private missedDeadlines = 0
  private positionChecks = 0
  private positionMismatches = 0
  private lastPositionCheckMs = 0
  private lastPresentMs: number | null = null
  private lastWin: { x: number; y: number } | null = null
  private a2Offset = Number.POSITIVE_INFINITY

  private readonly metrics = new AppMetricsSampler(T.metricsIntervalMs, now)
  private focus: FocusMonitor | null = null
  private interaction: InteractionController | null = null
  private rendererStatsWaiter: ((stats: OverlayRendererStats) => void) | null = null
  private footprint: FootprintResults | null = null
  private footprintError: string | null = null
  private readonly errors: string[] = []
  private readonly warnings: string[] = []
  private readonly detachers: (() => void)[] = []
  private finishing = false

  constructor(private readonly options: OverlayOptions) {
    this.isA = options.variant === 'A1' || options.variant === 'A2'
    this.edge = Math.round(tuning.render.bodyHeightPt[options.size] * tuning.render.viewportScale)
    // Same formula as scene.ts; replaced by the renderer's own anchor once it reports ready.
    this.anchor = { x: this.edge * tuning.render.anchor.x, y: this.edge * tuning.render.anchor.y }
  }

  async run(): Promise<void> {
    const o = this.options
    this.installProcessHandlers()
    this.focus = new FocusMonitor(now, () => this.interaction?.interaction ?? 'none', (e) => this.onFocusEvent(e))
    this.focus.start()

    const display = screen.getPrimaryDisplay()
    this.display = display
    const wa = display.workArea
    // Keep the whole pet viewport (= the A window) inside the work area horizontally and below the
    // menu bar; the ground is the work-area bottom (§8.1). B/Bfull use the same area for comparability.
    const area: SimArea = {
      minX: wa.x + this.anchor.x,
      maxX: wa.x + wa.width - (this.edge - this.anchor.x),
      minY: wa.y + this.anchor.y,
      groundY: wa.y + wa.height,
    }
    const path = o.mode === 'synthetic' ? makeLissajousPath(area, T.synthetic) : null
    const sim = new OverlaySim(o.mode, area, {
      walkSpeed: tuning.move.walkSpeed,
      followSpeed: T.followSpeed,
      gravity: tuning.move.gravity,
      terminalVelocity: tuning.move.terminalVelocity,
      facingDeadband: T.facingDeadband,
      toss: T.toss,
      path,
    })
    this.sim = sim
    const s = sim.state
    this.requestedBounds = this.isA
      ? { x: Math.round(s.x - this.anchor.x), y: Math.round(s.y - this.anchor.y), width: this.edge, height: this.edge }
      : { ...display.bounds }
    if (this.isA) this.lastWin = { x: this.requestedBounds.x, y: this.requestedBounds.y }

    const b = display.bounds
    out(
      `${TAG} ${o.variant} ${o.mode} duration=${o.durationS > 0 ? `${o.durationS}s` : 'until quit'} window-type=${o.windowType} ` +
        `size=${o.size} display=${b.width}x${b.height}@${display.scaleFactor}x ${display.displayFrequency}Hz ` +
        `workArea=${wa.x},${wa.y} ${wa.width}x${wa.height}` +
        (o.variant === 'A1' ? ` a1-timer=${o.a1Timer}` : '') +
        (path ? ` target-peak=${T.synthetic.peakSpeed}pt/s period=${round((2 * Math.PI) / (path.wx / T.synthetic.freqX), 1)}s` : ''),
    )

    const win = createOverlayWindow(this.requestedBounds, o.windowType)
    this.win = win
    this.attachIpc(win)
    this.attachWebContentsEvents(win)

    const ready = new Promise<OverlayReadyMsg>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`renderer did not report ready within ${T.timeouts.rendererReadyMs} ms`)),
        T.timeouts.rendererReadyMs,
      )
      this.readyResolve = (msg) => {
        clearTimeout(timer)
        this.readyResolve = null
        resolve(msg)
      }
    })
    const query: Record<string, string> = { mode: 'spike', size: o.size, palette: o.palette, variant: o.variant }
    if (o.renderFps !== null) query['renderFps'] = String(o.renderFps)
    await loadPage(win, 'pet', query)
    this.start(await ready)
  }

  // ── startup ────────────────────────────────────────────────────────────────────────────────

  private start(ready: OverlayReadyMsg): void {
    const win = this.win
    const sim = this.sim
    if (!win || !sim || win.isDestroyed()) return
    this.ready = ready
    this.anchor = ready.anchor
    this.petBox = ready.petBox
    // SPEC-DEVIATION: §12 says "follow the cursor"; the pet chases a point just below it (its top
    // followGapPt under the cursor) instead of the cursor itself. Sitting under the pointer would keep
    // the overlay's mouse events on and swallow the user's clicks, which would muddy the measurement.
    if (this.options.mode === 'follow') sim.setFollowOffset({ x: 0, y: T.followGapPt - ready.petBox.top })

    const t0 = now()
    this.originMs = t0
    this.clock = new FixedStepClock(this.stepMs, t0, T.maxStepsPerWake)
    const s = sim.state
    this.curr = { t: t0, x: s.x, y: s.y }
    this.prev = { ...this.curr }
    this.broadcastState(true)

    this.interaction = new InteractionController({
      win,
      interactive: this.options.mode === 'interactive',
      tuning: T,
      sim,
      focus: () => this.focus,
      now,
      elapsedS: (t) => (t - this.originMs) / 1000,
      cursor: () => screen.getCursorScreenPoint(),
      displayedPoint: (t) => this.displayedPoint(t),
      petBox: () => this.petBox ?? { left: 0, top: 0, right: 0, bottom: 0 },
      log: (line) => out(`${TAG} ${line}`),
      onSnap: () => this.onSnap(),
      sendHoverReset: () => {
        if (!win.isDestroyed()) win.webContents.send(SPIKE_OVERLAY_IPC.hoverReset)
      },
      quit: () => void this.finish('menu-quit'),
    })

    win.showInactive()
    this.windowState = describeWindow(win, this.options.windowType)
    this.wid = windowNumber(win)
    out(`${TAG} wid=${this.wid ?? 'unknown'}`)
    const ws = this.windowState
    out(
      `${TAG} window: content=${ws.contentBounds.x},${ws.contentBounds.y} ${ws.contentBounds.width}x${ws.contentBounds.height} ` +
        `focusable=${ws.focusable} alwaysOnTop=${ws.alwaysOnTop} allWorkspaces=${ws.visibleOnAllWorkspaces} gl=${ready.glRenderer ?? 'n/a'}`,
    )
    const cb = ws.contentBounds
    const rb = this.requestedBounds
    if (cb.x !== rb.x || cb.y !== rb.y || cb.width !== rb.width || cb.height !== rb.height) {
      this.warn(`window content bounds ${JSON.stringify(cb)} differ from requested ${JSON.stringify(rb)}`)
    }

    this.metrics.start()
    this.scheduleSim()
    if (this.options.variant === 'A1') this.startA1()
    this.warmupTimer = setTimeout(() => this.startMeasuring(), T.warmupS * 1000)
    if (this.options.durationS > 0) this.durationTimer = setTimeout(() => void this.finish('duration'), this.options.durationS * 1000)
    if (this.options.mode === 'interactive') {
      out(
        `${TAG} interactive: hover the pet, click it (pet), drag + toss it, right-click it; after each, type in your ` +
          `own app to confirm it kept focus. Every verdict line must read NO (PASS). Ctrl+C or menu > Quit ends the run.`,
      )
    }
  }

  private startMeasuring(): void {
    this.warmupTimer = null
    if (this.finishing) return
    this.measuring = true
    this.measureStartMs = now()
    this.lastPresentMs = null
    this.lastStepWakeMs = null
    this.positionChecks = 0
    this.positionMismatches = 0
    const win = this.win
    if (win && !win.isDestroyed()) win.webContents.send(SPIKE_OVERLAY_IPC.measureStart)
    out(`${TAG} measuring (first ${T.warmupS}s discarded as warm-up)`)
  }

  // ── simulation ─────────────────────────────────────────────────────────────────────────────

  private scheduleSim(): void {
    if (this.finishing || !this.clock) return
    // SPEC-DEVIATION: §5.1 computes a step once real time has reached it. Electron main-process timers
    // run several ms late, which starved presentation (rendered one step behind real time) in 4-8 % of
    // frames, so steps are computed up to simLeadMs early; they keep their nominal times and the render
    // time is unchanged. The delay is rounded up because Node schedules timers on its cached millisecond
    // loop clock and can fire a fraction of a ms early; an early wake finds no step due and re-arms
    // (stepsPerWake['0'], left out of the wake-interval stats). Rare after rounding, not impossible.
    this.simTimer = setTimeout(this.simWake, Math.ceil(this.clock.msUntilNextStep(now() + T.simLeadMs)))
  }

  private readonly simWake = (): void => {
    this.simTimer = null
    const clock = this.clock
    const sim = this.sim
    if (this.finishing || !clock || !sim) return
    const wakeMs = now()
    // Steps may be computed up to simLeadMs early (see scheduleSim); they keep their nominal times.
    const times = clock.advance(wakeMs + T.simLeadMs)
    if (this.measuring) this.stepsPerWake[String(times.length)] = (this.stepsPerWake[String(times.length)] ?? 0) + 1
    const firstDue = times[0]
    if (firstDue !== undefined) {
      if (this.measuring) {
        // Only wakes that computed steps: a zero-step (early) wake is a re-arm, not a sim tick.
        if (this.lastStepWakeMs !== null) this.wakeIntervals.push(wakeMs - this.lastStepWakeMs)
        // How late the wake was against its target (the first due step's nominal time minus the lead).
        // Above simLeadMs, that step was computed after its nominal time.
        this.wakeLateness.push(wakeMs - (firstDue - T.simLeadMs))
      }
      this.lastStepWakeMs = wakeMs
      const work0 = now()
      const cursor = this.options.mode === 'follow' ? screen.getCursorScreenPoint() : null
      const held = this.interaction?.sampleHeld(wakeMs) ?? null
      for (const t of times) {
        sim.step(this.stepMs / 1000, { tS: (t - this.originMs) / 1000, cursor, held })
        this.prev = this.curr
        this.curr = { t, x: sim.state.x, y: sim.state.y }
        this.broadcastState(false)
      }
      this.interaction?.safetyTick(wakeMs)
      this.checkWindowPosition(wakeMs)
      if (this.measuring) this.stepWork.push(now() - work0)
    }
    this.scheduleSim()
  }

  private broadcastState(snap: boolean): void {
    const win = this.win
    const sim = this.sim
    if (!win || win.isDestroyed() || !sim) return
    const s = sim.state
    const msg: OverlayStateMsg = {
      seq: ++this.stateSeq,
      t: this.curr.t,
      sentAt: now(),
      x: s.x,
      y: s.y,
      facing: s.facing,
      phase: s.phase,
      snap,
    }
    win.webContents.send(SPIKE_OVERLAY_IPC.state, msg)
    this.stateMsgsSent++
  }

  /** The sim position jumped (drag release): restart interpolation from it. */
  private onSnap(): void {
    const sim = this.sim
    if (!sim) return
    const s = sim.state
    this.curr = { t: this.curr.t, x: s.x, y: s.y }
    this.prev = { t: this.curr.t - this.stepMs, x: s.x, y: s.y }
    this.broadcastState(true)
  }

  /** Ground-contact point where the pet is drawn right now (A: the real window position). */
  private displayedPoint(nowMs: number): Point {
    if (this.isA && this.lastWin) return { x: this.lastWin.x + this.anchor.x, y: this.lastWin.y + this.anchor.y }
    const p = interpolate(this.prev, this.curr, nowMs - this.stepMs)
    return { x: p.x, y: p.y }
  }

  // ── presentation (A1 / A2) ─────────────────────────────────────────────────────────────────

  private startA1(): void {
    const period = 1000 / T.a1TimerHz
    if (this.options.a1Timer === 'interval') {
      // Naive free-running timer (Node rounds the period to whole ms).
      this.a1Interval = setInterval(() => {
        const t = now()
        this.presentTick(t, t - this.stepMs)
      }, period)
      return
    }
    // Drift-free: absolute deadlines k·period; never bursts to catch up.
    let deadline = now() + period
    const tick = (): void => {
      this.a1Timer = null
      if (this.finishing) return
      const t = now()
      if (t - deadline >= period) {
        const missed = Math.floor((t - deadline) / period)
        deadline += missed * period
        if (this.measuring) this.missedDeadlines += missed
      }
      this.presentTick(t, t - this.stepMs)
      deadline += period
      this.a1Timer = setTimeout(tick, Math.max(0, deadline - now()))
    }
    this.a1Timer = setTimeout(tick, period)
  }

  private onFrame(msg: OverlayFrameMsg): void {
    if (this.options.variant !== 'A2' || this.finishing || !this.clock) return
    const received = now()
    // Map the renderer's vsync-aligned rAF timestamp onto main's clock: the fastest delivery seen
    // approximates the clock offset, so frame-to-frame spacing stays exactly the display's.
    const offset = received - msg.t
    if (offset < this.a2Offset) this.a2Offset = offset
    const vsync = msg.t + this.a2Offset
    if (this.measuring) this.frameLatency.push(received - vsync)
    this.presentTick(received, vsync - this.stepMs)
  }

  private presentTick(nowMs: number, renderT: number): void {
    const win = this.win
    if (!win || win.isDestroyed() || this.finishing) return
    if (this.measuring) {
      this.presentTicks++
      if (this.lastPresentMs !== null) this.presentIntervals.push(nowMs - this.lastPresentMs)
    }
    this.lastPresentMs = nowMs
    let p: Point
    const held = this.interaction?.sampleHeld(nowMs) ?? null
    if (held) {
      p = held
    } else {
      const r = interpolate(this.prev, this.curr, renderT)
      if (r.starved && this.measuring) this.presentStarved++
      p = r
    }
    const x = Math.round(p.x - this.anchor.x)
    const y = Math.round(p.y - this.anchor.y)
    if (this.lastWin && this.lastWin.x === x && this.lastWin.y === y) {
      if (this.measuring) this.setPosUnchanged++
      return
    }
    const t0 = now()
    try {
      win.setPosition(x, y)
    } catch (err) {
      this.setPosErrors++
      this.error(`setPosition(${x}, ${y}) failed: ${String(err)}`)
      return
    }
    if (this.measuring) {
      this.setPosCalls++
      this.setPosDurations.push(now() - t0)
    }
    this.lastWin = { x, y }
  }

  /** ~1 Hz: does AppKit report the position we last set (no constraining, no drift)? */
  private checkWindowPosition(nowMs: number): void {
    const win = this.win
    if (!this.isA || !this.measuring || !win || win.isDestroyed() || !this.lastWin) return
    if (nowMs - this.lastPositionCheckMs < T.positionCheckIntervalMs) return
    this.lastPositionCheckMs = nowMs
    const [x, y] = win.getPosition()
    this.positionChecks++
    if (x !== this.lastWin.x || y !== this.lastWin.y) {
      this.positionMismatches++
      if (this.positionMismatches <= 5) this.warn(`getPosition()=(${x}, ${y}) but last setPosition was (${this.lastWin.x}, ${this.lastWin.y})`)
    }
  }

  // ── IPC and events ─────────────────────────────────────────────────────────────────────────

  private config(): OverlayConfig {
    const win = this.win
    return {
      variant: this.options.variant,
      mode: this.options.mode,
      window: win && !win.isDestroyed() ? win.getContentBounds() : this.requestedBounds,
      edge: this.edge,
      stepMs: this.stepMs,
      interactive: this.options.mode === 'interactive',
    }
  }

  private attachIpc(win: BrowserWindow): void {
    const senderId = win.webContents.id
    const fromUs = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => event.sender.id === senderId
    ipcMain.handle(SPIKE_OVERLAY_IPC.config, (event) => {
      if (!fromUs(event)) throw new Error('spike:overlay:config from an unknown sender')
      return this.config()
    })
    this.detachers.push(() => ipcMain.removeHandler(SPIKE_OVERLAY_IPC.config))
    const on = (channel: string, handler: (payload: unknown) => void): void => {
      const listener = (event: IpcMainEvent, payload: unknown): void => {
        if (fromUs(event)) handler(payload)
      }
      ipcMain.on(channel, listener)
      this.detachers.push(() => ipcMain.removeListener(channel, listener))
    }
    on(SPIKE_OVERLAY_IPC.ready, (p) => {
      if (isOverlayReadyMsg(p)) this.readyResolve?.(p)
      else this.error('malformed spike:overlay:ready payload')
    })
    on(SPIKE_OVERLAY_IPC.frame, (p) => {
      if (isOverlayFrameMsg(p)) this.onFrame(p)
    })
    on(SPIKE_OVERLAY_IPC.stats, (p) => {
      if (isOverlayRendererStats(p)) this.rendererStatsWaiter?.(p)
      else this.error('malformed spike:overlay:stats payload')
    })
    on(SPIKE_OVERLAY_IPC.log, (p) => {
      if (!isOverlayLogMsg(p)) return
      if (p.level === 'error') this.error(`renderer: ${p.message}`)
      else if (p.level === 'warning') this.warn(`renderer: ${p.message}`)
      else out(`${TAG} renderer: ${p.message}`)
    })
    on(IPC.petHover, (p) => {
      if (typeof p === 'object' && p !== null && typeof (p as { over?: unknown }).over === 'boolean') {
        this.interaction?.handleHover((p as { over: boolean }).over)
      }
    })
    on(IPC.petPointer, (p) => {
      if (isPetPointerMsg(p)) this.interaction?.handlePointer(p)
    })
  }

  private attachWebContentsEvents(win: BrowserWindow): void {
    const wc = win.webContents
    wc.on('console-message', (details) => {
      if (details.level === 'error') this.error(`renderer console: ${details.message}`)
      else if (details.level === 'warning') this.warn(`renderer console: ${details.message}`)
    })
    wc.on('render-process-gone', (_event, details) => {
      this.error(`renderer process gone: ${details.reason} (exit ${details.exitCode})`)
      void this.finish('renderer-gone')
    })
    wc.on('preload-error', (_event, _path, error) => this.error(`preload error: ${String(error)}`))
    wc.on('unresponsive', () => this.warn('renderer became unresponsive'))
  }

  private onFocusEvent(e: FocusEvent): void {
    const t = this.originMs > 0 ? `${((e.tMs - this.originMs) / 1000).toFixed(2)}s` : 'startup'
    out(`${TAG} focus: ${e.event} at ${t} (interaction: ${e.interaction})`)
  }

  private installProcessHandlers(): void {
    // One Ctrl+C arrives twice within a few ms (see signals.ts): the first signal finishes cleanly, the
    // echo is ignored, and only a later, deliberate Ctrl+C exits at once without results.
    const gate = new SignalGate(T.signalRepeatGraceMs)
    const onSignal = (signal: string) => (): void => {
      const action = gate.onSignal(now())
      if (action === 'finish') {
        if (this.finishing) out(`${TAG} ${signal}: already finishing (writing results); send it again to exit at once`)
        else void this.finish(`signal:${signal}`)
      } else if (action === 'force-exit') {
        out(`${TAG} ${signal} again: exiting at once, results NOT written`)
        app.exit(130)
      }
    }
    const sigint = onSignal('SIGINT')
    const sigterm = onSignal('SIGTERM')
    process.on('SIGINT', sigint)
    process.on('SIGTERM', sigterm)
    // Also keeps Electron from showing its "JavaScript error in the main process" dialog, which would steal focus.
    process.on('uncaughtException', (err) => {
      this.error(`main uncaught exception: ${err.stack ?? String(err)}`)
      void this.finish('fatal')
    })
    process.on('unhandledRejection', (reason) => this.error(`main unhandled rejection: ${String(reason)}`))
    this.detachers.push(
      () => process.off('SIGINT', sigint),
      () => process.off('SIGTERM', sigterm),
    )
  }

  private error(message: string): void {
    if (this.errors.length < 200) this.errors.push(message)
    out(`${TAG} ERROR ${message}`)
  }

  private warn(message: string): void {
    if (this.warnings.length < 200) this.warnings.push(message)
    out(`${TAG} warning: ${message}`)
  }

  // ── shutdown and results ───────────────────────────────────────────────────────────────────

  /** Startup failed: record why, write what we have and exit. */
  async abort(err: unknown): Promise<void> {
    this.error(`startup failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    await this.finish('startup-failed')
  }

  async finish(reason: string): Promise<void> {
    if (this.finishing) return
    this.finishing = true
    const endMs = now()
    for (const timer of [this.simTimer, this.a1Timer, this.warmupTimer, this.durationTimer]) if (timer) clearTimeout(timer)
    if (this.a1Interval) clearInterval(this.a1Interval)
    this.interaction?.stop()
    this.metrics.stop()
    try {
      // Closes the measurement window at endMs for the cumulative-CPU means (unless a periodic sample
      // was just taken: a very short interval would only add a noisy CPU% sample).
      const last = this.metrics.samples[this.metrics.samples.length - 1]
      if (last && endMs - last.tMs >= T.metricsIntervalMs / 4) this.metrics.sample()
    } catch {
      // App metrics can be unavailable during teardown; the periodic samples suffice.
    }

    const win = this.win
    let rendererStats: OverlayRendererStats | null = null
    if (win && !win.isDestroyed() && reason !== 'renderer-gone' && this.ready) {
      rendererStats = await this.requestRendererStats(T.timeouts.rendererStatsMs)
    }
    this.focus?.stop()
    // After the renderer's stats snapshot: `footprint` walks our processes' memory, outside the measurement.
    await this.measureFootprint()
    const capture = await this.capturePet()

    let code = 0
    try {
      const file = join(this.options.resultsDir, resultsFileName(this.options, this.startedAt))
      const results = this.buildResults(endMs, reason, rendererStats, file, capture)
      mkdirSync(this.options.resultsDir, { recursive: true })
      writeFileSync(file, `${JSON.stringify(results, null, 1)}\n`)
      out(`${TAG} RESULT ${results.summary}`)
      out(`${TAG} wrote ${file}`)
      code = results.ok ? 0 : 2
    } catch (err) {
      out(`${TAG} ERROR could not write results: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      code = 1
    }
    for (const detach of this.detachers.splice(0)) detach()
    if (win && !win.isDestroyed()) win.destroy()
    // SPEC-DEVIATION: §12 says quit cleanly with app.quit(). Clean runs do (with an app.exit(0)
    // fallback); runs that recorded errors exit with status 2 (1 = results not written) so the bench
    // runner can tell a failed run from a good one.
    if (code === 0) {
      // Results are flushed; quit normally (window-all-closed never quits this agent app by itself).
      setTimeout(() => app.exit(0), T.timeouts.quitFallbackMs).unref()
      app.quit()
    } else {
      app.exit(code)
    }
  }

  /**
   * Activity Monitor's "Memory" (phys_footprint) for every Bitbot process, read once with `footprint`
   * at the end of the run (see footprint.ts). A failure is a warning: RSS is still reported.
   * SPEC-DEVIATION: the task records workingSetSize (still sampled every second, reported as RSS); §11
   * measures memory with Activity Monitor, i.e. phys_footprint, so that is the headline memory number.
   */
  private async measureFootprint(): Promise<void> {
    const last = this.metrics.samples[this.metrics.samples.length - 1]
    if (!last || last.procs.length === 0) {
      this.footprintError = 'no app metrics sample to take process ids from'
      return
    }
    const atMs = now()
    const run = await runFootprint(
      last.procs.map((p) => p.pid),
      T.timeouts.footprintMs,
      now,
    )
    if (!run.output) {
      this.footprintError = run.error
      this.warn(`footprint failed: ${run.error ?? 'unknown error'}`)
      return
    }
    const footprint = aggregateFootprint(last.procs, run.output)
    if (footprint.missingPids.length > 0) this.warn(`footprint did not report pid(s) ${footprint.missingPids.join(', ')}`)
    this.footprint = { atS: round((atMs - this.originMs) / 1000, 3), tookMs: round(run.tookMs, 1), ...footprint }
  }

  /**
   * Dev check (--capture): our own page, cropped to the pet viewport, as a PNG plus alpha coverage,
   * so A/B/Bfull can be shown to draw the same pet at the same place. webContents.capturePage needs
   * no Screen Recording permission and only ever sees this window's own content.
   */
  private async capturePet(): Promise<CaptureResults | null> {
    const file = this.options.capture
    const win = this.win
    if (!file || !win || win.isDestroyed() || !this.ready) return null
    try {
      const cb = win.getContentBounds()
      const p = this.displayedPoint(now())
      const rect = this.isA
        ? undefined
        : { x: Math.round(p.x - this.anchor.x - cb.x), y: Math.round(p.y - this.anchor.y - cb.y), width: this.edge, height: this.edge }
      const image = await win.webContents.capturePage(rect)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, image.toPNG())
      const scale = image.getScaleFactors()[0] ?? 1
      const { width, height } = image.getSize(scale)
      const bmp = image.toBitmap({ scaleFactor: scale })
      let opaque = 0
      let alphaSum = 0
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1
      if (bmp.length === width * height * 4) {
        for (let i = 0; i < width * height; i++) {
          const a = bmp[i * 4 + 3] ?? 0
          if (a === 0) continue
          opaque++
          alphaSum += a
          const x = i % width
          const y = Math.floor(i / width)
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      } else {
        this.warn(`capture bitmap is ${bmp.length} bytes, expected ${width * height * 4}`)
      }
      const result: CaptureResults = {
        file,
        rectDip: rect ?? { x: 0, y: 0, width: cb.width, height: cb.height },
        width,
        height,
        opaquePixels: opaque,
        alphaSum,
        opaqueBox: maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
      }
      out(`${TAG} capture ${file}: ${width}x${height} px, ${opaque} opaque px, box ${JSON.stringify(result.opaqueBox)}`)
      return result
    } catch (err) {
      this.warn(`capture failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  private requestRendererStats(timeoutMs: number): Promise<OverlayRendererStats | null> {
    const win = this.win
    if (!win || win.isDestroyed()) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.rendererStatsWaiter = null
        this.error(`renderer did not send stats within ${timeoutMs} ms`)
        resolve(null)
      }, timeoutMs)
      this.rendererStatsWaiter = (stats) => {
        clearTimeout(timer)
        this.rendererStatsWaiter = null
        resolve(stats)
      }
      win.webContents.send(SPIKE_OVERLAY_IPC.statsRequest)
    })
  }

  private buildResults(
    endMs: number,
    reason: string,
    rs: OverlayRendererStats | null,
    file: string,
    capture: CaptureResults | null,
  ): OverlayResults {
    const o = this.options
    const display = this.display ?? screen.getPrimaryDisplay()
    const relS = (t: number): number => round((t - this.originMs) / 1000, 3)
    const mStart = this.measureStartMs
    const measuredS = mStart === null ? 0 : (endMs - mStart) / 1000
    if (mStart === null) this.warn('run ended before the warm-up was over: nothing was measured')
    const rawRound = (xs: Float64Array): number[] => Array.from(xs, (v) => round(v, 3))

    let presentation: PresentationResults | null = null
    if (this.isA) {
      presentation = {
        driver: o.variant === 'A2' ? 'raf' : o.a1Timer === 'interval' ? 'timer-interval' : 'timer-deadline',
        ticks: this.presentTicks,
        intervalMs: roundSummary(summarize(this.presentIntervals.values())),
        rawIntervalsMs: rawRound(this.presentIntervals.values()),
        setPosition: {
          calls: this.setPosCalls,
          unchanged: this.setPosUnchanged,
          errors: this.setPosErrors,
          durationMs: roundSummary(summarize(this.setPosDurations.values()), 4),
        },
        starved: this.presentStarved,
        missedDeadlines: this.missedDeadlines,
        frameLatencyMs: o.variant === 'A2' ? roundSummary(summarize(this.frameLatency.values())) : null,
        positionMismatches: this.positionMismatches,
        positionChecks: this.positionChecks,
      }
    }

    let renderer: RendererResults | null = null
    if (rs) {
      const raf = summarize(rs.rafIntervalsMs)
      renderer = {
        frames: rs.frames,
        measuredS: round(rs.measuredMs / 1000, 3),
        rafIntervalMs: roundSummary(raf),
        medianRafMs: raf ? round(raf.p50, 3) : null,
        longFrameMs: T.longFrameMs,
        pctLongFrames: round(fractionAbove(rs.rafIntervalsMs, T.longFrameMs) * 100, 3),
        callbackMs: roundSummary(summarize(rs.callbackMs), 4),
        renderMs: roundSummary(summarize(rs.renderMs), 4),
        starvedFrames: rs.starvedFrames,
        stateMsgs: rs.stateMsgs,
        mousemoves: rs.mousemoves,
        hitTests: rs.hitTests,
        hoverMsgsSent: rs.hoverMsgsSent,
        truncated: rs.truncated,
        rawRafIntervalsMs: rs.rafIntervalsMs.map((v) => round(v, 3)),
      }
      if (rs.truncated) this.warn('renderer series hit the raw sample cap (stats cover the first samples only)')
    }

    const interaction = this.interaction?.stats ?? {
      hoverOn: 0,
      hoverOff: 0,
      clickThroughToggles: 0,
      safetyNet: 0,
      safetyNetMissedLeaves: 0,
      safetyNetFirings: [],
      pets: 0,
      drags: 0,
      menus: 0,
      pointerIgnored: 0,
      verdicts: [],
    }
    const focusEvents = (this.focus?.events ?? []).map((e) => ({ tS: relS(e.tMs), event: e.event, interaction: e.interaction }))
    const gpuStatus: Record<string, string> = {}
    for (const [k, v] of Object.entries(app.getGPUFeatureStatus())) gpuStatus[k] = String(v)
    const cpu0 = cpus()

    const cpu = aggregateMetrics(this.metrics.samples, mStart ?? endMs, endMs, T.metricsIntervalMs)
    const base: Omit<OverlayResults, 'summary'> = {
      schema: RESULTS_SCHEMA,
      variant: o.variant,
      mode: o.mode,
      label: o.label,
      startedAt: this.startedAt.toISOString(),
      file,
      ok: false,
      options: {
        durationS: o.durationS,
        warmupS: T.warmupS,
        windowType: o.windowType,
        size: o.size,
        palette: o.palette,
        a1Timer: o.a1Timer,
        simHz: T.simHz,
        simLeadMs: T.simLeadMs,
        a1TimerHz: T.a1TimerHz,
        walkSpeed: tuning.move.walkSpeed,
        followSpeed: T.followSpeed,
        syntheticPeakSpeed: T.synthetic.peakSpeed,
      },
      env: {
        electron: process.versions.electron ?? 'unknown',
        chrome: process.versions.chrome ?? 'unknown',
        node: process.versions.node,
        macos: process.getSystemVersion(),
        arch: process.arch,
        cpu: cpu0[0]?.model ?? 'unknown',
        cores: cpu0.length,
        displays: screen.getAllDisplays().length,
        gpuFeatureStatus: gpuStatus,
        onBattery: powerMonitor.isOnBatteryPower(),
        thermalState: powerMonitor.getCurrentThermalState(),
        loadAvg1m: { start: round(this.loadAtStart, 2), end: round(loadavg()[0] ?? 0, 2) },
      },
      display: {
        id: display.id,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        displayFrequency: display.displayFrequency,
        internal: display.internal,
      },
      window: {
        wid: this.wid,
        requestedBounds: this.requestedBounds,
        state: this.windowState,
        edge: this.edge,
        anchor: this.anchor,
        petBox: this.petBox,
        devicePixelRatio: this.ready?.devicePixelRatio ?? null,
        canvas: this.ready?.canvas ?? null,
        glRenderer: this.ready?.glRenderer ?? null,
      },
      measure: {
        warmupS: T.warmupS,
        startS: mStart === null ? null : relS(mStart),
        endS: relS(endMs),
        measuredS: round(measuredS, 3),
        endReason: reason,
      },
      sim: {
        stepMs: round(this.stepMs, 4),
        steps: this.clock?.stepCount ?? 0,
        droppedSteps: this.clock?.droppedSteps ?? 0,
        wakeIntervalMs: roundSummary(summarize(this.wakeIntervals.values())),
        wakeLatenessMs: roundSummary(summarize(this.wakeLateness.values())),
        stepsPerWake: this.stepsPerWake,
        stepComputeMs: roundSummary(summarize(this.stepWork.values()), 4),
        stateMsgsSent: this.stateMsgsSent,
      },
      presentation,
      renderer,
      cpu,
      memory: { footprint: this.footprint, footprintError: this.footprintError, rssMeanMB: cpu.total.memMeanMB },
      metricsSamples: this.metrics.samples.map((sample) => ({ tS: relS(sample.tMs), procs: sample.procs })),
      interaction: { ...interaction, focusEvents, activations: this.focus?.activationCount ?? 0 },
      capture,
      errors: this.errors,
      warnings: this.warnings,
    }
    base.ok = base.errors.length === 0
    return { ...base, summary: summaryLine(base) }
  }
}
