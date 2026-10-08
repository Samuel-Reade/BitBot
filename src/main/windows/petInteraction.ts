// The pet's grab area and presses: the safety-critical state machine of the overlay (BITBOT_SPEC.md §2, §5.2, §10.4,
// §15.3; docs/decisions/overlay.md). Pure: the grab-area window, the simulation, the helper and IPC are injected, so
// every rule is unit-tested with fakes (test/petInteraction.test.ts).
//
// §2: clicks pass through everything except the pet, and nothing may steal focus. Whenever in doubt it fails closed:
// grab area hidden, click-through on.
// - The grab area is shown only near the pet, while the overlay is shown and the pet drawn, and only once the helper has
//   confirmed that the overlay is on screen (the grab area is a panel, and panels join fullscreen Spaces; the overlay
//   doesn't). The answer is discarded whenever the cursor enters the near zone and re-asked while it stays.
// - It takes the mouse only while the overlay's hit test reports the cursor over the pet (pet:hover), or while a press
//   or the context menu is in progress ("engaged"). The safety net turns the mouse off when the cursor strays outside
//   the pet's box.
// - Epochs: every reset main makes on its own bumps the epoch and tells the overlay (pet:hover-reset); hover and pointer
//   messages from another epoch are dropped, so one that was in flight during a reset can never switch the mouse back
//   on. The mouse is off after every bump.
// - Presses: the overlay's 'down' grabs. Its 'up', the grab area's native mouseUp, or a native move without the left
//   button (a lost mouseup) releases, whichever comes first; the others are then no-ops. Native events never grab.
// - An engaged interaction ends (cancel) as soon as the grab area can't stay: overlay hidden, pet not drawn, overlay off
//   screen, a fullscreen app in front. The glue also cancels on Space changes, sleep, crashes and errors.
// - Every dependency call is guarded: a throw is logged (once, until that call works again) and fails closed. No public
//   method throws.

import { distance, isBox, isPoint, type Box, type Point } from '../../shared/geometry'
import type { PetHoverMsg, PetPointerMsg } from '../../shared/petProtocol'
import {
  cursorNearPet,
  decideHitWindow,
  HIT_WINDOW_HIDDEN,
  shouldForceClickThrough,
  type HitAreaInput,
  type HitAreaTuning,
  type HitWindowPlacement,
  type HitWindowPort,
} from './hitArea'

/** The part of the simulation a press drives (M1 Locomotion: idle | held | fall). */
export interface LocomotionControl {
  /** The pet was grabbed: it follows PetInteraction.sampleHeld() until released. */
  grab(): void
  /** The pet was let go with its ground-contact point at `at` (global pt); it falls from there if that is in the air. */
  release(at: Point): void
}

/** A mouse event on the grab area as main sees it (its webContents' before-mouse-event), independent of renderer JS. */
export interface NativeMouseEvent {
  type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseEnter' | 'mouseLeave' | 'contextMenu' | 'mouseWheel'
  button: 'left' | 'middle' | 'right' | null
  /** The left button is held (hitWindow.ts toNativeMouseEvent: Electron 44 reports it in `button`, not in modifiers). */
  leftButtonDown: boolean
  /** Global pt, when known (globalX/globalY). */
  screen: Point | null
}

export interface PetInteractionTuning extends HitAreaTuning {
  /** Safety net: mouse on, nothing engaged, cursor this far outside the pet's box → click-through forced back on, pt. */
  safetyMarginPt: number
  /** While near or engaged, the on-screen question is re-asked this often, ms. */
  onScreenRecheckMs: number
  /** An on-screen question unanswered this long is abandoned (counts as unknown), ms. */
  onScreenAnswerTimeoutMs: number
  /** An on-screen answer older than this (since it was asked) counts as unknown, ms. */
  onScreenMaxAgeMs: number
  /** The cursor is re-sent to the overlay when it or the drawn pet moved more than this, pt. */
  cursorStreamMinMovePt: number
  /** A press that moved less than this is a click (the pet stays exactly where it was), pt. */
  clickMaxMovePt: number
}

