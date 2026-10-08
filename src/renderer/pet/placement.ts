// The overlay renderer's decisions (approach B, hardened: docs/decisions/overlay.md), pure: no DOM, no three.js, no
// clock (times are passed in), so Vitest runs them in Node. overlay.ts wires them to the page.
//
// - Placement: where the canvas goes each frame (the pet held under the cursor, held at the drop point, or
//   interpolated one simulation step behind main's states), snapped to device pixels; the contact shadow on the
//   support line; when a WebGL render is due; whether another animation frame is needed.
// - Input: the grab area's mouse events and main's cursor samples become hover / press / release / right-click
//   messages, stamped with the newest epoch seen (petProtocol.ts header), and never hover:false while pressed. A press
//   follows the grab area's raw pointer moves (pointerrawupdate) when they come: its frame-aligned mousemoves are
//   dispatched with the grab area's own frames, after the overlay's frame at the same vsync, so a drag drawn from them
//   lags the cursor by one frame (measured by the dev check, src/main/dev/overlayCheck.ts).
//
// - Animation: what main says about the pet (state, mood, dust, look, facing; the dev panel's overrides) and the press
//   go to the animator (character/animator.ts) when its pose is due; it says whether anything changed (render) and
//   when it next changes on its own (another frame now, or a timer for later), capped at the state's frame rate.
//
// OverlayModel holds that state; the small functions above it are its rules, exported so tests pin each one down.

import type { FaceOverride } from '../../shared/faceStates'
import { clampToArea, distance, type Box, type PetArea, type Point } from '../../shared/geometry'
import { pushTimed, sampleBuffer, type TimedPoint } from '../../shared/interpolation'
import { IPC } from '../../shared/ipc'
import {
  isDevPetMsg,
  isPetConfig,
  isPetCursorMsg,
  isPetHoverResetMsg,
  isPetStateMsg,
  isPetVisibleMsg,
  type OverlayStatsMsg,
  type PetConfig,
  type PetDrawnMsg,
  type PetHoverMsg,
  type PetLogMsg,
  type PetPointerMsg,
} from '../../shared/petProtocol'
import { tuning } from '../../shared/tuning'
import type { BehaviorState, IdleMode, LookDirection, Mood } from '../../shared/types'
import type { AnimInput, AnimResult } from './character/animator'

// ---- Placement rules -------------------------------------------------------------------------

/** `value` (CSS px) on the device-pixel grid, so the canvas texture is never resampled (sharp at any position). */
export function snapToDevicePixels(value: number, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  // `+ 0` folds −0 into 0.
  return Math.round(value * dpr) / dpr + 0
}

/**
 * Overlay-local position (CSS px) of the canvas's top-left that draws the ground-contact point `ground` (global pt)
 * at `anchor`, snapped to device pixels. The overlay window's content starts at `overlayOrigin` (global pt).
 */
export function canvasOrigin(ground: Point, overlayOrigin: Point, anchor: Point, devicePixelRatio: number): Point {
  return {
    x: snapToDevicePixels(ground.x - overlayOrigin.x - anchor.x, devicePixelRatio),
    y: snapToDevicePixels(ground.y - overlayOrigin.y - anchor.y, devicePixelRatio),
  }
}

/** The compositor transform that puts the canvas at `origin`. */
export function canvasTransform(origin: Point): string {
  return `translate3d(${origin.x}px, ${origin.y}px, 0)`
}

/** A global point (pt) in the coordinates of a canvas drawn at `origin` (overlay-local CSS px). */
export function canvasLocalPoint(global: Point, overlayOrigin: Point, origin: Point): Point {
  return { x: global.x - overlayOrigin.x - origin.x, y: global.y - overlayOrigin.y - origin.y }
}

export function insideCanvas(p: Point, edge: number): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < edge && p.y < edge
}

/** Where a held pet's ground-contact point is: the cursor minus the grab offset, clamped to the area (as main does). */
export function heldGroundPoint(mouse: Point, localGrab: Point, area: PetArea | null): Point {
  const p = { x: mouse.x - localGrab.x, y: mouse.y - localGrab.y }
  return area ? clampToArea(p, area) : p
}

/** The contact shadow to draw: on the support line `elevationPt` below the ground-contact point, at `strength` 0..1. */
export interface ContactShadowParams {
  elevationPt: number
  strength: number
}

/** The pet standing on its support line: what the first frame draws. */
export const STANDING_SHADOW: Readonly<ContactShadowParams> = { elevationPt: 0, strength: 1 }

