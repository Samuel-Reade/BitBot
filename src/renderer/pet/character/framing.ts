import * as THREE from 'three'
import { tuning } from '../../../shared/tuning'
import type { PetSize } from '../../../shared/types'
import type { BitbotRig } from './buildBitbot'
import { BODY_HEIGHT_UNITS, SPEC_ORIGIN_HEIGHT } from './construction'

// Camera framing for the pet viewport (§6.1 camera, §5.2 viewport). Pure three.js math, no WebGL,
// so tests can check it numerically.
//
// The pet lives in a 2D world: it stands on surface LINES (window tops, the Dock, the bottom of
// the screen). §6.1's camera looks slightly down, so the rig's 3D ground-contact point (the root
// origin, under the body center) is not where the feet are SEEN to touch: the feet reach forward
// of it and their lower front edge is drawn up to ~6 pt lower at size M, more or less depending
// on the yaw. So the framing moves the camera (translation only: FOV, angle and distance stay
// §6.1's) until
//   - the lowest drawn point of the rest-pose feet, the pet's "ground line", lands on anchor.y,
//     re-solved whenever the yaw changes (placeForYaw), and the root origin lands on anchor.x;
//   - the drawn body box is exactly tuning.render.bodyHeightPt[size] tall at the default yaw.
// Consumers put `anchor` on the surface line (Spike A: on the work-area bottom) and the feet rest
// exactly on it at every yaw.

/** Rest-pose shape the framing measures, as xyz triples in root space (the rig unrotated). */
export interface FramingReference {
  /** Points of the body box: its drawn height at the default yaw sets the scale. Null: nominal scale. */
  readonly body: Float64Array | null
  /** Points of what stands on the ground at rest (the feet): their lowest drawn point is the ground line. Null: the root origin. */
  readonly footprint: Float64Array | null
}

export interface PetFraming {
  /**
   * Viewport point (CSS px from the top-left) on the pet's ground line: the lowest drawn point of
   * the rest-pose feet is on its row, the root origin on its column.
   */
  readonly anchor: Readonly<{ x: number; y: number }>
  /** Scene units → points at the root's depth (world z = 0). */
  readonly ptPerUnit: number
  /** Camera distance from the root's depth plane. */
  readonly distance: number
  /** The rig yaw the camera is currently placed for. */
  readonly yaw: number
  /** Moves the camera (translation only) so the ground line of the rig at `yaw` sits on the anchor. False if it already did. */
  placeForYaw(yaw: number): boolean
  /**
   * Writes the world-space plane through the camera center and the anchor row into `target`:
   * everything drawn above the ground line is on its positive side. Valid until the next placeForYaw.
   */
  groundLinePlane(target: THREE.Plane): THREE.Plane
}

/** Footprint fallback when the rig has no feet: the root origin itself. */
const ORIGIN = new Float64Array([0, 0, 0])
/** Solver tolerance, viewport px. */
const EPSILON_PX = 1e-7

/**
 * Sets up `camera` (§6.1: FOV, slight top-down angle) for a width × height viewport and places it
 * for the rig at `yaw`; see the header comment for what lands where. Without a reference the
 * scale is nominal (BODY_HEIGHT_UNITS = bodyHeightPt at the root's depth) and the root origin is
 * the ground line.
 */
export function framePetCamera(
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  size: PetSize,
  reference: FramingReference | null = null,
  yaw: number = tuning.render.defaultYaw,
): PetFraming {
  const { camera: cam, anchor: anchorFraction, bodyHeightPt, defaultYaw } = tuning.render
  const anchor = { x: width * anchorFraction.x, y: height * anchorFraction.y }
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(cam.fovDeg) / 2)
  const footprint = reference?.footprint ?? ORIGIN
  // All math runs on a private camera, so a view offset set on `camera` (Spike A's fullscreen
  // variant) can never skew it; `camera` only receives the results.
  const probe = new THREE.PerspectiveCamera(cam.fovDeg, width / height, 0.1, 100)
  const viewProjection = new THREE.Matrix4()

  let ptPerUnit = 0
  let distance = 0
  // Camera target (look-at point) on the z = 0 plane; the camera sits heightAboveTarget above it.
  let tx = 0
  let ty = SPEC_ORIGIN_HEIGHT
  let placedYaw = Number.NaN

  const setScale = (value: number): void => {
    ptPerUnit = value
    distance = height / (2 * tanHalfFov * value)
    probe.near = 0.1
    probe.far = distance * 4
    probe.updateProjectionMatrix()
  }
  const aim = (): void => {
    probe.position.set(tx, ty + cam.heightAboveTarget, distance)
    probe.lookAt(tx, ty, 0)
    probe.updateMatrixWorld(true)
    viewProjection.multiplyMatrices(probe.projectionMatrix, probe.matrixWorldInverse)
  }
  // Solves the target so the ground line at `yaw` lands on the anchor. A camera move shifts the
  // image by ~ptPerUnit px per unit (a few % more for the feet, which are nearer), so this
  // converges by ~20× per step; a warm start (small yaw change) needs 3–5 steps.
  const solve = (atYaw: number): void => {
    for (let i = 0; i < 32; i++) {
      aim()
      const ex = projectedX(viewProjection, width) - anchor.x
      const ey = anchor.y - projectedYRange(viewProjection, footprint, atYaw, height).max
      if (Math.abs(ex) < EPSILON_PX && Math.abs(ey) < EPSILON_PX) return
      // Drawn too far right → move the camera right; drawn too high → move the camera up.
      tx += ex / ptPerUnit
      ty += ey / ptPerUnit
    }
    aim()
  }

  setScale(bodyHeightPt[size] / BODY_HEIGHT_UNITS)
  if (reference?.body) {
    // The drawn body is taller than BODY_HEIGHT_UNITS · ptPerUnit (its front is nearer the camera
    // and a sliver of its top shows), so scale until the drawn box is exactly bodyHeightPt.
    for (let i = 0; i < 16; i++) {
      solve(defaultYaw)
      const drawn = projectedYRange(viewProjection, reference.body, defaultYaw, height)
      const ratio = bodyHeightPt[size] / (drawn.max - drawn.min)
      setScale(ptPerUnit * ratio)
      if (Math.abs(ratio - 1) < 1e-12) break
    }
  }

  camera.fov = cam.fovDeg
  camera.aspect = width / height
  camera.near = probe.near
  camera.far = probe.far
  camera.updateProjectionMatrix()

  const framing: PetFraming = {
    anchor,
    get ptPerUnit() {
      return ptPerUnit
    },
    get distance() {
      return distance
    },
    get yaw() {
      return placedYaw
    },
    placeForYaw(nextYaw) {
      if (nextYaw === placedYaw) return false
      solve(nextYaw)
      placedYaw = nextYaw
      camera.position.copy(probe.position)
      camera.quaternion.copy(probe.quaternion)
      camera.updateMatrixWorld(true)
      return true
    },
    groundLinePlane(target) {
      // The camera center and two points on the anchor row span the plane.
      const ndcY = 1 - (2 * anchor.y) / height
      const left = new THREE.Vector3(-1, ndcY, 0.5).unproject(probe)
      const right = new THREE.Vector3(1, ndcY, 0.5).unproject(probe)
      target.setFromCoplanarPoints(probe.position, left, right)
      const above = new THREE.Vector3(0, ndcY + 0.5, 0.5).unproject(probe)
      if (target.distanceToPoint(above) < 0) target.negate()
      return target
    },
  }
  framing.placeForYaw(yaw)
  return framing
}

