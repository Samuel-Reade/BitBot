import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { PALETTES } from '../src/shared/palettes'
import { tuning } from '../src/shared/tuning'
import { ATTACH_POINTS, BASE_PARTS, type AttachPoint, type CharacterSpec, type PartId, type PetSize } from '../src/shared/types'
import { ATTACH_LAYOUT, restPositionInSpec } from '../src/renderer/pet/character/attachPoints'
import { BODY_HEIGHT_UNITS, HIT_LAYER, SPEC_ORIGIN_HEIGHT, buildBitbot, type BitbotRig } from '../src/renderer/pet/character/buildBitbot'
import { ARM_CENTER_OFFSET, ARM_HAND_OFFSET, BASE_FORM, BODY_OUTER, armShoulder, type Side } from '../src/renderer/pet/character/construction'
import {
  DEFAULT_FACE_STATE,
  FACE_HEIGHT,
  FACE_TEXTURE_SCALE,
  FACE_WIDTH,
  createPixelFace,
  mixHex,
  type CanvasFactory,
  type FaceCanvas,
  type FaceContext2D,
  type FaceState,
} from '../src/renderer/pet/character/face'
import {
  framePetCamera,
  framingReference,
  measureViewportExtents,
  projectToViewport,
  type PetFraming,
} from '../src/renderer/pet/character/framing'
import { createHitTester } from '../src/renderer/pet/character/hitTest'

// The character rig (§6.1, §6.3, §6.5) in Node: three.js geometry needs no WebGL, and the pixel
// face draws into a tiny software canvas injected below.

/** Minimal software 2D canvas: integer fillRect with globalAlpha blending, enough for the face. */
class RasterContext implements FaceContext2D {
  fillStyle: unknown = '#000000'
  globalAlpha = 1
  fillRectCalls = 0
  /** Test hook: the next fillRect throws (simulates a draw failing half-way). */
  failNextFill = false
  readonly data: Uint8ClampedArray

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4)
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.failNextFill) {
      this.failNextFill = false
      throw new Error('fake canvas: injected failure')
    }
    this.fillRectCalls++
    // Fractional rects blur on a real canvas; the face must only ever draw whole pixels.
    if (![x, y, w, h].every(Number.isInteger)) throw new Error(`non-integer fillRect(${x}, ${y}, ${w}, ${h})`)
    const [r, g, b] = rgb(String(this.fillStyle))
    const a = this.globalAlpha
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) {
        const o = (j * this.width + i) * 4
        this.data[o] = (this.data[o] ?? 0) * (1 - a) + r * a
        this.data[o + 1] = (this.data[o + 1] ?? 0) * (1 - a) + g * a
        this.data[o + 2] = (this.data[o + 2] ?? 0) * (1 - a) + b * a
        this.data[o + 3] = 255
      }
    }
  }

  pixel(x: number, y: number): [number, number, number] {
    const o = (y * this.width + x) * 4
    return [this.data[o] ?? 0, this.data[o + 1] ?? 0, this.data[o + 2] ?? 0]
  }
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`fake canvas: unsupported color ${hex}`)
  return [parseInt(m[1] ?? '', 16), parseInt(m[2] ?? '', 16), parseInt(m[3] ?? '', 16)]
}

function rasterCanvasFactory(): { factory: CanvasFactory; contexts: RasterContext[] } {
  const contexts: RasterContext[] = []
  const factory: CanvasFactory = (width, height) => {
    const ctx = new RasterContext(width, height)
    contexts.push(ctx)
    const canvas: FaceCanvas = { width, height, getContext: () => ctx }
    return canvas
  }
  return { factory, contexts }
}

const mint = PALETTES.mint
const DEFAULT_YAW = tuning.render.defaultYaw

function build(parts: readonly PartId[] = BASE_PARTS): BitbotRig {
  const rig = buildBitbot({ formId: 'base', palette: mint, parts } satisfies CharacterSpec, { createCanvas: rasterCanvasFactory().factory })
  rig.root.updateMatrixWorld(true)
  return rig
}

/** Position of an object in spec space (body-center origin) for a rig at rest with no yaw. */
function specPosition(object: THREE.Object3D): THREE.Vector3 {
  return object.getWorldPosition(new THREE.Vector3()).sub(new THREE.Vector3(0, SPEC_ORIGIN_HEIGHT, 0))
}

/** Spec-space position of a point given in `object`'s local frame (rig at rest, no yaw). */
function specPoint(object: THREE.Object3D, local: readonly [number, number, number]): THREE.Vector3 {
  return object.localToWorld(new THREE.Vector3(...local)).sub(new THREE.Vector3(0, SPEC_ORIGIN_HEIGHT, 0))
}

/** World bounds of a mesh moved into spec space (rig at rest, no yaw). */
function specBox(object: THREE.Object3D): THREE.Box3 {
  return new THREE.Box3().setFromObject(object, true).translate(new THREE.Vector3(0, -SPEC_ORIGIN_HEIGHT, 0))
}

function isDescendant(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let o = object.parent; o; o = o.parent) if (o === ancestor) return true
  return false
}

function mesh(rig: BitbotRig, name: string): THREE.Mesh {
  const found = rig.root.getObjectByName(name)
  if (!(found instanceof THREE.Mesh)) throw new Error(`no mesh named ${name}`)
  return found
}

const close = (actual: number, expected: number, digits = 3): void => expect(actual).toBeCloseTo(expected, digits)
const expectVec = (actual: THREE.Vector3, expected: readonly number[], digits = 3): void =>
  // `+ 0` folds −0 into 0.
  expect(actual.toArray().map((v) => +v.toFixed(digits) + 0)).toEqual(expected.map((v) => +v.toFixed(digits) + 0))

/** Bounds of what the pet camera draws under `object` (layer 0), excluding the hit proxies. */
function drawnBox(object: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3()
  object.updateMatrixWorld(true)
  object.traverse((o) => {
    if (o instanceof THREE.Mesh && o.layers.isEnabled(0)) box.union(new THREE.Box3().setFromObject(o, true))
  })
  return box
}

