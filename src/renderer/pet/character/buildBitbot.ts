import * as THREE from 'three'
import { tuning } from '../../../shared/tuning'
import type { AttachPoint, CharacterSpec, Palette, PartId } from '../../../shared/types'
import { createAttachPoints } from './attachPoints'
import { ARM_CENTER_OFFSET, BASE_FORM, BODY_BOTTOM_Y, BODY_OUTER, SPEC_ORIGIN_HEIGHT, armShoulder, type Side, type Vec3 } from './construction'
import { createFaceMaterial, createPixelFace, type CanvasFactory, type FaceState, type PixelFace } from './face'
import { bulgedScreenGeometry, instancedMerge, mergeAll, roundedBoxGeometry } from './geometry'
import {
  ARM_PROXY_OFFSET,
  antennaCableProxyGeometry,
  antennaTipProxyGeometry,
  armProxyGeometry,
  bodyProxyGeometry,
  createHitProxyMaterial,
  footProxyGeometry,
  hitProxy,
  rearCasingProxyGeometry,
  screenProxyGeometry,
  type HitProxyId,
} from './hitProxies'

// The Bitbot base-form rig (§6.1), built procedurally from a CharacterSpec so Phase 2 forms can
// reuse it and swap/add parts (§6.5). Only the parts listed in spec.parts are built.
//
// Hierarchy (origin of each group in brackets):
//   root            [ground-contact point: bottom of the feet, centered]  ← yaw / facing
//   ├─ contactShadow                                   (stays on the ground)
//   └─ figure       [ground-contact point]             ← jumps, leans, tumbles
//      └─ spec      [body center, SPEC_ORIGIN_HEIGHT up] (static; §6.1 coordinates from here on)
//         ├─ feet → joint:footL / joint:footR          (planted: NOT under the body)
//         └─ body   [bottom-center of the body box]    ← bob (position.y) and squash (scale)
//            └─ bodyContent [body center]
//               ├─ body, casing, vents, bezel, screen, belly lights, keys
//               ├─ joint:antenna [antenna base]        ← sway / droop
//               └─ arms → joint:armL / joint:armR [shoulder = body-side end cap] ← swing (rotation.z)
// Attach points (§6.5) hang off the joint they move with; hit proxies sit beside their meshes on HIT_LAYER.

export { BODY_HEIGHT_UNITS, SPEC_ORIGIN_HEIGHT } from './construction'
export { HIT_LAYER } from './hitProxies'

// SPEC-DEVIATION: the contact shadow sits 0.001 above §6.1's y = −0.95 (lead's request) so it can
// never z-fight a surface drawn at exactly that height. Invisible at any pet size (< 0.1 pt).
const SHADOW_LIFT = 0.001

export interface BitbotJoints {
  /**
   * Shoulder pivots at the body-side end cap of each arm; local +y runs shoulder → hand. Rest
   * rotation.z comes from armShoulder() (arms hanging down: §6.1's 0.5 tilt with the sign flipped,
   * see BASE_FORM.arms); swing by offsetting it.
   */
  readonly armL: THREE.Group | null
  readonly armR: THREE.Group | null
  /** Antenna group, origin at the antenna base: rotate to sway or droop. */
  readonly antenna: THREE.Group | null
  /** Foot groups at each foot's center, outside the body group: translate to step. */
  readonly footL: THREE.Group | null
  readonly footR: THREE.Group | null
}

/**
 * Glowing materials the animator drives via emissiveIntensity (rest values: tuning.anim.glow).
 * Each is its color × tuning.render.glowAlbedo as lit plastic plus the color as emissive, so at
 * rest it reads at its hex instead of clipping toward white.
 */
export interface BitbotGlow {
  readonly antennaTip: THREE.MeshStandardMaterial | null
  readonly powerLight: THREE.MeshStandardMaterial | null
  readonly amberLight: THREE.MeshStandardMaterial | null
}

export interface ContactShadow {
  readonly mesh: THREE.Mesh
  /** 0..1, where 1 = §6.1's full strength (black at tuning.render.contactShadowOpacity). */
  readonly strength: number
  /** 0 hides the mesh entirely (no draw call); use it when not standing on a surface, fade with height when falling. */
  setStrength(strength: number): void
  /**
   * Draws only the part of the shadow on the positive side of `plane` (world space, read every
   * frame, so update it in place); null draws all of it. The pet scene passes its ground-line
   * plane so the shadow never paints below the surface line the pet stands on. Needs
   * renderer.localClippingEnabled.
   */
  clipTo(plane: THREE.Plane | null): void
}