/**
 * The contact shadow for a pet whose ground-contact point is at `groundY` above the support line `supportY` (global
 * pt, y down; null: nothing below it, no shadow). Full strength standing on it, fading out over `fadePt` of height
 * (§6.1 "fades with height when falling"). A shadow with strength 0 has elevation 0, so hidden shadows compare equal.
 */
// SPEC-DEVIATION: §6.1 renders the contact shadow only when standing on a surface (and fading while falling); here
// it also fades with height while the pet is held, so lifting the pet off the Dock fades the shadow out instead of
// popping it off, and setting it down fades it back in.
export function contactShadowFor(supportY: number | null, groundY: number, fadePt: number): ContactShadowParams {
  if (supportY === null) return { elevationPt: 0, strength: 0 }
  const elevationPt = Math.max(0, supportY - groundY)
  const strength = fadePt > 0 ? Math.min(1, Math.max(0, 1 - elevationPt / fadePt)) : elevationPt > 0 ? 0 : 1
  return strength > 0 ? { elevationPt, strength } : { elevationPt: 0, strength: 0 }
}

export function sameShadow(a: ContactShadowParams, b: ContactShadowParams): boolean {
  return a.elevationPt === b.elevationPt && a.strength === b.strength
}

/**
 * True if a WebGL render may run in the frame at `ts` (animation-frame timestamp, ms): at most one per 1000 / maxFps
 * ms, less `slackMs` for vsync jitter (tuning.overlay.renderIntervalSlackMs). Null: no render in the frame loop yet.
 */
export function renderAllowed(lastRenderTs: number | null, ts: number, maxFps: number, slackMs: number): boolean {
  if (lastRenderTs === null || ts < lastRenderTs) return true
  return ts - lastRenderTs >= 1000 / maxFps - slackMs
}

export interface FrameNeeds {
  pressed: boolean
  /** Drawn at the drop point, waiting for main's snap state. */
  dropHold: boolean
  /** A render is wanted but could not run this frame (rate limit). */
  renderDue: boolean
  /** Render time on main's clock (one step behind), ms; null before the first state. */
  renderT: number | null
  /** Time of the newest buffered state, ms. */
  newestStateT: number | null
}

/**
 * When the animation next needs a render (renderer ms): when the animator says its pose changes (`wakeAt`), but not
 * before its frame-rate cap allows the next render after the last one. Null: not until something changes.
 */
export function nextAnimationAt(wakeAt: number | null, lastRenderTs: number | null, fps: number, slackMs: number): number | null {
  if (wakeAt === null) return null
  if (lastRenderTs === null || !(fps > 0)) return wakeAt
  return Math.max(wakeAt, lastRenderTs + 1000 / fps - slackMs)
}

/** True if the hit test's canvas-local point is inside the pet's measured box (main's grab area and safety net use it). */
export function insideBox(local: Point, anchor: Point, box: Box): boolean {
  const x = local.x - anchor.x
  const y = local.y - anchor.y
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
}

/** True if another animation frame is needed; false lets the loop stop until something changes (render on demand, §11). */
export function frameNeeded(needs: FrameNeeds, starveToleranceMs: number): boolean {
  if (needs.pressed || needs.dropHold || needs.renderDue) return true
  // Interpolating: there is a newer state to move toward.
  return needs.renderT !== null && needs.newestStateT !== null && needs.renderT < needs.newestStateT + starveToleranceMs
}

/**
 * Where a released pet is put down: a press that never moved `clickMaxMovePt` or more is a click and leaves the pet
 * where it was (the press-start ground point, as main does; petting is M4); a drag drops it at the current point.
 */
export function dropPoint(press: { startGround: Point; maxMovePt: number }, current: Point, clickMaxMovePt: number): Point {
  return press.maxMovePt < clickMaxMovePt ? { ...press.startGround } : { ...current }
}

/** Right button, or left with control held (macOS): never a press; the contextmenu event that follows opens the menu. */
export function isSecondaryClick(button: number, ctrlKey: boolean): boolean {
  return button === 2 || (button === 0 && ctrlKey)
}

/** True while main's cursor samples are older than the grab area's latest native mouse event (ignore them). */
export function cursorQuiet(lastGrabEventAt: number | null, now: number, quietMs: number): boolean {
  return lastGrabEventAt !== null && now - lastGrabEventAt < quietMs
}

/** Dev check stats: a sample list that keeps at most `cap` values and remembers that it dropped some. */
export class SampleList {
  private readonly values: number[] = []
  private dropped = false

  constructor(private readonly cap: number) {}

