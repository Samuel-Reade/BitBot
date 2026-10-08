// The production pet page: the overlay renderer of approach B, hardened (docs/decisions/overlay.md "Decision").
// Main owns the simulation and says where the pet is (pet:state); this page draws it on a small canvas that it moves
// with a compositor transform, renders WebGL only when something visible changed (§11 render on demand), and takes
// the pet's mouse input through the grab area it opens (hitWindow.ts). The decisions are OverlayModel's
// (placement.ts); this file wires them to the DOM, three.js and IPC.
//
// Fail closed: a malformed configuration starts nothing (no grab area, no pet:ready, so main recreates the page); a
// grab area that did not open never reports a hover, so main never makes it clickable.

import { IPC } from '../../shared/ipc'
import type { Box } from '../../shared/geometry'
import type { PetLogMsg, PetReadyMsg } from '../../shared/petProtocol'
import { tuning } from '../../shared/tuning'
import type { PaletteId, PetSize } from '../../shared/types'
import { openGrabArea, type GrabArea } from './hitWindow'
import { OverlayModel, STANDING_SHADOW, type ContactShadowParams } from './placement'
import type { PetScene } from './scene'

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
  let grabArea: GrabArea | null = null
  const requestFrame = (): void => {
    if (rafId === null) rafId = requestAnimationFrame(onFrame)
  }
  const model = new OverlayModel(
    { edge: pet.width, anchor: pet.anchor, devicePixelRatio: pixelRatio() },
    {
      hitTest: (x, y) => pet.hitTest(x, y),
      send: (channel, payload) => bridge.send(channel, payload),
      requestFrame,
      log: reportToMain,
    },
  )
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
      if (plan.again) requestFrame()
    })
  }

  // Subscribe before asking for the configuration, so nothing main sends meanwhile is lost.
  bridge.on(IPC.petState, (msg) => guarded('pet:state', () => model.onState(msg, performance.now())))
  bridge.on(IPC.petCursor, (msg) => guarded('pet:cursor', () => model.onCursor(msg, performance.now())))
  bridge.on(IPC.petHoverReset, (msg) => guarded('pet:hover-reset', () => model.onHoverReset(msg)))
  bridge.on(IPC.petVisible, (msg) =>
    guarded('pet:visible', () => {
      model.onVisible(msg)
      if (!model.visible && rafId !== null) {
        cancelAnimationFrame(rafId) // hidden: no frames until shown again
        rafId = null
      }
    }),
  )
  bridge.on(IPC.petConfigChanged, (msg) => guarded('pet:config-changed', () => model.onConfigChanged(msg)))
  bridge.on(IPC.petRedraw, () => guarded('pet:redraw', () => model.onRedraw()))
  bridge.on(IPC.debugOverlayStatsRequest, () =>
    guarded('debug:overlay-stats-request', () => {
      if (model.debug) bridge.send(IPC.debugOverlayStats, model.stats(performance.now()))
    }),
  )
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault() // allow the restore (three.js does the same)
    guarded('webglcontextlost', () => model.onContextLost())
  })
  canvas.addEventListener('webglcontextrestored', () => guarded('webglcontextrestored', () => model.onContextRestored()))
  watchPixelRatio(() => guarded('pixel ratio change', () => model.onRedraw()))
  window.addEventListener('pagehide', () => grabArea?.close())

  bridge
    .invoke(IPC.petConfig)
    .then((reply) => {
      const config = model.onConfig(reply)
      if (!config) return
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
      const ready: PetReadyMsg = {
        configSeq: config.configSeq,
        anchor: { x: pet.anchor.x, y: pet.anchor.y },
        petBox: measurePetBox(pet),
        edge: pet.width,
        devicePixelRatio: pixelRatio(),
        glRenderer: glRenderer(pet),
        hitWindowOpened: grabArea !== null,
      }
      bridge.send(IPC.petReady, ready)
    })
    .catch((err: unknown) => reportToMain('error', `overlay: start failed: ${errorText(err)}`))
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
