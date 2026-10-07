import { Menu, type BrowserWindow } from 'electron'
import type { PetPointerMsg } from '../../../shared/ipc'
import type { FocusMonitor } from './focus'
import { releaseVelocity, type OverlaySim, type Point, type TimedSample } from './sim'

// Click-through toggling, the click-through safety net, drag / toss / pet, and the right-click menu
// (BITBOT_SPEC.md §5.2, §10.4, §15.3), plus a focus verdict per interaction for the manual checklist.

export interface PetBox {
  left: number
  top: number
  right: number
  bottom: number
}

export type InteractionLabel = 'none' | 'hover' | 'down' | 'drag' | 'up' | 'menu'

export interface InteractionTuning {
  safetyMarginPt: number
  petClickMaxMovePt: number
  releaseWindowMs: number
  focusVerdictDelayMs: number
  safetyNetRaceMs: number
  cursorMovedWindowMs: number
  cursorMovedMinPt: number
  hideMs: number
}

export interface InteractionDeps {
  win: BrowserWindow
  /** Drag/toss/menu enabled (interactive mode); otherwise pointer events are only counted. */
  interactive: boolean
  tuning: InteractionTuning
  sim: OverlaySim
  focus: () => FocusMonitor | null
  now(): number
  /** Seconds since the harness origin, for logs. */
  elapsedS(nowMs: number): number
  cursor(): Point
  /** Ground-contact point where the pet is currently drawn (global pt). */
  displayedPoint(nowMs: number): Point
  petBox(): PetBox
  log(line: string): void
  /** The sim position jumped (release): reset interpolation and send a snap state. */
  onSnap(): void
  sendHoverReset(): void
  quit(): void
}

export interface InteractionVerdict {
  tS: number
  what: string
  becameActive: boolean
  events: string[]
}

export interface SafetyNetFiring {
  tS: number
  /**
   * The cursor moved during the last tuning cursorMovedWindowMs before firing (history starts at
   * hover-on). False = the pet moved away from a still cursor, which produces no mouse events at all.
   */
  cursorMoved: boolean
  /** The renderer's own leave ('pet:hover' off) arrived within tuning safetyNetRaceMs after: forwarding worked, just later than this check. */
  raced: boolean
}

export interface InteractionStats {
  hoverOn: number
  hoverOff: number
  clickThroughToggles: number
  safetyNet: number
  /** Firings with a moving cursor and no late leave from the renderer: forwarding really missed a leave. */
  safetyNetMissedLeaves: number
  safetyNetFirings: SafetyNetFiring[]
  pets: number
  drags: number
  menus: number
  /** Pointer messages received outside interactive mode (not acted on). */
  pointerIgnored: number
  verdicts: InteractionVerdict[]
}

interface HeldState {
  grab: Point
  down: Point
  downMs: number
  maxMove: number
}

export function isPetPointerMsg(value: unknown): value is PetPointerMsg {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const coords = typeof v['screenX'] === 'number' && typeof v['screenY'] === 'number'
  if (v['kind'] === 'contextmenu') return coords
  return (v['kind'] === 'down' || v['kind'] === 'up') && coords && typeof v['button'] === 'number'
}