  push(value: number): void {
    if (this.values.length >= this.cap) this.dropped = true
    else this.values.push(value)
  }

  get truncated(): boolean {
    return this.dropped
  }

  toArray(): number[] {
    return [...this.values]
  }
}

// ---- The overlay state machine ---------------------------------------------------------------

/** A grab-area mouse event: global pt (MouseEvent.screenX/screenY) and its time on the overlay page's clock, ms. */
export interface GrabMouseEvent {
  screenX: number
  screenY: number
  button: number
  buttons: number
  ctrlKey: boolean
  time: number
}

export interface OverlayModelDeps {
  /** pet.hitTest: is the canvas-local point (CSS px, inside the canvas) over the pet's silhouette? */
  hitTest(x: number, y: number): boolean
  /** The animator: poses the rig for frame time `ts` (renderer ms). Absent: the pet never animates. */
  animate?(input: AnimInput, ts: number): AnimResult
  /** An overlay → main message (window.bitbot.send). */
  send(channel: string, payload: unknown): void
  /** Asks for one animation frame; repeated requests before it runs are one request. */
  requestFrame(): void
  log(level: PetLogMsg['level'], message: string): void
}

export interface OverlayModelOptions {
  /** Pet canvas edge, CSS px (= pt). */
  edge: number
  /** Canvas point where the ground-contact point is drawn (PetScene.anchor). */
  anchor: Point
  devicePixelRatio: number
}

/** What a frame does: overlay.ts applies it in this order. */
export interface FramePlan {
  /** A new canvas transform, or null to keep the current one. */
  transform: string | null
  /** Render the pet with this contact shadow (then report rendered() or renderFailed()), or null to keep the canvas content. */
  render: ContactShadowParams | null
  /** Make the canvas visible (it is placed and was just drawn): once per page load. */
  reveal: boolean
  /** Ask for another frame. */
  again: boolean
  /** No frame needed now, but the animation needs one at this renderer time (ms): set a timer. Null: none. */
  wakeAt: number | null
}

const IDLE_PLAN: Readonly<FramePlan> = { transform: null, render: null, reveal: false, again: false, wakeAt: null }

/** What a state says about the pet besides where it is. */
interface StateLook {
  state: BehaviorState
  mood: Mood
  dust: number
  look: LookDirection | null
  facing: 1 | -1
}

interface BufferedState extends TimedPoint, StateLook {
  supportY: number | null
}

interface Press {
  /** Cursor minus the drawn ground point at the press, pt. */
  readonly localGrab: Point
  readonly startGround: Point
  readonly startMouse: Point
  /** Newest cursor position, global pt. */
  mouse: Point
  /** Farthest the cursor got from startMouse, pt. */
  maxMovePt: number
  /** A snap state arrived during the press: main already released (or cancelled) it and placed the pet itself. */
  snapSeen: boolean
  /** Raw pointer moves came during this press: they drive it, and the frame-aligned mousemoves are left out. */
  raw: boolean
  /** The state the pet showed when pressed: a click (no drag yet) keeps showing it. */
  stateAtStart: BehaviorState
}

interface Placement {
  /** Canvas top-left, overlay-local CSS px, snapped to device pixels. */
  readonly origin: Point
  /** The ground-contact point it draws, global pt. */
  readonly ground: Point
}

/**
 * The overlay page's state between main's messages, the grab area's mouse events and animation frames. Feed it
 * everything (on… methods), run frame() in each animation frame it asks for, and report the renders it plans.
 */
export class OverlayModel {
  private config: PetConfig | null = null
  /** A pet:config-changed that arrived before the pet:config reply; onConfig() adopts it if it is newer. */
  private earlyConfig: PetConfig | null = null
  private epochSeen = 0
  private shown = true
  private states: BufferedState[] = []
  /** Renderer clock minus main's clock, plus the fastest IPC delivery seen: min(arrival − sentAt). */
  private clockOffset = Number.POSITIVE_INFINITY
  /** Support line under the pet from the newest state, global pt. */
  private supportY: number | null = null
  private hover = false
  private press: Press | null = null
  private dropHold: { point: Point; until: number } | null = null
  private lastGrabEventAt: number | null = null
  /** What the canvas shows (hit tests use it); null before the first placement and after a configuration change. */
  private placement: Placement | null = null
  private transform = ''
  private revealed = false
  private renderPending = true
  private renderedShadow: ContactShadowParams = { ...STANDING_SHADOW }
  private lastRenderTs: number | null = null
  private dpr: number
  private contextLost = false
  /** The last render threw: the pet may not be on its canvas (reported as pet:drawn {drawn: false}). */
  private renderBroken = false
  /** Configuration to confirm with pet:drawn {drawn: true} after the next render. */
  private drawnReport: number | null = null
  private lastFrameTs: number | null = null
  /** Time of the newest grab-area mousemove of the press not drawn yet (dev stats). */
  private pendingInputAt: number | null = null
  /** The pet's box (PetReadyMsg.petBox): hit tests outside it never count, whatever an animation draws there. */
  private petBox: Box | null = null
  // Animation (see the header).
  private devFace: FaceOverride | null = null
  private idleMode: IdleMode = tuning.anim.idleMode
  private animInput: AnimInput | null = null
  private animDirty = true
  private animWakeAt: number | null = null
  private animFps: number = tuning.render.fps.moving
  private shadowScale = 1
  private lastLook: StateLook | null = null

