import { describe, expect, it } from 'vitest'
import type { Point } from '../src/shared/geometry'
import { IPC } from '../src/shared/ipc'
import {
  hitWindowName,
  isOverlayStatsMsg,
  isPetDrawnMsg,
  isPetHoverMsg,
  isPetPointerMsg,
  type PetConfig,
  type PetPointerMsg,
  type PetStateMsg,
} from '../src/shared/petProtocol'
import { tuning } from '../src/shared/tuning'
import {
  OverlayModel,
  SampleList,
  STANDING_SHADOW,
  canvasLocalPoint,
  canvasOrigin,
  canvasTransform,
  contactShadowFor,
  cursorQuiet,
  dropPoint,
  frameNeeded,
  heldGroundPoint,
  insideCanvas,
  isSecondaryClick,
  renderAllowed,
  sameShadow,
  snapToDevicePixels,
  type FramePlan,
  type GrabMouseEvent,
} from '../src/renderer/pet/placement'

// The overlay renderer's decisions (src/renderer/pet/placement.ts): the placement rules one by one, then the
// OverlayModel state machine driven the way overlay.ts drives it, with a fake pet whose silhouette is a box.

const O = tuning.overlay
const STEP = 1000 / 30
const GROUND = 1000
const CONFIG: PetConfig = {
  configSeq: 1,
  // Not at the origin, so a missing "− overlay origin" shows.
  overlay: { x: 100, y: 40, width: 1600, height: 1000 },
  area: { minX: 160, maxX: 1640, minY: 170, groundY: GROUND },
  stepMs: STEP,
  size: 'M',
  paletteId: 'mint',
  hitWindowName: hitWindowName(1),
  epoch: 3,
  debug: false,
}
const EDGE = 240
const ANCHOR = { x: 120, y: 180 }
/** The fake pet's silhouette in canvas-local CSS px: a box standing on the anchor row. */
const PET = { left: 80, top: 60, right: 160, bottom: 180 }
/** Renderer clock − main clock, ms. */
const SHIFT = 5000
const LATENCY = 1

// With the pet standing at (800, GROUND) the canvas is at (580, 780) overlay-local, so:
const ON_PET = { x: 800, y: 950 } // canvas-local (120, 130): over the silhouette
const BESIDE_PET = { x: 880, y: 950 } // canvas-local (200, 130): on the canvas, not on the pet
const OFF_CANVAS = { x: 980, y: 950 } // canvas-local (300, 130)

interface Sent {
  channel: string
  payload: unknown
}

const GUARDS: Record<string, (value: unknown) => boolean> = {
  [IPC.petHover]: isPetHoverMsg,
  [IPC.petPointer]: isPetPointerMsg,
  [IPC.petDrawn]: isPetDrawnMsg,
}

function grabEvent(x: number, y: number, more: Partial<GrabMouseEvent> = {}): GrabMouseEvent {
  return { screenX: x, screenY: y, button: 0, buttons: 0, ctrlKey: false, time: 0, ...more }
}

/** Drives an OverlayModel like overlay.ts: every message it sends must pass the protocol's validators. */
class Driver {
  readonly sent: Sent[] = []
  readonly logs: { level: string; message: string }[] = []
  readonly hitTests: Point[] = []
  frameRequests = 0
  dpr: number
  readonly model: OverlayModel
  private seq = 0

  constructor(options: { dpr?: number; config?: Partial<PetConfig>; start?: boolean } = {}) {
    this.dpr = options.dpr ?? 2
    this.model = new OverlayModel(
      { edge: EDGE, anchor: ANCHOR, devicePixelRatio: this.dpr },
      {
        hitTest: (x, y) => {
          this.hitTests.push({ x, y })
          return x >= PET.left && x <= PET.right && y >= PET.top && y <= PET.bottom
        },
        send: (channel, payload) => {
          const guard = GUARDS[channel]
          if (!guard) throw new Error(`unexpected channel ${channel}`)
          if (!guard(payload)) throw new Error(`malformed ${channel}: ${JSON.stringify(payload)}`)
          this.sent.push({ channel, payload })
        },
        requestFrame: () => {
          this.frameRequests++
        },
        log: (level, message) => this.logs.push({ level, message }),
      },
    )
    if (options.start !== false) this.start(options.config)
  }

  /** The pet:config reply and the first frame, which overlay.ts renders before pet:ready. */
  start(config: Partial<PetConfig> = {}): void {
    expect(this.model.onConfig({ ...CONFIG, ...config })).not.toBeNull()
    this.model.rendered(null, STANDING_SHADOW)
  }

  /** A state at main time `t`, sent then and arriving `latency` ms later. */
  state(t: number, x: number, y = GROUND, more: Partial<PetStateMsg> = {}, latency = LATENCY): void {
    const msg: PetStateMsg = { seq: ++this.seq, t, sentAt: t, x, y, facing: 1, state: 'idle', mood: 'content', dust: 0, look: null, supportY: GROUND, snap: false, ...more }
    this.model.onState(msg, t + SHIFT + latency)
  }

  /** The frame timestamp whose render time (one step behind main) is main time `t`. */
  static at(t: number): number {
    return t + SHIFT + LATENCY + STEP
  }

  /** One frame at `ts`, reporting its render as done. */
  frame(ts: number): FramePlan {
    const plan = this.model.frame(ts, ts, this.dpr)
    if (plan.render) this.model.rendered(ts, plan.render)
    return plan
  }

  /** Frames every `interval` ms from `ts` for as long as the model asks for them. */
  run(ts: number, interval = 1000 / 60, max = 1000): FramePlan[] {
    const plans: FramePlan[] = []
    for (let i = 0, t = ts; i < max; i++, t += interval) {
      const plan = this.frame(t)
      plans.push(plan)
      if (!plan.again) return plans
    }
    throw new Error('the frame loop never stopped')
  }

  move(p: Point, at: number, buttons = 0): void {
    this.model.onGrabMove(grabEvent(p.x, p.y, { buttons, time: at }), at)
  }

  /** A pointerrawupdate (button −1 on a move, as PointerEvent reports it). */
  rawMove(p: Point, at: number, buttons = 0): void {
    this.model.onGrabRawMove(grabEvent(p.x, p.y, { button: -1, buttons, time: at }), at)
  }

