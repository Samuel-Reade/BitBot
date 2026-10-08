// The M1 dev check (docs/decisions/overlay.md "Dev check" and "What the check can't see"):
//   electron . --check=overlay [--results=DIR] [--label=TEXT] [--no-measure] [--phases=a,b] [--a2-walk=FILE]
//                              [--a2-synthetic=FILE]          (npm run build first; see OVERLAY_CHECK_USAGE)
// Runs the real Bitbot (BitbotApp, its own profile; index.ts) with a synthetic cursor and synthetic mouse events sent
// only to Bitbot's own grab-area webContents, and reports:
// 1. functional checks, one PASS/FAIL line each (window settings, one renderer process, the helper's view of the
//    windows, the grab area appearing near the pet only, the event path, click, drag, drop, lost mouseup, right-click,
//    cancel by hiding, show, reload, no activation, no network, no errors);
// 2. measurement phases (idle, hidden, near, walk under a parked cursor, walk with the cursor near, chase, drag
//    patrols): CPU per process as % of one core, renderer frames, grab-area activity, hover latencies, drag
//    input→frame latency and whether the grab area keeps covering the pet; the memory footprint once at the end;
// 3. a verdict against tuning.dev.overlayCheck.thresholds, and a JSON results file (spike-results/, gitignored).
// Exit code 0 only if every functional check and every gating threshold passes (CPU vs A2 is report-only).
//
// §2 holds for the check too: it never moves the real cursor, clicks or types, triggers no permission prompt (capturePage
// sees only Bitbot's own windows; footprint, ps and pmset need none), reads no window titles, and makes no network
// request. The pet appears and moves at the bottom of the primary display while it runs.
//
// Driving Bitbot: through BitbotAppOptions (the cursor, the menu, the scripted mover) and inspect(), plus synthetic
// events (webContents.sendInputEvent with x/y relative to the grab area and globalX/globalY, 'leftbuttondown' on drag
// moves, the injected cursor moved in step). A lost mouseup is produced by calling PetInteraction.handleNativeMouse
// directly: Electron 44's before-mouse-event carries no modifiers and sendInputEvent always sets button 'left'.
// The check's per-step hook (the devMover) also probes, once per simulation wake and before that wake re-places the
// grab area, whether the grab area still covers the pet's box where it is drawn.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain, powerMonitor, screen, type MouseInputEvent } from 'electron'
import { boxAt, clampToArea, distance, rectContainsRect, type Box, type Point, type Rect } from '../../shared/geometry'
import { sampleBuffer, type TimedPoint } from '../../shared/interpolation'
import type { DevPanelSet } from '../../shared/devPanel'
import { IPC } from '../../shared/ipc'
import type { OverlayStatsMsg, PetReadyMsg } from '../../shared/petProtocol'
import { tuning } from '../../shared/tuning'
import { BitbotApp, type BitbotInspection } from '../bitbotApp'
import type { CliArgs } from '../cli'
import { resolveHelperPath } from '../helper/paths'
import { HELPER_PROTOCOL_VERSION, type HelperWindow } from '../helper/protocol'
import { blockedRequestCount } from '../security'
import type { SimLoop } from '../sim/loop'
import { windowNumber } from '../windows/onScreen'
import type { PetInteraction } from '../windows/petInteraction'
import {
  canvasArea,
  Chase,
  dragLiftMs,
  dragPatrolAt,
  fallTimeMs,
  makeLissajousPath,
  spanCrossings,
  walkAt,
  type DragPatrol,
  type Walk,
} from './checkPaths'
import {
  countDrawnPixels,
  judge,
  newestA2,
  overshoot,
  pairLatencies,
  percentileWithMisses,
  readA2Run,
  rendererDelta,
  verdictLine,
  zOrder,
  type A2Run,
  type LatencyPairs,
  type MouseToggle,
  type RendererDelta,
  type Verdict,
  type ZOrder,
} from './checkVerdicts'
import { aggregateFootprint, runFootprint, type FootprintAggregate } from './footprint'
import { cpuPercent, cpuSample, cpuWindow, psCpuSeconds, readPowerInfo, type CpuSample, type PowerInfo } from './metrics'
import { fmt, round, roundSummary, summarize, type Summary } from './stats'

const T = tuning.dev.overlayCheck
const RESULTS_SCHEMA = 'bitbot.check.overlay/1'
/** kCGFloatingWindowLevel: the 'floating' level both windows use (above app windows, below the Dock). A macOS constant. */
const FLOATING_LAYER = 3
const LABEL_RE = /^[A-Za-z0-9._-]{1,80}$/

/**
 * Log lines that mean something went wrong (the "no errors logged" check): errors and warnings, failed verdicts, the
 * overlay's own error reports, fail-closed decisions, dependency failures, a recreated overlay, helper trouble.
 */
const ERROR_LINES: readonly RegExp[] = [
  /\bERROR\b/,
  /\bWARNING\b/,
  /\(FAIL\b/,
  /overlay (error|warning):/,
  /overlay: (the pet page did not load|preload error|denied a window\.open|ignored a malformed)/,
  /making a new window in/,
  /unexpected error/,
  /grab area hidden: /,
  / failed: /,
  /could not order it directly above the overlay/,
  /helper protocol problem|speaks protocol|bitbot-helper not built|helper exited|helper restarted/,
  /^\[bitbot-helper\]/,
]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** On the ground and still: idle, or land (a touchdown's squash and settle, tuning.move.landS, before idle). */
const standing = (behavior: string): boolean => behavior === 'idle' || behavior === 'land'
const now = (): number => performance.now()
const errorDetail = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err))

export interface OverlayCheckOptions {
  resultsDir: string
  label: string | null
  /** false: functional checks only (no measurement phases, no footprint). */
  measure: boolean
  /** Only these measurement phases (null: all). */
  phases: readonly PhaseName[] | null
  /** Spike A results to compare with; default: the newest A2 runs of this session in resultsDir. */
  a2Walk: string | null
  a2Synthetic: string | null
}

export const OVERLAY_CHECK_USAGE =
  'usage: electron . --check=overlay [--results=DIR (default <repo>/spike-results)] [--label=TEXT] [--no-measure]\n' +
  '         [--phases=idle,idleContinuous,sleepEvent,sleepContinuous,hidden,nearStill,walkParked,walkCursor,chase,drag120,\n' +
  '                   drag600 (default: all)]\n' +
  '         [--a2-walk=FILE --a2-synthetic=FILE (Spike A results to compare with; default: the newest of this session)]'

export function parseOverlayCheckOptions(args: CliArgs, ctx: { appPath: string; cwd: string }): OverlayCheckOptions {
  const path = (value: string | undefined): string | null => (value ? (isAbsolute(value) ? value : resolve(ctx.cwd, value)) : null)
  const label = args['label'] ?? null
  if (label !== null && !LABEL_RE.test(label)) {
    throw new Error(`--label may only use letters, digits, '.', '_' and '-' (got ${label})`)
  }
  let phases: PhaseName[] | null = null
  if (args['phases'] !== undefined) {
    phases = args['phases'].split(',').filter((p) => p !== '') as PhaseName[]
    const unknown = phases.filter((p) => !(p in PHASE_TITLES))
    if (unknown.length > 0 || phases.length === 0) {
      throw new Error(`--phases takes a list of ${Object.keys(PHASE_TITLES).join(', ')} (got ${args['phases']})`)
    }
  }
  return {
    resultsDir: path(args['results']) ?? join(ctx.appPath, 'spike-results'),
    label,
    measure: args['no-measure'] !== 'true',
    phases,
    a2Walk: path(args['a2-walk']),
    a2Synthetic: path(args['a2-synthetic']),
  }
}

export async function runOverlayCheck(args: CliArgs): Promise<void> {
  let options: OverlayCheckOptions
  try {
    options = parseOverlayCheckOptions(args, { appPath: app.getAppPath(), cwd: process.cwd() })
  } catch (err) {
    console.log(`[check] ${err instanceof Error ? err.message : String(err)}\n${OVERLAY_CHECK_USAGE}`)
    app.exit(2)
    return
  }
  const code = await new OverlayCheck(options).run()
  app.exit(code)
}

type PhaseName =
  | 'idle'
  | 'idleContinuous'
  | 'sleepEvent'
  | 'sleepContinuous'
  | 'hidden'
  | 'nearStill'
  | 'walkParked'
  | 'walkCursor'
  | 'chase'
  | 'drag120'
  | 'drag600'

const PHASE_TITLES: Record<PhaseName, string> = {
  idle: 'idle, event style (cursor far)',
  idleContinuous: 'idle, continuous style (cursor far)',
  sleepEvent: 'asleep, event style',
  sleepContinuous: 'asleep, continuous style',
  hidden: 'hidden',
  nearStill: 'near, still (cursor beside the pet)',
  walkParked: 'walk under a parked cursor',
  walkCursor: 'walk, cursor moving near',
  chase: `chase ${T.chase.speed} pt/s, cursor near`,
  drag120: `drag patrol ${T.dragPatrol.speeds.slow} pt/s`,
  drag600: `drag patrol ${T.dragPatrol.speeds.fast} pt/s`,
}

interface Coverage {
  /** Wakes with the grab area shown (it should cover the pet's box then). */
  shownWakes: number
  outsideWakes: number
  maxOvershootPt: number
  /**
   * Wakes with YOUR (real) mouse inside the shown grab area. macOS then sends it real, buttonless mouse moves that end
   * the check's synthetic drags and flip its hover: that phase's numbers are not the pipeline's.
   */
  realMouseWakes: number
}