  private readonly counters = {
    frames: 0,
    renders: 0,
    starvedFrames: 0,
    longFrames: 0,
    cursorMsgs: 0,
    cursorMsgsIgnored: 0,
    hitTests: 0,
    hoverMsgs: 0,
    pointerMsgs: 0,
    contextLosses: 0,
  }
  private readonly rafIntervals = new SampleList(tuning.overlay.debugSampleCap)
  private readonly inputToFrame = new SampleList(tuning.overlay.debugSampleCap)

  private readonly edge: number
  private readonly anchor: Point

  constructor(
    options: OverlayModelOptions,
    private readonly deps: OverlayModelDeps,
  ) {
    this.edge = options.edge
    this.anchor = { x: options.anchor.x, y: options.anchor.y }
    this.dpr = options.devicePixelRatio
  }

  /** Newest epoch seen: every pet:hover and pet:pointer carries it. */
  get epoch(): number {
    return this.epochSeen
  }

  /** The configuration in use, or null before onConfig(). */
  get configSeq(): number | null {
    return this.config?.configSeq ?? null
  }

  get debug(): boolean {
    return this.config?.debug ?? false
  }

  /** Shown by the user (pet:visible). */
  get visible(): boolean {
    return this.shown
  }

  get hovering(): boolean {
    return this.hover
  }

  get pressed(): boolean {
    return this.press !== null
  }

  // ── main → overlay ──

  /** The pet:config reply. Returns the configuration adopted, or null if it is malformed (then nothing starts). */
  onConfig(raw: unknown): PetConfig | null {
    if (this.config) return this.config
    if (!isPetConfig(raw)) {
      this.deps.log('error', 'malformed pet:config reply; the overlay stays inert')
      return null
    }
    const early = this.earlyConfig
    this.earlyConfig = null
    this.config = early && early.configSeq > raw.configSeq ? withChangeableFields(raw, early) : { ...raw }
    this.adoptEpoch(raw.epoch)
    return this.config
  }

  onState(raw: unknown, arrival: number): void {
    const config = this.config
    if (!config) return // main sends states only after pet:ready
    if (!isPetStateMsg(raw)) {
      this.deps.log('warning', 'malformed pet:state ignored')
      return
    }
    this.clockOffset = Math.min(this.clockOffset, arrival - raw.sentAt)
    if (raw.snap) {
      // A jump (first state, release, shown again, display change): never interpolate from before it.
      this.states = []
      this.dropHold = null
      if (this.press) this.press.snapSeen = true
    }
    const state: BufferedState = {
      t: raw.t,
      x: raw.x,
      y: raw.y,
      supportY: raw.supportY,
      state: raw.state,
      mood: raw.mood,
      dust: raw.dust,
      look: raw.look,
      facing: raw.facing,
    }
    pushTimed(this.states, state, config.stepMs, tuning.overlay.stateBufferSize)
    this.supportY = raw.supportY
    this.requestFrame()
  }

  onCursor(raw: unknown, now: number): void {
    this.counters.cursorMsgs++
    if (!isPetCursorMsg(raw) || !this.config || !this.shown || this.press) {
      this.counters.cursorMsgsIgnored++
      return
    }
    // The grab area's own events are newer than main's sample.
    if (cursorQuiet(this.lastGrabEventAt, now, tuning.overlay.cursorQuietMs)) {
      this.counters.cursorMsgsIgnored++
      return
    }
    this.setHover(this.hitTestGlobal(raw))
  }