/**
 * Takes the framing reference from a rig at rest (right after buildBitbot, before anything
 * animates it): the body mesh, and the feet as the footprint. Works whatever the root's yaw.
 */
export function framingReference(rig: Pick<BitbotRig, 'root' | 'parts'>): FramingReference {
  rig.root.updateMatrixWorld(true)
  const toRoot = rig.root.matrixWorld.clone().invert()
  return {
    body: rig.parts.body ? drawnVertices(rig.parts.body, toRoot) : null,
    footprint: rig.parts.feet ? drawnVertices(rig.parts.feet, toRoot) : null,
  }
}

/** Vertices of every mesh the pet camera draws (layer 0) under `object`, in root space. */
function drawnVertices(object: THREE.Object3D, toRoot: THREE.Matrix4): Float64Array {
  const out: number[] = []
  const toRootFromMesh = new THREE.Matrix4()
  const v = new THREE.Vector3()
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.layers.isEnabled(0)) return
    toRootFromMesh.multiplyMatrices(toRoot, o.matrixWorld)
    const position = o.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(toRootFromMesh)
      out.push(v.x, v.y, v.z)
    }
  })
  return new Float64Array(out)
}

/** Viewport x (CSS px) of the world origin. */
function projectedX(viewProjection: THREE.Matrix4, width: number): number {
  const e = viewProjection.elements
  return (((e[12] ?? 0) / (e[15] ?? 1) + 1) / 2) * width
}

/** Viewport y range (CSS px, down = larger) of root-space `points` with the root turned by `yaw` about +y. */
function projectedYRange(viewProjection: THREE.Matrix4, points: Float64Array, yaw: number, height: number): { min: number; max: number } {
  const e = viewProjection.elements
  const at = (i: number): number => e[i] ?? 0
  // Column-major: ndc.y = (row 1 · p) / (row 3 · p).
  const [e1, e5, e9, e13] = [at(1), at(5), at(9), at(13)]
  const [e3, e7, e11, e15] = [at(3), at(7), at(11), at(15)]
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i + 2 < points.length; i += 3) {
    const px = points[i] ?? 0
    const py = points[i + 1] ?? 0
    const pz = points[i + 2] ?? 0
    // Rotation about +y (three.js rotation.y): x' = x cos + z sin, z' = −x sin + z cos.
    const x = px * cos + pz * sin
    const z = pz * cos - px * sin
    const ndcY = (e1 * x + e5 * py + e9 * z + e13) / (e3 * x + e7 * py + e11 * z + e15)
    const y = ((1 - ndcY) / 2) * height
    if (y < min) min = y
    if (y > max) max = y
  }
  return { min, max }
}

/** Projects a world-space point to viewport CSS px (from the top-left). */
export function projectToViewport(point: THREE.Vector3, camera: THREE.Camera, width: number, height: number): { x: number; y: number } {
  const ndc = point.clone().project(camera)
  return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height }
}

export interface ViewportExtents {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/**
 * Screen-space bounds (CSS px) of every mesh under `root` that `camera` renders (its layers,
 * visible only), from the actual vertices. Used to check the pet fits its viewport. Ignores
 * clipping planes (the contact shadow's ground-line clip).
 */
export function measureViewportExtents(root: THREE.Object3D, camera: THREE.Camera, width: number, height: number): ViewportExtents {
  root.updateMatrixWorld(true)
  camera.updateMatrixWorld(true)
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  const v = new THREE.Vector3()
  root.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh) || !object.layers.test(camera.layers)) return
    const position = object.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld).project(camera)
      const x = ((v.x + 1) / 2) * width
      const y = ((1 - v.y) / 2) * height
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  })
  return { left, right, top, bottom }
}
