import { Box3, Vector3 } from 'three'
import { IPC, type PetHoverMsg, type PetPointerMsg } from '../../../shared/ipc'
import {
  SPIKE_OVERLAY_IPC,
  isOverlayStateMsg,
  sampleBuffer,
  type OverlayConfig,
  type OverlayFrameMsg,
  type OverlayLogMsg,
  type OverlayReadyMsg,
  type OverlayRendererStats,
  type OverlayStateMsg,
} from '../../../shared/spikeOverlay'
import { tuning } from '../../../shared/tuning'
import type { PetScene } from '../../pet/scene'
import { Series } from './series'

// Renderer half of the Spike A harness (BITBOT_SPEC.md §12, §5.2). Renders every rAF (no adaptive
// throttling: comparable worst-case numbers), eases the yaw toward the walking direction, hit-tests
// forwarded mouse moves, and for B/Bfull places the pet itself from interpolated sim states:
//   'window'     A1/A2 — the canvas fills the small window; main moves the window.
//   'canvas'     B     — small canvas moved with translate3d (will-change: transform).
//   'fullscreen' Bfull — display-sized canvas; the pet is placed with camera.setViewOffset so its
//                        perspective is identical to the small viewport.

const T = tuning.spikeOverlay
type Layout = 'window' | 'canvas' | 'fullscreen'
interface Pt {
  x: number
  y: number
}

export function reportToMain(level: OverlayLogMsg['level'], message: string): void {
  try {
    window.bitbot.send(SPIKE_OVERLAY_IPC.log, { level, message } satisfies OverlayLogMsg)
  } catch {
    // Bridge unavailable: nothing else to tell.
  }
}

export class SpikeRenderer {
  private readonly layout: Layout
  private readonly canvas: HTMLCanvasElement
  private readonly dpr = window.devicePixelRatio || 1
  private states: OverlayStateMsg[] = []
  /** Renderer clock minus main clock (+ the fastest IPC delivery seen), from state send times. */
  private clockOffset = Number.POSITIVE_INFINITY
  private yaw = tuning.render.defaultYaw
  /** Page position of the pet viewport's top-left (B/Bfull), once placed. */
  private origin: Pt | null = null
  /** Ground-contact point currently drawn, global pt (B/Bfull). */
  private ground: Pt | null = null
  private lastTransform = ''
  private hoverOver = false
  private pressed = false
  /** B/Bfull drag: cursor minus ground point (global pt) while held — follows the mouse at frame rate. */
  private localGrab: Pt | null = null
  /** B/Bfull: after release, hold the last dragged position until main's snap state arrives. */
  private awaitingSnap: (Pt & { until: number }) | null = null
  private lastMouse: Pt | null = null
  private lastRafTs: number | null = null
  private frameSeq = 0

  private measureStartAt = performance.now()
  private frames = 0
  private starved = 0
  private stateMsgs = 0
  private mousemoves = 0
  private hitTests = 0
  private hoverMsgsSent = 0
  private readonly rafIntervals = new Series(T.rawSampleCap)
  private readonly callbackMs = new Series(T.rawSampleCap)
  private readonly renderMs = new Series(T.rawSampleCap)

  constructor(
    private readonly pet: PetScene,
    private readonly config: OverlayConfig,
    /** null = render every rAF; N > 0 = wake only every 1/N s; 0 = draw once, then no frame loop. */
    private readonly renderFps: number | null = null,
  ) {
    this.layout = config.variant === 'B' ? 'canvas' : config.variant === 'Bfull' ? 'fullscreen' : 'window'
    this.canvas = pet.renderer.domElement
  }

  start(): void {
    const petBox = this.measurePetBox()
    if (this.layout !== 'window') this.canvas.style.visibility = 'hidden' // until the first state places it
    if (this.layout === 'canvas') this.canvas.style.willChange = 'transform'
    if (this.layout === 'fullscreen') this.pet.renderer.setSize(this.config.window.width, this.config.window.height, true)

    const bridge = window.bitbot
    bridge.on(SPIKE_OVERLAY_IPC.state, (msg) => this.onState(msg))
    bridge.on(SPIKE_OVERLAY_IPC.measureStart, () => this.resetStats())
    bridge.on(SPIKE_OVERLAY_IPC.statsRequest, () => this.sendStats())
    bridge.on(SPIKE_OVERLAY_IPC.hoverReset, () => {
      this.hoverOver = false
    })
    this.attachPointer()

    this.pet.rig.root.rotation.y = this.yaw
    this.pet.render()
    const ready: OverlayReadyMsg = {
      anchor: { x: this.pet.anchor.x, y: this.pet.anchor.y },
      petBox,
      devicePixelRatio: this.dpr,
      canvas: { width: this.canvas.clientWidth, height: this.canvas.clientHeight },
      glRenderer: this.glRenderer(),
    }
    bridge.send(SPIKE_OVERLAY_IPC.ready, ready)
    requestAnimationFrame(this.frame)
  }

  // ── frame loop ─────────────────────────────────────────────────────────────────────────────