/** §6.4 "dusty": grey specks on the body's top and sides, shown when dust is visible (the animator sets how many). */
export interface DustSpecks {
  readonly mesh: THREE.InstancedMesh
  /** Specks shown (0 hides the mesh: no draw call); clamped to the number built. */
  readonly count: number
  setCount(count: number): void
}

export interface BitbotRig {
  /**
   * Root group. Its local origin is the pet's ground-contact point (bottom of the feet, centered).
   * Facing goes on rotation.y only (the pet scene re-places its camera for it, keeping the drawn
   * feet on the anchor row); put every other motion on `figure` or `body`.
   */
  root: THREE.Group
  /** Everything except the contact shadow, origin at the ground-contact point: jumps, leans, tumbles. */
  figure: THREE.Group
  /**
   * Everything that bobs/squashes above the planted feet (§6.1: feet are parented outside it).
   * Its origin is the bottom-center of the body box, so scale.y squashes down onto the feet.
   */
  body: THREE.Group
  /** The root object of each built part (parts not listed in the spec are absent). */
  parts: Partial<Record<PartId, THREE.Object3D>>
  joints: BitbotJoints
  attachPoints: Record<AttachPoint, THREE.Object3D>
  /** Invisible collision proxies for pointer hit-testing, all on HIT_LAYER. */
  hitTargets: THREE.Object3D[]
  /** The pixel face on the screen (null if the screen part is not built). */
  face: PixelFace | null
  shadow: ContactShadow | null
  glow: BitbotGlow
  /** Dust specks on the body (null if the body part is not built). */
  dust: DustSpecks | null
  dispose(): void
}

