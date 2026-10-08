import { Vector3 } from 'three'
import { IPC } from '../../shared/ipc'
import { DEFAULT_PALETTE_ID, PALETTES, isPaletteId } from '../../shared/palettes'
import { tuning } from '../../shared/tuning'
import { isBehaviorState, isMood, type PetSize } from '../../shared/types'
import type { Box } from '../../shared/geometry'
import { boxFor, isPetAttach, type PetAttach } from '../../shared/world'
import { Animator, type AnimInput } from './character/animator'
import { addAttachMarkers, showHitProxies } from './character/debugViews'
import { isEyesState, isFaceOverlay, isMouthState } from './character/face'
import { measureViewportExtents, projectToViewport } from './character/framing'
import { installOverlayErrorReporting, startOverlay } from './overlay'
import { anchorForTurn } from './placement'
import { createPetScene } from './scene'

// Pet renderer entry. Query params select the mode:
//   (no mode)      the overlay: the production pet page (overlay.ts); main passes size and palette
//   mode=snapshot  render one frame for the PNG dev tool (see src/main/dev/snapshot.ts)
//   mode=spike     hand over to the Spike A renderer harness
const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'overlay'
const isOverlay = mode !== 'snapshot' && mode !== 'spike'
// Before anything can throw (creating the WebGL context), so main hears about it.
if (isOverlay) installOverlayErrorReporting()
const paletteParam = params.get('palette')
const palette = PALETTES[isPaletteId(paletteParam) ? paletteParam : DEFAULT_PALETTE_ID]
const sizeParam = params.get('size')
const size: PetSize = sizeParam === 'S' || sizeParam === 'L' ? sizeParam : 'M'
const edge = Math.round(tuning.render.bodyHeightPt[size] * tuning.render.viewportScale)

const canvas = document.getElementById('pet')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('pet canvas missing')

const pet = createPetScene({ canvas, width: edge, height: edge, size, palette })

if (mode === 'snapshot') {
  // Options (all optional): bg=transparent|checker|<css color>  yaw=<radians>
  //   eyes=open|blink  mouth=smile  overlays=blush,...  frame=<n>  shadow=<0..1>
  //   state=<behavior state> [t=<seconds into it, default 1>] [mood=<mood>] [dust=<0..1>] [facing=1|-1]
  //     (pose the pet with the animator, continuous idle style, as it looks t seconds into that state)
  //   attach=floor|wallRight|wallLeft  (with state=: on a wall, turned onto it about the contact point, which is drawn
  //     on the wall's anchor, or on the way there for t below tuning.anim.blendS)
  //   show=hit,attach,anchor,box,measure,hitmask  (hit proxies, attach-point markers, anchor crosshair, the pet's
  //   box as main uses it (measured at rest, turned for attach= by boxFor), log numbers, or ONLY the region where
  //   pet.hitTest() is true, one sample per pt, for diffing)
  //   (not 'debug=': Electron's Node treats --debug as its own, removed flag and exits)
  const bg = params.get('bg') ?? 'transparent'
  if (bg === 'checker') {
    document.body.style.background = 'repeating-conic-gradient(#d8d8d8 0% 25%, #f4f4f4 0% 50%) 0 0 / 16px 16px'
  } else if (bg !== 'transparent') {
    document.body.style.background = bg
  }
  const yaw = params.get('yaw')
  if (yaw !== null && Number.isFinite(Number(yaw))) pet.rig.root.rotation.y = Number(yaw)
  const attachParam = params.get('attach')
  const attach: PetAttach = isPetAttach(attachParam) ? attachParam : 'floor'
  const show = new Set((params.get('show') ?? '').split(',').filter(Boolean))
  // Measured at rest, as the overlay measures it for pet:ready.
  const restBox = show.has('box') ? pet.measureBox([tuning.render.defaultYaw, -tuning.render.defaultYaw]) : null
  // The anchor moves with the turn onto the wall, as the overlay moves it (placement.ts).
  pet.setAnchor(anchorForTurn(pet.anchors, applySnapshotPose(params, attach)))
  applySnapshotFace(params)
  const shadow = params.get('shadow')
  if (shadow !== null && Number.isFinite(Number(shadow))) pet.rig.shadow?.setStrength(Number(shadow))
  else if (attach !== 'floor') pet.rig.shadow?.setStrength(0) // as the overlay draws it: no shadow on a wall
  if (show.has('hit')) showHitProxies(pet.camera, true)
  if (show.has('attach')) addAttachMarkers(pet.rig)
  if (show.has('anchor')) drawAnchorCrosshair(pet.drawnAnchor)
  if (restBox) drawBox(pet.drawnAnchor, boxFor(restBox, attach))
  if (show.has('hitmask')) pet.rig.root.visible = false // raycasting ignores visibility
  pet.render()
  if (show.has('hitmask')) drawHitMask()
  if (show.has('measure')) logSnapshotMeasurements()
  // Give the compositor a moment to present the frame before the main process captures it.
  setTimeout(() => window.bitbot.send(IPC.snapshotReady), tuning.dev.snapshotPresentDelayMs)
} else if (mode === 'spike') {
  void import('../spike/petSpike').then(({ startPetSpike }) => startPetSpike(pet, params))
} else {
  startOverlay(pet, { size, paletteId: palette.id })
}

// ---- Snapshot-mode helpers -------------------------------------------------------------------