  private readonly frame = (ts: number): void => {
    const start = performance.now()
    const dtS = this.lastRafTs === null ? 0 : Math.min(T.maxEaseDtS, Math.max(0, (ts - this.lastRafTs) / 1000))
    if (this.lastRafTs !== null) this.rafIntervals.push(ts - this.lastRafTs)
    this.lastRafTs = ts
    this.frames++
    // A2: tell main first, so the window move lands as early as possible in this frame.
    if (this.config.variant === 'A2') {
      window.bitbot.send(SPIKE_OVERLAY_IPC.frame, { seq: ++this.frameSeq, t: ts } satisfies OverlayFrameMsg)
    }
    if (this.layout !== 'window') this.place(ts)

    const facing = this.states[this.states.length - 1]?.facing ?? 1
    const targetYaw = facing * tuning.render.defaultYaw
    this.yaw += (targetYaw - this.yaw) * (1 - Math.exp(-T.facingEaseRate * dtS))
    this.pet.rig.root.rotation.y = this.yaw

    const r0 = performance.now()
    this.pet.render()
    const r1 = performance.now()
    this.renderMs.push(r1 - r0)
    this.callbackMs.push(r1 - start)
    this.scheduleNext(start)
  }

  /** Every rAF by default; with a renderFps cap, sleep in a timer and wake for the vsync after it. */
  private scheduleNext(frameStartedAt: number): void {
    const fps = this.renderFps
    if (fps === null) {
      requestAnimationFrame(this.frame)
      return
    }
    if (fps <= 0) return // drew once: no frame loop at all (idle baseline)
    // Ask for the rAF ~half a frame before the next due time so it lands on the right vsync. Measured
    // from performance.now() at the callback's start, not from the rAF timestamp: Chromium's timestamp
    // lags the callback by about a frame, which made a 30 fps cap render at 60 and 15 at 20.
    const delay = Math.max(0, frameStartedAt + 1000 / fps - performance.now() - 8)
    setTimeout(() => requestAnimationFrame(this.frame), delay)
  }

  /** B/Bfull: put the pet where the (interpolated or dragged) ground point is. */
  private place(ts: number): void {
    const win = this.config.window
    let g: Pt | null = null
    if (this.localGrab && this.lastMouse) {
      g = { x: this.lastMouse.x + win.x - this.localGrab.x, y: this.lastMouse.y + win.y - this.localGrab.y }
    } else if (this.awaitingSnap && performance.now() < this.awaitingSnap.until) {
      g = { x: this.awaitingSnap.x, y: this.awaitingSnap.y }
    } else {
      this.awaitingSnap = null
      // One sim step behind main's clock (same rule as A1/A2 in main).
      const sample = sampleBuffer(this.states, ts - this.clockOffset - this.config.stepMs)
      if (!sample) return
      if (sample.starved) this.starved++
      g = sample
    }
    this.ground = { x: g.x, y: g.y }
    let px = g.x - win.x - this.pet.anchor.x
    let py = g.y - win.y - this.pet.anchor.y
    if (this.layout === 'canvas') {
      // Snap to device pixels so the canvas texture is never resampled (sharp at any position).
      px = Math.round(px * this.dpr) / this.dpr
      py = Math.round(py * this.dpr) / this.dpr
      const transform = `translate3d(${px}px, ${py}px, 0)`
      if (transform !== this.lastTransform) {
        this.canvas.style.transform = transform
        this.lastTransform = transform
      }
    } else {
      this.pet.camera.setViewOffset(this.pet.width, this.pet.height, -px, -py, win.width, win.height)
    }
    this.origin = { x: px, y: py }
    if (this.canvas.style.visibility === 'hidden') this.canvas.style.visibility = 'visible'
  }

  private onState(raw: unknown): void {
    if (!isOverlayStateMsg(raw)) return
    const arrival = performance.now()
    this.stateMsgs++
    const offset = arrival - raw.sentAt
    if (offset < this.clockOffset) this.clockOffset = offset
    if (raw.snap) {
      this.states = [raw]
      this.awaitingSnap = null
    } else {
      this.states.push(raw)
      if (this.states.length > T.stateBufferSize) this.states.shift()
    }
  }

  // ── pointer ────────────────────────────────────────────────────────────────────────────────