/** Spec-space bounds of each consecutive run of `perCopy` vertices of a merged mesh (one per merged copy). */
function copyBoxes(m: THREE.Mesh, copies: number): THREE.Box3[] {
  const position = m.geometry.getAttribute('position')
  expect(position.count % copies).toBe(0)
  const perCopy = position.count / copies
  const v = new THREE.Vector3()
  return Array.from({ length: copies }, (_, c) => {
    const box = new THREE.Box3()
    for (let i = c * perCopy; i < (c + 1) * perCopy; i++) box.expandByPoint(v.fromBufferAttribute(position, i).applyMatrix4(m.matrixWorld))
    return box.translate(new THREE.Vector3(0, -SPEC_ORIGIN_HEIGHT, 0))
  })
}

const viewportEdge = (size: PetSize): number => Math.round(tuning.render.bodyHeightPt[size] * tuning.render.viewportScale)

/** A rig at `yaw` with a camera framed for it the way scene.ts does it. */
function framed(size: PetSize, yaw: number, parts: readonly PartId[] = BASE_PARTS) {
  const rig = build(parts)
  const edge = viewportEdge(size)
  const camera = new THREE.PerspectiveCamera()
  const framing = framePetCamera(camera, edge, edge, size, framingReference(rig), yaw)
  rig.root.rotation.y = yaw
  rig.root.updateMatrixWorld(true)
  return { rig, camera, framing, edge }
}