  down(p: Point, at: number, more: Partial<GrabMouseEvent> = {}): void {
    this.model.onGrabDown(grabEvent(p.x, p.y, { buttons: 1, time: at, ...more }), at)
  }

  up(p: Point, at: number, button = 0): void {
    this.model.onGrabUp(grabEvent(p.x, p.y, { button, time: at }), at)
  }

  contextmenu(p: Point, at: number): void {
    this.model.onGrabContextMenu(grabEvent(p.x, p.y, { button: 2, time: at }), at)
  }

  cursor(p: Point, at: number): void {
    this.model.onCursor({ x: p.x, y: p.y }, at)
  }

  /** Payloads sent on `channel` since the last call (then forgets them). */
  take(channel: string): unknown[] {
    const taken = this.sent.filter((s) => s.channel === channel).map((s) => s.payload)
    const rest = this.sent.filter((s) => s.channel !== channel)
    this.sent.length = 0
    this.sent.push(...rest)
    return taken
  }
}

/** A started driver with the pet standing at (x, y), drawn and settled (the loop stopped). */
function placed(options: { dpr?: number; config?: Partial<PetConfig> } = {}, x = 800, y = GROUND): Driver {
  const d = new Driver(options)
  d.state(0, x, y, { snap: true })
  const plans = d.run(Driver.at(0))
  expect(plans[0]?.reveal).toBe(true)
  d.sent.length = 0
  d.hitTests.length = 0
  return d
}

/** After placed(): an event time well after the settle frames. */
const T = Driver.at(0) + 1000

/** Main's clock when the renderer's reads `ts` (what main stamps on a state it sends then). */
const mainAt = (ts: number): number => ts - SHIFT - LATENCY

const transformAt = (ground: Point, overlay = CONFIG.overlay, dpr = 2): string =>
  canvasTransform(canvasOrigin(ground, overlay, ANCHOR, dpr))

/** The pet:pointer 'down' for a press at `screen` on a pet drawn at `ground`. */
const downMsg = (screen: Point, ground: Point, epoch = 3): PetPointerMsg => ({
  kind: 'down',
  button: 0,
  screenX: screen.x,
  screenY: screen.y,
  groundX: ground.x,
  groundY: ground.y,
  epoch,
})

