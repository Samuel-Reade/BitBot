// The production pet page: the overlay renderer of approach B, hardened (docs/decisions/overlay.md "Decision").
// Main owns the simulation and says where the pet is (pet:state); this page draws it on a small canvas that it moves
// with a compositor transform, animates it (character/animator.ts), renders WebGL only when something visible changed
// (§11 render on demand) and sleeps on a timer until the animation's next change, and takes the pet's mouse input
// through the grab area it opens (hitWindow.ts). The decisions are OverlayModel's (placement.ts); this file wires them
// to the DOM, three.js and IPC.
//
// Fail closed: a malformed configuration starts nothing (no grab area, no pet:ready, so main recreates the page); a
// grab area that did not open never reports a hover, so main never makes it clickable.
//
// Dev builds: debug:world shows the world's debug view (worldView.ts) over the overlay; it never takes input or asks
// for frames of its own.

import { IPC } from '../../shared/ipc'
import type { Box, Point, Rect } from '../../shared/geometry'
import {
  isPetBubbleMsg,
  isPetPingMsg,
  type PetBubbleShownMsg,
  type PetLogMsg,
  type PetPongMsg,
  type PetReadyMsg,
} from '../../shared/petProtocol'
import { tuning } from '../../shared/tuning'
import type { PaletteId, PetSize } from '../../shared/types'
import { isDebugWorldMsg, type DebugWorldMsg } from '../../shared/world'
import { Animator } from './character/animator'
import { createBubble } from './bubble'
import { openGrabArea, type GrabArea } from './hitWindow'
import { OverlayModel, STANDING_SHADOW, type ContactShadowParams } from './placement'
import type { PetScene } from './scene'
import { backingSize, drawWorldView, petBoxRect, worldViewShapes } from './worldView'