interface PhaseResult {
  name: PhaseName
  title: string
  startMs: number
  endMs: number
  measuredS: number
  cpu: {
    /** % of one core per Electron process type, from cumulative CPU time. */
    byType: Record<string, number>
    main: number
    renderer: number
    gpu: number
    utility: number
    /** The Electron processes (what Spike A's "CPU total" summed). */
    electron: number
    /** bitbot-helper (ps); null if it could not be read. */
    helper: number | null
    /** Electron + helper. */
    total: number | null
    /** Processes measured from percentCPUUsage because a cumulative reading was missing. */
    fallbacks: number
  }
  /** Idle wakeups per second per process type (Electron's energy-impact counter). */
  wakeupsPerS: Record<string, number>
  simWakesPerS: number
  simStepsPerS: number
  renderer: RendererDelta | null
  /** The grab area's native calls (ElectronHitWindow's counters) over the phase, and per second. */
  grab: GrabCounts & { perS: GrabCounts }
  coverage: (Coverage & { outsidePct: number | null }) | null
  /** Main-process time spent in the check's own per-step and cursor hooks, ms per second (it inflates main's CPU). */
  checkHooksMsPerS: number
  /** Drag phases: synthetic moves sent. */
  eventsSent: number | null
}

interface GrabCounts {
  moves: number
  shows: number
  hides: number
  mouseToggles: number
}

interface FunctionalResult {
  name: string
  pass: boolean
  detail: string
}

class Abort extends Error {}

class OverlayCheck {
  private readonly t0 = now()
  private readonly startedAt = new Date()
  private readonly load0 = loadavg()
  private readonly cores = Math.max(1, cpus().length)
  private readonly functional: FunctionalResult[] = []
  private readonly errorLines: string[] = []
  private readonly phases: Partial<Record<PhaseName, PhaseResult>> = {}
  private bitbot: BitbotApp | null = null
  private interaction: PetInteraction | null = null
  private loop: SimLoop | null = null
  /** The live simulation (created with the first pet:ready). */
  private loco: BitbotInspection['locomotion'] = null
  private ready: PetReadyMsg | null = null
  private power: PowerInfo | null = null
  private stepMs = 1000 / tuning.sim.hz

  // What the check feeds Bitbot.
  private cursorPoint: Point = { x: 0, y: 0 }
  /** The windows Bitbot's world is built from (made up; never the user's). */
  private windows: HelperWindow[] = []
  private cursorFn: ((nowMs: number) => Point) | null = null
  private mover: ((tMs: number) => Point | null) | null = null
  private popupCalls = 0
  private closeMenu: (() => void) | null = null
  /** Cursor minus the pet's ground-contact point at the current synthetic press (where the overlay draws a held pet). */
  private pressOffset: Point | null = null

  // Probes.
  /** The pet's newest steps (time, ground point), for the check's own estimate of where the overlay draws it. */
  private readonly steps: TimedPoint[] = []
  private lastWake = -1
  private coverage: Coverage | null = null
  private toggles: MouseToggle[] | null = null
  private lastMouse = false
  private hookMs = 0
  private readonly onHoverIpc = (): void => this.noteMouse()

  private calibration: { dyPt: number; span: { left: number; right: number } } | null = null
  private latency: (LatencyPairs & { crossings: number; enter: Summary | null; leave: Summary | null }) | null = null
  private footprint: { electron: FootprintAggregate | null; helper: FootprintAggregate | null; error: string | null } | null = null
  private a2: { walk: A2Run | null; synthetic: A2Run | null; looked: string } | null = null
  private verdicts: Verdict[] = []

  constructor(private readonly opts: OverlayCheckOptions) {}

  async run(): Promise<number> {
    const hard = setTimeout(() => void this.hardStop(), T.hardTimeoutS * 1000)
    try {
      await this.sequence()
    } catch (err) {
      if (!(err instanceof Abort)) this.check('no exception', false, errorDetail(err))
    }
    clearTimeout(hard)
    const code = this.finish()
    await this.bitbot?.quit('dev check done')
    return code
  }

  // ───────────────────────────── the sequence ─────────────────────────────