describe('placement rules', () => {
  it('snaps to the device-pixel grid', () => {
    expect(snapToDevicePixels(10.3, 2)).toBe(10.5)
    expect(snapToDevicePixels(10.2, 2)).toBe(10)
    expect(snapToDevicePixels(10.24, 1)).toBe(10)
    expect(snapToDevicePixels(7.4, 3)).toBeCloseTo(22 / 3, 12)
    expect(Object.is(snapToDevicePixels(-0.2, 2), 0)).toBe(true) // never "-0px"
    expect(snapToDevicePixels(10.4, Number.NaN)).toBe(10)
    expect(snapToDevicePixels(10.4, 0)).toBe(10)
    for (const v of [-3.37, 0.26, 581.749, 1e5 + 0.3]) {
      expect(snapToDevicePixels(snapToDevicePixels(v, 2), 2)).toBe(snapToDevicePixels(v, 2))
    }
  })

  it('puts the canvas at ground − overlay origin − anchor, snapped, and maps global points back into it', () => {
    const origin = canvasOrigin({ x: 800.3, y: 1000 }, CONFIG.overlay, ANCHOR, 2)
    expect(origin).toEqual({ x: 580.5, y: 780 })
    expect(canvasTransform(origin)).toBe('translate3d(580.5px, 780px, 0)')
    expect(canvasLocalPoint(ON_PET, CONFIG.overlay, { x: 580, y: 780 })).toEqual({ x: 120, y: 130 })
    expect(insideCanvas({ x: 0, y: 0 }, EDGE)).toBe(true)
    expect(insideCanvas({ x: 239.9, y: 239.9 }, EDGE)).toBe(true)
    expect(insideCanvas({ x: 240, y: 10 }, EDGE)).toBe(false)
    expect(insideCanvas({ x: -0.1, y: 10 }, EDGE)).toBe(false)
    expect(insideCanvas({ x: 10, y: 240 }, EDGE)).toBe(false)
  })

  it('holds the pet at the cursor minus the grab offset, clamped to the area like main', () => {
    const grab = { x: 0, y: -50 }
    expect(heldGroundPoint({ x: 900, y: 700 }, grab, CONFIG.area)).toEqual({ x: 900, y: 750 })
    expect(heldGroundPoint({ x: 5000, y: -500 }, grab, CONFIG.area)).toEqual({ x: 1640, y: 170 })
    expect(heldGroundPoint({ x: 10, y: 2000 }, grab, CONFIG.area)).toEqual({ x: 160, y: GROUND })
    expect(heldGroundPoint({ x: 5000, y: -500 }, grab, null)).toEqual({ x: 5000, y: -450 })
  })

  it('draws the contact shadow on the support line, fading out with height, off without a support line', () => {
    expect(contactShadowFor(GROUND, GROUND, 24)).toEqual({ elevationPt: 0, strength: 1 })
    expect(contactShadowFor(GROUND, GROUND - 12, 24)).toEqual({ elevationPt: 12, strength: 0.5 })
    expect(contactShadowFor(GROUND, GROUND - 6, 24)).toEqual({ elevationPt: 6, strength: 0.75 })
    expect(contactShadowFor(GROUND, GROUND - 24, 24)).toEqual({ elevationPt: 0, strength: 0 })
    expect(contactShadowFor(GROUND, GROUND - 300, 24)).toEqual({ elevationPt: 0, strength: 0 })
    // Below the line (never in M1: the area ends at the ground) counts as standing on it.
    expect(contactShadowFor(GROUND, GROUND + 6, 24)).toEqual({ elevationPt: 0, strength: 1 })
    expect(contactShadowFor(null, GROUND, 24)).toEqual({ elevationPt: 0, strength: 0 })
    expect(contactShadowFor(GROUND, GROUND, 0)).toEqual({ elevationPt: 0, strength: 1 })
    expect(contactShadowFor(GROUND, GROUND - 1, 0)).toEqual({ elevationPt: 0, strength: 0 })
    // Hidden shadows compare equal whatever the height, so lifting a pet higher never re-renders.
    expect(sameShadow(contactShadowFor(GROUND, 900, 24), contactShadowFor(GROUND, 500, 24))).toBe(true)
    expect(sameShadow({ elevationPt: 12, strength: 0.5 }, { elevationPt: 12, strength: 0.5 })).toBe(true)
    expect(sameShadow({ elevationPt: 12, strength: 0.5 }, { elevationPt: 12, strength: 0.4 })).toBe(false)
    expect(sameShadow({ elevationPt: 12, strength: 0.5 }, { elevationPt: 11, strength: 0.5 })).toBe(false)
  })

  it('caps WebGL renders at render.fps.moving with a little vsync slack', () => {
    const fps = tuning.render.fps.moving
    const slack = O.renderIntervalSlackMs
    expect(renderAllowed(null, 123, fps, slack)).toBe(true)
    expect(renderAllowed(100, 99, fps, slack)).toBe(true) // a clock that went backwards never blocks rendering
    expect(renderAllowed(0, 1000 / fps - slack - 0.01, fps, slack)).toBe(false)
    expect(renderAllowed(0, 1000 / fps - slack, fps, slack)).toBe(true)
    /** Renders over one second of frames at `hz`, rendering whenever allowed. */
    const renders = (hz: number): number[] => {
      const at: number[] = []
      for (let ts = 0; ts < 1000 - 1e-9; ts += 1000 / hz) if (renderAllowed(at[at.length - 1] ?? null, ts, fps, slack)) at.push(ts)
      return at
    }
    // A "60 Hz" display (measured 60.0024 Hz, frames 16.666 ms apart) renders every frame, not every other one.
    expect(renders(60.0024)).toHaveLength(61)
    expect(renders(120)).toHaveLength(60)
    for (const hz of [60.0024, 75, 90, 120, 144]) {
      const at = renders(hz)
      for (let i = 1; i < at.length; i++) expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000 / fps - slack - 1e-9)
    }
  })

  it('needs another frame only while pressed, holding a drop, owing a render or interpolating', () => {
    const idle = { pressed: false, dropHold: false, renderDue: false, renderT: null, newestStateT: null }
    expect(frameNeeded(idle, 0.5)).toBe(false)
    expect(frameNeeded({ ...idle, pressed: true }, 0.5)).toBe(true)
    expect(frameNeeded({ ...idle, dropHold: true }, 0.5)).toBe(true)
    expect(frameNeeded({ ...idle, renderDue: true }, 0.5)).toBe(true)
    expect(frameNeeded({ ...idle, renderT: 99.4, newestStateT: 100 }, 0.5)).toBe(true)
    expect(frameNeeded({ ...idle, renderT: 100.49, newestStateT: 100 }, 0.5)).toBe(true)
    expect(frameNeeded({ ...idle, renderT: 100.5, newestStateT: 100 }, 0.5)).toBe(false)
    expect(frameNeeded({ ...idle, renderT: 5000, newestStateT: 100 }, 0.5)).toBe(false)
    expect(frameNeeded({ ...idle, renderT: null, newestStateT: 100 }, 0.5)).toBe(false)
    expect(frameNeeded({ ...idle, renderT: 10, newestStateT: null }, 0.5)).toBe(false)
  })

  it('puts a clicked pet back where it was and drops a dragged one where it is', () => {
    const start = { x: 800, y: 1000 }
    const current = { x: 850, y: 990 }
    const max = tuning.hitArea.clickMaxMovePt
    const click = dropPoint({ startGround: start, maxMovePt: max - 0.01 }, current, max)
    expect(click).toEqual(start)
    click.x = 0 // a copy
    expect(start.x).toBe(800)
    expect(dropPoint({ startGround: start, maxMovePt: max }, current, max)).toEqual(current)
    expect(dropPoint({ startGround: start, maxMovePt: 0 }, current, max)).toEqual(start)
  })

  it('treats the right button and control-click as secondary clicks', () => {
    expect(isSecondaryClick(2, false)).toBe(true)
    expect(isSecondaryClick(2, true)).toBe(true)
    expect(isSecondaryClick(0, true)).toBe(true)
    expect(isSecondaryClick(0, false)).toBe(false)
    expect(isSecondaryClick(1, true)).toBe(false)
  })

  it('keeps main cursor samples quiet for a while after a native event', () => {
    expect(cursorQuiet(null, 100, 70)).toBe(false)
    expect(cursorQuiet(100, 100, 70)).toBe(true)
    expect(cursorQuiet(100, 169.9, 70)).toBe(true)
    expect(cursorQuiet(100, 170, 70)).toBe(false)
  })

  it('caps sample lists and says so', () => {
    const list = new SampleList(3)
    for (const v of [1, 2, 3]) list.push(v)
    expect(list.truncated).toBe(false)
    list.push(4)
    list.push(5)
    expect(list.toArray()).toEqual([1, 2, 3])
    expect(list.truncated).toBe(true)
    const copy = list.toArray()
    copy.push(9)
    expect(list.toArray()).toHaveLength(3)
  })
})