/** What the page was loaded with (main's query: size, palette); the configuration should agree. */
export interface OverlayQuery {
  size: PetSize
  paletteId: PaletteId
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const reported = new Set<string>()
let reportsSuppressed = false

/** pet:log, each distinct message once per page load, at most tuning.overlay.logMessageBudget of them. */
export function reportToMain(level: PetLogMsg['level'], message: string): void {
  if (reported.has(message)) return
  let payload: PetLogMsg = { level, message }
  if (reported.size >= tuning.overlay.logMessageBudget) {
    if (reportsSuppressed) return
    reportsSuppressed = true
    payload = { level: 'warning', message: 'overlay: pet:log budget used up; further problems are not reported' }
  } else {
    reported.add(message)
  }
  try {
    window.bitbot.send(IPC.petLog, payload)
  } catch {
    // Bridge unavailable: nothing else to tell.
  }
}

/** Reports uncaught errors and rejections from this page; install before anything that can throw (creating WebGL). */
export function installOverlayErrorReporting(): void {
  window.addEventListener('error', (e) => {
    const file = typeof e.filename === 'string' ? (e.filename.split('/').pop() ?? '') : ''
    reportToMain('error', `overlay: ${e.message} (${file}:${e.lineno}:${e.colno})`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    reportToMain('error', `overlay: unhandled rejection: ${errorText(e.reason)}`)
  })
}

/** Runs the overlay: handshake with main, grab area, first frame, then frames on demand. */
export function startOverlay(pet: PetScene, query: OverlayQuery): void {
  const bridge = window.bitbot
  const canvas = pet.renderer.domElement
  canvas.style.visibility = 'hidden' // until the first pet:state places it
  canvas.style.willChange = 'transform'

  let rafId: number | null = null
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let grabArea: GrabArea | null = null
  const clearWake = (): void => {
    if (wakeTimer !== null) clearTimeout(wakeTimer)
    wakeTimer = null
  }
  const requestFrame = (): void => {
    clearWake()
    if (rafId === null) rafId = requestAnimationFrame(onFrame)
  }
  /** No frames until `at` (renderer ms): a timer asks for the frame just before it (the frame lands on the next vsync). */
  const wakeAt = (at: number): void => {
    clearWake()
    const delay = Math.max(0, at - performance.now() - 1000 / tuning.render.fps.moving)
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      requestFrame()
    }, delay)
  }
  const animator = new Animator(pet.rig, { ptPerUnit: pet.ptPerUnit })
  const model = new OverlayModel(
    { edge: pet.width, anchor: pet.anchor, anchors: pet.anchors, devicePixelRatio: pixelRatio() },
    {
      hitTest: (x, y) => pet.hitTest(x, y),
      animate: (input, ts) => animator.update(ts, input),
      send: (channel, payload) => bridge.send(channel, payload),
      requestFrame,
      log: reportToMain,
    },
  )
  const worldView = new WorldDebugView(canvas, () => model.overlay, () => model.drawnBox)
  const bubble = createBubble(document)
  const guarded = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      reportToMain('error', `overlay: ${what} failed: ${errorText(err)}`)
    }
  }

  const render = (ts: number | null, shadow: ContactShadowParams): void => {
    try {
      // Resizing the drawing buffer clears it, so a new pixel ratio is applied only right before a render.
      const ratio = Math.min(pixelRatio(), tuning.render.pixelRatioCap)
      if (pet.renderer.getPixelRatio() !== ratio) pet.renderer.setPixelRatio(ratio)
      // Where this frame's canvas transform puts the ground-contact point (it moves only in frames that render).
      pet.setAnchor(model.anchor)
      pet.setContactShadow(shadow.elevationPt, shadow.strength)
      pet.render()
      model.rendered(ts, shadow)
    } catch (err) {
      model.renderFailed()
      reportToMain('error', `overlay: pet render failed: ${errorText(err)}`)
    }
  }

  function onFrame(ts: number): void {
    rafId = null
    guarded('frame', () => {
      const plan = model.frame(ts, performance.now(), pixelRatio())
      if (plan.transform !== null) canvas.style.transform = plan.transform
      if (plan.render) render(ts, plan.render)
      if (plan.reveal) canvas.style.visibility = 'visible'
      bubble.place(model.bubbleLayout, model.overlay, pixelRatio()) // §9.4: follows the pet (no-op without a bubble)
      // Only in frames that run anyway, and nothing at all while the debug view is off.
      if (worldView.shown) worldView.petMoved()
      if (plan.again) requestFrame()
      else if (plan.wakeAt !== null) wakeAt(plan.wakeAt)
    })
  }

  // §9.4 the speech bubble (bubble.ts): drawn and measured here, laid out by the model, timed and dismissed by main.
  bridge.on(IPC.petBubble, (msg) =>
    guarded('pet:bubble', () => {
      if (!isPetBubbleMsg(msg)) return reportToMain('warning', 'overlay: malformed pet:bubble ignored')
      if ('hide' in msg) {
        if (model.bubbleId === msg.id) model.setBubble(null)
        return bubble.hide(msg.id)
      }
      const size = bubble.show(msg.id, msg.text)
      model.setBubble({ id: msg.id, ...size })
      bridge.send(IPC.petBubbleShown, { id: msg.id, ...size } satisfies PetBubbleShownMsg)
    }),
  )

  // Subscribe before asking for the configuration, so nothing main sends meanwhile is lost.
  bridge.on(IPC.petState, (msg) => guarded('pet:state', () => model.onState(msg, performance.now())))
  bridge.on(IPC.petCursor, (msg) => guarded('pet:cursor', () => model.onCursor(msg, performance.now())))
  bridge.on(IPC.petHoverReset, (msg) => guarded('pet:hover-reset', () => model.onHoverReset(msg)))
  bridge.on(IPC.petVisible, (msg) =>
    guarded('pet:visible', () => {
      model.onVisible(msg)
      if (!model.visible) {
        // Hidden: no frames until shown again.
        if (rafId !== null) cancelAnimationFrame(rafId)
        rafId = null
        clearWake()
      }
    }),
  )
  bridge.on(IPC.petConfigChanged, (msg) =>
    guarded('pet:config-changed', () => {
      model.onConfigChanged(msg)
      worldView.redraw()
    }),
  )
  bridge.on(IPC.debugWorld, (msg) => guarded('debug:world', () => worldView.onMessage(msg)))
  bridge.on(IPC.petRedraw, () => guarded('pet:redraw', () => model.onRedraw()))
  bridge.on(IPC.debugPet, (msg) => guarded('debug:pet', () => model.onDevPet(msg)))
  // Always answered (counters are cheap; the sample lists stay empty unless config.debug): the dev panel shows rates.
  bridge.on(IPC.debugOverlayStatsRequest, () =>
    guarded('debug:overlay-stats-request', () => bridge.send(IPC.debugOverlayStats, model.stats(performance.now()))),
  )
  // Main's liveness watchdog: a page that stops answering is recreated.
  bridge.on(IPC.petPing, (msg) =>
    guarded('pet:ping', () => {
      if (isPetPingMsg(msg)) bridge.send(IPC.petPong, { id: msg.id } satisfies PetPongMsg)
    }),
  )
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault() // allow the restore (three.js does the same)
    guarded('webglcontextlost', () => model.onContextLost())
  })
  canvas.addEventListener('webglcontextrestored', () => guarded('webglcontextrestored', () => model.onContextRestored()))
  watchPixelRatio(() =>
    guarded('pixel ratio change', () => {
      model.onRedraw()
      worldView.redraw()
    }),
  )
  window.addEventListener('pagehide', () => grabArea?.close())

  bridge
    .invoke(IPC.petConfig)
    .then((reply) => {
      const config = model.onConfig(reply)
      if (!config) return
      worldView.redraw() // a debug:world that came before the configuration
      if (config.size !== query.size || config.paletteId !== query.paletteId) {
        const asked = `${config.size}, ${config.paletteId}`
        const drawn = `${query.size}, ${query.paletteId}`
        reportToMain('warning', `overlay: pet:config asks for (${asked}); drawing the page query's (${drawn})`)
      }
      const now = (): number => performance.now()
      grabArea = openGrabArea(
        config.hitWindowName,
        {
          move: (e) => model.onGrabMove(e, now()),
          rawMove: (e) => model.onGrabRawMove(e, now()),
          down: (e) => model.onGrabDown(e, now()),
          up: (e) => model.onGrabUp(e, now()),
          contextmenu: (e) => model.onGrabContextMenu(e, now()),
          leave: () => model.onGrabLeave(now()),
        },
        (message) => reportToMain('error', message),
      )
      // The first frame: the rest pose at the default 3/4 yaw (facing +1: M1 never turns, so no yaw easing).
      pet.rig.root.rotation.y = tuning.render.defaultYaw
      render(null, STANDING_SHADOW)
      const petBox = measurePetBox(pet)
      model.setPetBox(petBox)
      const ready: PetReadyMsg = {
        configSeq: config.configSeq,
        anchor: { x: pet.anchor.x, y: pet.anchor.y },
        petBox,
        edge: pet.width,
        devicePixelRatio: pixelRatio(),
        glRenderer: glRenderer(pet),
        hitWindowOpened: grabArea !== null,
      }
      bridge.send(IPC.petReady, ready)
    })
    .catch((err: unknown) => reportToMain('error', `overlay: start failed: ${errorText(err)}`))
}