  /** Main reset the grab area (new epoch): forget hover and any press (main cancelled it; its snap state places the pet). */
  onHoverReset(raw: unknown): void {
    if (!isPetHoverResetMsg(raw)) {
      this.deps.log('warning', 'malformed pet:hover-reset ignored')
      return
    }
    this.adoptEpoch(raw.epoch)
    this.hover = false
    // Main's next cursor sample is the authority now: the grab area's older events must not make it ignored (main sends
    // just one while the cursor and the pet stay still, so an ignored one would leave a dropped pet unclickable).
    this.lastGrabEventAt = null
    if (this.press) {
      this.press = null
      this.pendingInputAt = null
      this.requestFrame()
    }
  }

  onVisible(raw: unknown): void {
    if (!isPetVisibleMsg(raw)) {
      this.deps.log('warning', 'malformed pet:visible ignored')
      return
    }
    this.adoptEpoch(raw.epoch)
    if (!raw.visible) {
      this.shown = false
      this.hover = false
      this.press = null
      this.dropHold = null
      this.pendingInputAt = null
      this.lastFrameTs = null
      return
    }
    this.shown = true
    this.renderPending = true
    this.animDirty = true
    this.requestFrame()
  }

  /** debug:pet (dev builds): the dev panel's face override and idle style. */
  onDevPet(raw: unknown): void {
    if (!isDevPetMsg(raw)) {
      this.deps.log('warning', 'malformed debug:pet ignored')
      return
    }
    this.devFace = raw.face
    this.idleMode = raw.idleMode
    this.animDirty = true
    this.requestFrame()
  }

  /** The pet's measured box (relative to the ground-contact point, pt), as sent in pet:ready. */
  setPetBox(box: Box): void {
    this.petBox = { ...box }
  }

  /** Display change or the pet's area became known: adopt it, redraw, then confirm with pet:drawn. */
  onConfigChanged(raw: unknown): void {
    if (!isPetConfig(raw)) {
      this.deps.log('warning', 'malformed pet:config-changed ignored')
      return
    }
    this.adoptEpoch(raw.epoch)
    const config = this.config
    if (!config) {
      if (!this.earlyConfig || raw.configSeq > this.earlyConfig.configSeq) this.earlyConfig = raw
      return
    }
    if (raw.configSeq < config.configSeq) return
    if (raw.hitWindowName !== config.hitWindowName) {
      this.deps.log('warning', 'pet:config-changed names another grab area; keeping this one')
    }
    this.config = withChangeableFields(config, raw)
    // Hit tests wait until the canvas is placed for the new overlay origin.
    this.placement = null
    this.renderPending = true
    this.drawnReport = raw.configSeq
    this.requestFrame()
  }

  /** GPU process restart, wake, unlock, pixel ratio change: draw again even though nothing changed. */
  onRedraw(): void {
    this.renderPending = true
    this.animDirty = true
    this.requestFrame()
  }

  onContextLost(): void {
    this.counters.contextLosses++
    this.contextLost = true
    if (this.config) this.deps.send(IPC.petDrawn, { drawn: false, configSeq: this.config.configSeq } satisfies PetDrawnMsg)
  }

  onContextRestored(): void {
    this.contextLost = false
    this.renderPending = true
    if (this.config) this.drawnReport = this.config.configSeq
    this.requestFrame()
  }

  // ── the grab area ──

  /** The grab area's (frame-aligned) mousemove: hover, and a press that gets no raw moves. */
  onGrabMove(e: GrabMouseEvent, now: number): void {
    this.lastGrabEventAt = now
    const press = this.press
    if (!press) {
      this.setHover(this.hitTestGlobal({ x: e.screenX, y: e.screenY }))
      return
    }
    if (!press.raw) this.pressMove(press, e, now)
  }

  /**
   * The grab area's raw pointer move (pointerrawupdate: dispatched as soon as it arrives, not with a frame). It drives
   * a press; hover stays on the frame-aligned mousemove, which costs at most one hit test per frame.
   */
  onGrabRawMove(e: GrabMouseEvent, now: number): void {
    this.lastGrabEventAt = now
    const press = this.press
    if (!press) return
    press.raw = true
    this.pressMove(press, e, now)
  }

  onGrabDown(e: GrabMouseEvent, now: number): void {
    this.lastGrabEventAt = now
    if (this.press || !this.config || !this.shown) return
    // Right or control click: no press; the contextmenu event follows. Other buttons do nothing.
    if (isSecondaryClick(e.button, e.ctrlKey) || e.button !== 0) return
    const point = { x: e.screenX, y: e.screenY }
    const placement = this.placement
    if (!placement || !this.hitTestGlobal(point)) {
      this.setHover(false)
      return
    }
    this.setHover(true)
    const ground = placement.ground
    this.press = {
      localGrab: { x: point.x - ground.x, y: point.y - ground.y },
      startGround: { ...ground },
      startMouse: point,
      mouse: point,
      maxMovePt: 0,
      snapSeen: false,
      raw: false,
      stateAtStart: this.lastLook?.state ?? 'idle',
    }
    this.dropHold = null
    this.sendPointer({
      kind: 'down',
      button: 0,
      screenX: point.x,
      screenY: point.y,
      groundX: ground.x,
      groundY: ground.y,
      epoch: this.epochSeen,
    })
    this.requestFrame()
  }