describe('OverlayModel: placement and frames', () => {
  it('draws nothing and hit-tests nothing before the first state', () => {
    const d = new Driver()
    expect(d.frameRequests).toBe(0)
    expect(d.frame(Driver.at(0))).toEqual({ transform: null, render: null, reveal: false, again: false })
    d.cursor(ON_PET, T)
    d.move(ON_PET, T + 100)
    expect(d.hitTests).toHaveLength(0)
    expect(d.model.hovering).toBe(false)
    expect(d.sent).toHaveLength(0)
  })

  it('places the canvas at the first state, renders it and reveals it once', () => {
    const d = new Driver()
    d.state(0, 800.3, GROUND, { snap: true })
    expect(d.frameRequests).toBe(1)
    const first = d.frame(Driver.at(0))
    expect(first.transform).toBe('translate3d(580.5px, 780px, 0)')
    // The reveal frame always renders: a canvas drawn while hidden may have lost its content.
    expect(first.render).toEqual(STANDING_SHADOW)
    expect(first.reveal).toBe(true)
    const rest = d.run(Driver.at(0) + 1000 / 60)
    for (const plan of rest) expect(plan).toMatchObject({ transform: null, render: null, reveal: false })
    expect(rest[rest.length - 1]?.again).toBe(false)
  })

  it('keeps the pet unhittable while its canvas is still hidden (the reveal render waiting on the render cap)', () => {
    const d = new Driver()
    d.model.onRedraw()
    expect(d.frame(Driver.at(0) - 5).render).not.toBeNull() // nothing placed yet, but a render ran
    d.state(0, 800, GROUND, { snap: true })
    const capped = d.frame(Driver.at(0))
    expect(capped.render).toBeNull()
    expect(capped.reveal).toBe(false)
    expect(capped.again).toBe(true)
    d.move(ON_PET, Driver.at(0) + 1)
    expect(d.model.hovering).toBe(false)
    expect(d.frame(Driver.at(0) + 1000 / 60).reveal).toBe(true)
    d.move(ON_PET, Driver.at(0) + 20)
    expect(d.model.hovering).toBe(true)
  })

  it('interpolates one step behind main, with the clock offset from the fastest delivery', () => {
    const d = new Driver()
    d.state(0, 800, GROUND, { snap: true })
    d.state(STEP, 810)
    d.state(2 * STEP, 820, GROUND, {}, 20) // a slow delivery must not shift the clock estimate
    expect(d.frame(Driver.at(STEP / 2)).transform).toBe(transformAt({ x: 805, y: GROUND }))
    const mid = d.frame(Driver.at(1.5 * STEP))
    expect(mid.transform).toBe(transformAt({ x: 815, y: GROUND }))
    // Moving the canvas is a compositor transform only: no WebGL render.
    expect(mid.render).toBeNull()
    expect(mid.again).toBe(true)
    const end = d.frame(Driver.at(2 * STEP))
    expect(end.transform).toBe(transformAt({ x: 820, y: GROUND }))
    // Past the newest state the loop stops until main sends something new.
    expect(d.frame(Driver.at(2 * STEP) + 1000 / 60).again).toBe(false)
    expect(d.model.stats(0).starvedFrames).toBe(1)
    const requests = d.frameRequests
    d.state(3 * STEP, 830)
    expect(d.frameRequests).toBe(requests + 1)
    expect(d.frame(Driver.at(2.5 * STEP)).transform).toBe(transformAt({ x: 825, y: GROUND }))
  })

  it('starts moving from where the pet stood after a long gap, as if every step had been sent', () => {
    const d = placed()
    d.state(3000, 900) // seconds later
    expect(d.frame(Driver.at(2000)).transform).toBeNull() // still standing at 800
    expect(d.frame(Driver.at(3000 - STEP / 2)).transform).toBe(transformAt({ x: 850, y: GROUND }))
  })

  it('never interpolates across a snap state', () => {
    const d = placed()
    const m = mainAt(T)
    d.state(m, 810)
    d.state(m + STEP, 1200, GROUND, { snap: true })
    // Even at a render time before the snap state, the pet is drawn there and nowhere in between.
    expect(d.frame(Driver.at(m + STEP / 2)).transform).toBe(transformAt({ x: 1200, y: GROUND }))
  })

  it('writes the transform only when it changes, and re-snaps and re-renders for a new pixel ratio', () => {
    const d = placed({}, 800.3)
    d.model.onRedraw()
    expect(d.frame(T).transform).toBeNull()
    d.dpr = 1
    const plan = d.frame(T + 20)
    expect(plan.transform).toBe('translate3d(580px, 780px, 0)')
    expect(plan.render).not.toBeNull()
  })

  it('renders only for a visible change: a redraw request, a shadow change, being shown again', () => {
    const d = placed()
    const renders = (): number => d.model.stats(0).renders
    const before = renders()
    d.model.onRedraw()
    expect(d.run(T).filter((p) => p.render)).toHaveLength(1)
    expect(renders()).toBe(before + 1)
    d.model.onVisible({ visible: false, epoch: 3 })
    d.model.onVisible({ visible: true, epoch: 3 })
    expect(d.run(T + 100).filter((p) => p.render)).toHaveLength(1)
    // Walking along the ground (same shadow) moves the canvas without rendering.
    const m = mainAt(T + 200)
    d.state(m, 800)
    d.state(m + STEP, 820)
    d.state(m + 2 * STEP, 840)
    const walk = d.run(Driver.at(m))
    expect(walk.filter((p) => p.transform).length).toBeGreaterThan(1)
    expect(walk.filter((p) => p.render)).toHaveLength(0)
  })
})

describe('OverlayModel: the contact shadow', () => {
  it('fades with height while the pet is held, on the support line of the newest state', () => {
    const d = placed()
    d.down(ON_PET, T) // grab offset (0, −50)
    d.move({ x: 800, y: 938 }, T + 1, 1) // ground 988: 12 pt up
    expect(d.frame(T + 2).render).toEqual({ elevationPt: 12, strength: 0.5 })
    d.move({ x: 800, y: 900 }, T + 20, 1) // 50 pt up: gone
    expect(d.frame(T + 21).render).toEqual({ elevationPt: 0, strength: 0 })
    d.move({ x: 800, y: 850 }, T + 40, 1) // higher still: nothing visible changes
    expect(d.frame(T + 41).render).toBeNull()
  })

  it('renders shadow changes at most once per 1000/fps ms', () => {
    const d = placed()
    d.down(ON_PET, T)
    const frame120 = 1000 / 120
    const plans: FramePlan[] = []
    for (let i = 1; i <= 12; i++) {
      d.move({ x: 800, y: 950 - i }, T + i * frame120 - 1, 1) // a new height (shadow) every frame
      plans.push(d.frame(T + i * frame120))
    }
    // Every frame moves the canvas; every other one renders.
    expect(plans.filter((p) => p.transform)).toHaveLength(12)
    expect(plans.filter((p) => p.render)).toHaveLength(6)
    expect(plans.every((p) => p.again)).toBe(true)
  })

  it('is off when nothing is below the pet', () => {
    const d = placed()
    d.state(STEP, 800, GROUND, { supportY: null })
    const plans = d.run(Driver.at(STEP))
    expect(plans[0]?.render).toEqual({ elevationPt: 0, strength: 0 })
  })
})