describe('buildBitbot: §6.1 construction', () => {
  it('builds every base part', () => {
    const rig = build()
    expect(Object.keys(rig.parts).sort()).toEqual([...BASE_PARTS].sort())
    rig.dispose()
  })

  it('body outer box is 1.88 × 1.58 × 1.18 and BODY_HEIGHT_UNITS matches the geometry', () => {
    const rig = build()
    const box = specBox(mesh(rig, 'part:body'))
    expectVec(box.getSize(new THREE.Vector3()), [1.88, 1.58, 1.18])
    expectVec(box.getCenter(new THREE.Vector3()), [0, 0, 0])
    close(BODY_HEIGHT_UNITS, box.max.y - box.min.y, 6)
    rig.dispose()
  })

  it('rear casing: rounded box w 1.05 h 0.85 d 0.45 bevel 0.12 at z −0.72 (outer 1.29 × 1.09 × 0.69)', () => {
    const rig = build()
    const box = specBox(mesh(rig, 'part:rearCasing'))
    expectVec(box.getSize(new THREE.Vector3()), [1.29, 1.09, 0.69])
    expectVec(box.getCenter(new THREE.Vector3()), [0, 0, -0.72])
    rig.dispose()
  })

  it('side vents: 4 boxes 0.03 × 0.06 × 0.5 per side at x ±0.94, y 0.2 down in 0.13 steps, z −0.05', () => {
    const rig = build()
    const boxes = copyBoxes(mesh(rig, 'part:sideVents'), 8)
    const expected: number[][] = []
    for (const side of [1, -1]) for (let i = 0; i < 4; i++) expected.push([side * 0.94, 0.2 - i * 0.13, -0.05])
    boxes.forEach((box, i) => {
      expectVec(box.getSize(new THREE.Vector3()), [0.03, 0.06, 0.5])
      expectVec(box.getCenter(new THREE.Vector3()), expected[i] ?? [])
    })
    rig.dispose()
  })

  it('screen bezel: rounded box w 1.22 h 0.94 d 0.04 bevel 0.03 at (0, 0.1, 0.6)', () => {
    const rig = build()
    const box = specBox(mesh(rig, 'part:bezel'))
    expectVec(box.getSize(new THREE.Vector3()), [1.28, 1.0, 0.1])
    expectVec(box.getCenter(new THREE.Vector3()), [0, 0.1, 0.6])
    rig.dispose()
  })

  it('screen: 1.06 × 0.79 plane, 12×12 segments, bulged to z = 0.06 − (x²+y²)·0.08, unlit', () => {
    const rig = build()
    const screen = mesh(rig, 'part:screen')
    const position = screen.geometry.getAttribute('position')
    expect(position.count).toBe(13 * 13)
    const local = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute)
    expectVec(local.getSize(new THREE.Vector3()).setZ(0), [1.06, 0.79, 0])
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i)
      const y = position.getY(i)
      close(position.getZ(i), 0.06 - (x * x + y * y) * 0.08, 6)
    }
    // (0, 0.1, 0.6) plus the forward offset (SPEC-DEVIATION in construction.ts).
    expectVec(specPosition(screen), [0, 0.1, 0.6 + BASE_FORM.screen.forwardOffset])
    expect(screen.material).toBeInstanceOf(THREE.MeshBasicMaterial)
    rig.dispose()
  })

  it('shows the whole bulged screen in front of the bezel face, inside its flat front', () => {
    const rig = build()
    const screen = new THREE.Box3().setFromObject(mesh(rig, 'part:screen'), true)
    const bezel = new THREE.Box3().setFromObject(mesh(rig, 'part:bezel'), true)
    expect(screen.min.z).toBeGreaterThan(bezel.max.z)
    expect(screen.min.z - bezel.max.z).toBeLessThan(0.01)
    const flatHalfW = BASE_FORM.bezel.w / 2
    expect(screen.max.x).toBeLessThan(flatHalfW)
    expect(screen.min.x).toBeGreaterThan(-flatHalfW)
    rig.dispose()
  })

  it('belly lights: cylinders r 0.045 facing forward at (−0.55 | −0.40, −0.48, 0.62)', () => {
    const rig = build()
    for (const [name, x] of [
      ['powerLight', -0.55],
      ['amberLight', -0.4],
    ] as const) {
      const box = specBox(mesh(rig, name))
      expectVec(box.getCenter(new THREE.Vector3()), [x, -0.48, 0.62])
      const size = box.getSize(new THREE.Vector3())
      close(size.x, 0.09)
      close(size.y, 0.09)
      // Axis along z: the cap faces the viewer and the cylinder reaches back into the body face (z 0.59).
      close(size.z, BASE_FORM.bellyLights.length)
      expect(box.min.z).toBeLessThan(0.59)
    }
    rig.dispose()
  })

  it('belly keys: 3 rounded boxes 0.13 × 0.07 at x 0.25 / 0.43 / 0.61, y −0.48, z 0.6', () => {
    const rig = build()
    const k = BASE_FORM.bellyKeys
    copyBoxes(mesh(rig, 'part:bellyKeys'), 3).forEach((box, i) => {
      expectVec(box.getCenter(new THREE.Vector3()), [[0.25, 0.43, 0.61][i] ?? NaN, -0.48, 0.6])
      expectVec(box.getSize(new THREE.Vector3()), [0.13 + 2 * k.bevel, 0.07 + 2 * k.bevel, k.depth + 2 * k.bevel])
    })
    rig.dispose()
  })

  it('antenna: base r 0.11 → 0.09 h 0.08, cable r 0.035 along the §6.1 curve, tip r 0.1, all in the group at (0.15, 0.78, −0.05)', () => {
    const rig = build()
    const joint = rig.joints.antenna
    if (!joint) throw new Error('antenna joint missing')
    expectVec(specPosition(joint), [0.15, 0.78, -0.05])
    const stalk = mesh(rig, 'antennaStalk')
    expect(stalk.parent).toBe(joint)
    const position = stalk.geometry.getAttribute('position')
    const v = new THREE.Vector3()
    const radiusAt = (y: number): number => {
      let r = 0
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i)
        if (Math.abs(v.y - y) < 1e-6) r = Math.max(r, Math.hypot(v.x, v.z))
      }
      return r
    }
    close(radiusAt(-0.04), 0.11, 6) // base bottom
    close(radiusAt(0.04), 0.09, 6) // base top
    // The cable's end rings sit 0.035 around the curve's first and last points.
    const curve = BASE_FORM.antenna.cable.points
    for (const end of [curve[0], curve[curve.length - 1]]) {
      const p = new THREE.Vector3(...(end ?? [NaN, NaN, NaN]))
      const ring: number[] = []
      for (let i = 0; i < position.count; i++) {
        const d = v.fromBufferAttribute(position, i).distanceTo(p)
        if (d > 0.03 && d < 0.036) ring.push(d)
      }
      expect(ring.length).toBeGreaterThanOrEqual(10)
      for (const d of ring) close(d, 0.035, 6)
    }
    const tip = mesh(rig, 'antennaTip')
    expect((tip.geometry as THREE.SphereGeometry).parameters.radius).toBe(0.1)
    expectVec(tip.position, [0.38, 0.66, 0.1])
    expectVec(specPosition(tip), [0.53, 1.44, 0.05])
    rig.dispose()
  })

  it('arms: capsules r 0.11 h 0.3 centered at (±1.0, −0.1, 0.15), hanging down with base rotation z ±0.5 (§6.1: ∓0.5)', () => {
    const rig = build()
    for (const side of [1, -1] as const) {
      const arm = mesh(rig, side === 1 ? 'armL' : 'armR')
      const capsule = arm.geometry as THREE.CapsuleGeometry
      expect(capsule.parameters.radius).toBe(0.11)
      expect(capsule.parameters.height).toBe(0.3)
      expectVec(specPosition(arm), [side * 1.0, -0.1, 0.15])
      // The capsule is symmetric end for end, so compare its axis direction up to sign. The sign is
      // §6.1's flipped (SPEC-DEVIATION in construction.ts): x = +1 → +0.5 about z.
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(arm.getWorldQuaternion(new THREE.Quaternion()))
      const hanging = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), side * 0.5)
      close(Math.abs(axis.dot(hanging)), 1, 9)
      // The free end (the cap farther from the body) is below the shoulder (the body-side cap).
      const capA = specPoint(arm, [0, 0.15, 0])
      const capB = specPoint(arm, [0, -0.15, 0])
      const free = Math.abs(capA.x) > Math.abs(capB.x) ? capA : capB
      const shoulder = free === capA ? capB : capA
      close(free.y - shoulder.y, -0.3 * Math.cos(0.5), 9)
      close(Math.abs(free.x) - Math.abs(shoulder.x), 0.3 * Math.sin(0.5), 9)
    }
    rig.dispose()
  })

  it('feet: spheres r 0.22 scaled (1, 0.55, 1.3) at (±0.42, −0.84, 0.12); ground-contact point at the root origin', () => {
    const rig = build()
    for (const side of [1, -1] as const) {
      const foot = mesh(rig, side === 1 ? 'footL' : 'footR')
      expect((foot.geometry as THREE.SphereGeometry).parameters.radius).toBe(0.22)
      expectVec(specPosition(foot), [side * 0.42, -0.84, 0.12], 4)
      expect(foot.scale.toArray()).toEqual([1, 0.55, 1.3])
    }
    const feet = rig.parts.feet
    if (!feet) throw new Error('feet missing')
    const box = drawnBox(feet)
    close(box.min.y, 0, 4)
    close((box.min.x + box.max.x) / 2, 0, 6)
    close(SPEC_ORIGIN_HEIGHT, 0.84 + 0.22 * 0.55, 6)
    // Nothing the camera draws goes below the ground plane.
    expect(drawnBox(rig.root).min.y).toBeGreaterThan(-1e-4)
    rig.dispose()
  })

  it('contact shadow: circle r 1.1 scaled (1, 0.6), black at 12%, flat at y −0.95, on the root', () => {
    const rig = build()
    const shadow = mesh(rig, 'part:contactShadow')
    const box = specBox(shadow)
    expectVec(box.getSize(new THREE.Vector3()), [2.2, 0, 1.32])
    close(box.getCenter(new THREE.Vector3()).y, -0.95, 2)
    const material = shadow.material as THREE.MeshBasicMaterial
    expect(material.color.getHex()).toBe(0x000000)
    expect(material.opacity).toBe(0.12)
    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(false)
    rig.dispose()
  })

  it('keeps the feet and contact shadow out of the bobbing body group, and the shadow out of the figure', () => {
    const rig = build()
    const { footL, footR } = rig.joints
    if (!footL || !footR || !rig.shadow) throw new Error('missing parts')
    expect(isDescendant(footL, rig.body)).toBe(false)
    expect(isDescendant(footR, rig.body)).toBe(false)
    expect(isDescendant(rig.shadow.mesh, rig.figure)).toBe(false)
    expect(rig.shadow.mesh.parent).toBe(rig.root)
    // Squash pivot = bottom-center of the body box.
    close(specPosition(rig.body).y, -1.58 / 2)
    rig.dispose()
  })

  it('respects the parts list: omitted parts (and their joints, proxies) are not built', () => {
    const parts = BASE_PARTS.filter((p) => p !== 'arms' && p !== 'antenna')
    const rig = build(parts)
    expect(rig.parts.arms).toBeUndefined()
    expect(rig.parts.antenna).toBeUndefined()
    expect(rig.joints.armL).toBeNull()
    expect(rig.joints.antenna).toBeNull()
    expect(rig.glow.antennaTip).toBeNull()
    expect(rig.root.getObjectByName('armL')).toBeUndefined()
    expect(rig.hitTargets.map((t) => t.name)).not.toContain('hit:armL')
    expect(rig.hitTargets.map((t) => t.name)).not.toContain('hit:antennaTip')
    // Anchors still exist, at the rest position the missing joint would have held them.
    const full = build()
    for (const name of ['hand_L', 'hand_R', 'antenna_tip'] as const) {
      const a = specPosition(rig.attachPoints[name])
      const b = specPosition(full.attachPoints[name])
      expect(a.distanceTo(b)).toBeLessThan(1e-9)
    }
    full.dispose()
    rig.dispose()

    const bodyOnly = build(['body'])
    const drawn: string[] = []
    bodyOnly.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.layers.isEnabled(0)) drawn.push(o.name)
    })
    expect(drawn).toEqual(['part:body'])
    expect(bodyOnly.face).toBeNull()
    expect(bodyOnly.shadow).toBeNull()
    bodyOnly.dispose()
  })

  it('materials follow §6.1 and the palette', () => {
    const rig = build()
    const body = mesh(rig, 'part:body').material as THREE.MeshStandardMaterial
    expect(body.roughness).toBe(0.42)
    expect(body.metalness).toBe(0.05)
    expect(body.color.getHexString()).toBe(mint.primary.slice(1).toLowerCase())
    const casing = mesh(rig, 'part:rearCasing').material as THREE.MeshStandardMaterial
    expect(casing.roughness).toBe(0.5)
    expect(casing.color.getHexString()).toBe(mint.secondary.slice(1).toLowerCase())
    expect(mesh(rig, 'part:bezel').material).toBe(mesh(rig, 'part:sideVents').material)
    expect((mesh(rig, 'part:bezel').material as THREE.MeshStandardMaterial).color.getHexString()).toBe(mint.outline.slice(1).toLowerCase())
    expect(mesh(rig, 'antennaStalk').material).toBe(mesh(rig, 'part:bezel').material)
    expect(mesh(rig, 'part:bellyKeys').material).toBe(mesh(rig, 'part:bezel').material)
    expect(mesh(rig, 'armL').material).toBe(body)
    expect(mesh(rig, 'footL').material).toBe(casing)
    rig.dispose()
  })

  it('glowing parts are their color as emissive plus a dim lit albedo, so at rest they read at their hex', () => {
    const rig = build()
    const { antennaTip, powerLight, amberLight } = rig.glow
    if (!antennaTip || !powerLight || !amberLight) throw new Error('glow materials missing')
    const albedo = tuning.render.glowAlbedo
    for (const [material, hex, rest] of [
      [antennaTip, mint.accent, tuning.anim.glow.antennaTip],
      [powerLight, '#6FF2B6', tuning.anim.glow.powerLight],
      [amberLight, '#FFB43F', tuning.anim.glow.amberLight],
    ] as const) {
      expect(material.emissive.getHexString()).toBe(hex.slice(1).toLowerCase())
      const expected = new THREE.Color(hex).multiplyScalar(albedo)
      expect(material.color.r).toBeCloseTo(expected.r, 9)
      expect(material.color.g).toBeCloseTo(expected.g, 9)
      expect(material.color.b).toBeCloseTo(expected.b, 9)
      expect(material.emissiveIntensity).toBe(rest)
      // Lit front ≈ albedo + glow: at most the color itself, so it never clips toward white at rest.
      expect(albedo + rest).toBeLessThanOrEqual(1 + 1e-9)
    }
    rig.dispose()
  })

  it('contact shadow strength fades and hides, and clipTo installs a clipping plane', () => {
    const rig = build()
    const shadow = rig.shadow
    if (!shadow) throw new Error('shadow missing')
    const material = shadow.mesh.material as THREE.MeshBasicMaterial
    shadow.setStrength(0.5)
    close(material.opacity, 0.06, 6)
    expect(shadow.mesh.visible).toBe(true)
    shadow.setStrength(-1)
    expect(shadow.strength).toBe(0)
    expect(shadow.mesh.visible).toBe(false)
    shadow.setStrength(3)
    expect(shadow.strength).toBe(1)
    close(material.opacity, 0.12, 6)
    const plane = new THREE.Plane()
    shadow.clipTo(plane)
    expect(material.clippingPlanes).toEqual([plane])
    expect(material.clippingPlanes?.[0]).toBe(plane)
    shadow.clipTo(null)
    expect(material.clippingPlanes).toBeNull()
    rig.dispose()
  })

  it('dispose releases every geometry, material and the face texture', () => {
    const rig = build()
    const resources = new Set<THREE.EventDispatcher<{ dispose: object }>>()
    rig.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        resources.add(o.geometry)
        resources.add(o.material as THREE.Material)
      }
    })
    if (rig.face) resources.add(rig.face.texture)
    let disposed = 0
    for (const r of resources) r.addEventListener('dispose', () => disposed++)
    rig.dispose()
    expect(disposed).toBe(resources.size)
  })
})

