import * as THREE from 'three'
import { tuning } from '../../../shared/tuning'
import { ARM_CENTER_OFFSET, BASE_FORM, outerSize } from './construction'
import { roundedBoxGeometry, type RoundedBoxQuality } from './geometry'

// Pointer hit-testing (§5.2): simplified, slightly inflated collision proxies parented next to the
// meshes they stand for, so they follow every animated joint. They live ONLY on HIT_LAYER: the
// camera renders layer 0, so they are never drawn, and the hit tester (hitTest.ts) raycasts only HIT_LAYER.
// tuning.render.hit sets how forgiving they are.

/** three.js layer holding the hit proxies (never rendered by the pet camera). */
export const HIT_LAYER = 1

const PROXY_QUALITY: RoundedBoxQuality = { curveSegments: 3, bevelSegments: 2 }

export type HitProxyId = 'body' | 'rearCasing' | 'screen' | 'antennaTip' | 'antennaCable' | 'armL' | 'armR' | 'footL' | 'footR'

/** Debug look only (dev overlay / snapshot `--show=hit`): enable HIT_LAYER on a camera to see them. */
export function createHitProxyMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    name: 'hit-proxy',
    color: 0xff00ff,
    wireframe: true,
    transparent: true,
    opacity: 0.7,
    depthTest: false,
  })
}

export function hitProxy(id: HitProxyId, geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `hit:${id}`
  mesh.layers.set(HIT_LAYER)
  return mesh
}

const margin = (): number => tuning.render.hit.margin

/** Body box, rounded like the body, inflated by the margin. Spec space, centered on the body. */
export function bodyProxyGeometry(): THREE.BufferGeometry {
  const b = BASE_FORM.body
  return roundedBoxGeometry({ ...b, bevel: b.bevel + margin() }, PROXY_QUALITY)
}

/** Rear casing, inflated. Centered on the casing. */
export function rearCasingProxyGeometry(): THREE.BufferGeometry {
  const c = BASE_FORM.rearCasing
  return roundedBoxGeometry({ ...c, bevel: c.bevel + margin() }, PROXY_QUALITY)
}

/**
 * Bezel + bulged screen, which stand proud of the body front (z 0.59) by up to 0.1: a box from
 * the bezel's back face to just in front of the screen's crown. Centered at the bezel's (x, y).
 * Returns the geometry and the z of its center in spec space.
 */
export function screenProxyGeometry(): { geometry: THREE.BufferGeometry; z: number } {
  const m = margin()
  const bezel = outerSize(BASE_FORM.bezel)
  const s = BASE_FORM.screen
  const back = BASE_FORM.bezel.position[2] - bezel.depth / 2
  const front = s.position[2] + s.forwardOffset + s.bulgeBase + m
  return { geometry: new THREE.BoxGeometry(bezel.w + 2 * m, bezel.h + 2 * m, front - back), z: (front + back) / 2 }
}

/** Arm capsule, inflated; position it at (0, ARM_CENTER_OFFSET, 0) in the shoulder pivot. */
export function armProxyGeometry(): THREE.BufferGeometry {
  const a = BASE_FORM.arms
  return new THREE.CapsuleGeometry(a.radius + margin(), a.length, 2, 8)
}
export const ARM_PROXY_OFFSET = ARM_CENTER_OFFSET

/** Foot ellipsoid, inflated; scale the mesh by BASE_FORM.feet.scale. */
export function footProxyGeometry(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(BASE_FORM.feet.radius + margin(), 10, 6)
}

/** Antenna tip: much larger than the 0.1 ball so the thin antenna is grabbable near its tip. */
export function antennaTipProxyGeometry(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(tuning.render.hit.antennaTipRadius, 10, 6)
}

/** Antenna cable: a fat, coarse tube along the same curve (antenna-group frame). */
export function antennaCableProxyGeometry(curve: THREE.Curve<THREE.Vector3>): THREE.BufferGeometry {
  return new THREE.TubeGeometry(curve, 6, tuning.render.hit.antennaCableRadius, 6, false)
}