describe('OverlayModel: hover and hit tests', () => {
  it('hit-tests global points through overlay-local and canvas-local coordinates', () => {
    const d = placed()
    d.move(ON_PET, T)
    expect(d.hitTests).toEqual([{ x: 120, y: 130 }])
    expect(d.take(IPC.petHover)).toEqual([{ over: true, epoch: 3 }])
    d.move(ON_PET, T + 1) // no change, no message
    d.move(BESIDE_PET, T + 2)
    expect(d.take(IPC.petHover)).toEqual([{ over: false, epoch: 3 }])
    // Outside the canvas the pet is not even asked.
    d.hitTests.length = 0
    d.move(OFF_CANVAS, T + 3)
    expect(d.hitTests).toHaveLength(0)
    d.model.onGrabLeave(T + 4)
    expect(d.sent).toHaveLength(0)
  })

  it('uses main cursor samples while no press, except right after a native event', () => {
    const d = placed()
    d.cursor(ON_PET, T)
    expect(d.take(IPC.petHover)).toEqual([{ over: true, epoch: 3 }])
    d.move(BESIDE_PET, T + 1)
    expect(d.take(IPC.petHover)).toEqual([{ over: false, epoch: 3 }])
    d.cursor(ON_PET, T + 1 + O.cursorQuietMs - 1) // older than the native move: ignored
    expect(d.model.hovering).toBe(false)
    d.cursor(ON_PET, T + 1 + O.cursorQuietMs)
    expect(d.take(IPC.petHover)).toEqual([{ over: true, epoch: 3 }])
    const stats = d.model.stats(0)
    expect(stats.cursorMsgs).toBe(3)
    expect(stats.cursorMsgsIgnored).toBe(1)
  })

  it('stamps every message with the newest epoch seen from any of main’s messages', () => {
    const d = placed()
    expect(d.model.epoch).toBe(3)
    d.model.onHoverReset({ epoch: 2 }) // older: the epoch never goes back
    expect(d.model.epoch).toBe(3)
    d.model.onHoverReset({ epoch: 7 })
    d.move(ON_PET, T)
    d.model.onVisible({ visible: true, epoch: 9 })
    d.move(BESIDE_PET, T + 1)
    d.model.onConfigChanged({ ...CONFIG, configSeq: 2, epoch: 12 })
    d.run(T + 2)
    d.move(ON_PET, T + 100)
    d.down(ON_PET, T + 101)
    expect(d.take(IPC.petHover)).toEqual([
      { over: true, epoch: 7 },
      { over: false, epoch: 9 },
      { over: true, epoch: 12 },
    ])
    expect(d.take(IPC.petPointer)).toEqual([downMsg(ON_PET, { x: 800, y: GROUND }, 12)])
  })

  it('forgets hover on pet:hover-reset without telling main', () => {
    const d = placed()
    d.move(ON_PET, T)
    d.take(IPC.petHover)
    d.model.onHoverReset({ epoch: 5 })
    expect(d.model.hovering).toBe(false)
    expect(d.sent).toHaveLength(0)
    d.move(ON_PET, T + 1)
    expect(d.take(IPC.petHover)).toEqual([{ over: true, epoch: 5 }])
  })
})