describe('arm shoulder pivots', () => {
  /** Spec-space point at `offset` along the pivot's local +y. */
  const alongArm = (pivot: { position: readonly number[]; rotationZ: number }, offset: number): THREE.Vector2 =>
    new THREE.Vector2(pivot.position[0] ?? NaN, pivot.position[1] ?? NaN).add(
      new THREE.Vector2(-Math.sin(pivot.rotationZ), Math.cos(pivot.rotationZ)).multiplyScalar(offset),
    )

  it('pivot at the body-side cap, hand at the free cap, for either sign of the tilt', () => {
    const wall = BODY_OUTER.w / 2 // 0.94
    for (const rotZ of [0.5, -0.5, 0.25, -0.25]) {
      for (const side of [1, -1] as const satisfies readonly Side[]) {
        const pivot = armShoulder(side, rotZ)
        const center = alongArm(pivot, ARM_CENTER_OFFSET)
        const hand = alongArm(pivot, ARM_HAND_OFFSET)
        // The arm itself does not move: same center and same (unsigned) axis as the requested tilt.
        close(center.x, side * 1.0, 9)
        close(center.y, -0.1, 9)
        const axis = new THREE.Vector2(-Math.sin(pivot.rotationZ), Math.cos(pivot.rotationZ))
        close(Math.abs(axis.dot(new THREE.Vector2(Math.sin(side * rotZ), Math.cos(side * rotZ)))), 1, 9)
        // The pivot is the cap nearer the body; the hand is the far one.
        expect(Math.abs(pivot.position[0])).toBeLessThan(Math.abs(center.x))
        expect(Math.abs(hand.x)).toBeGreaterThan(Math.abs(center.x))
        if (Math.abs(rotZ) === 0.5) {
          expect(Math.abs(pivot.position[0])).toBeLessThanOrEqual(wall)
          expect(Math.abs(hand.x)).toBeGreaterThan(wall)
        }
        // §6.1's sign (rotZ > 0) raises the outer ends (shoulder below the hand); the flipped sign,
        // the default BASE_FORM.arms.rotZ, hangs them.
        if (rotZ > 0) expect(hand.y).toBeGreaterThan(pivot.position[1])
        else expect(hand.y).toBeLessThan(pivot.position[1])
      }
    }
  })

  it('a vertical arm pivots at its upper cap', () => {
    for (const side of [1, -1] as const) {
      const pivot = armShoulder(side, 0)
      close(pivot.position[1], -0.1 + ARM_CENTER_OFFSET, 9)
      close(alongArm(pivot, ARM_HAND_OFFSET).y, -0.1 - ARM_CENTER_OFFSET, 9)
    }
  })

  it('the built rig uses those pivots: joints at the shoulder, hands at the far caps, below the shoulders', () => {
    const rig = build()
    for (const side of [1, -1] as const) {
      const joint = side === 1 ? rig.joints.armL : rig.joints.armR
      if (!joint) throw new Error('arm joint missing')
      const pivot = armShoulder(side)
      expectVec(specPosition(joint), [...pivot.position], 9)
      close(joint.rotation.z, pivot.rotationZ, 12)
      const hand = specPosition(rig.attachPoints[side === 1 ? 'hand_L' : 'hand_R'])
      expect(Math.abs(hand.x)).toBeGreaterThan(Math.abs(specPosition(joint).x))
      expect(hand.y).toBeLessThan(specPosition(joint).y)
    }
    rig.dispose()
  })
})