/**
 * The world's debug view (dev builds, debug:world): a 2D canvas under the pet's canvas, covering the overlay, created
 * on the first message with show true and removed with show false, plus an outline of the pet's box above the pet.
 * The world is redrawn only when a message comes or the configuration or pixel ratio changes; the box only follows the
 * pet in frames that run anyway (petMoved). Neither takes input (pointer-events none; the overlay window ignores the
 * mouse anyway, §2).
 */
class WorldDebugView {
  private layer: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; box: HTMLDivElement } | null = null
  private msg: DebugWorldMsg | null = null
  private boxKey = ''

  constructor(
    private readonly petCanvas: HTMLCanvasElement,
    private readonly overlay: () => Rect | null,
    private readonly drawnBox: () => { ground: Point; box: Box } | null,
  ) {}

  get shown(): boolean {
    return this.msg !== null
  }

  onMessage(raw: unknown): void {
    if (!isDebugWorldMsg(raw)) {
      reportToMain('warning', 'overlay: malformed debug:world ignored')
      return
    }
    if (!raw.show) {
      this.msg = null
      this.layer?.canvas.remove()
      this.layer?.box.remove()
      this.layer = null
      this.boxKey = ''
      return
    }
    this.msg = raw
    this.redraw()
  }

  /** Draws the newest message again (a new message, configuration or pixel ratio). Nothing while hidden. */
  redraw(): void {
    const msg = this.msg
    const overlay = this.overlay()
    if (!msg || !overlay) return
    const layer = this.layer ?? this.create()
    if (!layer) return
    const dpr = pixelRatio()
    const backing = backingSize(overlay.width, overlay.height, dpr)
    layer.canvas.style.width = `${overlay.width}px`
    layer.canvas.style.height = `${overlay.height}px`
    // Assigning the size clears the canvas even when it is unchanged, so only when it changed.
    if (layer.canvas.width !== backing.width) layer.canvas.width = backing.width
    if (layer.canvas.height !== backing.height) layer.canvas.height = backing.height
    drawWorldView(layer.ctx, worldViewShapes(msg, overlay), backing, dpr)
    this.boxKey = ''
    this.petMoved()
  }

  /** Moves the pet's box outline to where the pet is drawn now, if that changed. */
  petMoved(): void {
    const layer = this.layer
    const overlay = this.overlay()
    if (!layer || !overlay) return
    const drawn = this.drawnBox()
    const rect = drawn ? petBoxRect(drawn.ground, drawn.box, overlay) : null
    const key = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : 'none'
    if (key === this.boxKey) return
    this.boxKey = key
    layer.box.style.display = rect ? 'block' : 'none'
    if (!rect) return
    layer.box.style.width = `${rect.width}px`
    layer.box.style.height = `${rect.height}px`
    layer.box.style.transform = `translate(${rect.x}px, ${rect.y}px)`
  }

  private create(): WorldDebugView['layer'] {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      reportToMain('warning', 'overlay: no 2D context for the world debug view')
      return null
    }
    canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none'
    // Under the pet's canvas, so the pet stays readable.
    this.petCanvas.before(canvas)
    const box = document.createElement('div')
    const { color, width } = tuning.dev.worldView.petBox
    box.style.cssText = `position:absolute;left:0;top:0;box-sizing:border-box;pointer-events:none;border:${width}px solid ${color}`
    this.petCanvas.after(box)
    this.layer = { canvas, ctx, box }
    return this.layer
  }
}

function pixelRatio(): number {
  const dpr = window.devicePixelRatio
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1
}

/** Calls `onChange` whenever the window's device pixel ratio changes (display change, scaling change). */
function watchPixelRatio(onChange: () => void): void {
  const query = matchMedia(`(resolution: ${pixelRatio()}dppx)`)
  query.addEventListener(
    'change',
    () => {
      onChange()
      watchPixelRatio(onChange)
    },
    { once: true },
  )
}

/**
 * The pet's projected box relative to the ground-contact point (pt) as the union over both facings, so it holds
 * whichever way the pet faces (main sizes the grab area and the click-through safety net with it).
 */
function measurePetBox(pet: PetScene): Box {
  const yaw = tuning.render.defaultYaw
  const box = pet.measureBox([yaw, -yaw])
  if (box) return box
  reportToMain('warning', 'overlay: the pet has no geometry to measure; using the whole canvas as its box')
  return { left: -pet.anchor.x, top: -pet.anchor.y, right: pet.width - pet.anchor.x, bottom: pet.height - pet.anchor.y }
}

/** The unmasked WebGL renderer string, when the browser exposes it. */
function glRenderer(pet: PetScene): string | null {
  try {
    const gl = pet.renderer.getContext()
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const value: unknown = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}