export class InteractionController {
  readonly stats: InteractionStats = {
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
  private mouseEnabled = false
  private hoverOver = false
  private held: HeldState | null = null
  private samples: TimedSample[] = []
  private menuOpen = false
  private label: InteractionLabel = 'none'
  private stopped = false
  /**
   * Cursor positions while mouse events are on: seeded at hover-on, then one per safetyTick. Covers the
   * last cursorMovedWindowMs plus the newest sample before it (where the cursor was when it began).
   */
  private recentCursor: TimedSample[] = []
  private lastFiringMs = Number.NEGATIVE_INFINITY

  constructor(private readonly deps: InteractionDeps) {}

  get interaction(): InteractionLabel {
    return this.label
  }

  get isHeld(): boolean {
    return this.held !== null
  }

  get mouseEventsEnabled(): boolean {
    return this.mouseEnabled
  }

  stop(): void {
    this.stopped = true
  }

  /** Renderer hit-test result changed ('pet:hover'). */
  handleHover(over: boolean): void {
    this.hoverOver = over
    if (over) {
      this.stats.hoverOn++
      if (this.label === 'none') this.label = 'hover'
      this.setMouseEnabled(true)
    } else {
      this.stats.hoverOff++
      if (this.label === 'hover') this.label = 'none'
      if (!this.held && !this.menuOpen) this.setMouseEnabled(false)
      const last = this.stats.safetyNetFirings[this.stats.safetyNetFirings.length - 1]
      if (last && !last.raced && this.deps.now() - this.lastFiringMs <= this.deps.tuning.safetyNetRaceMs) {
        last.raced = true
        this.recountMissed()
      }
    }
    if (this.deps.interactive) this.deps.log(`hover ${over ? 'on -> mouse events ON' : 'off -> click-through ON'}`)
  }

  handlePointer(msg: PetPointerMsg): void {
    if (this.stopped) return
    // SPEC-DEVIATION: §12 has drag/toss/pet/right-click in interactive mode; the other modes only count
    // pointer messages, so a stray click cannot change a benchmark run (keeps runs deterministic).
    if (!this.deps.interactive) {
      this.stats.pointerIgnored++
      return
    }
    if (msg.kind === 'down' && msg.button === 0) this.grab()
    else if (msg.kind === 'up' && msg.button === 0) this.release()
    else if (msg.kind === 'contextmenu' && !this.held) this.showMenu()
  }

  /**
   * While held: samples the cursor (for the release velocity) and returns where the pet's
   * ground-contact point is held. Called on every sim step and presentation tick.
   */
  sampleHeld(nowMs: number): Point | null {
    const held = this.held
    if (!held) return null
    const c = this.deps.cursor()
    this.pushSample(nowMs, c)
    held.maxMove = Math.max(held.maxMove, Math.hypot(c.x - held.down.x, c.y - held.down.y))
    if (this.label === 'down' && held.maxMove >= this.deps.tuning.petClickMaxMovePt) this.label = 'drag'
    return { x: c.x - held.grab.x, y: c.y - held.grab.y }
  }

  /**
   * Safety net, run every sim step: mouse events are on but the cursor is outside the pet's box
   * (+ margin) — forwarding missed a leave. Force click-through back on and count it.
   */
  safetyTick(nowMs: number): void {
    if (!this.mouseEnabled || this.held || this.menuOpen || this.stopped) return
    const c = this.deps.cursor()
    const { cursorMovedWindowMs, cursorMovedMinPt } = this.deps.tuning
    this.recentCursor.push({ t: nowMs, x: c.x, y: c.y })
    // Keep the window plus the newest sample at or before its start (the cursor's position then).
    while (this.recentCursor.length > 1 && (this.recentCursor[1]?.t ?? nowMs) <= nowMs - cursorMovedWindowMs) this.recentCursor.shift()
    const p = this.deps.displayedPoint(nowMs)
    const b = this.deps.petBox()
    const m = this.deps.tuning.safetyMarginPt
    const inside = c.x >= p.x + b.left - m && c.x <= p.x + b.right + m && c.y >= p.y + b.top - m && c.y <= p.y + b.bottom + m
    if (inside) return
    const cursorMoved = this.recentCursor.some((s) => Math.hypot(s.x - c.x, s.y - c.y) > cursorMovedMinPt)
    this.stats.safetyNet++
    this.stats.safetyNetFirings.push({ tS: this.deps.elapsedS(nowMs), cursorMoved, raced: false })
    this.lastFiringMs = nowMs
    this.recountMissed()
    this.recentCursor = []
    this.hoverOver = false
    if (this.label === 'hover') this.label = 'none'
    this.setMouseEnabled(false)
    this.deps.sendHoverReset()
    this.deps.log(
      `safety net #${this.stats.safetyNet}: mouse events were on with the cursor outside the pet ` +
        `(${cursorMoved ? 'cursor moving' : 'cursor still: the pet moved away'}) -> click-through forced ON`,
    )
  }

  private recountMissed(): void {
    this.stats.safetyNetMissedLeaves = this.stats.safetyNetFirings.filter((f) => f.cursorMoved && !f.raced).length
  }

  private setMouseEnabled(on: boolean): void {
    if (on === this.mouseEnabled || this.deps.win.isDestroyed()) return
    this.mouseEnabled = on
    if (on) {
      this.seedCursorHistory()
      this.deps.win.setIgnoreMouseEvents(false)
    } else {
      this.deps.win.setIgnoreMouseEvents(true, { forward: true })
    }
    this.stats.clickThroughToggles++
  }

  /**
   * Restarts the safety net's cursor history at the cursor's current position: at hover-on (so a leave
   * missed before the next safety tick, i.e. a cursor flicked off within one sim step, still counts as
   * "cursor moved") and when a drag or the menu ends (safetyTick pauses during both).
   */
  private seedCursorHistory(): void {
    const c = this.deps.cursor()
    this.recentCursor = [{ t: this.deps.now(), x: c.x, y: c.y }]
  }

  private pushSample(t: number, c: Point): void {
    this.samples.push({ t, x: c.x, y: c.y })
    // Keep a little more than the velocity window.
    const keepFrom = t - this.deps.tuning.releaseWindowMs * 3
    while (this.samples.length > 2 && (this.samples[0]?.t ?? t) < keepFrom) this.samples.shift()
  }

  private grab(): void {
    if (this.held) return
    const now = this.deps.now()
    const c = this.deps.cursor()
    const p = this.deps.displayedPoint(now)
    this.held = { grab: { x: c.x - p.x, y: c.y - p.y }, down: c, downMs: now, maxMove: 0 }
    this.samples = []
    this.pushSample(now, c)
    this.label = 'down'
    this.setMouseEnabled(true)
    this.deps.sim.grab()
  }

  private release(): void {
    const held = this.held
    if (!held) return
    const now = this.deps.now()
    const at = this.sampleHeld(now) ?? this.deps.displayedPoint(now)
    const petClick = held.maxMove < this.deps.tuning.petClickMaxMovePt
    const v = petClick ? { x: 0, y: 0 } : releaseVelocity(this.samples, this.deps.tuning.releaseWindowMs)
    this.held = null
    this.deps.sim.release(at, v, petClick)
    this.deps.onSnap()
    this.label = 'up'
    let what: string
    if (petClick) {
      this.stats.pets++
      what = 'click on pet (pet!)'
    } else {
      this.stats.drags++
      what = `drag ${Math.round(held.maxMove)} pt, toss ${Math.round(Math.hypot(v.x, v.y))} pt/s`
    }
    if (!this.hoverOver) this.setMouseEnabled(false)
    else this.seedCursorHistory()
    this.verdictLater(what, held.downMs)
  }

  private showMenu(): void {
    if (this.menuOpen || this.deps.win.isDestroyed()) return
    const startMs = this.deps.now()
    this.menuOpen = true
    this.label = 'menu'
    this.stats.menus++
    let chosen = 'nothing'
    const sim = this.deps.sim
    const menu = Menu.buildFromTemplate([
      {
        label: 'Pet',
        click: () => {
          chosen = 'Pet'
          this.stats.pets++
        },
      },
      {
        label: sim.staying ? 'Roam' : 'Stay here',
        click: () => {
          chosen = sim.staying ? 'Roam' : 'Stay here'
          sim.setStay(!sim.staying)
        },
      },
      {
        label: `Hide (${this.deps.tuning.hideMs / 1000} s)`,
        click: () => {
          chosen = 'Hide'
          this.hideBriefly()
        },
      },
      { type: 'separator' },
      {
        label: 'Quit spike harness',
        click: () => {
          chosen = 'Quit'
          this.deps.quit()
        },
      },
    ])
    menu.popup({
      window: this.deps.win,
      callback: () => {
        this.menuOpen = false
        if (!this.hoverOver) this.setMouseEnabled(false)
        else this.seedCursorHistory()
        // Item clicks are delivered after the menu closes; the verdict delay covers that.
        this.verdictLater(`right-click menu`, startMs, () => `chose ${chosen}`)
      },
    })
  }

  private hideBriefly(): void {
    const win = this.deps.win
    if (win.isDestroyed()) return
    win.hide()
    setTimeout(() => {
      if (!win.isDestroyed() && !this.stopped) win.showInactive()
    }, this.deps.tuning.hideMs)
  }

  private verdictLater(what: string, sinceMs: number, detail?: () => string): void {
    const delayMs = this.deps.tuning.focusVerdictDelayMs
    setTimeout(() => {
      const focus = this.deps.focus()
      // Look back too: AppKit would activate the app on the mouse-down itself, i.e. before the
      // renderer's 'down' message reaches main.
      const acts = focus ? focus.activationsSince(sinceMs - delayMs) : []
      const becameActive = acts.length > 0
      const label = detail ? `${what} (${detail()})` : what
      const now = this.deps.now()
      this.stats.verdicts.push({
        tS: this.deps.elapsedS(now),
        what: label,
        becameActive,
        events: acts.map((a) => a.event),
      })
      this.deps.log(
        `${label} -> Bitbot became the active app: ${becameActive ? `YES (FAIL: ${acts.map((a) => a.event).join(', ')})` : 'NO (PASS)'}`,
      )
      if (this.label === 'up' || this.label === 'menu') this.label = this.hoverOver ? 'hover' : 'none'
    }, delayMs)
  }
}