describe('§6.5 attach points', () => {
  const expectedParent: Record<AttachPoint, (rig: BitbotRig) => THREE.Object3D | null> = {
    head_top: (r) => r.body.children[0] ?? null,
    head_side_L: (r) => r.body.children[0] ?? null,
    head_side_R: (r) => r.body.children[0] ?? null,
    face_screen: (r) => r.body.children[0] ?? null,
    back_casing: (r) => r.body.children[0] ?? null,
    belly: (r) => r.body.children[0] ?? null,
    antenna_tip: (r) => r.joints.antenna,
    hand_L: (r) => r.joints.armL,
    hand_R: (r) => r.joints.armR,
    foot_L: (r) => r.joints.footL,
    foot_R: (r) => r.joints.footR,
  }

  it('creates all 11 named anchors with the specified parents', () => {
    const rig = build()
    expect(Object.keys(rig.attachPoints).sort()).toEqual([...ATTACH_POINTS].sort())
    for (const name of ATTACH_POINTS) {
      const anchor = rig.attachPoints[name]
      expect(anchor.name).toBe(`attach:${name}`)
      expect(anchor.parent, name).toBe(expectedParent[name](rig))
    }
    rig.dispose()
  })

  it('places anchors on the surfaces they decorate', () => {
    const rig = build()
    const at = (name: AttachPoint): THREE.Vector3 => specPosition(rig.attachPoints[name])
    close(at('head_top').y, 0.79)
    close(at('head_side_L').x, 0.94)
    close(at('head_side_R').x, -0.94)
    expect(at('face_screen').z).toBeGreaterThan(0.69)
    expect(at('back_casing').z).toBeLessThan(-1.065)
    expect(at('antenna_tip').distanceTo(specPosition(mesh(rig, 'antennaTip')))).toBeLessThan(1e-9)
    // Hands at the outer end-cap centers: arm center + 0.15 along the hanging axis, out and down.
    close(at('hand_L').x, 1.0 + 0.15 * Math.sin(0.5))
    close(at('hand_L').y, -0.1 - 0.15 * Math.cos(0.5))
    close(at('hand_R').x, -(1.0 + 0.15 * Math.sin(0.5)))
    close(at('hand_R').y, -0.1 - 0.15 * Math.cos(0.5))
    expectVec(at('foot_L'), [0.42, -0.84, 0.12], 4)
    expect(at('belly').y).toBeLessThan(-0.3)
    rig.dispose()
  })

  it('fallback rest positions agree with the jointed rig', () => {
    const rig = build()
    for (const name of ATTACH_POINTS) {
      const { joint, position } = ATTACH_LAYOUT[name]
      const rest = new THREE.Vector3(...restPositionInSpec(joint, position))
      expect(rest.distanceTo(specPosition(rig.attachPoints[name])), name).toBeLessThan(1e-9)
    }
    rig.dispose()
  })
})