describe('OverlayModel: press, drag and release', () => {
  it('a press over the pet sends the drawn ground point; the pet then follows the mouse at frame rate, clamped', () => {
    const d = placed({}, 800.3)
    d.down(ON_PET, T)
    expect(d.model.pressed).toBe(true)
    expect(d.take(IPC.petHover)).toEqual([{ over: true, epoch: 3 }])
    // The unsnapped ground point, so main holds the pet by exactly this grab offset.
    expect(d.take(IPC.petPointer)).toEqual([downMsg(ON_PET, { x: 800.3, y: GROUND })])
    d.move({ x: 900, y: 700 }, T + 5, 1)
    expect(d.frame(T + 6).transform).toBe(transformAt({ x: 900.3, y: 750 }))
    d.move({ x: 5000, y: -500 }, T + 10, 1)
    expect(d.frame(T + 23).transform).toBe(transformAt({ x: 1640, y: 170 }))
    // Main's held states do not move the pet while the mouse holds it.
    d.state(STEP, 1000, 500)
    const plan = d.frame(T + 40)
    expect(plan.transform).toBeNull()
    expect(plan.again).toBe(true)
  })

  it('a press beside the pet or with no pet drawn is no press', () => {
    const d = placed()
    d.down(BESIDE_PET, T)
    expect(d.model.pressed).toBe(false)
    expect(d.take(IPC.petPointer)).toEqual([])
    const fresh = new Driver()
    fresh.down(ON_PET, T)
    expect(fresh.model.pressed).toBe(false)
    expect(fresh.sent).toHaveLength(0)
  })

  it('release after a drag: pointer up, and the pet stays at the drop point until main’s snap state', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.move({ x: 900, y: 700 }, T + 5, 1)
    d.frame(T + 6)
    d.up({ x: 900, y: 700 }, T + 10)
    expect(d.model.pressed).toBe(false)
    expect(d.take(IPC.petPointer)).toEqual([
      { kind: 'down', button: 0, screenX: 800, screenY: 950, groundX: 800, groundY: GROUND, epoch: 3 },
      { kind: 'up', button: 0, screenX: 900, screenY: 700, epoch: 3 },
    ])
    // A held state from before the release does not move it…
    d.state(mainAt(T + 8), 880, 760, { state: 'held' })
    const held = d.frame(T + 20)
    expect(held.transform).toBeNull()
    expect(held.again).toBe(true)
    // …main's snap state does, and the fall that follows is interpolated.
    const m = mainAt(T + 25)
    d.state(m, 905, 755, { snap: true, state: 'fall' })
    d.state(m + STEP, 905, 800, { state: 'fall' })
    expect(d.frame(T + 30).transform).toBe(transformAt({ x: 905, y: 755 }))
    expect(d.frame(Driver.at(m + STEP / 2)).transform).toBe(transformAt({ x: 905, y: 777.5 }))
  })

  // Main sends one cursor sample on its next wake (≤ one step) after the reset, and none while cursor and pet stay still.
  for (const order of ['up first', 'reset first'] as const) {
    for (const after of [5, 20, STEP]) {
      it(`after a drop, main's first cursor sample (+${after.toFixed(0)} ms, ${order}) makes the still pet clickable again`, () => {
        const d = placed()
        d.down(ON_PET, T)
        d.move({ x: 900, y: 700 }, T + 5, 1)
        d.frame(T + 6)
        const tUp = T + 10
        if (order === 'up first') {
          d.up({ x: 900, y: 700 }, tUp)
          d.model.onHoverReset({ epoch: 4 })
        } else {
          d.model.onHoverReset({ epoch: 4 })
          d.up({ x: 900, y: 700 }, tUp)
        }
        d.take(IPC.petHover)
        d.cursor({ x: 900, y: 700 }, tUp + after)
        expect(d.take(IPC.petHover)).toEqual([{ over: true, epoch: 4 }])
      })
    }
  }

  it('the grab area’s own events still win over an older main sample while no reset came', () => {
    const d = placed()
    d.move(ON_PET, T)
    expect(d.take(IPC.petHover)).toEqual([{ over: true, epoch: 3 }])
    d.cursor(OFF_CANVAS, T + O.cursorQuietMs - 1) // main's sample is older news than the grab area's move
    expect(d.take(IPC.petHover)).toEqual([])
  })

  it('main’s pet:hover-reset after a drag release (its epoch bump) does not end the drop hold', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.move({ x: 900, y: 700 }, T + 5, 1)
    d.frame(T + 6)
    d.up({ x: 900, y: 700 }, T + 10)
    d.model.onHoverReset({ epoch: 4 })
    const plan = d.frame(T + 20)
    expect(plan.transform).toBeNull() // still at the drop point (900, 750)
    expect(plan.again).toBe(true)
    // The cursor stream then finds the cursor still on the pet, under the new epoch.
    d.cursor({ x: 900, y: 700 }, T + 10 + O.cursorQuietMs)
    expect(d.take(IPC.petHover).pop()).toEqual({ over: true, epoch: 4 })
  })

  it('the drop hold gives up after dropHoldMs without a snap state', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.move({ x: 900, y: 700 }, T + 5, 1)
    d.up({ x: 900, y: 700 }, T + 10)
    expect(d.frame(T + 10 + O.dropHoldMs - 1).transform).toBe(transformAt({ x: 900, y: 750 }))
    // Then the buffer (the pet standing at 800) draws it again, and the loop stops.
    const after = d.run(T + 10 + O.dropHoldMs)
    expect(after[0]?.transform).toBe(transformAt({ x: 800, y: GROUND }))
    expect(after[after.length - 1]?.again).toBe(false)
  })

  it('a click (never moved clickMaxMovePt) puts the pet back at the press-start ground point', () => {
    const max = tuning.hitArea.clickMaxMovePt
    const d = placed()
    d.down(ON_PET, T)
    d.move({ x: 800 + (max - 1), y: 950 }, T + 5, 1)
    d.frame(T + 6)
    d.up({ x: 800 + (max - 1), y: 951 }, T + 10)
    // Drawn where it was, not where the cursor let go.
    expect(d.frame(T + 11).transform).toBe(transformAt({ x: 800, y: GROUND }))
  })

  it('a press that moved clickMaxMovePt or more is a drag even if it ends where it started', () => {
    const max = tuning.hitArea.clickMaxMovePt
    const d = placed()
    d.down(ON_PET, T)
    d.move({ x: 800 + max, y: 950 }, T + 5, 1)
    d.move({ x: 801, y: 950 }, T + 6, 1)
    d.up({ x: 801, y: 950 }, T + 10)
    expect(d.frame(T + 11).transform).toBe(transformAt({ x: 801, y: GROUND }))
  })

  it('a mousemove without the left button during a press is the lost mouseup', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.move({ x: 850, y: 950 }, T + 5, 1)
    d.move({ x: 860, y: 950 }, T + 6, 0)
    expect(d.model.pressed).toBe(false)
    expect(d.take(IPC.petPointer).slice(1)).toEqual([{ kind: 'up', button: 0, screenX: 860, screenY: 950, epoch: 3 }])
    expect(d.frame(T + 7).transform).toBe(transformAt({ x: 860, y: GROUND }))
  })

  it('a press follows raw pointer moves; once they come, the frame-aligned mousemoves are left out', () => {
    // The dev check measured drags drawn a frame late from mousemove: the grab area dispatches it with its own frame,
    // after the overlay's frame at the same vsync. pointerrawupdate arrives at once.
    const d = placed({ config: { debug: true } })
    d.down(ON_PET, T)
    d.rawMove({ x: 900, y: 700 }, T + 5, 1)
    expect(d.frame(T + 6).transform).toBe(transformAt({ x: 900, y: 750 }))
    // The frame-aligned mousemove for an older position arrives after it: it must not pull the pet back.
    d.move({ x: 880, y: 720 }, T + 7, 1)
    const plan = d.frame(T + 23)
    expect(plan.transform).toBeNull()
    expect(plan.again).toBe(true)
    d.rawMove({ x: 950, y: 700 }, T + 30, 1)
    expect(d.frame(T + 39).transform).toBe(transformAt({ x: 950, y: 750 }))
    // Input → frame comes from the raw moves (5 → 6 and 30 → 39 ms; the left-out mousemove adds none).
    expect(d.model.stats(0).inputToFrameMs).toEqual([1, 9])
    d.up({ x: 950, y: 700 }, T + 40)
    expect(d.take(IPC.petPointer).pop()).toEqual({ kind: 'up', button: 0, screenX: 950, screenY: 700, epoch: 3 })
  })

  it('raw moves never hover (hover stays on the frame-aligned mousemove); one without the left button is the lost mouseup', () => {
    const d = placed()
    d.rawMove(ON_PET, T, 0)
    expect(d.hitTests).toEqual([])
    expect(d.take(IPC.petHover)).toEqual([])
    d.down(ON_PET, T + 1)
    d.rawMove({ x: 850, y: 950 }, T + 5, 1)
    d.rawMove({ x: 860, y: 950 }, T + 6, 0)
    expect(d.model.pressed).toBe(false)
    expect(d.take(IPC.petPointer).slice(1)).toEqual([{ kind: 'up', button: 0, screenX: 860, screenY: 950, epoch: 3 }])
    expect(d.frame(T + 7).transform).toBe(transformAt({ x: 860, y: GROUND }))
    // Without raw moves (no pointerrawupdate), mousemoves drive a press as before.
    const plain = placed()
    plain.down(ON_PET, T)
    plain.move({ x: 900, y: 700 }, T + 5, 1)
    expect(plain.frame(T + 6).transform).toBe(transformAt({ x: 900, y: 750 }))
  })

  it('never says hover:false while pressed', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.take(IPC.petHover)
    d.model.onGrabLeave(T + 1)
    d.move({ x: 2000, y: 300 }, T + 2, 1)
    d.frame(T + 3)
    d.cursor(OFF_CANVAS, T + 500)
    d.contextmenu(OFF_CANVAS, T + 501)
    expect(d.take(IPC.petHover)).toEqual([])
    expect(d.model.hovering).toBe(true)
    // Released off the pet (it was clamped at the area's edge): now main hears it.
    d.up({ x: 2000, y: 300 }, T + 600)
    expect(d.take(IPC.petHover)).toEqual([{ over: false, epoch: 3 }])
  })

  it('pet:hover-reset drops a press: main cancelled it and places the pet; the later mouseup says nothing', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.move({ x: 900, y: 700 }, T + 5, 1)
    d.frame(T + 6)
    d.sent.length = 0
    d.model.onHoverReset({ epoch: 4 })
    expect(d.model.pressed).toBe(false)
    expect(d.model.hovering).toBe(false)
    // Back to main's states (no drop hold): the pet standing at 800.
    expect(d.frame(T + 7).transform).toBe(transformAt({ x: 800, y: GROUND }))
    d.up({ x: 900, y: 700 }, T + 8)
    expect(d.sent).toHaveLength(0)
  })

  it('a snap state during the press (main saw the native mouseup first) means no drop hold', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.move({ x: 900, y: 700 }, T + 5, 1)
    d.frame(T + 6)
    d.state(STEP, 910, 760, { snap: true, state: 'fall' })
    d.up({ x: 900, y: 700 }, T + 10)
    expect(d.take(IPC.petPointer).slice(1)).toEqual([{ kind: 'up', button: 0, screenX: 900, screenY: 700, epoch: 3 }])
    expect(d.frame(T + 11).transform).toBe(transformAt({ x: 910, y: 760 }))
  })

  it('a new press during a drop hold grabs the pet where it is drawn', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.move({ x: 900, y: 700 }, T + 5, 1)
    d.up({ x: 900, y: 700 }, T + 10)
    d.frame(T + 11)
    d.take(IPC.petPointer)
    d.down({ x: 900, y: 700 }, T + 20)
    expect(d.take(IPC.petPointer)).toEqual([downMsg({ x: 900, y: 700 }, { x: 900, y: 750 })])
  })
})