  onGrabUp(e: GrabMouseEvent, now: number): void {
    // Only an up that ends a press is newer news than main's samples; a stray one (after a hover-reset) is not.
    if (!this.press) return
    this.lastGrabEventAt = now
    if (e.button === 0) this.release({ x: e.screenX, y: e.screenY }, now)
  }

  onGrabContextMenu(e: GrabMouseEvent, now: number): void {
    this.lastGrabEventAt = now
    if (this.press || !this.config || !this.shown) return
    const point = { x: e.screenX, y: e.screenY }
    const over = this.hitTestGlobal(point)
    this.setHover(over)
    if (over) this.sendPointer({ kind: 'contextmenu', screenX: point.x, screenY: point.y, epoch: this.epochSeen })
  }

  onGrabLeave(now: number): void {
    this.lastGrabEventAt = now
    this.setHover(false)
  }

  // ── frames ──

  /** One animation frame: `ts` its timestamp, `now` performance.now() in it (ms), the window's current pixel ratio. */
  frame(ts: number, now: number, devicePixelRatio: number): FramePlan {
    this.counters.frames++
    const config = this.config
    if (!config || !this.shown) {
      this.lastFrameTs = null
      return { ...IDLE_PLAN }
    }
    // Intervals only between frames of one run: after the loop stopped, the next frame's gap is idle time.
    if (this.lastFrameTs !== null) {
      const interval = ts - this.lastFrameTs
      if (interval > tuning.overlay.longFrameMs) this.counters.longFrames++
      if (config.debug) this.rafIntervals.push(interval)
    }
    if (Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 && devicePixelRatio !== this.dpr) {
      this.dpr = devicePixelRatio
      this.renderPending = true
    }

    const renderT = Number.isFinite(this.clockOffset) ? ts - this.clockOffset - config.stepMs : null
    const ground = this.groundAt(ts, renderT)
    let transform: string | null = null
    let shadow = this.renderedShadow
    // The first placement also renders, so the canvas is never revealed with content the compositor may have dropped.
    const revealNow = !this.revealed && ground !== null
    if (ground) {
      const origin = canvasOrigin(ground, config.overlay, this.anchor, this.dpr)
      this.placement = { origin, ground }
      const next = canvasTransform(origin)
      if (next !== this.transform) {
        this.transform = next
        transform = next
      }
    }
    const slackMs = tuning.overlay.renderIntervalSlackMs
    this.animateIfDue(ts, renderT, slackMs)
    if (ground) {
      shadow = scaledShadow(contactShadowFor(this.supportY, ground.y, tuning.overlay.shadowFadePt), this.shadowScale)
      if (revealNow || !sameShadow(shadow, this.renderedShadow)) this.renderPending = true
    }

    const canRender = this.renderPending && !this.contextLost
    const allowed = renderAllowed(this.lastRenderTs, ts, tuning.render.fps.moving, slackMs)
    const render = canRender && allowed ? { ...shadow } : null
    const reveal = revealNow && render !== null
    if (reveal) this.revealed = true

    if (this.press && this.pendingInputAt !== null) {
      const latency = now - this.pendingInputAt
      if (Number.isFinite(latency) && latency >= 0) this.inputToFrame.push(latency)
    }
    this.pendingInputAt = null

    const newest = this.states[this.states.length - 1]
    const needs: FrameNeeds = {
      pressed: this.press !== null,
      dropHold: this.dropHold !== null,
      renderDue: canRender && render === null,
      renderT,
      newestStateT: newest?.t ?? null,
    }
    let again = frameNeeded(needs, tuning.overlay.starveToleranceMs)
    // The animation's next render: another frame if it falls before the one after this, else a timer.
    const renderTs = render ? ts : this.lastRenderTs
    const animating = this.deps.animate !== undefined && this.states.length > 0 && !this.contextLost
    const nextAnim = !animating
      ? null
      : this.animDirty
        ? nextAnimationAt(ts, renderTs, this.animFps, slackMs)
        : nextAnimationAt(this.animWakeAt, renderTs, this.animFps, slackMs)
    if (!again && nextAnim !== null && nextAnim <= ts + FRAME_MS) again = true
    const wakeAt = !again && nextAnim !== null ? nextAnim : null
    this.lastFrameTs = again ? ts : null
    return { transform, render, reveal, again, wakeAt }
  }