describe('hit proxies and hit-testing', () => {
  it('live only on HIT_LAYER, which the pet camera does not render', () => {
    const rig = build()
    const camera = new THREE.PerspectiveCamera()
    expect(rig.hitTargets.length).toBe(9)
    for (const proxy of rig.hitTargets) {
      expect(proxy.layers.mask).toBe(1 << HIT_LAYER)
      expect(proxy.layers.test(camera.layers)).toBe(false)
    }
    // Conversely nothing the camera draws is a hit target.
    rig.root.traverse((o) => {
      if (o.layers.test(camera.layers) && o instanceof THREE.Mesh) expect(rig.hitTargets).not.toContain(o)
    })
    rig.dispose()
  })

  it('createHitTester (scene.hitTest): body and near-tip hits, empty space misses, layer 0 ignored', () => {
    const { rig, camera, edge } = framed('M', DEFAULT_YAW)
    const hitTest = createHitTester(rig, camera, edge, edge)
    const px = (object: THREE.Object3D, offset = new THREE.Vector3()): { x: number; y: number } =>
      projectToViewport(object.getWorldPosition(new THREE.Vector3()).add(offset), camera, edge, edge)

    const body = px(mesh(rig, 'part:body'))
    expect(hitTest(body.x, body.y)).toBe(true)
    const tip = mesh(rig, 'antennaTip')
    const nearTip = px(tip, new THREE.Vector3(0, 0.17, 0)) // 0.07 above the visible ball
    expect(hitTest(nearTip.x, nearTip.y)).toBe(true)
    const farAboveTip = px(tip, new THREE.Vector3(0, 0.35, 0))
    expect(hitTest(farAboveTip.x, farAboveTip.y)).toBe(false)
    expect(hitTest(1, 1)).toBe(false)
    expect(hitTest(edge - 2, edge / 2)).toBe(false)
    // Moving the proxies off HIT_LAYER makes the pet unhittable: the tester only sees that layer.
    for (const proxy of rig.hitTargets) proxy.layers.set(0)
    expect(hitTest(body.x, body.y)).toBe(false)
    rig.dispose()
  })

  it('every visible point is hittable, with a small forgiving halo (size M, 2-pt grid)', () => {
    const step = 2
    for (const yaw of [0, DEFAULT_YAW, -DEFAULT_YAW]) {
      const { rig, camera, edge } = framed('M', yaw)
      const hitTest = createHitTester(rig, camera, edge, edge)
      // "Visible" = what the camera draws, minus the faint contact shadow (clicks there pass through).
      const drawn: THREE.Object3D[] = []
      rig.root.traverse((o) => {
        if (o instanceof THREE.Mesh && o.layers.isEnabled(0) && o.name !== 'part:contactShadow') drawn.push(o)
      })
      const raycaster = new THREE.Raycaster()
      const visibleAt = (x: number, y: number): boolean => {
        raycaster.setFromCamera(new THREE.Vector2((x / edge) * 2 - 1, 1 - (y / edge) * 2), camera)
        return raycaster.intersectObjects(drawn, false).length > 0
      }
      const box = measureViewportExtents(rig.figure, camera, edge, edge)
      const visible: [number, number][] = []
      const halo: [number, number][] = []
      let unhittable = 0
      for (let y = Math.floor(box.top) - 12; y <= box.bottom + 12; y += step) {
        for (let x = Math.floor(box.left) - 12; x <= box.right + 12; x += step) {
          const v = visibleAt(x, y)
          const h = hitTest(x, y)
          if (v) visible.push([x, y])
          if (v && !h) unhittable++
          if (h && !v) halo.push([x, y])
        }
      }
      expect(visible.length).toBeGreaterThan(2000)
      expect(unhittable, `yaw ${yaw}`).toBe(0)
      // Halo: hittable but not visible. Distance of each such sample to the nearest visible one.
      const distances = halo.map(([x, y]) => Math.min(...visible.map(([vx, vy]) => Math.hypot(vx - x, vy - y))))
      const mean = distances.reduce((a, b) => a + b, 0) / Math.max(1, distances.length)
      expect(mean, `yaw ${yaw} mean halo`).toBeLessThan(3)
      expect(Math.max(0, ...distances), `yaw ${yaw} max halo`).toBeLessThanOrEqual(8)
      rig.dispose()
    }
  }, 30_000)
})