describe('OverlayModel: secondary clicks', () => {
  it('control-click and the right button never press; contextmenu over the pet asks main for the menu', () => {
    const d = placed()
    d.move(ON_PET, T)
    d.take(IPC.petHover)
    d.down(ON_PET, T + 1, { ctrlKey: true })
    d.down(ON_PET, T + 2, { button: 2, buttons: 2 })
    d.down(ON_PET, T + 3, { button: 1, buttons: 4 })
    expect(d.model.pressed).toBe(false)
    expect(d.sent).toHaveLength(0)
    d.contextmenu(ON_PET, T + 4)
    expect(d.take(IPC.petPointer)).toEqual([{ kind: 'contextmenu', screenX: 800, screenY: 950, epoch: 3 }])
    // Beside the pet: no menu, and the hover goes.
    d.contextmenu(BESIDE_PET, T + 5)
    expect(d.take(IPC.petPointer)).toEqual([])
    expect(d.take(IPC.petHover)).toEqual([{ over: false, epoch: 3 }])
  })

  it('a right-click during a drag does nothing', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.take(IPC.petPointer)
    d.contextmenu(ON_PET, T + 1)
    expect(d.take(IPC.petPointer)).toEqual([])
    expect(d.model.pressed).toBe(true)
  })
})

describe('OverlayModel: shown, hidden, configuration and context loss', () => {
  it('hidden: no frames, and hover and press are dropped; shown: renders again and resumes', () => {
    const d = placed()
    d.down(ON_PET, T)
    d.model.onVisible({ visible: false, epoch: 4 })
    expect(d.model.visible).toBe(false)
    expect(d.model.pressed).toBe(false)
    expect(d.model.hovering).toBe(false)
    expect(d.frame(T + 1)).toEqual({ transform: null, render: null, reveal: false, again: false })
    const requests = d.frameRequests
    const m = mainAt(T + 400)
    d.state(m, 900)
    d.model.onRedraw()
    d.cursor(ON_PET, T + 500)
    d.move(ON_PET, T + 501)
    expect(d.frameRequests).toBe(requests)
    expect(d.model.hovering).toBe(false)
    d.model.onVisible({ visible: true, epoch: 4 })
    expect(d.frameRequests).toBe(requests + 1)
    const plans = d.run(Driver.at(m))
    expect(plans[0]?.render).not.toBeNull()
    expect(plans[0]?.transform).toBe(transformAt({ x: 900, y: GROUND }))
  })

  it('pet:config-changed: new overlay origin and area, hit tests off until re-placed, then pet:drawn', () => {
    const d = placed()
    d.move(ON_PET, T)
    d.take(IPC.petHover)
    const requests = d.frameRequests
    const overlay = { x: 0, y: 0, width: 1600, height: 1000 }
    d.model.onConfigChanged({ ...CONFIG, configSeq: 2, overlay })
    expect(d.frameRequests).toBe(requests + 1)
    expect(d.model.configSeq).toBe(2)
    // Not drawn for the new configuration yet: not over the pet.
    d.hitTests.length = 0
    d.move(ON_PET, T + 1)
    expect(d.hitTests).toHaveLength(0)
    expect(d.take(IPC.petHover)).toEqual([{ over: false, epoch: 3 }])
    const plan = d.frame(T + 2)
    expect(plan.transform).toBe(transformAt({ x: 800, y: GROUND }, overlay))
    expect(plan.render).not.toBeNull()
    expect(d.take(IPC.petDrawn)).toEqual([{ drawn: true, configSeq: 2 }])
    // A stale configuration changes nothing.
    d.model.onConfigChanged({ ...CONFIG, configSeq: 1 })
    expect(d.model.configSeq).toBe(2)
    expect(d.frameRequests).toBe(requests + 1)
  })

  it('a pet:config-changed that overtook the pet:config reply wins if newer', () => {
    const d = new Driver({ start: false })
    d.model.onVisible({ visible: true, epoch: 6 })
    d.model.onConfigChanged({ ...CONFIG, configSeq: 5, overlay: { x: 0, y: 0, width: 800, height: 600 }, epoch: 8, debug: true })
    expect(d.frameRequests).toBe(0)
    const config = d.model.onConfig(CONFIG)
    expect(config).toMatchObject({
      configSeq: 5,
      overlay: { x: 0, y: 0, width: 800, height: 600 },
      debug: true,
      hitWindowName: CONFIG.hitWindowName,
    })
    expect(d.model.epoch).toBe(8)
    const older = new Driver({ start: false })
    older.model.onConfigChanged({ ...CONFIG, configSeq: 0, debug: true })
    expect(older.model.onConfig(CONFIG)).toMatchObject({ configSeq: 1, debug: false })
  })

  it('WebGL context loss: pet:drawn false at once, no renders or spinning frames, then a render and pet:drawn true', () => {
    const d = placed()
    d.model.onContextLost()
    expect(d.take(IPC.petDrawn)).toEqual([{ drawn: false, configSeq: 1 }])
    d.move(ON_PET, T)
    expect(d.model.hovering).toBe(false)
    d.model.onRedraw()
    const lost = d.frame(T + 1)
    expect(lost.render).toBeNull()
    expect(lost.again).toBe(false)
    const requests = d.frameRequests
    d.model.onContextRestored()
    expect(d.frameRequests).toBe(requests + 1)
    expect(d.frame(T + 2).render).not.toBeNull()
    expect(d.take(IPC.petDrawn)).toEqual([{ drawn: true, configSeq: 1 }])
    d.move(ON_PET, T + 3)
    expect(d.model.hovering).toBe(true)
    expect(d.model.stats(0).contextLosses).toBe(1)
  })

  it('a context lost before the first placement keeps the canvas hidden until it is restored and drawn', () => {
    const d = new Driver()
    d.model.onContextLost()
    d.state(0, 800, GROUND, { snap: true })
    const lost = d.frame(Driver.at(0))
    expect(lost.reveal).toBe(false)
    expect(lost.render).toBeNull()
    d.model.onContextRestored()
    const restored = d.frame(Driver.at(0) + 20)
    expect(restored.reveal).toBe(true)
    expect(restored.render).not.toBeNull()
  })

  it('a render that throws: pet:drawn false once, hit tests off, no retry loop; the next render recovers', () => {
    const d = placed()
    d.model.onRedraw()
    const plan = d.model.frame(T, T, 2)
    expect(plan.render).not.toBeNull()
    d.model.renderFailed()
    expect(d.take(IPC.petDrawn)).toEqual([{ drawn: false, configSeq: 1 }])
    expect(d.model.frame(T + 20, T + 20, 2)).toMatchObject({ render: null, again: false })
    d.move(ON_PET, T + 21)
    expect(d.model.hovering).toBe(false)
    d.model.onRedraw()
    expect(d.model.frame(T + 40, T + 40, 2).render).not.toBeNull()
    d.model.renderFailed()
    expect(d.take(IPC.petDrawn)).toEqual([]) // already reported
    d.model.onRedraw()
    expect(d.frame(T + 60).render).not.toBeNull()
    expect(d.take(IPC.petDrawn)).toEqual([{ drawn: true, configSeq: 1 }])
  })

  it('ignores malformed messages from main, logging them; a malformed pet:config starts nothing', () => {
    const d = placed()
    const requests = d.frameRequests
    d.model.onState({ x: 1 }, T)
    d.model.onCursor({ x: 'a' }, T)
    d.model.onHoverReset({})
    d.model.onVisible({ visible: 'no', epoch: 1 })
    d.model.onConfigChanged({ ...CONFIG, stepMs: 0 })
    expect(d.frameRequests).toBe(requests)
    expect(d.model.visible).toBe(true)
    expect(d.model.configSeq).toBe(1)
    expect(d.logs.map((l) => l.level)).toEqual(['warning', 'warning', 'warning', 'warning'])
    expect(d.model.stats(0).cursorMsgsIgnored).toBe(1)

    const inert = new Driver({ start: false })
    expect(inert.model.onConfig({ ...CONFIG, hitWindowName: '_blank' })).toBeNull()
    expect(inert.logs).toEqual([{ level: 'error', message: expect.stringContaining('pet:config') }])
    inert.state(0, 800, GROUND, { snap: true })
    expect(inert.frameRequests).toBe(0)
    expect(inert.frame(Driver.at(0)).reveal).toBe(false)
  })
})