  /** The planned render ran (`ts` its frame's timestamp; null outside the frame loop, e.g. the first frame). */
  rendered(ts: number | null, shadow: ContactShadowParams): void {
    this.counters.renders++
    if (ts !== null) this.lastRenderTs = ts
    this.renderedShadow = { ...shadow }
    this.renderPending = false
    this.renderBroken = false
    const configSeq = this.drawnReport
    this.drawnReport = null
    if (configSeq !== null && !this.contextLost) this.deps.send(IPC.petDrawn, { drawn: true, configSeq } satisfies PetDrawnMsg)
  }

  /**
   * The planned render threw. The pet may be missing from its canvas, so main hears pet:drawn {drawn: false} (once)
   * and hit tests stay off until a render succeeds. The render is dropped rather than retried every frame: the next
   * visible change tries again.
   */
  renderFailed(): void {
    this.renderPending = false
    const config = this.config
    if (!config) return
    if (!this.renderBroken) this.deps.send(IPC.petDrawn, { drawn: false, configSeq: config.configSeq } satisfies PetDrawnMsg)
    this.renderBroken = true
    this.drawnReport = config.configSeq
  }

  /** debug:overlay-stats payload: counters since the page loaded, samples while config.debug was on. */
  stats(now: number): OverlayStatsMsg {
    return {
      at: now,
      ...this.counters,
      rafIntervalsMs: this.rafIntervals.toArray(),
      inputToFrameMs: this.inputToFrame.toArray(),
      truncated: this.rafIntervals.truncated || this.inputToFrame.truncated,
    }
  }

  // ── internals ──

  /**
   * Gives the animator this frame's input and lets it pose the rig when the pose is due (its wake time came, or the
   * input changed) and its frame-rate cap allows a render; a change of input is shown at once.
   */
  private animateIfDue(ts: number, renderT: number | null, slackMs: number): void {
    const animate = this.deps.animate
    const look = this.stateLookAt(renderT)
    if (!animate || !look || this.contextLost) return
    this.lastLook = look
    const press = this.press
    const dragging = press !== null && press.maxMovePt >= tuning.hitArea.clickMaxMovePt
    const input: AnimInput = {
      state: press ? (dragging ? 'held' : press.stateAtStart) : look.state,
      mood: look.mood,
      dust: look.dust,
      look: look.look,
      facing: look.facing,
      held: press && dragging ? { grabX: press.localGrab.x, grabY: press.localGrab.y, mouseX: press.mouse.x } : null,
      faceOverride: this.devFace,
      idleMode: this.idleMode,
    }
    const changed = this.animInput === null || !sameAnimInput(input, this.animInput)
    if (changed) this.animDirty = true
    const due = this.animDirty || (this.animWakeAt !== null && ts + FRAME_MS / 2 >= this.animWakeAt)
    const fps = changed ? tuning.render.fps.moving : this.animFps
    if (!due || !renderAllowed(this.lastRenderTs, ts, fps, slackMs)) return
    const result = animate(input, ts)
    this.animInput = input
    this.animDirty = false
    this.animWakeAt = result.wakeAt
    this.animFps = result.fps
    this.shadowScale = result.shadowScale
    if (result.changed) this.renderPending = true
  }

  /** What the pet is doing at render time `renderT`: the newest state at or before it (else the oldest); null: none yet. */
  private stateLookAt(renderT: number | null): StateLook | null {
    const states = this.states
    if (states.length === 0) return null
    let pick = states[0] as BufferedState
    if (renderT === null) pick = states[states.length - 1] as BufferedState
    else for (const s of states) if (s.t <= renderT + tuning.overlay.starveToleranceMs) pick = s
    return { state: pick.state, mood: pick.mood, dust: pick.dust, look: pick.look, facing: pick.facing }
  }

  private groundAt(ts: number, renderT: number | null): Point | null {
    const config = this.config
    if (!config) return null
    if (this.press) return heldGroundPoint(this.press.mouse, this.press.localGrab, config.area)
    if (this.dropHold) {
      if (ts < this.dropHold.until) return { ...this.dropHold.point }
      this.dropHold = null
    }
    if (renderT === null) return null
    const sample = sampleBuffer(this.states, renderT, tuning.overlay.starveToleranceMs)
    if (!sample) return null
    if (sample.starved) this.counters.starvedFrames++
    return { x: sample.x, y: sample.y }
  }

