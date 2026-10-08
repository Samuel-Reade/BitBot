import * as THREE from 'three'
import type { Box, Point } from '../../shared/geometry'
import { tuning } from '../../shared/tuning'
import { BASE_PARTS, type Palette, type PetSize } from '../../shared/types'
import type { PetAttach } from '../../shared/world'
import { buildBitbot, type BitbotRig } from './character/buildBitbot'
import { framePetCamera, framingReference, projectedBoundingBox, supportLineShadow } from './character/framing'
import { createHitTester } from './character/hitTest'
import { anchorsFor } from './placement'

// The pet's three.js scene: renderer, camera, lights and rig, laid out so that the pet's ground
// line lands exactly on `anchor` (CSS px) inside a viewport of width × height. Works the same for
// approach A (viewport = the small window) and B (viewport = a canvas element).
//
// Facing: set rig.root.rotation.y. render() and hitTest() notice a new yaw and re-place the
// camera (so the feet stay on the anchor row), re-clip the contact shadow and, with
// tuning.render.lights.followFacing, mirror the lights. Other motion (bob, jumps, tumbles) goes
// on rig.body / rig.figure and never moves the camera. setContactShadow() puts the shadow on the
// surface line under a lifted pet.
//
// Climbing (M3): on a wall the animator turns the figure a quarter turn about the ground-contact point (the root
// origin); turned, it reaches ~1.8 body heights to the side, past the canvas's half-width. setAnchor() moves the whole
// image within the viewport (camera.setViewOffset: a 2D translation, the perspective unchanged) so the contact point
// is drawn elsewhere: on the wall's anchor (tuning.render.climbAnchor, `anchors`), or in between while the pet turns.
// The hit tester raycasts through the same camera, so it follows the shift.
//
// The shift moves `anchor` (the rest pose's ground line, under the root origin) onto the new point. So the root
// origin, and with it the turned feet's line against the wall, lands exactly on the point's column, but ≈2 pt above
// its row at size M: the root origin is drawn that much above the ground line, the camera looking slightly down at the
// feet's front edge.

export interface PetSceneOptions {
  canvas: HTMLCanvasElement
  /** Viewport size in CSS px (1 CSS px = 1 pt on macOS). */
  width: number
  height: number
  size: PetSize
  palette: Palette
}

export interface PetScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly rig: BitbotRig
  /**
   * Viewport point (CSS px from top-left) where the pet touches the ground: put it on the surface
   * line the pet stands on. The lowest drawn point of the feet (at rest) is exactly on its row at
   * every yaw, and the root origin (the 3D ground-contact point) on its column. Nothing at rest is
   * drawn below the row: the contact shadow is clipped there.
   */
  readonly anchor: Readonly<{ x: number; y: number }>
  /** Where the ground-contact point is drawn for each attach (CSS px): `anchor` standing, tuning.render.climbAnchor on a wall. */
  readonly anchors: Readonly<Record<PetAttach, Readonly<Point>>>
  /** Where the ground-contact point is drawn now (setAnchor; initially `anchor`). */
  readonly drawnAnchor: Readonly<Point>
  readonly width: number
  readonly height: number
  /** Scene units → points at the root's depth. The drawn body box is tuning.render.bodyHeightPt tall at the default yaw. */
  readonly ptPerUnit: number
  render(): void
  /** Draws (and hit-tests) the ground-contact point at this viewport point (CSS px) from now on: see the header. */
  setAnchor(point: Point): void
  /** True if the viewport point (CSS px) is over the pet. */
  hitTest(x: number, y: number): boolean
  /**
   * Contact shadow (§6.1) on the surface line `elevationPt` below the pet's ground-contact point (0 = standing on
   * it; the rest pose), at `strength` 0..1 (0 hides it). Takes effect at the next render.
   */
  setContactShadow(elevationPt: number, strength: number): void
  /**
   * The pet's projected box relative to `anchor` (pt) as the union over `yaws`, standing: everything the rig can draw
   * or be hit at, hit proxies and the resting contact shadow included. Restores the current yaw and anchor. Null for an
   * empty rig.
   */
  measureBox(yaws: readonly number[]): Box | null
  dispose(): void
}