export interface PetInteractionDeps {
  hitWindow: HitWindowPort
  locomotion: LocomotionControl
  /** tuning.hitArea */
  tuning: PetInteractionTuning
  /** Monotonic ms (the simulation's clock). */
  now(): number
  /** Main's cursor poll, global pt (the dev check injects a synthetic one). */
  cursor(): Point
  /** Where the overlay draws the ground-contact point at `nowMs` (main's interpolation, one step behind). */
  displayedPoint(nowMs: number): Point
  /** The pet's box relative to its ground-contact point; null until pet:ready. */
  petBox(): Box | null
  /** Not hidden by the user. */
  overlayShown(): boolean
  /** pet:ready / pet:drawn reported the current configSeq, and no WebGL context loss since. */
  petDrawn(): boolean
  /** Helper: the frontmost app covers the primary display → the overlay counts as off screen. */
  frontmostFullscreen(): boolean
  /** Helper snapshot: is the overlay on screen? May reject (treated as null). */
  checkOverlayOnScreen(): Promise<boolean | null>
  /** Pops up the native menu over the grab area; `onClose` when it closes (honoured once, even if called twice). */
  popupMenu(onClose: () => void): void
  closeMenu(): void
  /** The pet jumped: restart main's interpolation and send a snap state. */
  onSnap(): void
  /** pet:hover-reset {epoch} */
  sendHoverReset(epoch: number): void
  /** pet:cursor */
  sendCursor(p: Point): void
  log(line: string): void
}

export type InteractionLabel = 'none' | 'near' | 'hover' | 'press' | 'drag' | 'menu'

interface Press {
  /** Cursor − ground-contact point at the press: the overlay's grab offset, pt. */
  readonly offset: Point
  /** Where the pet's ground-contact point and the cursor were at the press. */
  readonly startGround: Point
  readonly startCursor: Point
  /** Farthest the cursor got from startCursor so far, pt. */
  maxMove: number
  /** The newest held point (used when the cursor can't be read). */
  last: Point
}

interface OnScreenQuestion {
  readonly askedAt: number
  /** onScreenGeneration when asked: an answer to a question asked before the last discard is ignored. */
  readonly generation: number
}

/** What a tick reads from its dependencies. */
interface Frame {
  cursor: Point
  displayed: Point
  petBox: Box | null
  overlayShown: boolean
  petDrawn: boolean
  fullscreen: boolean
}