  /** A move during a press: the pet follows the mouse; a move without the left button is a lost mouseup. */
  private pressMove(press: Press, e: GrabMouseEvent, now: number): void {
    const point = { x: e.screenX, y: e.screenY }
    if ((e.buttons & 1) === 0) {
      this.release(point, now) // its mouseup went missing
      return
    }
    press.mouse = point
    press.maxMovePt = Math.max(press.maxMovePt, distance(point, press.startMouse))
    if (this.debug) this.pendingInputAt = e.time
    this.requestFrame()
  }

  private release(point: Point, now: number): void {
    const press = this.press
    const config = this.config
    if (!press || !config) return
    this.press = null
    this.pendingInputAt = null
    press.maxMovePt = Math.max(press.maxMovePt, distance(point, press.startMouse))
    this.sendPointer({ kind: 'up', button: 0, screenX: point.x, screenY: point.y, epoch: this.epochSeen })
    // Hold the pet where it is let go until main's snap state places it, unless main already did (it saw the native
    // mouseup first and its snap state overtook this event).
    if (!press.snapSeen) {
      const current = heldGroundPoint(point, press.localGrab, config.area)
      this.dropHold = { point: dropPoint(press, current, tuning.hitArea.clickMaxMovePt), until: now + tuning.overlay.dropHoldMs }
    }
    this.setHover(this.hitTestGlobal(point))
    this.requestFrame()
  }

  /** Global pt → overlay-local → canvas-local → pet.hitTest. False until the pet is drawn for this configuration. */
  private hitTestGlobal(p: Point): boolean {
    this.counters.hitTests++
    const config = this.config
    const placement = this.placement
    if (!config || !placement || !this.revealed || !this.shown || this.contextLost || this.renderBroken) return false
    const local = canvasLocalPoint(p, config.overlay, placement.origin)
    if (!insideCanvas(local, this.edge)) return false
    // An animation may draw the pet beyond the box main sizes the grab area and the safety net with (a jump, a
    // tumble): those parts are not grabbable, so the two never disagree about where the pet is.
    if (this.petBox && !insideBox(local, this.anchor, this.petBox)) return false
    return this.deps.hitTest(local.x, local.y)
  }

  private setHover(over: boolean): void {
    // Never hover:false while pressed: main would switch the grab area back to click-through mid-drag.
    if (over === this.hover || (!over && this.press)) return
    this.hover = over
    this.counters.hoverMsgs++
    this.deps.send(IPC.petHover, { over, epoch: this.epochSeen } satisfies PetHoverMsg)
  }

  private sendPointer(msg: PetPointerMsg): void {
    this.counters.pointerMsgs++
    this.deps.send(IPC.petPointer, msg)
  }

  private adoptEpoch(epoch: number): void {
    if (epoch > this.epochSeen) this.epochSeen = epoch
  }

  private requestFrame(): void {
    if (this.config && this.shown) this.deps.requestFrame()
  }
}

/** One display frame at tuning.render.fps.moving, ms. */
const FRAME_MS = 1000 / tuning.render.fps.moving

/** The contact shadow with its strength scaled (an animation lifting the pet off its surface). */
function scaledShadow(shadow: ContactShadowParams, scale: number): ContactShadowParams {
  if (scale >= 1) return shadow
  const strength = shadow.strength * Math.max(0, scale)
  return strength > 0 ? { elevationPt: shadow.elevationPt, strength } : { elevationPt: 0, strength: 0 }
}

function sameAnimInput(a: AnimInput, b: AnimInput): boolean {
  return (
    a.state === b.state &&
    a.mood === b.mood &&
    a.dust === b.dust &&
    a.look === b.look &&
    a.facing === b.facing &&
    a.idleMode === b.idleMode &&
    a.faceOverride === b.faceOverride &&
    a.held?.grabX === b.held?.grabX &&
    a.held?.grabY === b.held?.grabY &&
    a.held?.mouseX === b.held?.mouseX
  )
}

/** `base` with the fields a pet:config-changed may change taken from `next` (size, palette, step and grab area stay). */
function withChangeableFields(base: PetConfig, next: PetConfig): PetConfig {
  return {
    ...base,
    configSeq: next.configSeq,
    overlay: { ...next.overlay },
    area: next.area ? { ...next.area } : null,
    epoch: Math.max(base.epoch, next.epoch),
    debug: next.debug,
  }
}