describe('OverlayModel: dev stats', () => {
  it('counts frames, renders, hit tests and messages; samples intervals and input latency only with debug', () => {
    const d = placed({ config: { debug: true } })
    const frame60 = 1000 / 60
    // placed() ran two frames of one run: one interval already.
    expect(d.model.stats(0).rafIntervalsMs).toHaveLength(1)
    d.move(ON_PET, T)
    d.down(ON_PET, T + 1)
    for (let i = 1; i <= 5; i++) {
      d.move({ x: 800 + 10 * i, y: 900 }, T + i * frame60 - 4, 1) // event time 4 ms before the frame
      d.frame(T + i * frame60)
    }
    // A long frame inside the run, then the run goes on at 60 Hz until it ends.
    const long = T + 5 * frame60 + 40
    d.move({ x: 900, y: 900 }, long - 4, 1)
    d.frame(long)
    d.up({ x: 900, y: 900 }, long + 1)
    d.run(long + frame60)
    const stats = d.model.stats(1234)
    expect(isOverlayStatsMsg(stats)).toBe(true)
    expect(stats.at).toBe(1234)
    expect(stats.inputToFrameMs).toEqual([4, 4, 4, 4, 4, 4])
    // The press run: 5 frames 1/60 s apart, then a 40 ms one (the first frame of a run has no interval).
    const round = (v: number): number => +v.toFixed(6)
    expect(stats.rafIntervalsMs.slice(1, 6).map(round)).toEqual([frame60, frame60, frame60, frame60, 40].map(round))
    expect(stats.longFrames).toBe(1)
    expect(stats.hoverMsgs).toBe(1)
    expect(stats.pointerMsgs).toBe(2)
    expect(stats.hitTests).toBeGreaterThanOrEqual(2)
    expect(stats.truncated).toBe(false)

    // The idle gap before a new run is not a frame interval.
    d.model.onRedraw()
    d.run(T + 10_000)
    expect(d.model.stats(0).longFrames).toBe(1)

    const plain = placed()
    plain.down(ON_PET, T)
    plain.move({ x: 900, y: 900 }, T + 10, 1)
    plain.frame(T + 16)
    plain.frame(T + 33)
    const quiet = plain.model.stats(0)
    expect(quiet.frames).toBeGreaterThan(2)
    expect(quiet.rafIntervalsMs).toEqual([])
    expect(quiet.inputToFrameMs).toEqual([])
  })
})