describe('framing', () => {
  const yaws = [0, DEFAULT_YAW, -DEFAULT_YAW, Math.PI / 2, Math.PI, 2.5]

  /** Lowest drawn (largest viewport y) point of every layer-0 mesh under `object`. */
  const lowestDrawnY = (object: THREE.Object3D, framing: PetFraming, camera: THREE.Camera, edge: number): number =>
    measureViewportExtents(object, camera, edge, edge).bottom - framing.anchor.y

  it('puts the lowest drawn foot point on the anchor row and the root origin on its column, at every size and yaw', () => {
    for (const size of ['S', 'M', 'L'] as const) {
      const { rig, camera, framing, edge } = framed(size, DEFAULT_YAW)
      for (const yaw of yaws) {
        rig.root.rotation.y = yaw
        rig.root.updateMatrixWorld(true)
        framing.placeForYaw(yaw)
        const feet = rig.parts.feet
        if (!feet) throw new Error('feet missing')
        expect(Math.abs(lowestDrawnY(feet, framing, camera, edge)), `${size} yaw ${yaw}`).toBeLessThan(1e-4)
        const origin = projectToViewport(rig.root.localToWorld(new THREE.Vector3()), camera, edge, edge)
        expect(Math.abs(origin.x - framing.anchor.x)).toBeLessThan(1e-4)
        // Nothing of the figure is drawn below the ground line.
        expect(lowestDrawnY(rig.figure, framing, camera, edge)).toBeLessThan(1e-4)
      }
      rig.dispose()
    }
  })

  it('scales the pet so the drawn body box is bodyHeightPt tall at the default yaw', () => {
    for (const size of ['S', 'M', 'L'] as const) {
      for (const yaw of [DEFAULT_YAW, -DEFAULT_YAW]) {
        const { rig, camera, edge } = framed(size, yaw)
        const body = measureViewportExtents(mesh(rig, 'part:body'), camera, edge, edge)
        close(body.bottom - body.top, tuning.render.bodyHeightPt[size], 4)
        rig.dispose()
      }
    }
  })

  it('clips the contact shadow exactly at the ground line', () => {
    const { rig, camera, framing, edge } = framed('M', DEFAULT_YAW)
    const plane = new THREE.Plane()
    const shadow = mesh(rig, 'part:contactShadow')
    const position = shadow.geometry.getAttribute('position')
    const v = new THREE.Vector3()
    for (const yaw of yaws) {
      rig.root.rotation.y = yaw
      rig.root.updateMatrixWorld(true)
      framing.placeForYaw(yaw)
      framing.groundLinePlane(plane)
      let below = 0
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i).applyMatrix4(shadow.matrixWorld)
        const rowOffset = projectToViewport(v, camera, edge, edge).y - framing.anchor.y
        const distance = plane.distanceToPoint(v)
        // Unclipped, part of the ellipse is drawn below the line; the plane cuts exactly there.
        if (rowOffset > 1e-6) below++
        if (Math.abs(rowOffset) > 1e-6) expect(Math.sign(distance), `yaw ${yaw}`).toBe(-Math.sign(rowOffset))
      }
      expect(below).toBeGreaterThan(0)
    }
    rig.dispose()
  })

  it('re-places only for a new yaw, by translation only, ignoring any view offset on the camera', () => {
    const { rig, camera, framing } = framed('M', DEFAULT_YAW)
    const quaternion = camera.quaternion.clone()
    const at = camera.position.clone()
    expect(framing.yaw).toBe(DEFAULT_YAW)
    expect(framing.placeForYaw(DEFAULT_YAW)).toBe(false)
    camera.setViewOffset(240, 240, -500, -300, 1440, 900) // as Spike A's fullscreen variant does
    expect(framing.placeForYaw(0)).toBe(true)
    expect(camera.position.distanceTo(at)).toBeGreaterThan(1e-3)
    expect(camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-12)
    expect(framing.placeForYaw(DEFAULT_YAW)).toBe(true)
    // Same place again (the solver converges to < 1e-7 px from either warm start).
    expect(camera.position.distanceTo(at)).toBeLessThan(1e-6)
    rig.dispose()
  })

  it('without feet, the root origin is the ground line; without a body, the scale is nominal', () => {
    const parts = BASE_PARTS.filter((p) => p !== 'feet' && p !== 'body')
    const { rig, camera, framing, edge } = framed('M', DEFAULT_YAW, parts)
    const origin = projectToViewport(new THREE.Vector3(), camera, edge, edge)
    expect(Math.hypot(origin.x - framing.anchor.x, origin.y - framing.anchor.y)).toBeLessThan(1e-4)
    close(framing.ptPerUnit, tuning.render.bodyHeightPt.M / BODY_HEIGHT_UNITS, 9)
    rig.dispose()
  })

  it('draws the whole pet inside the viewport at the default yaw', () => {
    for (const size of ['S', 'M', 'L'] as const) {
      const { rig, camera, edge } = framed(size, DEFAULT_YAW)
      const e = measureViewportExtents(rig.root, camera, edge, edge)
      expect(e.left).toBeGreaterThan(0)
      expect(e.top).toBeGreaterThan(0)
      expect(e.right).toBeLessThan(edge)
      expect(e.bottom).toBeLessThan(edge)
      rig.dispose()
    }
  })
})