export interface BuildBitbotOptions {
  /** Canvas factory for the pixel face; defaults to a DOM <canvas> (inject one in Node tests). */
  createCanvas?: CanvasFactory
  /** Initial face state. */
  face?: Partial<FaceState>
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

interface BuildContext {
  readonly palette: Palette
  readonly options: BuildBitbotOptions
  readonly root: THREE.Group
  readonly spec: THREE.Group
  readonly bodyContent: THREE.Group
  readonly materials: { primary: THREE.Material; secondary: THREE.Material; outline: THREE.Material }
  readonly joints: Mutable<BitbotJoints>
  readonly glow: Mutable<BitbotGlow>
  face: PixelFace | null
  shadow: ContactShadow | null
  dust: DustSpecks | null
  own<T extends { dispose(): void }>(resource: T): T
  standard(name: string, color: string, roughness: number): THREE.MeshStandardMaterial
  /** A part that glows in `color`: see BitbotGlow. */
  glowing(name: string, color: string, roughness: number, restIntensity: number): THREE.MeshStandardMaterial
  mesh(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D, position?: Vec3): THREE.Mesh
  proxy(id: HitProxyId, geometry: THREE.BufferGeometry, parent: THREE.Object3D, position?: Vec3, scale?: Vec3): THREE.Mesh
}

type PartBuilder = (ctx: BuildContext) => THREE.Object3D

const SIDES: readonly Side[] = [1, -1]
const sideName = (side: Side): 'L' | 'R' => (side === 1 ? 'L' : 'R')

/** One builder per PartId: adding a part to the union without a builder is a compile error. */
const PART_BUILDERS: Record<PartId, PartBuilder> = {
  body(ctx) {
    const b = BASE_FORM.body
    ctx.proxy('body', bodyProxyGeometry(), ctx.bodyContent, b.position)
    const mesh = ctx.mesh('part:body', roundedBoxGeometry(b), ctx.materials.primary, ctx.bodyContent, b.position)
    ctx.dust = dustSpecks(ctx)
    return mesh
  },

  rearCasing(ctx) {
    const c = BASE_FORM.rearCasing
    ctx.proxy('rearCasing', rearCasingProxyGeometry(), ctx.bodyContent, c.position)
    return ctx.mesh('part:rearCasing', roundedBoxGeometry(c), ctx.materials.secondary, ctx.bodyContent, c.position)
  },

  sideVents(ctx) {
    const v = BASE_FORM.sideVents
    const positions: Vec3[] = []
    for (const side of SIDES) for (let i = 0; i < v.perSide; i++) positions.push([side * v.x, v.yTop - i * v.yStep, v.z])
    const slot = new THREE.BoxGeometry(...v.size)
    const merged = instancedMerge(slot, positions)
    slot.dispose()
    return ctx.mesh('part:sideVents', merged, ctx.materials.outline, ctx.bodyContent)
  },

  bezel(ctx) {
    const b = BASE_FORM.bezel
    const { geometry, z } = screenProxyGeometry()
    ctx.proxy('screen', geometry, ctx.bodyContent, [b.position[0], b.position[1], z])
    return ctx.mesh('part:bezel', roundedBoxGeometry(b), ctx.materials.outline, ctx.bodyContent, b.position)
  },

  screen(ctx) {
    const s = BASE_FORM.screen
    const face = ctx.own(createPixelFace(ctx.palette, { createCanvas: ctx.options.createCanvas, state: ctx.options.face }))
    ctx.face = face
    // Unlit so it reads as a glowing screen (§6.1).
    const material = ctx.own(createFaceMaterial(face))
    const geometry = bulgedScreenGeometry(s.w, s.h, s.segments, s.bulgeBase, s.bulgeK)
    return ctx.mesh('part:screen', geometry, material, ctx.bodyContent, [s.position[0], s.position[1], s.position[2] + s.forwardOffset])
  },

  bellyLights(ctx) {
    const b = BASE_FORM.bellyLights
    const group = named(new THREE.Group(), 'part:bellyLights')
    ctx.bodyContent.add(group)
    // Cylinder axis y → z so the caps face forward.
    const lens = ctx.own(new THREE.CylinderGeometry(b.r, b.r, b.length, 20).rotateX(Math.PI / 2))
    const { leds } = tuning.render
    const power = ctx.glowing('powerLight', leds.powerColor, leds.roughness, tuning.anim.glow.powerLight)
    const amber = ctx.glowing('amberLight', leds.amberColor, leds.roughness, tuning.anim.glow.amberLight)
    ctx.mesh('powerLight', lens, power, group, b.power)
    ctx.mesh('amberLight', lens, amber, group, b.amber)
    ctx.glow.powerLight = power
    ctx.glow.amberLight = amber
    return group
  },

  bellyKeys(ctx) {
    const k = BASE_FORM.bellyKeys
    const key = roundedBoxGeometry(k)
    const merged = instancedMerge(
      key,
      k.xs.map((x): Vec3 => [x, k.y, k.z]),
    )
    key.dispose()
    return ctx.mesh('part:bellyKeys', merged, ctx.materials.outline, ctx.bodyContent)
  },

  antenna(ctx) {
    const a = BASE_FORM.antenna
    const joint = named(new THREE.Group(), 'joint:antenna')
    joint.position.set(...a.position)
    ctx.bodyContent.add(joint)
    const curve = new THREE.CatmullRomCurve3(a.cable.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)))
    // Base and cable share the outline material and never move apart: one mesh, one draw call.
    const stalk = mergeAll([
      new THREE.CylinderGeometry(a.base.radiusTop, a.base.radiusBottom, a.base.height, 24),
      new THREE.TubeGeometry(curve, 32, a.cable.radius, 10, false),
    ])
    ctx.mesh('antennaStalk', stalk, ctx.materials.outline, joint)
    const tipMaterial = ctx.glowing('antennaTip', ctx.palette.accent, tuning.render.antennaTipRoughness, tuning.anim.glow.antennaTip)
    ctx.mesh('antennaTip', new THREE.SphereGeometry(a.tip.radius, 24, 16), tipMaterial, joint, a.tip.position)
    ctx.proxy('antennaTip', antennaTipProxyGeometry(), joint, a.tip.position)
    ctx.proxy('antennaCable', antennaCableProxyGeometry(curve), joint)
    ctx.joints.antenna = joint
    ctx.glow.antennaTip = tipMaterial
    return joint
  },

  arms(ctx) {
    const a = BASE_FORM.arms
    const group = named(new THREE.Group(), 'part:arms')
    ctx.bodyContent.add(group)
    const capsule = ctx.own(new THREE.CapsuleGeometry(a.radius, a.length, 8, 16))
    const proxyCapsule = ctx.own(armProxyGeometry())
    for (const side of SIDES) {
      const { position, rotationZ } = armShoulder(side)
      const pivot = named(new THREE.Group(), `joint:arm${sideName(side)}`)
      pivot.position.set(...position)
      pivot.rotation.z = rotationZ
      group.add(pivot)
      ctx.mesh(`arm${sideName(side)}`, capsule, ctx.materials.primary, pivot, [0, ARM_CENTER_OFFSET, 0])
      ctx.proxy(side === 1 ? 'armL' : 'armR', proxyCapsule, pivot, [0, ARM_PROXY_OFFSET, 0])
      if (side === 1) ctx.joints.armL = pivot
      else ctx.joints.armR = pivot
    }
    return group
  },

  feet(ctx) {
    const f = BASE_FORM.feet
    const group = named(new THREE.Group(), 'part:feet')
    ctx.spec.add(group)
    const ball = ctx.own(new THREE.SphereGeometry(f.radius, 32, 20))
    const proxyBall = ctx.own(footProxyGeometry())
    for (const side of SIDES) {
      const joint = named(new THREE.Group(), `joint:foot${sideName(side)}`)
      joint.position.set(side * f.x, f.y, f.z)
      group.add(joint)
      ctx.mesh(`foot${sideName(side)}`, ball, ctx.materials.secondary, joint).scale.set(...f.scale)
      ctx.proxy(side === 1 ? 'footL' : 'footR', proxyBall, joint, undefined, f.scale)
      if (side === 1) ctx.joints.footL = joint
      else ctx.joints.footR = joint
    }
    return group
  },

  contactShadow(ctx) {
    const c = BASE_FORM.contactShadow
    // Flat on the ground plane (circle in XY → XZ, facing up), squashed to an ellipse.
    const geometry = new THREE.CircleGeometry(c.radius, 48).rotateX(-Math.PI / 2).scale(1, 1, c.scaleZ)
    const material = ctx.own(
      new THREE.MeshBasicMaterial({
        name: 'contactShadow',
        color: 0x000000,
        transparent: true,
        opacity: tuning.render.contactShadowOpacity,
        depthWrite: false,
      }),
    )
    // Parented to the root, not the figure: it stays on the ground while the pet jumps.
    const mesh = ctx.mesh('part:contactShadow', geometry, material, ctx.root, [0, SPEC_ORIGIN_HEIGHT + c.y + SHADOW_LIFT, 0])
    ctx.shadow = contactShadowControl(mesh, material)
    return mesh
  },
}