/** Poses the pet as the query says; returns how far it is turned onto a wall (AnimResult.wallTurn; 0 without a state). */
function applySnapshotPose(query: URLSearchParams, attach: PetAttach): number {
  const state = query.get('state')
  if (!isBehaviorState(state)) return 0
  const mood = query.get('mood')
  const t = Number(query.get('t') ?? '1')
  const dust = Number(query.get('dust') ?? '0')
  const facing = query.get('facing') === '-1' ? -1 : 1
  // A fixed random source, so a snapshot is the same every run.
  let seed = 1
  const animator = new Animator(pet.rig, { ptPerUnit: pet.ptPerUnit, random: () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646 })
  const input: AnimInput = {
    state,
    mood: isMood(mood) ? mood : 'content',
    dust: Number.isFinite(dust) ? Math.min(1, Math.max(0, dust)) : 0,
    facing,
    look: null,
    attach,
    held: null,
    faceOverride: null,
    idleMode: 'continuous',
  }
  // Step into the state at 60 fps, so springs and blends are where they would be.
  const end = Number.isFinite(t) && t >= 0 ? t * 1000 : 1000
  for (let ms = 0; ms < end; ms += 1000 / 60) animator.update(ms, input)
  return animator.update(end, input).wallTurn ?? 0
}

function applySnapshotFace(query: URLSearchParams): void {
  const eyes = query.get('eyes')
  const mouth = query.get('mouth')
  const overlays = query.get('overlays')
  const frame = query.get('frame') // the animated overlays' frame index
  pet.rig.face?.setState({
    ...(isEyesState(eyes) ? { eyes } : {}),
    ...(isMouthState(mouth) ? { mouth } : {}),
    ...(overlays !== null ? { overlays: overlays.split(',').filter(isFaceOverlay) } : {}),
    ...(frame !== null && /^\d+$/.test(frame) ? { frame: Number(frame) } : {}),
  })
}

function drawAnchorCrosshair(anchor: Readonly<{ x: number; y: number }>): void {
  for (const vertical of [false, true]) {
    const line = document.createElement('div')
    line.style.cssText = vertical
      ? `position:absolute;left:${anchor.x - 0.5}px;top:0;width:1px;height:100%;background:rgba(255,0,0,.6)`
      : `position:absolute;top:${anchor.y - 0.5}px;left:0;height:1px;width:100%;background:rgba(255,0,0,.6)`
    document.body.appendChild(line)
  }
}

/** Outlines `box` (relative to the viewport point `at`, CSS px). */
function drawBox(at: Readonly<{ x: number; y: number }>, box: Box): void {
  const outline = document.createElement('div')
  const { left, top, right, bottom } = box
  outline.style.cssText = `position:absolute;left:${at.x + left}px;top:${at.y + top}px;width:${right - left}px;height:${bottom - top}px;box-sizing:border-box;border:1px solid rgba(0,90,255,.8)`
  document.body.appendChild(outline)
}

/**
 * Logs where the pet lands vs the anchor and its drawn extents, from the rendered camera (run
 * Electron with --enable-logging). groundLineErrorPx = lowest drawn foot point − anchor row (0 =
 * feet exactly on the surface line); the root origin sits rootOriginAbovePx above the row.
 */
function logSnapshotMeasurements(): void {
  const { rig, camera, width, height, anchor } = pet
  const origin = projectToViewport(rig.root.localToWorld(new Vector3(0, 0, 0)), camera, width, height)
  const feet = rig.parts.feet ? measureViewportExtents(rig.parts.feet, camera, width, height) : null
  const body = rig.parts.body ? measureViewportExtents(rig.parts.body, camera, width, height) : null
  console.info(
    `[snapshot-measure] ${JSON.stringify({
      viewport: [width, height],
      anchor,
      drawnAnchor: pet.drawnAnchor,
      yaw: rig.root.rotation.y,
      groundLineErrorPx: feet ? feet.bottom - anchor.y : null,
      rootOriginXErrorPx: origin.x - anchor.x,
      rootOriginAbovePx: anchor.y - origin.y,
      rootOriginPx: origin,
      bodyDrawnPt: body ? [body.right - body.left, body.bottom - body.top] : null,
      ptPerUnit: pet.ptPerUnit,
      // Shadow excluded: it is clipped at the ground line when drawn.
      figure: measureViewportExtents(rig.figure, camera, width, height),
      devicePixelRatio: window.devicePixelRatio,
      drawCalls: pet.renderer.info.render.calls,
      triangles: pet.renderer.info.render.triangles,
    })}`,
  )
}

/** Paints every viewport point (sampled at pt centers) where pet.hitTest() is true. */
function drawHitMask(): void {
  const overlay = document.createElement('canvas')
  overlay.width = pet.width
  overlay.height = pet.height
  overlay.style.cssText = `position:absolute;left:0;top:0;width:${pet.width}px;height:${pet.height}px;image-rendering:pixelated`
  const ctx = overlay.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#ff00ff'
  const started = performance.now()
  for (let y = 0; y < pet.height; y++) for (let x = 0; x < pet.width; x++) if (pet.hitTest(x + 0.5, y + 0.5)) ctx.fillRect(x, y, 1, 1)
  console.info(`[snapshot-measure] hitmask ${pet.width}x${pet.height} in ${(performance.now() - started).toFixed(0)} ms`)
  document.body.appendChild(overlay)
}