describe('§6.3 pixel face', () => {
  const K = FACE_TEXTURE_SCALE
  const glow = rgb(mint.screenGlow)
  const background = rgb(mixHex('#10201F', mint.screenGlow, tuning.render.face.backgroundTint))
  // Rows 2, 5, 8, … carry a scanline (period 3); sample on rows that do not.
  const scanRow = (y: number): boolean => y % tuning.render.face.scanlinePeriodPx === tuning.render.face.scanlinePeriodPx - 1

  function makeFace(state?: Partial<FaceState>) {
    const { factory, contexts } = rasterCanvasFactory()
    const face = createPixelFace(mint, { createCanvas: factory, state })
    const ctx = contexts[0]
    if (!ctx) throw new Error('no canvas created')
    return { face, ctx }
  }

  /** Color of face pixel (x, y), i.e. of its K×K canvas block. */
  const px = (ctx: RasterContext, x: number, y: number): [number, number, number] => ctx.pixel(x * K + (K >> 1), y * K + (K >> 1))

  /** True if every face pixel is one solid K×K block of canvas pixels. */
  function blocksAreSolid(ctx: RasterContext): boolean {
    for (let y = 0; y < FACE_HEIGHT; y++) {
      for (let x = 0; x < FACE_WIDTH; x++) {
        const [r, g, b] = ctx.pixel(x * K, y * K)
        for (let j = 0; j < K; j++) {
          for (let i = 0; i < K; i++) {
            const [r2, g2, b2] = ctx.pixel(x * K + i, y * K + j)
            if (r2 !== r || g2 !== g || b2 !== b) return false
          }
        }
      }
    }
    return true
  }

  it('keeps the 128×96 face grid, rasterized K× and sampled with linear filtering + trilinear mipmaps', () => {
    const { face, ctx } = makeFace()
    expect([FACE_WIDTH, FACE_HEIGHT]).toEqual([128, 96])
    expect(Number.isInteger(K) && K >= 1).toBe(true)
    expect([face.canvas.width, face.canvas.height]).toEqual([128 * K, 96 * K])
    expect(face.texture.magFilter).toBe(THREE.LinearFilter)
    expect(face.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter)
    expect(face.texture.generateMipmaps).toBe(true)
    expect(face.texture.anisotropy).toBe(tuning.render.face.sampling.anisotropy)
    expect(face.texture.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(blocksAreSolid(ctx)).toBe(true)
    face.setState({ eyes: 'blink', overlays: ['blush'] })
    expect(blocksAreSolid(ctx)).toBe(true)
    face.dispose()
  })

  it('the screen material samples the face with the tuned mip bias (patch applies to this three.js)', () => {
    const rig = build()
    const face = rig.face
    if (!face) throw new Error('face missing')
    const material = mesh(rig, 'part:screen').material as THREE.MeshBasicMaterial
    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial)
    expect(material.map).toBe(face.texture)
    // The chunk text the patch rewrites must exist, or the bias would silently be lost.
    expect(THREE.ShaderChunk.map_fragment).toContain('texture2D( map, vMapUv )')
    const bias = tuning.render.face.sampling.mipBias.toFixed(3)
    const shader = { fragmentShader: 'void main() {\n#include <map_fragment>\n}', vertexShader: '', uniforms: {} }
    material.onBeforeCompile(shader as never, undefined as never)
    expect(shader.fragmentShader).toContain(`texture2D( map, vMapUv, ${bias} )`)
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>')
    expect(material.customProgramCacheKey()).toContain(bias)
    rig.dispose()
  })

  it('redraws and re-uploads only when the state changes', () => {
    const { face, ctx } = makeFace()
    expect(face.drawCount).toBe(1)
    const version = face.texture.version
    const calls = ctx.fillRectCalls
    expect(face.setState({ eyes: 'open', mouth: 'smile', overlays: [] })).toBe(false)
    expect(face.setState({})).toBe(false)
    expect(face.drawCount).toBe(1)
    expect(face.texture.version).toBe(version)
    expect(ctx.fillRectCalls).toBe(calls)
    expect(face.setState({ eyes: 'blink' })).toBe(true)
    expect(face.drawCount).toBe(2)
    expect(face.texture.version).toBe(version + 1)
    expect(face.setState({ eyes: 'blink' })).toBe(false)
    face.dispose()
  })

  it('merges partial states field by field: undefined or unknown values keep the current ones', () => {
    const { face } = makeFace()
    expect(face.setState({ eyes: undefined, mouth: undefined, overlays: undefined })).toBe(false)
    expect(face.state).toEqual(DEFAULT_FACE_STATE)
    const blinking = true as boolean
    expect(face.setState({ eyes: blinking ? 'blink' : undefined })).toBe(true)
    expect(face.setState({ eyes: !blinking ? 'blink' : undefined })).toBe(false)
    expect(face.state.eyes).toBe('blink')
    // Unknown values (e.g. from an untyped IPC message) are ignored, not drawn.
    expect(face.setState({ eyes: 'wink' as never, mouth: 42 as never })).toBe(false)
    expect(face.setState({ overlays: ['blush', 'sparkles' as never, 'blush'] })).toBe(true)
    expect(face.state.overlays).toEqual(['blush'])
    expect(face.setState({ overlays: undefined })).toBe(false)
    expect(face.setState({ overlays: 'blush' as never })).toBe(false)
    expect(face.state).toEqual({ eyes: 'blink', mouth: 'smile', overlays: ['blush'] })
    expect(face.setState({ overlays: [] })).toBe(true)
    face.dispose()

    const created = makeFace({ eyes: 'blink', mouth: undefined, overlays: undefined }).face
    expect(created.state).toEqual({ eyes: 'blink', mouth: 'smile', overlays: [] })
    created.dispose()
  })

  it('commits a new state only after it is drawn', () => {
    const { face, ctx } = makeFace()
    ctx.failNextFill = true
    expect(() => face.setState({ eyes: 'blink' })).toThrow('injected failure')
    expect(face.state.eyes).toBe('open')
    expect(face.drawCount).toBe(1)
    // The failed state is not mistaken for the current one: retrying draws it.
    expect(face.setState({ eyes: 'blink' })).toBe(true)
    expect(face.state.eyes).toBe('blink')
    expect(px(ctx, 34, 39)).toEqual(glow)
    face.dispose()
  })

  it('draws open eyes as 14×18 glow blocks with a 4×4 white highlight, over the tinted background', () => {
    const { face, ctx } = makeFace()
    // Left eye block: x 35..48, y 31..48 (center 42, 40).
    expect(px(ctx, 36, 33)).toEqual(glow)
    expect(px(ctx, 48, 46)).toEqual(glow)
    expect(px(ctx, 34, 33)).toEqual(background)
    expect(px(ctx, 49, 33)).toEqual(background)
    // Highlight: upper-right corner inset 2 px → x 43..46, y 33..36.
    expect(scanRow(33)).toBe(false)
    expect(px(ctx, 43, 33)).toEqual([255, 255, 255])
    expect(px(ctx, 46, 33)).toEqual([255, 255, 255])
    expect(px(ctx, 47, 33)).toEqual(glow)
    expect(px(ctx, 5, 6)).toEqual(background)
    face.dispose()
  })

  it('draws faint scanlines every 3 px at ~6% over everything', () => {
    const { face, ctx } = makeFace()
    expect(scanRow(5)).toBe(true)
    const dark = px(ctx, 5, 5)
    const light = px(ctx, 5, 6)
    dark.forEach((v, i) => close(v, (light[i] ?? 0) * (1 - tuning.render.face.scanlineOpacity), 0))
    face.dispose()
  })

  it('blink replaces the eye blocks with 16×4 lines', () => {
    const { face, ctx } = makeFace()
    face.setState({ eyes: 'blink' })
    expect(px(ctx, 42, 33)).toEqual(background) // top of the old eye block
    expect(px(ctx, 34, 39)).toEqual(glow) // line spans x 34..49, y 38..41
    expect(px(ctx, 49, 40)).toEqual(glow)
    expect(px(ctx, 33, 39)).toEqual(background)
    expect(px(ctx, 44, 34)).toEqual(background) // no highlight
    face.dispose()
  })

  it('draws the smile below the eyes and overlays in canonical order', () => {
    const { face, ctx } = makeFace()
    expect(px(ctx, 55, 57)).toEqual(glow) // left stroke of the U (x 55..57, y 56..61)
    expect(px(ctx, 64, 63)).toEqual(glow) // bottom bar (y 62..64)
    expect(px(ctx, 64, 57)).toEqual(background) // inside the U
    expect(face.setState({ overlays: ['blush', 'blush'] })).toBe(true)
    expect(face.state.overlays).toEqual(['blush'])
    expect(face.setState({ overlays: ['blush'] })).toBe(false)
    face.dispose()
  })
})