const FAILED: unique symbol = Symbol('failed')
type Failed = typeof FAILED

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class PetInteraction {
  private epochValue = 0
  private mouseOn = false
  /** False after hitWindow.setMouseEnabled threw: the next tick sends the mouse state again. */
  private mouseInSync = true
  private placed: HitWindowPlacement = HIT_WINDOW_HIDDEN
  private press: Press | null = null
  /** The open context menu (identity only); null when none is open. */
  private menu: object | null = null

  // On-screen cache (onScreen.ts). The answer is kept with the time its question was asked.
  private onScreenAnswer: { value: boolean | null; askedAt: number } | null = null
  /** Bumped by every discard. */
  private onScreenGeneration = 0
  /** The question in flight (one at a time). */
  private onScreenQuestion: OnScreenQuestion | null = null
  private onScreenNotBefore = Number.NEGATIVE_INFINITY
  private onScreenEffective: boolean | null = null

  private wasNear = false
  private wasEngaged = false
  private lastNow = 0
  private lastDisplayed: Point | null = null
  /** The last pet:cursor sent and where the pet was drawn then; null: the next tick sends one (after every reset). */
  private lastSent: { cursor: Point; pet: Point | null } | null = null
  private ticking = false
  private safetyNetFirings = 0
  /** Dependency calls whose failure was logged; an entry is cleared when that call works again. */
  private readonly failing = new Set<string>()
  /** Why the last tick failed closed (logged once per streak). */
  private closedFor: string | null = null

  constructor(private readonly deps: PetInteractionDeps) {}

  /** Bumped by every reset main makes on its own; renderer messages must carry the current one. */
  get epoch(): number {
    return this.epochValue
  }

  /** A press is in progress: the pet follows sampleHeld(). */
  get held(): boolean {
    return this.press !== null
  }

  /** A press or the context menu is in progress. */
  get engaged(): boolean {
    return this.press !== null || this.menu !== null
  }

  /** What the grab area was last asked for: true = it takes the mouse. */
  get mouseEnabled(): boolean {
    return this.mouseOn
  }

  get placement(): HitWindowPlacement {
    return this.placed
  }

  /** The on-screen answer the last decision used (frontmostFullscreen counts as false); null = unknown. */
  get overlayOnScreen(): boolean | null {
    return this.onScreenEffective
  }

  /** For logs and the activation monitor. */
  get label(): InteractionLabel {
    if (this.menu) return 'menu'
    if (this.press) return this.press.maxMove >= this.deps.tuning.clickMaxMovePt ? 'drag' : 'press'
    if (this.mouseOn) return 'hover'
    return this.placed.shown ? 'near' : 'none'
  }

  /** pet:hover — over: the grab area takes the mouse; off: click-through again, unless engaged. */
  handleHover(msg: PetHoverMsg): void {
    this.safely('handleHover', () => {
      if (!this.accepts(msg.epoch)) return
      if (msg.over) this.setMouse(true)
      else if (!this.engaged) this.setMouse(false)
    })
  }

  /** pet:pointer — 'down' grabs, 'up' releases, 'contextmenu' opens the menu. The renderer never sends ctrl-clicks as 'down'. */
  handlePointer(msg: PetPointerMsg): void {
    this.safely('handlePointer', () => {
      if (!this.accepts(msg.epoch)) return
      if (msg.kind === 'down') {
        if (msg.button === 0) this.grab(msg)
      } else if (msg.kind === 'up') {
        if (msg.button === 0) this.release(finitePoint(msg.screenX, msg.screenY))
      } else if (msg.kind === 'contextmenu') {
        this.openMenu()
      }
    })
  }

  /**
   * The grab area's own mouse events (before-mouse-event), which arrive even if the overlay's JavaScript is stuck. While
   * held, a left mouseUp releases, and so does a move without the left button (the mouseup was lost). Never grabs.
   */
  handleNativeMouse(e: NativeMouseEvent): void {
    this.safely('handleNativeMouse', () => {
      if (!this.press) return
      // A mouseUp of unknown button counts as left: releasing is the safe side.
      const up = e.type === 'mouseUp' && e.button !== 'right' && e.button !== 'middle'
      const lostUp = e.type === 'mouseMove' && !e.leftButtonDown
      if (!up && !lostUp) return
      this.release(e.screen && isPoint(e.screen) ? { x: e.screen.x, y: e.screen.y } : this.readCursor())
    })
  }

  /**
   * While held: where the pet's ground-contact point is held (the cursor minus the grab offset), and the press's largest
   * movement so far (click or drag). Null when nothing is held. The time is unused in M1 (M4's toss samples it).
   */
  sampleHeld(_nowMs: number): Point | null {
    const press = this.press
    if (!press) return null
    try {
      const cursor = this.readCursor()
      if (cursor) {
        this.trackMove(press, cursor)
        press.last = heldPoint(cursor, press)
      }
    } catch {
      // Keep the last held point.
    }
    return { x: press.last.x, y: press.last.y }
  }

  /** Every simulation wake: on-screen check, cancel if needed, place the grab area, safety net, cursor stream. */
  tick(nowMs: number): void {
    if (this.ticking) return // re-entered from a dependency: the running tick decides
    this.ticking = true
    try {
      this.safely('tick', () => this.runTick(nowMs))
    } finally {
      this.ticking = false
    }
  }

  /**
   * Discards the on-screen answer and re-decides the placement now, so the grab area hides at once until the helper
   * confirms again (Space change, app activation, fullscreen change, helper restart, show/hide, display change, overlay
   * reload). No question is asked before `settleMs` from now (a Space change animates for ~0.7 s).
   */
  invalidateOnScreen(settleMs = 0): void {
    this.safely('invalidateOnScreen', () => {
      const now = this.readNow()
      this.discardOnScreen()
      if (Number.isFinite(settleMs) && settleMs > 0) this.onScreenNotBefore = Math.max(this.onScreenNotBefore, now + settleMs)
      this.tick(now)
    })
  }

  /**
   * Ends whatever is in progress: a held pet is let go where it is drawn (it falls if in the air; no click rule), the
   * menu is closed, click-through on, epoch bumped. Safe to call at any time, also with nothing in progress.
   */
  cancel(reason: string): void {
    this.safely('cancel', () => this.cancelNow(reason))
  }

  // ───────────────────────────── tick ─────────────────────────────

  private runTick(now: number): void {
    if (!Number.isFinite(now)) {
      this.failClosed('the clock gave a non-finite time')
      return
    }
    this.lastNow = now
    if (!this.mouseInSync) this.setMouse(this.mouseOn)
    const frame = this.readFrame(now)
    if (typeof frame === 'string') {
      this.failClosed(frame)
      return
    }
    this.lastDisplayed = frame.displayed
    const T = this.deps.tuning
    const { cursor, displayed, petBox } = frame

    // 1. Is the overlay on screen?
    const near = petBox !== null && cursorNearPet(cursor, displayed, petBox, this.placed.shown ? T.farMarginPt : T.nearMarginPt)
    // Nothing to ask while the grab area must stay hidden anyway; coming back counts as coming near (a fresh question).
    const usable = !frame.fullscreen && frame.overlayShown && frame.petDrawn
    this.updateOnScreen(now, near && usable)
    const answer = this.onScreenAnswer
    // No answer, or only a stale one (a slow or stuck helper), means unknown: hidden unless engaged (hitArea.ts).
    const fresh = answer !== null && now - answer.askedAt <= T.onScreenMaxAgeMs
    const onScreen = frame.fullscreen ? false : fresh ? answer.value : null
    this.onScreenEffective = onScreen

    // 2 + 3. Where the grab area goes; an interaction that can't keep it is cancelled first.
    const input: HitAreaInput = {
      cursor,
      pet: displayed,
      petBox,
      overlayShown: frame.overlayShown,
      overlayOnScreen: onScreen,
      petDrawn: frame.petDrawn,
      engaged: this.engaged,
      current: this.placed,
    }
    let next = decideHitWindow(input, T)
    if (input.engaged) {
      const blocker = engagedBlocker(frame, onScreen) ?? (next.shown ? null : 'the grab area cannot follow the pet')
      if (blocker !== null) {
        this.cancelNow(blocker)
        next = decideHitWindow({ ...input, engaged: false }, T)
      }
    }
    if (!this.applyPlacement(next, cursor)) {
      this.failClosed('the grab area could not be placed')
      return
    }

    // 4. Safety net.
    const force = shouldForceClickThrough({
      mouseEnabled: this.mouseOn,
      engaged: this.engaged,
      cursor,
      pet: displayed,
      petBox,
      marginPt: T.safetyMarginPt,
    })
    if (force) {
      this.setMouse(false)
      this.bumpEpoch()
      const n = ++this.safetyNetFirings
      // Logged at 1, 2, 4, 8… firings, so a mismatch that fires on every wake can't flood the log.
      if (Number.isInteger(Math.log2(n))) {
        this.log(`safety net: the grab area took the mouse with the cursor outside the pet; click-through forced back on (${n} so far)`)
      }
    }

    // 5. Cursor stream: lets the overlay hit-test a still cursor, and a pet moving under it.
    if (this.placed.shown && !this.press && this.cursorMoved(cursor, displayed)) this.sendCursor(cursor, displayed)
    this.closedFor = null
  }

  /** Reads what a tick needs; a failing or misbehaving dependency yields the reason to fail closed. */
  private readFrame(now: number): Frame | string {
    const cursor = this.readCursor()
    if (!cursor) return 'the cursor position is unavailable'
    const displayed = this.attempt('displayedPoint', () => this.deps.displayedPoint(now))
    if (displayed === FAILED || !isPoint(displayed)) return 'the drawn pet position is unavailable'
    const petBox = this.attempt('petBox', () => this.deps.petBox())
    if (petBox === FAILED || (petBox !== null && !isBox(petBox))) return 'the pet box is invalid'
    const overlayShown = this.attempt('overlayShown', () => this.deps.overlayShown())
    const petDrawn = this.attempt('petDrawn', () => this.deps.petDrawn())
    const fullscreen = this.attempt('frontmostFullscreen', () => this.deps.frontmostFullscreen())
    if (overlayShown === FAILED || petDrawn === FAILED || fullscreen === FAILED) return 'the overlay state is unavailable'
    return {
      cursor,
      displayed: { x: displayed.x, y: displayed.y },
      petBox,
      // Anything but a real boolean counts as the unsafe answer.
      overlayShown: overlayShown === true,
      petDrawn: petDrawn === true,
      fullscreen: fullscreen !== false,
    }
  }

  /** Keeps the on-screen answer fresh while it matters (near or engaged). */
  private updateOnScreen(now: number, near: boolean): void {
    const engaged = this.engaged
    // Fail closed on entry: an answer from before the cursor came near, or before this interaction, isn't trusted.
    if ((near && !this.wasNear) || (engaged && !this.wasEngaged)) this.discardOnScreen()
    this.wasNear = near
    this.wasEngaged = engaged
    const T = this.deps.tuning
    const question = this.onScreenQuestion
    if (question && now - question.askedAt >= T.onScreenAnswerTimeoutMs) {
      // Abandoned: its late answer is ignored, and the overlay counts as off screen until a new one.
      this.onScreenQuestion = null
      this.onScreenAnswer = null
      this.noteFailure('checkOverlayOnScreen', `no answer after ${T.onScreenAnswerTimeoutMs} ms`)
    }
    if (!near && !engaged) return
    if (this.onScreenQuestion !== null || now < this.onScreenNotBefore) return
    const answer = this.onScreenAnswer
    // A null answer (helper down, unknown window, failed request) is re-asked on the same schedule, not every wake.
    if (answer && now - answer.askedAt < T.onScreenRecheckMs) return
    this.askOnScreen(now)
  }

  private askOnScreen(now: number): void {
    const question: OnScreenQuestion = { askedAt: now, generation: this.onScreenGeneration }
    this.onScreenQuestion = question
    let reply: Promise<boolean | null>
    try {
      reply = Promise.resolve(this.deps.checkOverlayOnScreen())
    } catch (err) {
      reply = Promise.reject(err)
    }
    void reply.then(
      (value) => {
        this.failing.delete('checkOverlayOnScreen')
        this.onScreenReplied(question, value === true || value === false ? value : null)
      },
      (err: unknown) => {
        this.noteFailure('checkOverlayOnScreen', err)
        this.onScreenReplied(question, null)
      },
    )
  }

  private onScreenReplied(question: OnScreenQuestion, value: boolean | null): void {
    if (this.onScreenQuestion !== question) return // abandoned after onScreenAnswerTimeoutMs
    this.onScreenQuestion = null
    if (question.generation !== this.onScreenGeneration) return // asked before the last discard
    this.onScreenAnswer = { value, askedAt: question.askedAt }
  }

  private discardOnScreen(): void {
    this.onScreenAnswer = null
    this.onScreenGeneration++
  }

  /** Places the grab area (every tick: the port skips no-ops). False if the port threw; it then counts as hidden. */
  private applyPlacement(next: HitWindowPlacement, cursor: Point | null): boolean {
    const wasShown = this.placed.shown
    if (!next.shown) this.setMouse(false) // click-through before the window goes away
    const ok = this.attempt('hitWindow.place', () => this.deps.hitWindow.place(next)) !== FAILED
    this.placed = ok ? next : HIT_WINDOW_HIDDEN
    if (!ok) this.setMouse(false)
    if (wasShown !== this.placed.shown) {
      this.bumpEpoch()
      // Just shown: the overlay forgot any hover with the bump; a fresh cursor sample lets it report again.
      if (this.placed.shown && cursor) this.sendCursor(cursor, this.lastDisplayed)
    }
    return ok
  }

  /** A dependency failed or misbehaved: end any interaction, click-through on, grab area hidden. */
  private failClosed(reason: string): void {
    if (reason !== this.closedFor) {
      this.closedFor = reason
      this.log(`grab area hidden: ${reason}`)
    }
    this.wasNear = false
    if (this.engaged) this.cancelNow(reason)
    this.setMouse(false)
    this.applyPlacement(HIT_WINDOW_HIDDEN, null)
  }

  // ───────────────────────────── presses and the menu ─────────────────────────────

  /** Renderer messages count only for the current epoch, while the grab area is shown over a shown overlay with the pet drawn. */
  private accepts(epoch: unknown): boolean {
    if (epoch !== this.epochValue || !this.placed.shown) return false
    return (
      this.attempt('overlayShown', () => this.deps.overlayShown()) === true &&
      this.attempt('petDrawn', () => this.deps.petDrawn()) === true
    )
  }

  private grab(msg: Extract<PetPointerMsg, { kind: 'down' }>): void {
    if (this.press || this.menu) return // a second 'down' while held keeps the first press
    const cursor = finitePoint(msg.screenX, msg.screenY)
    const ground = finitePoint(msg.groundX, msg.groundY)
    if (!cursor || !ground) return
    // The overlay's own grab offset, so the pet doesn't jump under the cursor.
    const offset = { x: cursor.x - ground.x, y: cursor.y - ground.y }
    this.press = { offset, startGround: ground, startCursor: cursor, maxMove: 0, last: ground }
    if (this.attempt('locomotion.grab', () => this.deps.locomotion.grab()) === FAILED) {
      // The simulation didn't take it: nothing is held.
      this.press = null
      this.setMouse(false)
      this.bumpEpoch()
      return
    }
    this.setMouse(true)
  }

  /** Ends the press: a drag lets go at the release point, a click where the pet was pressed (§10.4). */
  private release(screen: Point | null): void {
    const press = this.press
    if (!press) return
    if (screen) this.trackMove(press, screen)
    const dragged = press.maxMove >= this.deps.tuning.clickMaxMovePt
    this.press = null
    // A click leaves the pet exactly where it was (petting is M4).
    this.releaseAt(!dragged ? press.startGround : screen ? heldPoint(screen, press) : press.last)
    if (dragged) {
      // The overlay forgets its hover with the bump; the cursor stream re-enables the mouse if it is still on the pet.
      this.setMouse(false)
      this.bumpEpoch()
    }
  }

  private releaseAt(at: Point): void {
    this.attempt('locomotion.release', () => this.deps.locomotion.release({ x: at.x, y: at.y }))
    this.attempt('onSnap', () => this.deps.onSnap())
  }

  private trackMove(press: Press, cursor: Point): void {
    press.maxMove = Math.max(press.maxMove, distance(cursor, press.startCursor))
  }

  private openMenu(): void {
    if (this.press || this.menu) return
    const menu = {}
    this.menu = menu
    this.setMouse(true)
    const onClose = (): void => this.safely('menu closed', () => this.menuClosed(menu))
    if (this.attempt('popupMenu', () => this.deps.popupMenu(onClose)) === FAILED) onClose()
  }

  /** The menu closed (chosen or dismissed): click-through on, epoch bumped, a cursor sample so the overlay reports again. */
  private menuClosed(menu: object): void {
    if (this.menu !== menu) return // closed already, or cancelled (cancel resets everything itself)
    this.menu = null
    this.setMouse(false)
    this.bumpEpoch()
    if (this.placed.shown) {
      const cursor = this.readCursor()
      if (cursor) this.sendCursor(cursor, this.lastDisplayed)
    }
  }

  private cancelNow(reason: string): void {
    const press = this.press
    const menu = this.menu
    this.press = null
    this.menu = null
    if (press) {
      // Where the overlay draws it now: no jump, and it falls from there if it is in the air.
      const drawn = this.attempt('displayedPoint', () => this.deps.displayedPoint(this.readNow()))
      this.releaseAt(drawn !== FAILED && isPoint(drawn) ? drawn : press.last)
    }
    if (menu) this.attempt('closeMenu', () => this.deps.closeMenu())
    this.setMouse(false)
    this.bumpEpoch()
    const what = press ? 'let the pet go where it is drawn' : menu ? 'closed the menu' : 'nothing was in progress'
    this.log(`interaction cancelled (${reason}): ${what}`)
  }

  // ───────────────────────────── outputs ─────────────────────────────

  private setMouse(on: boolean): void {
    if (on === this.mouseOn && this.mouseInSync) return
    this.mouseOn = on
    this.mouseInSync = this.attempt('hitWindow.setMouseEnabled', () => this.deps.hitWindow.setMouseEnabled(on)) !== FAILED
    if (!this.mouseInSync && on) {
      // It may or may not take the mouse now: ask for click-through instead.
      this.mouseOn = false
      this.mouseInSync = this.attempt('hitWindow.setMouseEnabled', () => this.deps.hitWindow.setMouseEnabled(false)) !== FAILED
    }
  }

  private bumpEpoch(): void {
    const epoch = ++this.epochValue
    this.lastSent = null // the overlay forgets its hover on a reset: the stream sends it a fresh cursor sample
    this.attempt('sendHoverReset', () => this.deps.sendHoverReset(epoch))
  }

  private sendCursor(cursor: Point, pet: Point | null): void {
    this.lastSent = { cursor, pet }
    this.attempt('sendCursor', () => this.deps.sendCursor({ x: cursor.x, y: cursor.y }))
  }

  private cursorMoved(cursor: Point, pet: Point): boolean {
    const last = this.lastSent
    if (!last || !last.pet) return true
    const min = this.deps.tuning.cursorStreamMinMovePt
    return distance(cursor, last.cursor) > min || distance(pet, last.pet) > min
  }

  // ───────────────────────────── guarded dependency calls ─────────────────────────────

  /** Runs a public entry point: an unexpected error is logged and fails closed instead of escaping. */
  private safely(what: string, body: () => void): void {
    try {
      body()
    } catch (err) {
      this.log(`${what}: unexpected error (${errorText(err)}); failing closed`)
      try {
        this.failClosed(`unexpected error in ${what}`)
      } catch {
        // Nothing more to do here: the next tick decides again.
      }
    }
  }

  /** Calls a dependency; a throw is logged (once, until that call works again) and yields FAILED. */
  private attempt<T>(what: string, call: () => T): T | Failed {
    try {
      const value = call()
      if (this.failing.size > 0) this.failing.delete(what)
      return value
    } catch (err) {
      this.noteFailure(what, err)
      return FAILED
    }
  }

  private noteFailure(what: string, err: unknown): void {
    if (this.failing.has(what)) return
    this.failing.add(what)
    this.log(`${what} failed: ${errorText(err)}`)
  }

  private readCursor(): Point | null {
    const cursor = this.attempt('cursor', () => this.deps.cursor())
    return cursor !== FAILED && isPoint(cursor) ? { x: cursor.x, y: cursor.y } : null
  }

  private readNow(): number {
    const now = this.attempt('now', () => this.deps.now())
    return now !== FAILED && Number.isFinite(now) ? now : this.lastNow
  }

  private log(line: string): void {
    try {
      this.deps.log(line)
    } catch {
      // Nowhere left to report it.
    }
  }
}

/** Why an engaged interaction can't keep the grab area, or null. */
function engagedBlocker(frame: Frame, onScreen: boolean | null): string | null {
  if (!frame.overlayShown) return 'the overlay is hidden'
  if (!frame.petDrawn) return 'the pet is not drawn'
  if (frame.fullscreen) return 'a fullscreen app is in front'
  if (onScreen === false) return 'the overlay is not on screen'
  if (!frame.petBox) return 'the pet box is unknown'
  return null
}

function heldPoint(cursor: Point, press: Press): Point {
  return { x: cursor.x - press.offset.x, y: cursor.y - press.offset.y }
}

function finitePoint(x: number, y: number): Point | null {
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}