export function createPetScene(opts: PetSceneOptions): PetScene {
  const { canvas, width, height, size, palette } = opts
  const { pixelRatioCap, defaultYaw, lights } = tuning.render

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap))
  renderer.setSize(width, height, true)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping
  renderer.setClearColor(0x000000, 0)
  // The contact shadow is clipped at the ground line (see below).
  renderer.localClippingEnabled = true

  const scene = new THREE.Scene()

  // §6.1 lighting: hemisphere (sky white, ground #88aaa5), key from upper-right-front, cool rim
  // from back-left. The pet turns underneath them.
  // SPEC-DEVIATION: every intensity is multiplied by tuning.render.lights.unitScale (2.75). The
  // §6.1 values (0.75 / 0.9 / 0.6) were authored for three.js' legacy light units; since r155,
  // lights are physical and a Lambert surface reflects intensity/π, so the spec numbers render
  // far too dark (the placeholder box's front read #5B847E instead of mint #7FD1C7). 2.75 was
  // calibrated from snapshots so a palette's primary reads at about its hex on the key-lit front
  // at the default yaw (π overexposes it ~14%). Directions, colors and the ratios between the
  // lights are §6.1's. Measured luminance at the default yaw relative to the front: the visible
  // side wall ~48% (it faces away from the key), the top ~124%.
  // SPEC-DEVIATION: with tuning.render.lights.followFacing (default on), the key and rim lights
  // mirror left/right with the facing (eased with the yaw): from upper-LEFT-front and back-right
  // when the pet faces left. With screen-fixed lights a left-facing pet's front is 28% darker and
  // its top 1.6× brighter than its front, so it looked like a different color walking left.
  const k = lights.unitScale
  const hemisphere = new THREE.HemisphereLight(lights.hemisphere.sky, lights.hemisphere.ground, lights.hemisphere.intensity * k)
  const key = new THREE.DirectionalLight(lights.key.color, lights.key.intensity * k)
  const rim = new THREE.DirectionalLight(lights.rim.color, lights.rim.intensity * k)
  scene.add(hemisphere, key, rim)
  const aimLights = (yaw: number): void => {
    // +1 at the default (right-facing) yaw or beyond, −1 mirrored, 0 facing straight out.
    const facing = lights.followFacing ? THREE.MathUtils.clamp(Math.sin(yaw) / Math.sin(defaultYaw), -1, 1) : 1
    key.position.set(...swingAzimuth(lights.key.position, facing))
    rim.position.set(...swingAzimuth(lights.rim.position, facing))
  }

  const rig = buildBitbot({ formId: 'base', palette, parts: BASE_PARTS })
  rig.root.rotation.y = defaultYaw
  scene.add(rig.root)

  // The camera keeps three.js' default layer mask (layer 0 only), so the hit proxies on
  // HIT_LAYER are never drawn. The reference is the rig's rest pose, taken before it ever moves.
  const camera = new THREE.PerspectiveCamera()
  const framing = framePetCamera(camera, width, height, size, framingReference(rig), rig.root.rotation.y)

  // SPEC-DEVIATION: §6.1's contact shadow is an ellipse on the 3D ground plane. Seen from the
  // slightly raised camera its front half is drawn below the feet, i.e. below the surface line,
  // over the window's title bar (or the Dock / screen edge, which hide it). Clipping it at the
  // ground line makes it look the same on every surface and keeps the pet from painting into
  // the window it stands on. Size, color and opacity are §6.1's. A lifted pet's shadow is drawn on
  // the surface line below it, clipped the same way at that line (supportLineShadow).
  const supportLine = new THREE.Plane()
  rig.shadow?.clipTo(supportLine)
  const shadowRestY = rig.shadow?.mesh.position.y ?? 0
  let shadowElevation = 0

  const anchors = anchorsFor(width, height, framing.anchor)
  let drawnAnchor: Point = { ...framing.anchor }
  /** Shifts the image so `anchor` is drawn at `point` (a view offset of the opposite amount). */
  const placeView = (point: Point): void => {
    drawnAnchor = { x: point.x, y: point.y }
    const dx = framing.anchor.x - point.x
    const dy = framing.anchor.y - point.y
    if (dx === 0 && dy === 0) camera.clearViewOffset()
    else camera.setViewOffset(width, height, dx, dy, width, height)
  }

  let syncedYaw = Number.NaN
  let syncedElevation = Number.NaN
  const sync = (): void => {
    const yaw = rig.root.rotation.y
    const yawChanged = yaw !== syncedYaw
    if (yawChanged) {
      syncedYaw = yaw
      framing.placeForYaw(yaw)
      aimLights(yaw)
    }
    if (!yawChanged && shadowElevation === syncedElevation) return
    syncedElevation = shadowElevation
    const placement = supportLineShadow(framing, shadowElevation)
    framing.linePlaneAt(placement.clipRow, supportLine)
    if (rig.shadow) rig.shadow.mesh.position.y = shadowRestY - placement.drop
  }
  sync()

  const hitTester = createHitTester(rig, camera, width, height)

  return {
    renderer,
    scene,
    camera,
    rig,
    anchor: framing.anchor,
    anchors,
    get drawnAnchor() {
      return drawnAnchor
    },
    width,
    height,
    ptPerUnit: framing.ptPerUnit,
    render() {
      sync()
      renderer.render(scene, camera)
    },
    setAnchor(point) {
      if (Number.isFinite(point.x) && Number.isFinite(point.y) && (point.x !== drawnAnchor.x || point.y !== drawnAnchor.y)) placeView(point)
    },
    hitTest(x, y) {
      sync()
      return hitTester(x, y)
    },
    setContactShadow(elevationPt, strength) {
      shadowElevation = Number.isFinite(elevationPt) ? Math.max(0, elevationPt) : 0
      rig.shadow?.setStrength(Number.isFinite(strength) ? strength : 0)
    },
    measureBox(yaws) {
      const savedYaw = rig.root.rotation.y
      const savedElevation = shadowElevation
      const savedAnchor = drawnAnchor
      shadowElevation = 0
      placeView(framing.anchor)
      let left = Infinity
      let top = Infinity
      let right = -Infinity
      let bottom = -Infinity
      for (const yaw of yaws) {
        rig.root.rotation.y = yaw
        sync() // re-places the camera for this yaw, as a render would
        const e = projectedBoundingBox(rig.root, camera, width, height)
        if (!e) continue
        left = Math.min(left, e.left)
        top = Math.min(top, e.top)
        right = Math.max(right, e.right)
        bottom = Math.max(bottom, e.bottom)
      }
      rig.root.rotation.y = savedYaw
      shadowElevation = savedElevation
      placeView(savedAnchor)
      sync()
      rig.root.updateMatrixWorld(true)
      if (!Number.isFinite(left)) return null
      const { x, y } = framing.anchor
      return { left: left - x, top: top - y, right: right - x, bottom: bottom - y }
    },
    dispose() {
      rig.dispose()
      key.dispose()
      rim.dispose()
      hemisphere.dispose()
      renderer.dispose()
    },
  }
}

/**
 * A light position mirrored left/right by `facing` (1 = as given, −1 = x mirrored), moving
 * through an azimuth swing about the vertical axis: its elevation and distance stay constant, so
 * a pet turning between facings keeps even shading (moving x linearly through 0 would put the
 * key light overhead mid-turn and flare the top of the body).
 */
function swingAzimuth([x, y, z]: readonly [number, number, number], facing: number): [number, number, number] {
  const radius = Math.hypot(x, z)
  const back = z < 0 ? -1 : 1
  const azimuth = Math.atan2(x, back * z) * facing
  return [radius * Math.sin(azimuth), y, back * radius * Math.cos(azimuth)]
}