export function buildBitbot(spec: CharacterSpec, options: BuildBitbotOptions = {}): BitbotRig {
  // Everything disposable the rig creates; a Set so shared geometries are owned (and disposed) once.
  const owned = new Set<{ dispose(): void }>()
  const own = <T extends { dispose(): void }>(resource: T): T => {
    owned.add(resource)
    return resource
  }
  const standard = (name: string, color: string, roughness: number): THREE.MeshStandardMaterial =>
    own(new THREE.MeshStandardMaterial({ name, color, roughness, metalness: 0.05 }))
  const glowing = (name: string, color: string, roughness: number, restIntensity: number): THREE.MeshStandardMaterial => {
    const material = standard(name, color, roughness)
    // SPEC-DEVIATION: §6.1 gives glowing parts their color plus emissive. With the full color as
    // both lit albedo and emissive, the lit side summed past 1 and clipped toward white with a hue
    // shift (amber read as lemon yellow, power green as pale cyan, the mint accent tip as pale
    // orange). So the albedo is the color × glowAlbedo and the emissive supplies the rest: at rest
    // the part reads at its hex, and the animator still dims, blinks or flashes it.
    material.color.multiplyScalar(tuning.render.glowAlbedo)
    material.emissive.set(color)
    material.emissiveIntensity = restIntensity
    return material
  }
  const hitMaterial = own(createHitProxyMaterial())

  const root = named(new THREE.Group(), 'bitbot')
  const figure = named(new THREE.Group(), 'figure')
  root.add(figure)
  const specSpace = named(new THREE.Group(), 'spec')
  specSpace.position.y = SPEC_ORIGIN_HEIGHT
  figure.add(specSpace)
  const body = named(new THREE.Group(), 'body')
  body.position.y = BODY_BOTTOM_Y
  specSpace.add(body)
  const bodyContent = named(new THREE.Group(), 'bodyContent')
  bodyContent.position.y = -BODY_BOTTOM_Y
  body.add(bodyContent)

  const hitTargets: THREE.Object3D[] = []
  const ctx: BuildContext = {
    palette: spec.palette,
    options,
    root,
    spec: specSpace,
    bodyContent,
    materials: {
      primary: standard('primary', spec.palette.primary, 0.42),
      secondary: standard('secondary', spec.palette.secondary, 0.5),
      outline: standard('outline', spec.palette.outline, 0.5),
    },
    joints: { armL: null, armR: null, antenna: null, footL: null, footR: null },
    glow: { antennaTip: null, powerLight: null, amberLight: null },
    face: null,
    shadow: null,
    dust: null,
    own,
    standard,
    glowing,
    mesh(name, geometry, material, parent, position) {
      const mesh = new THREE.Mesh(own(geometry), material)
      mesh.name = name
      if (position) mesh.position.set(...position)
      parent.add(mesh)
      return mesh
    },
    proxy(id, geometry, parent, position, scale) {
      const mesh = hitProxy(id, own(geometry), hitMaterial)
      if (position) mesh.position.set(...position)
      if (scale) mesh.scale.set(...scale)
      parent.add(mesh)
      hitTargets.push(mesh)
      return mesh
    },
  }

  const parts: Partial<Record<PartId, THREE.Object3D>> = {}
  for (const id of new Set(spec.parts)) parts[id] = PART_BUILDERS[id](ctx)

  const attachPoints = createAttachPoints({ body: bodyContent, ground: specSpace, ...ctx.joints })

  return {
    root,
    figure,
    body,
    parts,
    joints: ctx.joints,
    attachPoints,
    hitTargets,
    face: ctx.face,
    shadow: ctx.shadow,
    glow: ctx.glow,
    dust: ctx.dust,
    dispose() {
      root.removeFromParent()
      for (const resource of owned) resource.dispose()
      owned.clear()
    },
  }
}