  private async sequence(): Promise<void> {
    this.log(
      `[check] Bitbot dev check: overlay (approach B, hardened). Electron ${process.versions.electron}, ` +
        `macOS ${process.getSystemVersion()}, ${cpus()[0]?.model ?? 'unknown CPU'} (${this.cores} cores)`,
    )
    this.power = await readPowerInfo(T.toolTimeoutMs)
    this.printConditions('start')
    const helperPath = resolveHelperPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    })
    if (!existsSync(helperPath)) {
      this.check('bitbot-helper present', false, `${helperPath} missing: run npm run build:helper`)
      throw new Abort()
    }

    const bitbot = new BitbotApp({
      cursor: () => this.cursorNow(),
      popupMenu: (onClose) => {
        this.popupCalls++
        this.closeMenu = onClose
      },
      devMover: (tMs) => this.onStep(tMs),
      windows: () => this.windows,
      debug: true,
      log: (line) => this.appLog(line),
    })
    this.bitbot = bitbot
    bitbot.installErrorHandlers()
    // After BitbotApp's own listener: by the time this runs, PetInteraction has handled the hover.
    ipcMain.on(IPC.petHover, this.onHoverIpc)
    const wa = screen.getPrimaryDisplay().workArea
    this.cursorPoint = this.farPoint()
    await bitbot.start()
    this.interaction = this.i().interaction
    this.loop = this.i().loop
    this.stepMs = this.loop.stepMs

    await this.helperChecks()
    this.ready = await this.i().waitForReady(T.readyTimeoutMs)
    const opened = this.ready.hitWindowOpened ? 'opened' : 'NOT opened'
    this.check('pet:ready', true, `page load ${this.i().readyLoad}, ${this.ready.devicePixelRatio}x, grab area ${opened}`)
    await this.until(
      'the pet is drawn for the newest configuration (after the area config-changed)',
      () => this.i().petDrawn && this.i().configSeq >= 2,
    )
    this.watchConsole()
    // The grab area's checks and timings assume an outline that only moves with the pet: the still idle style (blinks
    // and looks only). The idle styles' own cost is measured in their phases.
    this.i().setDevOverrides({ idleMode: 'still', wander: false })
    this.loco = this.i().locomotion
    const home = this.groundPoint()
    this.log(`[check] the pet stands at ${fmtPoint(home)} (work area ${fmtRect(wa)})`)

    await this.windowChecks()
    await this.grabAreaChecks(home)
    await this.interactionChecks(home)
    await this.directingChecks(home)
    await this.worldChecks(home)
    if (this.opts.measure) await this.measurements(home)
    await this.reloadCheck()
    await this.finalChecks()
  }

  private async helperChecks(): Promise<void> {
    const ok = await this.until(null, () => this.i().helper?.helloMessage != null, T.helperHelloTimeoutMs)
    const hello = this.i().helper?.helloMessage ?? null
    if (!ok || !hello) {
      this.check('bitbot-helper started (hello)', false, `no hello within ${T.helperHelloTimeoutMs} ms: run npm run build:helper`)
      throw new Abort()
    }
    if (hello.version !== HELPER_PROTOCOL_VERSION) {
      const hint = `it speaks ${hello.version}: run npm run build:helper`
      this.check(`bitbot-helper speaks protocol ${HELPER_PROTOCOL_VERSION}`, false, hint)
      throw new Abort()
    }
    this.check(`bitbot-helper present, protocol ${HELPER_PROTOCOL_VERSION}`, true, `pid ${hello.pid}`)
  }

  private async windowChecks(): Promise<void> {
    const ov = this.overlay()
    const hw = this.hitWindow()
    this.check('overlay: not focusable', !ov.isFocusable())
    this.check('overlay: always on top', ov.isAlwaysOnTop())
    this.check('overlay: visible on all workspaces', ov.isVisibleOnAllWorkspaces())
    this.check('grab area: not focusable', !hw.isFocusable())
    this.check('grab area: always on top', hw.isAlwaysOnTop())
    const tabs = app.getAppMetrics().filter((m) => m.type === 'Tab')
    this.check('exactly one renderer process', tabs.length === 1, `${tabs.length} 'Tab' process(es)`)
    const ovPid = ov.webContents.getOSProcessId()
    const hwPid = hw.webContents.getOSProcessId()
    const pids = `overlay pid ${ovPid}, grab area pid ${hwPid}`
    this.check("the grab area lives in the overlay's renderer process", ovPid === hwPid, pids)
    this.check('no Dock icon', app.dock?.isVisible() === false)
  }

  private async grabAreaChecks(home: Point): Promise<void> {
    const hw = this.hitWindow()
    this.cursorPoint = this.farPoint()
    this.check('cursor far: grab area hidden', await this.holds(() => !hw.isVisible() && !this.ix().placement.shown))
    let z = await this.zOrderNow()
    const overlayListed = z?.overlay?.onScreen === true && z.overlay.layer === FLOATING_LAYER
    this.check('helper: overlay on screen at layer 3', overlayListed, this.describeZ(z))

    this.cursorPoint = this.cornerPoint(home)
    await this.until('cursor near: grab area shown (once the helper confirmed the overlay on screen)', () => hw.isVisible())
    const bounds = hw.getBounds()
    const box = boxAt(home, this.box())
    this.check("grab area covers the pet's box", rectContainsRect(bounds, box), `bounds ${fmtRect(bounds)}, box ${fmtRect(box)}`)
    // The window server lists a window a moment after it was ordered in (and drops it a moment after it went).
    const shown = await this.untilZ((zz) => zz.grab !== null)
    z = shown.z
    this.check(
      'helper: grab area on screen at layer 3, directly in front of the overlay',
      z?.grab?.onScreen === true && z.grab.layer === FLOATING_LAYER && z.between === 0,
      `${this.describeZ(z)}; listed ${shown.ms.toFixed(0)} ms after it was shown`,
    )
    this.check('cursor near but off the silhouette: click-through', await this.holds(() => !this.ix().mouseEnabled))
    const capture = await this.capture(hw)
    this.check(
      'grab area capture fully transparent',
      capture !== null && capture.drawn === 0,
      capture ? `${capture.width}x${capture.height} px, ${capture.drawn} drawn` : 'capture failed',
    )

    // The event path: main's cursor sample says "off the silhouette" (and stays still, so no new one is sent) while a
    // grab-area mousemove lands on the pet. Only the grab area's own event can switch the mouse on.
    const s0 = await this.stats()
    this.send('mouseMove', this.pressPoint(home))
    await this.until('a grab-area mousemove over the pet: the grab area takes the mouse', () => this.ix().mouseEnabled)
    const s1 = await this.stats()
    const d =
      s0 && s1 ? { cursor: s1.cursorMsgs - s0.cursorMsgs, hover: s1.hoverMsgs - s0.hoverMsgs, hits: s1.hitTests - s0.hitTests } : null
    this.check(
      "…through the native path (the overlay hit-tested the grab area's event, not main's cursor samples)",
      d !== null && d.cursor === 0 && d.hover === 1 && d.hits > 0,
      d ? `cursor msgs +${d.cursor}, hover msgs +${d.hover}, hit tests +${d.hits}` : 'no stats',
    )

    this.cursorPoint = this.farPoint()
    await this.until('cursor far again: grab area hidden', () => !hw.isVisible())
    const gone = await this.untilZ((zz) => zz.grab === null)
    this.check(
      'helper: the hidden grab area is not in the on-screen list',
      gone.z !== null && gone.z.grab === null,
      `${this.describeZ(gone.z)}; gone from the list ${gone.ms.toFixed(0)} ms after it was hidden`,
    )
    this.check('…and click-through', !this.ix().mouseEnabled)
  }

  /**
   * M4 directing (§10.4): a toss (let go while moving fast: it flies on, lands farther along, dizzy), Come here (to the
   * cursor) and Go home.
   */
  private async directingChecks(home: Point): Promise<void> {
    const ix = this.ix()
    const loco = (): NonNullable<BitbotInspection['locomotion']> => {
      const l = this.i().locomotion
      if (!l) throw new Error('no pet')
      return l
    }
    await this.goTo(home)
    const press = this.pressPoint(home)
    this.cursorPoint = press
    await this.until(null, () => ix.mouseEnabled)
    this.down(press)
    await this.until('toss: held', () => ix.held)
    this.pressOffset = { x: press.x - home.x, y: press.y - home.y }
    const end = await this.dragMoves(press, T.toss)
    const releasedX = end.x - this.pressOffset.x
    this.up(end) // still moving: a toss
    this.pressOffset = null
    await this.until('toss: released', () => !ix.held)
    const flew = await this.until('toss: it flies off (falling with sideways speed)', () => loco().state.behavior === 'fall' && loco().state.vx > 0)
    if (flew) {
      await this.until(null, () => standing(loco().state.behavior), 5000)
      // Farther along, or back the other way after bouncing off the screen's side (a hard toss reaches it).
      const flight = loco().state.x - releasedX
      this.check('toss: …and lands well away from the release point', Math.abs(flight) >= T.toss.minFlightPt, `${flight.toFixed(0)} pt from it`)
      const r = this.i().reaction
      this.check('toss: …dizzy after a hard throw (§10.4)', r?.kind === 'dizzy', `reaction ${r ? `${r.kind} #${r.seq}` : 'none'}`)
    }
    await this.until(null, () => loco().state.behavior === 'idle')

    const D = T.directing
    const target = { x: home.x + D.comeHereDx, y: home.y }
    this.cursorPoint = target
    this.bitbot?.comeHere('dev check')
    await this.until(
      'Come here: it walks to the cursor (§10.4)',
      () => loco().goal === null && loco().state.behavior === 'idle' && Math.abs(loco().state.x - target.x) <= D.arrivePt,
      D.walkTimeoutMs,
    )
    this.cursorPoint = this.farPoint()
    this.bitbot?.goHome('dev check')
    await this.until(
      'Go home: it walks back to its home on the Dock',
      () => loco().goal === null && loco().state.behavior === 'idle' && Math.abs(loco().state.x - home.x) <= D.arrivePt,
      D.walkTimeoutMs,
    )
  }

  /**
   * M3: the world from a made-up window. The pet gets onto its top (a route: walk, climb its side, step on), rides it
   * while it moves (with the fast snapshot rate), and falls back to the ground when it closes.
   */
  private async worldChecks(home: Point): Promise<void> {
    const W = T.world
    const loco = (): NonNullable<BitbotInspection['locomotion']> => {
      const l = this.i().locomotion
      if (!l) throw new Error('no pet')
      return l
    }
    const win: HelperWindow = {
      wid: 900_001,
      pid: 1,
      bundleId: 'com.bitbot.check',
      layer: 0,
      x: home.x + W.dx,
      y: home.y - W.up,
      w: W.width,
      h: W.up,
      onScreen: true,
      alpha: 1,
    }
    const onTop = (): boolean => loco().state.surface?.startsWith(`top:${win.wid}:`) === true
    this.windows = [{ ...win }]
    this.i().refreshWorld()
    if (!(await this.until("world: the made-up window's top is a surface", () => loco().world.segments.some((s) => s.windowId === win.wid))))
      return
    this.check('world: a route onto its top', loco().goTo({ x: win.x + win.w / 2, y: win.y }))
    const reached = await this.until(
      'world: the pet gets onto the window (walks, climbs its side, steps onto the top)',
      // Arrived: on the top with its route done (a hop onto the corner lands first, then it walks on to the middle).
      () => onTop() && loco().state.behavior === 'idle' && loco().goal === null,
      W.reachTimeoutMs,
    )
    if (!reached) return
    const x0 = loco().state.x
    let fast = false
    for (let i = 0; i < W.rideSteps; i++) {
      win.x += W.rideStepPt
      this.windows = [{ ...win }]
      this.i().refreshWorld()
      await sleep(W.rideIntervalMs)
      if (this.i().snapshotHz === tuning.world.snapshotHz.attached) fast = true
    }
    const moved = W.rideSteps * W.rideStepPt
    const rode = await this.until(null, () => Math.abs(loco().state.x - (x0 + moved)) < 1)
    const s = loco().state
    this.check(
      'world: it rides the moving window',
      rode,
      `moved ${(s.x - x0).toFixed(1)} of ${moved} pt, on ${s.surface ?? 'nothing'} (${s.behavior})`,
    )
    this.check('world: …with the fast snapshot rate while the window moves', fast, `${tuning.world.snapshotHz.attached} Hz`)
    this.windows = []
    this.i().refreshWorld()
    await this.until(
      'world: the window closes and the pet falls back onto the ground',
      () => loco().state.surface === 'ground' && standing(loco().state.behavior),
    )
    await this.goTo(home)
  }

  private async interactionChecks(home: Point): Promise<void> {
    const ix = this.ix()
    const loco = (): BitbotInspection['locomotion'] => this.i().locomotion
    const press = this.pressPoint(home)
    this.cursorPoint = press
    await this.until(
      "cursor on the pet: the grab area takes the mouse (main's cursor sample, hit-tested by the overlay)",
      () => ix.mouseEnabled,
    )

    // A click: the pet stays exactly where it was.
    const before = { ...this.state() }
    this.down(press)
    await this.until('click: held', () => ix.held)
    this.up(press)
    await this.until('click: released', () => !ix.held)
    await sleep(3 * this.stepMs)
    const after = this.state()
    const stayed = after.x === before.x && after.y === before.y && standing(after.behavior)
    this.check('click without a drag: the pet did not move', stayed, `${fmtPoint(before)} → ${fmtPoint(after)}`)
    const petted = this.i().reaction
    this.check('…and it was petted (§10.4)', petted?.kind === 'petted', `reaction ${petted ? `${petted.kind} #${petted.seq}` : 'none'}`)

    // A drag up and left; the simulation follows; let go in the air, it falls and lands where it was dropped.
    await this.until(null, () => ix.mouseEnabled)
    this.down(press)
    await this.until('drag: held', () => ix.held)
    this.pressOffset = { x: press.x - home.x, y: press.y - home.y }
    const end = await this.dragMoves(press, T.drag)
    await sleep(3 * this.stepMs)
    const area = loco()?.area
    const expected = area ? clampToArea({ x: end.x - this.pressOffset.x, y: end.y - this.pressOffset.y }, area) : null
    const heldAt = this.state()
    this.check(
      'drag: the simulation follows the cursor',
      expected !== null && heldAt.behavior === 'held' && ix.label === 'drag' && distance(heldAt, expected) <= T.followTolerancePt,
      expected ? `${fmtPoint(heldAt)} vs ${fmtPoint(expected)} (label ${ix.label})` : 'no area',
    )
    const dropped = { x: heldAt.x, y: heldAt.y }
    const fallMs = fallTimeMs(home.y - dropped.y, tuning.move, this.stepMs)
    this.up(end)
    this.pressOffset = null
    await this.until('drag: released', () => !ix.held)
    const landed = await this.until(
      `released in the air: falls and lands on the ground (physics ${fallMs.toFixed(0)} ms + ${T.landMarginMs} ms)`,
      () => standing(this.state().behavior) && this.state().y === home.y,
      fallMs + T.landMarginMs,
    )
    const landedX = this.state().x
    if (landed) {
      this.check('…where it was dropped', Math.abs(landedX - dropped.x) < 0.01, `x ${landedX.toFixed(2)} vs ${dropped.x.toFixed(2)}`)
    }
    const spot = { x: this.state().x, y: this.state().y }
    await sleep(3 * this.stepMs)
    const atNew = await this.capture(this.overlay(), this.canvasRect(spot))
    const atOld = await this.capture(this.overlay(), this.canvasRect(home))
    this.check(
      "overlay capture: the pet's pixels at the new spot, none at the old",
      atNew !== null && atOld !== null && atNew.drawn >= T.minPetPixels && atOld.drawn === 0,
      `new spot ${atNew?.drawn ?? 'n/a'} drawn px, old spot ${atOld?.drawn ?? 'n/a'}`,
    )

    // A lost mouseup: the grab area sees a move without the left button (the mouseup went elsewhere).
    const press2 = this.pressPoint(spot)
    this.cursorPoint = press2
    await this.until(null, () => ix.mouseEnabled)
    this.down(press2)
    await this.until('lost mouseup: held', () => ix.held)
    const end2 = await this.dragMoves(press2, T.shortDrag)
    ix.handleNativeMouse({ type: 'mouseMove', button: null, leftButtonDown: false, screen: end2 })
    this.check('lost mouseup (a grab-area move without the left button): released', !ix.held)
    this.send('mouseUp', end2, { button: 'left', clickCount: 1 }) // ends the synthetic press in Chromium too
    await this.until(null, () => standing(this.state().behavior))

    // Right-click: the (injected) pet menu, then closed.
    const spot2 = this.groundPoint()
    const rc = this.pressPoint(spot2)
    this.cursorPoint = rc
    await this.until(null, () => ix.mouseEnabled)
    const popups = this.popupCalls
    this.send('mouseDown', rc, { button: 'right', clickCount: 1 })
    this.send('mouseUp', rc, { button: 'right', clickCount: 1 })
    await this.until('right-click: the pet menu pops up', () => this.popupCalls === popups + 1 && ix.label === 'menu')
    await sleep(T.holdMs) // a menu stays open a moment (the overlay ignores cursor samples right after grab-area events)
    this.closeMenu?.()
    this.closeMenu = null
    await this.until('…and closes', () => ix.label !== 'menu' && !ix.engaged)

    // Hidden during a drag: let go, grab area hidden, loop parked, no frames; then shown again.
    await this.until(null, () => ix.mouseEnabled)
    this.down(rc)
    await this.until('hide during a drag: held', () => ix.held)
    const end3 = await this.dragMoves(rc, T.shortDrag)
    this.i().setVisible(false)
    const hw = this.hitWindow()
    const loop = this.liveLoop()
    this.check('hidden during a drag: released', !ix.held)
    const parked = !hw.isVisible() && !this.overlay().isVisible() && !loop.running
    this.check('…grab area hidden, overlay hidden, simulation parked', parked)
    this.send('mouseUp', end3, { button: 'left', clickCount: 1 })
    const sA = await this.stats()
    const stepsA = loop.stepCount
    await sleep(T.hiddenHoldMs)
    const sB = await this.stats()
    const stepsHidden = loop.stepCount - stepsA
    this.check('…no simulation steps while hidden', stepsHidden === 0, `${stepsHidden} steps in ${T.hiddenHoldMs} ms`)
    const framesHidden = sA !== null && sB !== null ? sB.frames - sA.frames : null
    this.check('…no renderer frames while hidden', framesHidden === 0, framesHidden === null ? 'no stats' : `${framesHidden} frames`)
    this.i().setVisible(true)
    this.check('shown again: overlay visible, simulation running', this.overlay().isVisible() && loop.running)
    await this.until('…the pet is drawn again', () => this.i().petDrawn)
    await sleep(3 * this.stepMs)
    const drawnAgain = await this.stats()
    const rendersShown = sB !== null && drawnAgain !== null ? drawnAgain.renders - sB.renders : null
    const rendered = rendersShown !== null && rendersShown > 0
    this.check('…and rendered', rendered, rendersShown === null ? 'no stats' : `${rendersShown} renders`)
    this.cursorPoint = this.farPoint()
    await this.until(null, () => standing(this.state().behavior))
  }

  // ───────────────────────────── measurements ─────────────────────────────

  private async measurements(home: Point): Promise<void> {
    this.log('[check] measurement phases (CPU in % of one core)')
    const want = (name: PhaseName): boolean => this.opts.phases === null || this.opts.phases.includes(name)
    this.cursorPoint = this.farPoint()
    await this.goTo(home)
    // The two idle styles (docs/decisions/overlay.md, decided (c)), awake and asleep, set as the dev panel would.
    const style = (set: DevPanelSet): void => this.i().setDevOverrides(set)
    style({ state: null, idleMode: 'event' })
    if (want('idle')) await this.phase('idle', T.phaseS.idle)
    style({ idleMode: 'continuous' })
    if (want('idleContinuous')) await this.phase('idleContinuous', T.phaseS.idleContinuous)
    style({ state: 'sleep', idleMode: 'event' })
    if (want('sleepEvent')) await this.phase('sleepEvent', T.phaseS.sleepEvent)
    style({ idleMode: 'continuous' })
    if (want('sleepContinuous')) await this.phase('sleepContinuous', T.phaseS.sleepContinuous)
    style({ state: null, idleMode: 'still' })

    if (want('hidden')) {
      this.i().setVisible(false)
      await this.phase('hidden', T.phaseS.hidden)
      this.i().setVisible(true)
      await this.until(null, () => this.i().petDrawn)
    }

    if (want('nearStill')) {
      this.cursorPoint = this.nearCursor(home, 0, false)
      await this.until('near-still: grab area shown', () => this.hitWindow().isVisible())
      await this.phase('nearStill', T.phaseS.nearStill, { coverage: true })
    }

    if (want('walkParked')) await this.walkParked(home)

    if (want('walkCursor')) {
      const walk = this.walkAround(home, T.walkCursorSpanPt)
      this.mover = (t) => walkAt(walk, t)
      this.cursorFn = (t) => this.nearCursor(walkAt(walk, t - this.stepMs), t, true)
      await this.phase('walkCursor', T.phaseS.walkCursor, { coverage: true })
    }

    if (want('chase')) {
      const ready = this.readyMsg()
      const path = makeLissajousPath(canvasArea(screen.getPrimaryDisplay().workArea, ready.edge, ready.anchor), T.chase)
      const chase = new Chase(path, T.chase.speed, now())
      this.mover = (t) => chase.step(t, this.stepMs / 1000)
      this.cursorFn = (t) => this.nearCursor(this.drawnAt(t) ?? home, t, true)
      await this.phase('chase', T.phaseS.chase, { coverage: true })
    }
    this.mover = null
    this.cursorFn = null
    this.cursorPoint = this.farPoint()
    await this.goTo(home)

    if (want('drag120')) await this.dragPatrol('drag120', T.dragPatrol.speeds.slow, T.phaseS.drag120, home)
    if (want('drag600')) await this.dragPatrol('drag600', T.dragPatrol.speeds.fast, T.phaseS.drag600, home)
    this.cursorPoint = this.farPoint()
    await this.goTo(home)
    await this.measureFootprint()
  }

  /** Walk under a parked cursor: the cost, and how fast the grab area follows the silhouette past a still cursor. */
  private async walkParked(home: Point): Promise<void> {
    const box = this.box()
    const dyPt = box.top + T.parkedCursorAt * (box.bottom - box.top)
    const span = await this.calibrateSpan(home, dyPt)
    this.calibration = span ? { dyPt, span } : null
    this.check(
      'hit-test span at the parked cursor measured (pet still)',
      span !== null,
      span
        ? `${span.left.toFixed(1)} … ${span.right.toFixed(1)} pt from the ground point at ${dyPt.toFixed(1)} pt`
        : 'the cursor on the body did not take the mouse',
    )
    const parked = { x: home.x, y: home.y + dyPt }
    this.cursorPoint = parked
    await this.until(null, () => this.ix().mouseEnabled)
    const walk = this.walkAround(home, T.walkParkedSpanPt)
    this.toggles = []
    this.lastMouse = this.ix().mouseEnabled
    this.mover = (t) => walkAt(walk, t)
    const phase = await this.phase('walkParked', T.phaseS.walkParked, { coverage: true })
    const toggles = (this.toggles ?? []).filter((t) => t.tMs >= phase.startMs - T.latencyEarlyMs && t.tMs <= phase.endMs)
    this.toggles = null
    this.mover = null
    if (!span) return
    // Main draws (and the overlay renders) one step behind: the silhouette is where the walk was a step ago.
    const drawnX = (t: number): number => walkAt(walk, t - this.stepMs).x
    const crossings = spanCrossings(drawnX, parked.x, span, phase.startMs, phase.endMs - T.latencyWindowMs, 1)
    const pairs = pairLatencies(crossings, toggles, T.latencyEarlyMs, T.latencyWindowMs)
    const enter = roundSummary(summarize(pairs.enterMs))
    const leave = roundSummary(summarize(pairs.leaveMs))
    this.latency = { ...pairs, crossings: crossings.length, enter, leave }
    this.log(
      `[check] hover latency over ${crossings.length} crossings: (a) silhouette reached the cursor → mouse on ` +
        `${this.describeLatency(enter, pairs.missedEnter)}; (b) silhouette left the cursor → click-through ` +
        `${this.describeLatency(leave, pairs.missedLeave)}; ${pairs.unpaired} unpaired toggles`,
    )
  }

  /**
   * The hit test's horizontal span at height dyPt (pt from the pet's ground point), by binary search on main's cursor
   * samples with the pet still.
   */
  private async calibrateSpan(home: Point, dyPt: number): Promise<{ left: number; right: number } | null> {
    const y = home.y + dyPt
    const probe = async (dx: number): Promise<boolean> => {
      this.cursorPoint = { x: home.x + dx, y }
      await sleep(T.calibration.probeMs)
      return this.ix().mouseEnabled
    }
    if (!(await probe(0))) return null
    const edge = async (outside: number): Promise<number | null> => {
      if (await probe(outside)) return null
      let inside = 0
      let out = outside
      for (let k = 0; k < T.calibration.steps; k++) {
        const mid = (inside + out) / 2
        if (await probe(mid)) inside = mid
        else out = mid
      }
      return (inside + out) / 2
    }
    // Start just outside the box but inside the safety net's margin (the net would switch the mouse off by itself).
    const reach = tuning.hitArea.safetyMarginPt / 2
    const box = this.box()
    const right = await edge(box.right + reach)
    const left = await edge(box.left - reach)
    return right === null || left === null ? null : { left, right }
  }

  /** A drag patrol phase: press at home, lift, patrol at speedPtS with synthetic moves; measure; let go; land. */
  private async dragPatrol(name: PhaseName, speedPtS: number, seconds: number, home: Point): Promise<void> {
    const ix = this.ix()
    const press = this.pressPoint(home)
    this.cursorPoint = press
    await this.until(null, () => ix.mouseEnabled)
    this.down(press)
    if (!(await this.until(`${PHASE_TITLES[name]}: held`, () => ix.held))) return
    this.pressOffset = { x: press.x - home.x, y: press.y - home.y }
    const patrol: DragPatrol = { start: press, liftPt: T.dragPatrol.liftPt, amplitudePt: T.dragPatrol.spanPt, speedPtS }
    let last = press
    let sent = 0
    let counting = false
    const stop = this.pump(T.dragPatrol.eventIntervalMs, (elapsedMs) => {
      last = dragPatrolAt(patrol, elapsedMs)
      this.moveHeld(last)
      if (counting) sent++
    })
    await sleep(dragLiftMs(patrol))
    counting = true
    const phase = await this.phase(name, seconds, { coverage: true, settled: () => (sent = 0) })
    phase.eventsSent = sent
    stop()
    this.up(last)
    this.pressOffset = null
    await this.until(`${PHASE_TITLES[name]}: released`, () => !ix.held)
    await this.until(null, () => standing(this.state().behavior))
    this.cursorPoint = this.farPoint()
    await this.goTo(home)
  }

  /**
   * One measured phase: the motion set up by the caller settles (phaseSettleMs), then CPU (Electron processes every
   * metricsIntervalMs, the helper at both ends), renderer counters, grab-area counters and simulation wakes are taken
   * over `seconds`.
   */
  private async phase(
    name: PhaseName,
    seconds: number,
    opts: { coverage?: boolean; settled?: () => void } = {},
  ): Promise<PhaseResult> {
    await sleep(T.phaseSettleMs)
    opts.settled?.()
    const helperPid = this.i().helper?.pid ?? null
    const statsA = await this.stats()
    const helperA = helperPid !== null ? await psCpuSeconds(helperPid, T.toolTimeoutMs) : null
    const helperAt = now()
    const countersA = this.i().hitWindowCounters
    const loop = this.liveLoop()
    const wakesA = loop.wakeCount
    const stepsA = loop.stepCount
    this.hookMs = 0
    this.coverage = opts.coverage ? { shownWakes: 0, outsideWakes: 0, maxOvershootPt: 0, realMouseWakes: 0 } : null
    const samples: CpuSample[] = [this.sampleCpu()]
    const timer = setInterval(() => samples.push(this.sampleCpu()), T.metricsIntervalMs)
    await sleep(seconds * 1000)
    clearInterval(timer)
    samples.push(this.sampleCpu())
    const coverage = this.coverage
    this.coverage = null
    const hookMs = this.hookMs
    const countersB = this.i().hitWindowCounters
    const wakesB = loop.wakeCount
    const stepsB = loop.stepCount
    const helperB = helperPid !== null ? await psCpuSeconds(helperPid, T.toolTimeoutMs) : null
    const helperBt = now()
    const statsB = await this.stats()

    const first = samples[0]
    const last = samples[samples.length - 1]
    const startMs = first?.tMs ?? 0
    const endMs = last?.tMs ?? 0
    const s = Math.max(1e-6, (endMs - startMs) / 1000)
    const cpu = cpuWindow(samples)
    const helper = cpuPercent(helperA, helperB, (helperBt - helperAt) / 1000)
    const type = (t: string): number => cpu.byType[t] ?? 0
    const perS = (n: number): number => round(n / s, 2)
    const grab: GrabCounts = {
      moves: countersB.moves - countersA.moves,
      shows: countersB.shows - countersA.shows,
      hides: countersB.hides - countersA.hides,
      mouseToggles: countersB.mouseToggles - countersA.mouseToggles,
    }
    const grabPerS: GrabCounts = {
      moves: perS(grab.moves),
      shows: perS(grab.shows),
      hides: perS(grab.hides),
      mouseToggles: perS(grab.mouseToggles),
    }
    const result: PhaseResult = {
      name,
      title: PHASE_TITLES[name],
      startMs,
      endMs,
      measuredS: round(s, 3),
      cpu: {
        byType: Object.fromEntries(Object.entries(cpu.byType).map(([k, v]) => [k, round(v, 2)])),
        main: round(type('Browser'), 2),
        renderer: round(type('Tab'), 2),
        gpu: round(type('GPU'), 2),
        utility: round(type('Utility'), 2),
        electron: round(cpu.total, 2),
        helper: helper === null ? null : round(helper, 2),
        total: helper === null ? null : round(cpu.total + helper, 2),
        fallbacks: cpu.fallbacks,
      },
      wakeupsPerS: Object.fromEntries(Object.entries(cpu.wakeupsByType).map(([k, v]) => [k, round(v, 1)])),
      simWakesPerS: perS(wakesB - wakesA),
      simStepsPerS: perS(stepsB - stepsA),
      renderer: rendererDelta(statsA, statsB, s),
      grab: { ...grab, perS: grabPerS },
      coverage: coverage
        ? {
            ...coverage,
            maxOvershootPt: round(coverage.maxOvershootPt, 2),
            outsidePct: coverage.shownWakes > 0 ? round((100 * coverage.outsideWakes) / coverage.shownWakes, 2) : null,
          }
        : null,
      checkHooksMsPerS: round(hookMs / s, 3),
      eventsSent: null,
    }
    this.phases[name] = result
    this.log(`[check] ${this.phaseLine(result)}`)
    return result
  }

  private async measureFootprint(): Promise<void> {
    const procs = app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type as string }))
    const helperPid = this.i().helper?.pid
    const pids = procs.map((p) => p.pid)
    if (helperPid !== undefined) pids.push(helperPid)
    const run = await runFootprint(pids, T.toolTimeoutMs)
    const output = run.output
    this.footprint = {
      electron: output ? aggregateFootprint(procs, output) : null,
      helper: output && helperPid !== undefined ? aggregateFootprint([{ pid: helperPid, type: 'helper' }], output) : null,
      error: run.error,
    }
    const fp = this.footprint.electron
    this.log(
      `[check] footprint (phys_footprint): Electron ${fmt(fp?.totalMB)} MB (` +
        Object.entries(fp?.byType ?? {})
          .map(([t, v]) => `${t} ${fmt(v.mb)}`)
          .join(', ') +
        `), helper ${fmt(this.footprint.helper?.totalMB)} MB${run.error ? `; ${run.error}` : ''}`,
    )
  }

  // ───────────────────────────── reload and the end ─────────────────────────────

  private async reloadCheck(): Promise<void> {
    this.cursorPoint = this.farPoint()
    await sleep(3 * this.stepMs)
    const loads = this.i().loads
    this.overlay().webContents.reload()
    await this.i().waitForReady(T.readyTimeoutMs, loads + 1)
    await this.until('reload: a new pet:ready, drawn again', () => this.i().petDrawn)
    await sleep(T.holdMs)
    const overlay = this.overlay()
    const others = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== overlay)
    const one = others.length === 1 && others[0] === this.i().hitWindow
    this.check('reload: exactly one grab area afterwards', one, `${others.length} other window(s)`)
    const ix = this.ix()
    const press = this.pressPoint(this.groundPoint())
    this.cursorPoint = press
    await this.until('reload: the grab area takes the mouse again', () => ix.mouseEnabled)
    this.down(press)
    await this.until('reload: still grabbable (held)', () => ix.held)
    this.up(press)
    await this.until('reload: released', () => !ix.held)
    this.cursorPoint = this.farPoint()
  }

  private async finalChecks(): Promise<void> {
    await sleep(T.verdictWaitMs)
    const a = this.i().activation
    const events = Object.values(a.events).reduce((x, y) => x + y, 0)
    this.check(
      'no activation the whole run (no did-become-active, browser-window-focus, resign or blur)',
      a.activations === 0 && events === 0 && a.fails === 0,
      `${a.verdicts} verdicts (${a.passes} PASS, ${a.fails} FAIL), events ${JSON.stringify(a.events)}`,
    )
    this.check('no network requests (security.ts blocked none)', blockedRequestCount() === 0, `${blockedRequestCount()} blocked`)
    this.check('no errors logged', this.errorLines.length === 0, this.errorLines.slice(0, 5).join(' | '))
  }

  // ───────────────────────────── hooks into Bitbot ─────────────────────────────

  private cursorNow(): Point {
    const fn = this.cursorFn
    if (!fn) return this.cursorPoint
    const t = now()
    const p = fn(t)
    this.hookMs += now() - t
    return p
  }

  /** BitbotAppOptions.devMover: once per simulation step, before the step runs. */
  private onStep(tMs: number): Point | null {
    const t = now()
    const s = this.loco?.state
    if (s) {
      // The state the previous step produced.
      this.steps.push({ t: tMs - this.stepMs, x: s.x, y: s.y })
      if (this.steps.length > tuning.overlay.stateBufferSize) this.steps.shift()
    }
    const loop = this.loop
    if (loop && loop.wakeCount !== this.lastWake) {
      // The first step of this wake: the grab area is still where the previous wake placed it.
      this.lastWake = loop.wakeCount
      this.noteMouse()
      if (this.coverage) this.probeCoverage(this.coverage)
    }
    const p = this.mover ? this.mover(tMs) : null
    this.hookMs += now() - t
    return p
  }

  /**
   * Is the pet's box, where the overlay draws it, inside the grab area while that is shown? Independent of main's own
   * estimate: a held pet is drawn under the cursor (the overlay follows the grab area's events), anything else one step
   * behind the simulation's states. Plain reads, so the probe adds next to nothing to main's CPU.
   */
  private probeCoverage(cov: Coverage): void {
    const ix = this.interaction
    const ready = this.ready
    const placement = ix?.placement
    if (!ix || !ready || !placement?.shown) return
    const offset = this.pressOffset
    const area = this.loco?.area
    const c = this.cursorPoint
    const drawn = ix.held && offset && area ? clampToArea({ x: c.x - offset.x, y: c.y - offset.y }, area) : this.drawnAt(now())
    if (!drawn) return
    const out = overshoot(placement.bounds, boxAt(drawn, ready.petBox))
    const real = screen.getCursorScreenPoint()
    const b = placement.bounds
    if (real.x >= b.x && real.x < b.x + b.width && real.y >= b.y && real.y < b.y + b.height) cov.realMouseWakes++
    cov.shownWakes++
    if (out > 0) {
      cov.outsideWakes++
      cov.maxOvershootPt = Math.max(cov.maxOvershootPt, out)
    }
  }

  /** Where the overlay draws a pet that isn't held at nowMs: one step behind its states, interpolated (as main estimates it). */
  private drawnAt(nowMs: number): Point | null {
    const p = sampleBuffer(this.steps, nowMs - this.stepMs)
    return p ? { x: p.x, y: p.y } : null
  }

  /** Records a change of the grab area's mouse state (from the hover IPC and once per wake). */
  private noteMouse(): void {
    const toggles = this.toggles
    const ix = this.interaction
    if (!toggles || !ix) return
    const on = ix.mouseEnabled
    if (on === this.lastMouse) return
    this.lastMouse = on
    toggles.push({ tMs: now(), on })
  }

  private appLog(line: string): void {
    if (ERROR_LINES.some((re) => re.test(line))) this.errorLines.push(line)
    this.log(line)
  }

  /** Renderer console errors count as errors too. */
  private watchConsole(): void {
    for (const win of [this.overlay(), this.hitWindow()]) {
      win.webContents.on('console-message', (details) => {
        if (details.level === 'error') this.appLog(`[check] renderer console ERROR: ${details.message}`)
      })
    }
  }

  // ───────────────────────────── synthetic input ─────────────────────────────

  /** A synthetic mouse event for the grab area only (x/y relative to it, globalX/globalY for screenX/screenY). */
  /**
   * A synthetic mouse event for the grab area only (x/y relative to it, globalX/globalY for screenX/screenY), on whole
   * points: Chromium truncates a mouse event's screenX/screenY, and the real cursor (getCursorScreenPoint) is whole too.
   */
  private send(type: 'mouseDown' | 'mouseUp' | 'mouseMove', p: Point, extra: Partial<MouseInputEvent> = {}): void {
    const hw = this.i().hitWindow
    if (!hw || hw.isDestroyed()) return
    const q = whole(p)
    const b = hw.getBounds()
    hw.webContents.sendInputEvent({ type, x: q.x - b.x, y: q.y - b.y, globalX: q.x, globalY: q.y, ...extra })
  }

  private down(p: Point): void {
    this.cursorPoint = whole(p)
    this.send('mouseDown', p, { button: 'left', clickCount: 1 })
  }

  private up(p: Point): void {
    this.send('mouseUp', p, { button: 'left', clickCount: 1 })
  }

  /** A drag move: the cursor first (main samples it), then the event with the left button held (the overlay reads `buttons`). */
  private moveHeld(p: Point): void {
    this.cursorPoint = whole(p)
    this.send('mouseMove', p, { modifiers: ['leftbuttondown'] })
  }

  private async dragMoves(from: Point, drag: { moves: number; stepPt: Point; intervalMs: number }): Promise<Point> {
    let p = from
    for (let k = 1; k <= drag.moves; k++) {
      p = { x: from.x + k * drag.stepPt.x, y: from.y + k * drag.stepPt.y }
      this.moveHeld(p)
      await sleep(drag.intervalMs)
    }
    return p
  }

  /** Calls tick(elapsed) every intervalMs on drift-free deadlines (a late tick skips the missed ones); returns stop(). */
  private pump(intervalMs: number, tick: (elapsedMs: number) => void): () => void {
    const start = now()
    let n = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const run = (): void => {
      if (stopped) return
      const t = now()
      tick(t - start)
      n = Math.max(n + 1, Math.ceil((t - start) / intervalMs))
      timer = setTimeout(run, Math.max(0, start + n * intervalMs - now()))
    }
    run()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  // ───────────────────────────── places ─────────────────────────────

  private farPoint(): Point {
    const wa = screen.getPrimaryDisplay().workArea
    return { x: wa.x + T.farInsetPt, y: wa.y + T.farInsetPt }
  }

  private pressPoint(ground: Point): Point {
    const b = this.box()
    const at = T.pressAt
    return whole({ x: ground.x + b.left + at.x * (b.right - b.left), y: ground.y + b.top + at.y * (b.bottom - b.top) })
  }

  private cornerPoint(ground: Point): Point {
    const b = this.box()
    return whole({ x: ground.x + b.left + T.boxCornerInsetPt, y: ground.y + b.top + T.boxCornerInsetPt })
  }

  /** A walk on the ground back and forth ±amplitudePt around `home` at tuning.move.walkSpeed, from now. */
  private walkAround(home: Point, amplitudePt: number): Walk {
    return { centerX: home.x, groundY: home.y, amplitudePt, speedPtS: tuning.move.walkSpeed, startMs: now() }
  }

  /** Beside the pet (right of its box), circling when `wobble`. */
  private nearCursor(ground: Point, nowMs: number, wobble: boolean): Point {
    const b = this.box()
    const n = T.nearCursor
    const a = (2 * Math.PI * n.wobbleHz * nowMs) / 1000
    const r = wobble ? n.wobblePt : 0
    return { x: ground.x + b.right + n.gapPt + r * Math.cos(a), y: ground.y + b.top + n.at * (b.bottom - b.top) + r * Math.sin(a) }
  }

  /** The pet's canvas around ground point `g`, in the overlay's coordinates (for capturePage). */
  private canvasRect(g: Point): Rect {
    const ready = this.readyMsg()
    const cb = this.overlay().getContentBounds()
    const { anchor, edge } = ready
    return { x: Math.round(g.x - anchor.x - cb.x), y: Math.round(g.y - anchor.y - cb.y), width: edge, height: edge }
  }

  /** Teleports the pet to `p` (it isn't held) and waits until it stands there. */
  private async goTo(p: Point): Promise<void> {
    let pending = true
    this.mover = () => {
      if (!pending) return null
      pending = false
      return p
    }
    await this.until(null, () => !pending && this.state().x === p.x && this.state().y === p.y && standing(this.state().behavior))
    this.mover = null
  }

  // ───────────────────────────── reading Bitbot ─────────────────────────────

  private i(): BitbotInspection {
    if (!this.bitbot) throw new Error('Bitbot is not running')
    return this.bitbot.inspect()
  }

  private ix(): PetInteraction {
    if (!this.interaction) throw new Error('Bitbot is not running')
    return this.interaction
  }

  private liveLoop(): SimLoop {
    if (!this.loop) throw new Error('Bitbot is not running')
    return this.loop
  }

  private overlay(): BrowserWindow {
    const win = this.i().overlay
    if (!win) throw new Error('there is no overlay window')
    return win
  }

  private hitWindow(): BrowserWindow {
    const win = this.i().hitWindow
    if (!win) throw new Error('there is no grab-area window')
    return win
  }

  private readyMsg(): PetReadyMsg {
    if (!this.ready) throw new Error('no pet:ready yet')
    return this.ready
  }

  private box(): Box {
    return this.readyMsg().petBox
  }

  private state(): { x: number; y: number; behavior: string } {
    const s = this.i().locomotion?.state
    if (!s) throw new Error('the pet has no place yet')
    return { x: s.x, y: s.y, behavior: s.behavior }
  }

  private groundPoint(): Point {
    const s = this.state()
    return { x: s.x, y: s.y }
  }

  private stats(): Promise<OverlayStatsMsg | null> {
    return this.i().requestOverlayStats(T.statsTimeoutMs)
  }

  private sampleCpu(): CpuSample {
    return cpuSample(now(), app.getAppMetrics(), this.cores)
  }

  /** Polls the helper's on-screen list until fn(z) holds (or the deadline); returns the last answer and how long it took. */
  private async untilZ(fn: (z: ZOrder) => boolean, timeoutMs: number = T.deadlineMs): Promise<{ z: ZOrder | null; ms: number }> {
    const start = now()
    for (;;) {
      const z = await this.zOrderNow()
      if ((z && fn(z)) || now() - start > timeoutMs) return { z, ms: now() - start }
      await sleep(T.pollMs)
    }
  }

  private async zOrderNow(): Promise<ZOrder | null> {
    const helper = this.i().helper
    if (!helper) return null
    try {
      const snap = await helper.snapshot()
      const hw = this.i().hitWindow
      const grabWid = hw && !hw.isDestroyed() ? windowNumber(hw.getMediaSourceId()) : null
      return zOrder(snap.windows, this.i().overlayWid, grabWid)
    } catch {
      return null
    }
  }

  private describeZ(z: ZOrder | null): string {
    if (!z) return 'no snapshot'
    const place = (p: ZOrder['overlay']): string =>
      p ? `#${p.index} layer ${p.layer}${p.onScreen ? '' : ' off screen'}` : 'not listed'
    return `overlay ${place(z.overlay)}, grab area ${place(z.grab)}${z.between !== null ? `, ${z.between} window(s) between` : ''}`
  }

  private async capture(win: BrowserWindow, rect?: Rect): Promise<{ width: number; height: number; drawn: number } | null> {
    try {
      const image = await win.webContents.capturePage(rect)
      const scale = image.getScaleFactors()[0] ?? 1
      const { width, height } = image.getSize(scale)
      const bitmap = image.toBitmap({ scaleFactor: scale })
      if (width * height === 0) return { width, height, drawn: 0 }
      if (bitmap.length !== width * height * 4) return null
      return { width, height, drawn: countDrawnPixels(bitmap, T.drawnAlpha) }
    } catch {
      return null
    }
  }

  // ───────────────────────────── checks and output ─────────────────────────────

  private check(name: string, pass: boolean, detail = ''): boolean {
    this.functional.push({ name, pass, detail })
    this.log(`[check] ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
    return pass
  }

  /** Waits until fn() holds (polling every pollMs); with a name, records a check with the time it took. */
  private async until(name: string | null, fn: () => boolean, timeoutMs: number = T.deadlineMs): Promise<boolean> {
    const start = now()
    for (;;) {
      let ok = false
      try {
        ok = fn()
      } catch {
        ok = false
      }
      if (ok) {
        if (name) this.check(name, true, `${(now() - start).toFixed(0)} ms`)
        return true
      }
      if (now() - start > timeoutMs) {
        if (name) this.check(name, false, `not within ${timeoutMs} ms`)
        else this.log(`[check] (a wait timed out after ${timeoutMs} ms)`)
        return false
      }
      await sleep(T.pollMs)
    }
  }

  /** True if fn() holds for `ms` (sampled every pollMs). */
  private async holds(fn: () => boolean, ms: number = T.holdMs): Promise<boolean> {
    const end = now() + ms
    while (now() < end) {
      if (!fn()) return false
      await sleep(T.pollMs)
    }
    return fn()
  }

  private log(line: string): void {
    console.log(`${((now() - this.t0) / 1000).toFixed(2)} ${line}`)
  }

  private printConditions(when: 'start' | 'end'): void {
    const d = screen.getPrimaryDisplay()
    const b = d.bounds
    const w = d.workArea
    if (when === 'start') {
      const right = b.x + b.width - (w.x + w.width)
      const bottom = b.y + b.height - (w.y + w.height)
      this.log(
        `[check] display ${d.id}: bounds ${fmtRect(b)}, work area ${fmtRect(w)} (insets top ${w.y - b.y}, left ${w.x - b.x}, ` +
          `right ${right}, bottom ${bottom}), ${d.scaleFactor}x, ${round(d.displayFrequency, 2)} Hz, ` +
          `${screen.getAllDisplays().length} display(s)`,
      )
    }
    const p = this.power
    const charge = p?.batteryPct !== null && p?.batteryPct !== undefined ? ` (${p.batteryPct}%)` : ''
    const lpm = !p || p.lowPowerMode === null ? 'unknown' : p.lowPowerMode ? 'ON' : 'off'
    const load = loadavg()
      .map((v) => v.toFixed(2))
      .join(' ')
    this.log(
      `[check] conditions (${when}): ${powerMonitor.isOnBatteryPower() ? 'battery' : 'AC power'}${charge}, Low Power Mode ${lpm}, ` +
        `thermal ${powerMonitor.getCurrentThermalState()}, load average ${load} (${this.cores} cores)`,
    )
  }

  private phaseLine(r: PhaseResult): string {
    const c = r.cpu
    const rd = r.renderer
    const cov = r.coverage
    const g = r.grab.perS
    const input = rd?.inputToFrameMs
    const parts = [
      `${r.title} (${r.measuredS.toFixed(1)} s): CPU main ${fmt(c.main, 2)} renderer ${fmt(c.renderer, 2)} GPU ${fmt(c.gpu, 2)} ` +
        `helper ${fmt(c.helper, 2)} total ${fmt(c.total, 2)}`,
      `frames ${rd?.frames ?? 'n/a'} renders ${rd?.renders ?? 'n/a'} long ${rd?.longFrames ?? 'n/a'} ` +
        `starved ${rd?.starvedFrames ?? 'n/a'} rAF p50/p99 ${fmt(rd?.rafMs?.p50, 2)}/${fmt(rd?.rafMs?.p99, 2)} ms`,
      `grab moves ${g.moves}/s shows ${g.shows}/s hides ${g.hides}/s toggles ${g.mouseToggles}/s`,
      `sim wakes ${r.simWakesPerS}/s, main idle wakeups ${fmt(r.wakeupsPerS['Browser'], 0)}/s`,
    ]
    if (input) parts.push(`input→frame p50 ${fmt(input.p50, 2)} p95 ${fmt(input.p95, 2)} ms (n ${input.n})`)
    if (cov) {
      const worst = `max ${fmt(cov.maxOvershootPt, 1)} pt`
      parts.push(`box outside the grab area ${fmt(cov.outsidePct, 2)}% of ${cov.shownWakes} wakes (${worst})`)
      if (cov.realMouseWakes > 0) parts.push(`YOUR MOUSE was over the grab area in ${cov.realMouseWakes} wakes`)
    }
    parts.push(`check hooks ${fmt(r.checkHooksMsPerS, 3)} ms/s`)
    return parts.join(' | ')
  }

  private describeLatency(s: Summary | null, missed: number): string {
    if (!s) return `n/a (${missed} missed)`
    return `p50 ${fmt(s.p50, 0)} p95 ${fmt(s.p95, 0)} max ${fmt(s.max, 0)} ms (n ${s.n}${missed ? `, ${missed} missed` : ''})`
  }

  // ───────────────────────────── verdict and results ─────────────────────────────

  /** The thresholds, for the phases that ran (all of them unless --phases chose some). */
  private judgeAll(): Verdict[] {
    const th = T.thresholds
    const v: Verdict[] = []
    const p = this.phases
    if (!this.opts.measure) return v
    const ran = (name: PhaseName): boolean => this.opts.phases === null || this.opts.phases.includes(name)
    if (ran('hidden')) v.push(judge(`renderer frames while ${PHASE_TITLES.hidden}`, p.hidden?.renderer?.frames ?? null, th.hiddenFrames, 'frames'))
    const frameMs = 1000 / (screen.getPrimaryDisplay().displayFrequency || 60)
    for (const name of ['drag120', 'drag600'] as const) {
      if (!ran(name)) continue
      const lat = p[name]?.renderer?.inputToFrameMs ?? null
      const detail = `one frame ${frameMs.toFixed(1)} ms + ${th.dragFrameSlackMs}`
      v.push(judge(`drag input→frame p95, ${PHASE_TITLES[name]}`, lat?.p95 ?? null, frameMs + th.dragFrameSlackMs, 'ms', { detail }))
    }
    for (const name of ['nearStill', 'walkParked', 'walkCursor', 'chase', 'drag120', 'drag600'] as const) {
      if (!ran(name)) continue
      const cov = p[name]?.coverage ?? null
      const detail = cov ? `${cov.outsideWakes} of ${cov.shownWakes} wakes, worst ${fmt(cov.maxOvershootPt, 1)} pt` : 'not measured'
      v.push(judge(`box outside the grab area, ${PHASE_TITLES[name]}`, cov?.outsidePct ?? null, th.boxOutsidePct, '%', { detail }))
    }
    if (ran('walkParked')) {
      const lat = this.latency
      const window = T.latencyWindowMs
      const p95 = (values: number[], missed: number): number | null => percentileWithMisses(values, missed, window, 95)
      const detail = (n: number, missed: number): string => `n ${n}, ${missed} missed (counted as ${window} ms)`
      const leave = lat ? p95(lat.leaveMs, lat.missedLeave) : null
      const enter = lat ? p95(lat.enterMs, lat.missedEnter) : null
      v.push(
        judge('hover latency (b) silhouette left the still cursor → click-through, p95', leave, th.leaveP95Ms, 'ms', {
          detail: lat ? detail(lat.leaveMs.length, lat.missedLeave) : 'not measured',
        }),
      )
      v.push(
        judge('hover latency (a) silhouette reached the still cursor → mouse on, p95', enter, th.enterP95Ms, 'ms', {
          detail: lat ? detail(lat.enterMs.length, lat.missedEnter) : 'not measured',
        }),
      )
    }
    const fp = this.footprint
    const memory = fp?.electron?.totalMB ?? null
    v.push(judge('footprint of the Electron processes', memory, th.footprintMB, 'MB', { detail: fp?.error ?? '' }))
    const a2 = this.findA2()
    const versus = (phase: PhaseName, run: A2Run | null, what: string): Verdict => {
      const detail = run
        ? `A2 ${what}: ${run.file.split('/').pop()}, ${run.onBattery ? 'battery' : 'AC'}, A2 total ${fmt(run.total, 2)} %`
        : `no A2 ${what} run of this session in ${a2.looked}`
      const name = `main CPU, ${PHASE_TITLES[phase]}, below A2 ${what} (same session)`
      return judge(name, p[phase]?.cpu.main ?? null, run?.byType['Browser'] ?? Number.NaN, '%', { rule: 'below', gate: false, detail })
    }
    if (ran('walkCursor')) v.push(versus('walkCursor', a2.walk, 'walk'))
    if (ran('chase')) v.push(versus('chase', a2.synthetic, 'synthetic'))
    return v
  }

  /** The A2 runs to compare with: the files given, or the newest of this session in the results directory. */
  private findA2(): { walk: A2Run | null; synthetic: A2Run | null; looked: string } {
    const read = (file: string): A2Run | null => {
      try {
        return readA2Run(JSON.parse(readFileSync(file, 'utf8')), file)
      } catch {
        return null
      }
    }
    const dir = this.opts.resultsDir
    let runs: A2Run[] = []
    try {
      runs = readdirSync(dir)
        .filter((f) => /^overlay-A2-(walk|synthetic)-.*\.json$/.test(f))
        .map((f) => read(join(dir, f)))
        .filter((r): r is A2Run => r !== null)
    } catch {
      runs = []
    }
    const maxAge = T.a2MaxAgeMin * 60_000
    const at = this.startedAt.getTime()
    const a2 = {
      walk: this.opts.a2Walk ? read(this.opts.a2Walk) : newestA2(runs, 'walk', at, maxAge),
      synthetic: this.opts.a2Synthetic ? read(this.opts.a2Synthetic) : newestA2(runs, 'synthetic', at, maxAge),
      looked: this.opts.a2Walk || this.opts.a2Synthetic ? 'the files given' : dir,
    }
    this.a2 = a2
    return a2
  }

  /** Verdict, tables, results JSON; returns the exit code. */
  private finish(): number {
    this.verdicts = this.judgeAll()
    const failed = this.functional.filter((r) => !r.pass)
    const gateFails = this.verdicts.filter((v) => v.gate && !v.pass)
    const code = failed.length === 0 && gateFails.length === 0 ? 0 : 1
    this.printConditions('end')
    if (Object.keys(this.phases).length > 0) this.printTables()
    if (this.verdicts.length > 0) {
      console.log('\n== Verdict')
      for (const v of this.verdicts) console.log(verdictLine(v))
    }
    const file = this.writeResults(code)
    const passed = this.functional.length - failed.length
    const lines = [`\n[check] ${code === 0 ? 'ALL PASS' : 'FAILED'}: ${passed}/${this.functional.length} functional checks passed`]
    if (this.verdicts.length > 0) lines[0] += `, ${gateFails.length} gating threshold(s) failed`
    for (const r of failed) lines.push(`FAIL ${r.name}${r.detail ? ` (${r.detail})` : ''}`)
    const disturbed = Object.values(this.phases).filter((r) => (r?.coverage?.realMouseWakes ?? 0) > 0)
    if (disturbed.length > 0) {
      lines.push(
        `[check] WARNING your mouse was over the pet's grab area during: ${disturbed.map((r) => r?.title).join('; ')}. ` +
          'Its real moves end the check\'s drags and flip hover, so those numbers are not the app\'s: move the mouse away and rerun.',
      )
    }
    if (file) lines.push(`[check] results: ${file}`)
    console.log(lines.join('\n'))
    return code
  }

  private printTables(): void {
    const names = Object.keys(PHASE_TITLES) as PhaseName[]
    const rows = names.map((n) => this.phases[n]).filter((r): r is PhaseResult => r !== undefined)
    const cells = (values: readonly (readonly [string, number])[]): string => values.map(([v, w]) => v.padStart(w)).join('')
    const title = (t: string): string => t.padEnd(38)
    console.log('\n== CPU (% of one core; Electron processes from cumulative CPU time, helper from ps)')
    const cpuHead: [string, number][] = [
      ['s', 6],
      ['main', 7],
      ['rend', 7],
      ['GPU', 7],
      ['util', 7],
      ['helper', 8],
      ['Electron', 10],
      ['total', 8],
    ]
    console.log(title('phase') + cells(cpuHead))
    for (const r of rows) {
      const c = r.cpu
      const values: [string, number][] = [
        [r.measuredS.toFixed(1), 6],
        [fmt(c.main, 2), 7],
        [fmt(c.renderer, 2), 7],
        [fmt(c.gpu, 2), 7],
        [fmt(c.utility, 2), 7],
        [fmt(c.helper, 2), 8],
        [fmt(c.electron, 2), 10],
        [fmt(c.total, 2), 8],
      ]
      console.log(title(r.title) + cells(values))
    }
    console.log('\n== Renderer, grab area, main wakes (per second unless noted)')
    const head: [string, number][] = [
      ['frames', 8],
      ['renders', 8],
      ['long', 6],
      ['starv', 6],
      ['rAF p50/p99', 13],
      ['moves', 7],
      ['shows', 7],
      ['hides', 7],
      ['toggl', 7],
      ['wakes', 7],
      ['idleWk', 8],
      ['outside%', 10],
    ]
    console.log(title('phase') + cells(head))
    for (const r of rows) {
      const rd = r.renderer
      const g = r.grab.perS
      const values: [string, number][] = [
        [fmt(rd?.framesPerS, 1), 8],
        [fmt(rd?.rendersPerS, 1), 8],
        [String(rd?.longFrames ?? 'n/a'), 6],
        [String(rd?.starvedFrames ?? 'n/a'), 6],
        [`${fmt(rd?.rafMs?.p50, 1)}/${fmt(rd?.rafMs?.p99, 1)}`, 13],
        [fmt(g.moves, 1), 7],
        [fmt(g.shows, 1), 7],
        [fmt(g.hides, 1), 7],
        [fmt(g.mouseToggles, 1), 7],
        [fmt(r.simWakesPerS, 1), 7],
        [fmt(r.wakeupsPerS['Browser'], 0), 8],
        [fmt(r.coverage?.outsidePct, 2), 10],
      ]
      console.log(title(r.title) + cells(values))
    }
    const lat = this.latency
    if (lat) {
      console.log(
        `\nhover latency (walk under a parked cursor, ${lat.crossings} crossings): ` +
          `(a) mouse on ${this.describeLatency(lat.enter, lat.missedEnter)}; ` +
          `(b) click-through ${this.describeLatency(lat.leave, lat.missedLeave)}`,
      )
    }
    for (const name of ['drag120', 'drag600'] as const) {
      const r = this.phases[name]
      const s = r?.renderer?.inputToFrameMs
      if (!r) continue
      console.log(
        `drag input→frame, ${r.title}: p50 ${fmt(s?.p50, 2)} p95 ${fmt(s?.p95, 2)} max ${fmt(s?.max, 2)} ms ` +
          `(n ${s?.n ?? 0}, ${r.eventsSent ?? 0} moves sent)`,
      )
    }
    const fp = this.footprint
    if (fp) console.log(`footprint: Electron ${fmt(fp.electron?.totalMB)} MB, helper ${fmt(fp.helper?.totalMB)} MB`)
  }

  private writeResults(code: number): string | null {
    try {
      const pad = (n: number): string => String(n).padStart(2, '0')
      const d = this.startedAt
      const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
      const stamp = `${date}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      mkdirSync(this.opts.resultsDir, { recursive: true })
      const file = join(this.opts.resultsDir, `overlay-check-${this.opts.label ?? stamp}.json`)
      const display = screen.getPrimaryDisplay()
      const ready = this.ready
      const results = {
        schema: RESULTS_SCHEMA,
        startedAt: this.startedAt.toISOString(),
        label: this.opts.label,
        file,
        exitCode: code,
        env: {
          electron: process.versions.electron ?? 'unknown',
          chrome: process.versions.chrome ?? 'unknown',
          macos: process.getSystemVersion(),
          arch: process.arch,
          cpu: cpus()[0]?.model ?? 'unknown',
          cores: this.cores,
        },
        conditions: {
          onBattery: powerMonitor.isOnBatteryPower(),
          power: this.power,
          thermalState: powerMonitor.getCurrentThermalState(),
          loadAvg: { start: this.load0.map((v) => round(v, 2)), end: loadavg().map((v) => round(v, 2)) },
        },
        display: {
          id: display.id,
          bounds: display.bounds,
          workArea: display.workArea,
          scaleFactor: display.scaleFactor,
          displayFrequency: display.displayFrequency,
        },
        pet: ready ? { petBox: ready.petBox, anchor: ready.anchor, edge: ready.edge, devicePixelRatio: ready.devicePixelRatio } : null,
        options: { measure: this.opts.measure, phases: this.opts.phases, thresholds: T.thresholds, phaseS: T.phaseS },
        functional: this.functional,
        calibration: this.calibration,
        latency: this.latency,
        phases: this.phases,
        footprint: this.footprint,
        a2: this.a2,
        verdicts: this.verdicts,
        errors: this.errorLines,
      }
      writeFileSync(file, `${JSON.stringify(results, null, 1)}\n`)
      return file
    } catch (err) {
      console.log(`[check] could not write the results: ${errorDetail(err)}`)
      return null
    }
  }

  /** The whole check took too long: FAIL, results written, Bitbot quit (the helper with it), exit. */
  private async hardStop(): Promise<void> {
    this.check(`the check finished within ${T.hardTimeoutS} s`, false)
    const code = this.finish()
    try {
      await this.bitbot?.quit('dev check timed out')
    } finally {
      app.exit(code || 1)
    }
  }
}

function whole(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

function fmtRect(r: Rect): string {
  return `${round(r.x, 1)},${round(r.y, 1)} ${round(r.width, 1)}x${round(r.height, 1)}`
}

function fmtPoint(p: Point): string {
  return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
}