  private attachPointer(): void {
    window.addEventListener('mousemove', (e) => this.onMouseMove(e), { passive: true })
    window.addEventListener('mousedown', (e) => this.onMouseDown(e))
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0 && this.pressed) this.endPress(e)
    })
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.hitTest(e.clientX, e.clientY)) this.sendPointer({ kind: 'contextmenu', screenX: e.screenX, screenY: e.screenY })
    })
    document.documentElement.addEventListener('mouseleave', () => {
      if (!this.pressed) this.setHover(false)
    })
  }

  private onMouseMove(e: MouseEvent): void {
    this.mousemoves++
    this.lastMouse = { x: e.clientX, y: e.clientY }
    if (this.pressed) {
      if ((e.buttons & 1) === 0) this.endPress(e) // the mouseup went missing
      return
    }
    this.setHover(this.hitTest(e.clientX, e.clientY))
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0 && e.button !== 2) return
    if (!this.hitTest(e.clientX, e.clientY)) return
    this.setHover(true)
    if (e.button !== 0) return // right button: the contextmenu event follows
    e.preventDefault()
    this.pressed = true
    this.lastMouse = { x: e.clientX, y: e.clientY }
    if (this.config.interactive && this.layout !== 'window' && this.ground) {
      const win = this.config.window
      this.localGrab = { x: e.clientX + win.x - this.ground.x, y: e.clientY + win.y - this.ground.y }
    }
    this.sendPointer({ kind: 'down', button: 0, screenX: e.screenX, screenY: e.screenY })
  }

  private endPress(e: MouseEvent): void {
    this.pressed = false
    if (this.localGrab && this.ground) this.awaitingSnap = { x: this.ground.x, y: this.ground.y, until: performance.now() + T.dropHoldMs }
    this.localGrab = null
    this.sendPointer({ kind: 'up', button: 0, screenX: e.screenX, screenY: e.screenY })
    this.setHover(this.hitTest(e.clientX, e.clientY))
  }

  private sendPointer(msg: PetPointerMsg): void {
    window.bitbot.send(IPC.petPointer, msg)
  }

  private setHover(over: boolean): void {
    if (over === this.hoverOver) return
    this.hoverOver = over
    this.hoverMsgsSent++
    window.bitbot.send(IPC.petHover, { over } satisfies PetHoverMsg)
  }

  /** Page point (CSS px) → is it over the pet? */
  private hitTest(clientX: number, clientY: number): boolean {
    this.hitTests++
    if (this.layout === 'window') return this.pet.hitTest(clientX, clientY)
    const o = this.origin
    if (!o) return false
    const vx = clientX - o.x
    const vy = clientY - o.y
    if (vx < 0 || vy < 0 || vx >= this.pet.width || vy >= this.pet.height) return false
    if (this.layout === 'canvas') return this.pet.hitTest(vx, vy)
    // Bfull: pet.hitTest assumes the plain viewport camera, so lift the view offset around it.
    const cam = this.pet.camera
    cam.clearViewOffset()
    const hit = this.pet.hitTest(vx, vy)
    cam.setViewOffset(this.pet.width, this.pet.height, -o.x, -o.y, this.config.window.width, this.config.window.height)
    return hit
  }

  // ── stats and setup helpers ───────────────────────────────────────────────────────────────

  private resetStats(): void {
    this.measureStartAt = performance.now()
    this.frames = 0
    this.starved = 0
    this.stateMsgs = 0
    this.mousemoves = 0
    this.hitTests = 0
    this.hoverMsgsSent = 0
    this.rafIntervals.reset()
    this.callbackMs.reset()
    this.renderMs.reset()
    this.lastRafTs = null
  }

  private sendStats(): void {
    const stats: OverlayRendererStats = {
      measuredMs: performance.now() - this.measureStartAt,
      frames: this.frames,
      rafIntervalsMs: this.rafIntervals.toArray(),
      callbackMs: this.callbackMs.toArray(),
      renderMs: this.renderMs.toArray(),
      starvedFrames: this.starved,
      stateMsgs: this.stateMsgs,
      mousemoves: this.mousemoves,
      hitTests: this.hitTests,
      hoverMsgsSent: this.hoverMsgsSent,
      truncated: this.rafIntervals.dropped + this.callbackMs.dropped + this.renderMs.dropped > 0,
    }
    window.bitbot.send(SPIKE_OVERLAY_IPC.stats, stats)
  }

  /**
   * The pet's projected box (viewport px) relative to the anchor, as the union over both facings,
   * from the rig's bounding box. Main uses it for the click-through safety net.
   */
  private measurePetBox(): OverlayReadyMsg['petBox'] {
    const { rig, camera, anchor, width, height } = this.pet
    const root = rig.root
    const savedYaw = root.rotation.y
    const box = new Box3()
    const v = new Vector3()
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    camera.updateMatrixWorld()
    for (const yaw of [tuning.render.defaultYaw, -tuning.render.defaultYaw]) {
      root.rotation.y = yaw
      root.updateMatrixWorld(true)
      box.setFromObject(root)
      if (box.isEmpty()) continue
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera)
        const px = ((v.x + 1) / 2) * width
        const py = ((1 - v.y) / 2) * height
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
        minY = Math.min(minY, py)
        maxY = Math.max(maxY, py)
      }
    }
    root.rotation.y = savedYaw
    root.updateMatrixWorld(true)
    if (!Number.isFinite(minX)) {
      reportToMain('warning', 'pet bounding box is empty; using the whole viewport for the safety net')
      return { left: -anchor.x, top: -anchor.y, right: width - anchor.x, bottom: height - anchor.y }
    }
    return { left: minX - anchor.x, top: minY - anchor.y, right: maxX - anchor.x, bottom: maxY - anchor.y }
  }

  private glRenderer(): string | null {
    try {
      const gl = this.pet.renderer.getContext()
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      const value: unknown = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
      return typeof value === 'string' ? value : null
    } catch {
      return null
    }
  }
}