function named<T extends THREE.Object3D>(object: T, name: string): T {
  object.name = name
  return object
}

/**
 * Dust specks: small flat grey dots lying on the body's flat top and side faces, at fixed pseudo-random spots
 * (tuning.anim.dust.seed), so the same specks appear in the same order as dust builds up. One instanced mesh.
 */
function dustSpecks(ctx: BuildContext): DustSpecks {
  const d = tuning.anim.dust
  const outer = BODY_OUTER
  // The flat parts of the faces (the rounded corners and bevels are left bare).
  const r = BASE_FORM.body.r
  const halfW = BASE_FORM.body.w / 2 - r
  const halfH = BASE_FORM.body.h / 2 - r
  const halfD = BASE_FORM.body.depth / 2 - d.radius
  const random = mulberry32(d.seed)
  const geometry = ctx.own(new THREE.CircleGeometry(d.radius, 8))
  const material = ctx.own(new THREE.MeshStandardMaterial({ name: 'dust', color: d.color, roughness: 1, metalness: 0 }))
  const mesh = new THREE.InstancedMesh(geometry, material, d.maxSpecks)
  mesh.name = 'dust'
  const lift = 0.002
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 0, 1)
  for (let i = 0; i < d.maxSpecks; i++) {
    // Half on the top face, a quarter on each side.
    const face = i % 4 < 2 ? 'top' : i % 4 === 2 ? 'left' : 'right'
    const a = random() * 2 - 1
    const c = random() * 2 - 1
    const scale = 0.6 + random() * 0.8
    let position: THREE.Vector3
    let normal: THREE.Vector3
    if (face === 'top') {
      position = new THREE.Vector3(a * halfW, outer.h / 2 + lift, c * halfD)
      normal = new THREE.Vector3(0, 1, 0)
    } else {
      const side = face === 'left' ? 1 : -1
      position = new THREE.Vector3(side * (outer.w / 2 + lift), a * halfH, c * halfD)
      normal = new THREE.Vector3(side, 0, 0)
    }
    q.setFromUnitVectors(up, normal)
    m.compose(position, q, new THREE.Vector3(scale, scale, scale))
    mesh.setMatrixAt(i, m)
  }
  mesh.instanceMatrix.needsUpdate = true
  mesh.count = 0
  mesh.visible = false
  ctx.bodyContent.add(mesh)
  ctx.own({ dispose: () => mesh.dispose() })
  return {
    mesh,
    get count() {
      return mesh.count
    },
    setCount(count) {
      const n = Math.max(0, Math.min(d.maxSpecks, Math.floor(Number.isFinite(count) ? count : 0)))
      mesh.count = n
      mesh.visible = n > 0
    },
  }
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function contactShadowControl(mesh: THREE.Mesh, material: THREE.MeshBasicMaterial): ContactShadow {
  let strength = 1
  return {
    mesh,
    get strength() {
      return strength
    },
    setStrength(value) {
      strength = Math.min(1, Math.max(0, value))
      material.opacity = tuning.render.contactShadowOpacity * strength
      mesh.visible = strength > 0
    },
    clipTo(plane) {
      material.clippingPlanes = plane ? [plane] : null
      material.needsUpdate = true
    },
  }
}
