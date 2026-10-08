import * as THREE from 'three'
import { tuning } from '../../../shared/tuning'
import type { Palette } from '../../../shared/types'

// The Bitbot egg (BITBOT_SPEC.md §15.1: wobbling on the welcome step, cracking on the hatch step), built procedurally
// in three.js like the pet (no assets). Pure three.js, no DOM: runs in Node for tests.
//
// Shape: a surface of revolution with an egg outline (tuning.onboarding.egg: polar angle φ from the bottom,
// y = −cos φ·h/2, r = R·sin φ·(1 + taper·cos φ)), built as two shells split along a zigzag seam, which is where it
// cracks. The lower shell is tinted toward the palette's primary, the upper one stays pale, and both carry a few
// square "pixel" speckles in the palette's colours (the CRT touch). Normals are analytic (smooth, no pole artefacts).
//
// Hierarchy:  root [the ground-contact point: the bottom of the egg]
//             ├─ shadow (a soft disc on the ground; stays put)
//             └─ rocker [same point]   ← wobble (rocks about the bottom)
//                └─ shell [the egg's centre]
//                   ├─ lower: shell, pixels, crack lines (two tubes along the seam, from the front round each side)
//                   └─ upper [the seam's middle height]: shell, pixels   ← flies off when it parts
//
// wobble(t) rocks it (bursts, or a steady wobble of a given intensity); crack(p) draws the crack for p up to
// crack.drawUntil, then parts the shell; setOpacity() fades it. dispose() frees everything it made.

type EggTuning = typeof tuning.onboarding.egg
type WobbleTuning = typeof tuning.onboarding.wobble

export interface Egg {
  /** Put it in the scene: its origin is the bottom of the egg (stand it on the ground point). */
  readonly root: THREE.Group
  /**
   * Rocks the egg for time `t` (s). intensity null: the welcome wobble (bursts, still in between); a number: a steady
   * wobble that strong (1 = tuning.onboarding.wobble.amplitude). Returns the angle (rad), so a caller can skip a render
   * when it did not change.
   */
  wobble(t: number, intensity?: number | null): number
  /** 0 = whole; up to crack.drawUntil the crack line grows round the seam; then the top flies off, 1 = fully parted. */
  crack(progress: number): void
  /** 0..1 (1 = opaque). */
  setOpacity(alpha: number): void
  dispose(): void
}

/** The rocking angle at time t (s). intensity null: bursts of burstS every periodS (zero in between); else steady. */
export function wobbleAngle(t: number, intensity: number | null, w: WobbleTuning = tuning.onboarding.wobble): number {
  if (!Number.isFinite(t)) return 0
  if (intensity !== null) {
    if (!Number.isFinite(intensity) || intensity === 0) return 0
    return intensity * w.amplitude * Math.sin(2 * Math.PI * w.hz * t)
  }
  // Each burst the same, timed from its own start.
  const phase = ((t % w.periodS) + w.periodS) % w.periodS
  if (phase >= w.burstS) return 0
  return w.amplitude * Math.sin((Math.PI * phase) / w.burstS) * Math.sin(2 * Math.PI * w.hz * phase)
}

/** The seam's polar angle at azimuth θ: a triangle wave round the egg, a tooth tip at the front (θ = 0). */
export function seamAngle(theta: number, p: EggTuning = tuning.onboarding.egg): number {
  const x = (theta * p.seam.teeth) / (2 * Math.PI) // one tooth per unit
  const frac = x - Math.floor(x)
  const tri = 1 - 4 * Math.abs(frac - 0.5) // −1 at the tooth's start/end, +1 in its middle
  return p.seam.angle - p.seam.amplitude * tri
}

interface ProfilePoint {
  r: number
  y: number
  /** Unit outward normal in the (radial, y) plane. */
  nr: number
  ny: number
}

function profile(phi: number, p: EggTuning): ProfilePoint {
  const half = p.height / 2
  const s = Math.sin(phi)
  const c = Math.cos(phi)
  const r = p.radius * s * (1 + p.taper * c)
  const y = -c * half
  const dr = p.radius * (c * (1 + p.taper * c) - p.taper * s * s)
  const dy = s * half
  const len = Math.hypot(dy, dr) || 1
  return { r, y, nr: dy / len, ny: -dr / len }
}

function surfacePoint(theta: number, phi: number, p: EggTuning, out: THREE.Vector3, normal?: THREE.Vector3): THREE.Vector3 {
  const q = profile(phi, p)
  const sin = Math.sin(theta)
  const cos = Math.cos(theta)
  out.set(q.r * sin, q.y, q.r * cos)
  normal?.set(q.nr * sin, q.ny, q.nr * cos)
  return out
}

/** One shell half: a grid of columns round the egg, rows from the bottom pole to the seam (lower) or the seam to the top. */
function shellGeometry(lower: boolean, p: EggTuning, yOffset: number): THREE.BufferGeometry {
  const U = p.segments.around
  const V = p.segments.along
  const positions = new Float32Array((U + 1) * (V + 1) * 3)
  const normals = new Float32Array((U + 1) * (V + 1) * 3)
  const pos = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  let k = 0
  for (let iu = 0; iu <= U; iu++) {
    const theta = (2 * Math.PI * iu) / U
    const seam = seamAngle(theta, p)
    for (let iv = 0; iv <= V; iv++) {
      const f = iv / V
      const phi = lower ? f * seam : seam + f * (Math.PI - seam)
      surfacePoint(theta, phi, p, pos, nrm)
      positions.set([pos.x, pos.y - yOffset, pos.z], k)
      normals.set([nrm.x, nrm.y, nrm.z], k)
      k += 3
    }
  }
  const index: number[] = []
  for (let iu = 0; iu < U; iu++) {
    for (let iv = 0; iv < V; iv++) {
      const a = iu * (V + 1) + iv
      const b = (iu + 1) * (V + 1) + iv
      index.push(a, b, b + 1, a, b + 1, a + 1)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setIndex(index)
  return geometry
}

/** A deterministic random source in [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Square tiles lying on one half's surface, edges along the latitude and meridian, in the given colours. */
function pixelSpeckles(lower: boolean, p: EggTuning, colors: readonly THREE.Color[], yOffset: number, random: () => number): THREE.InstancedMesh {
  const { perHalf, size, depth, raise, jitter, seamGap, poleGap, roughness } = p.pixels
  const geometry = new THREE.BoxGeometry(size, size, depth)
  // White: each tile's colour is its instance colour.
  const material = new THREE.MeshStandardMaterial({ name: 'egg-pixels', color: 0xffffff, roughness, metalness: p.metalness })
  const mesh = new THREE.InstancedMesh(geometry, material, perHalf)
  mesh.name = lower ? 'egg-pixels-lower' : 'egg-pixels-upper'
  const pos = new THREE.Vector3()
  const n = new THREE.Vector3()
  const east = new THREE.Vector3()
  const north = new THREE.Vector3()
  const m = new THREE.Matrix4()
  const clear = p.seam.amplitude + seamGap
  for (let i = 0; i < perHalf; i++) {
    // Spread evenly round (with jitter) so they never clump on one side.
    const theta = ((i + random() * jitter) / perHalf) * 2 * Math.PI
    const lo = lower ? poleGap : p.seam.angle + clear
    const hi = lower ? p.seam.angle - clear : Math.PI - poleGap
    const phi = lo + random() * Math.max(0, hi - lo)
    surfacePoint(theta, phi, p, pos, n)
    east.set(Math.cos(theta), 0, -Math.sin(theta))
    north.crossVectors(n, east).normalize()
    m.makeBasis(east, north, n)
    const out = depth * raise
    m.setPosition(pos.x + n.x * out, pos.y + n.y * out - yOffset, pos.z + n.z * out)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, colors[Math.floor(random() * colors.length)] ?? colors[0] ?? new THREE.Color(0xffffff))
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}

/** The crack along the seam from the front tooth round one side (side +1: through +x; −1: through −x), as a tube. */
function crackGeometry(side: 1 | -1, p: EggTuning, yOffset: number): THREE.TubeGeometry {
  const columns = p.segments.around / 2 // half way round
  const path = new THREE.CurvePath<THREE.Vector3>()
  const n = new THREE.Vector3()
  let prev: THREE.Vector3 | null = null
  for (let i = 0; i <= columns; i++) {
    const theta = (side * Math.PI * i) / columns
    const point = surfacePoint(theta, seamAngle(theta, p), p, new THREE.Vector3(), n)
    point.addScaledVector(n, p.crack.radius * p.crack.raise)
    point.y -= yOffset
    if (prev) path.add(new THREE.LineCurve3(prev, point))
    prev = point
  }
  return new THREE.TubeGeometry(path, columns * 2, p.crack.radius, p.segments.crackSides, false)
}

/** A disc on the ground (in its own xy plane: lay it flat), black, its alpha falling off smoothly from the centre. */
function shadowGeometry(p: EggTuning): THREE.BufferGeometry {
  const { radius, opacity, rings, falloff } = p.shadow
  // A ring with a pin-prick hole (a full circle's centre vertex would get one alpha for all its triangles' edges).
  const geometry = new THREE.RingGeometry(radius * 1e-3, radius, p.segments.shadowAround, rings)
  const position = geometry.getAttribute('position')
  const colors = new Float32Array(position.count * 4)
  for (let i = 0; i < position.count; i++) {
    const r = Math.hypot(position.getX(i), position.getY(i)) / radius
    colors[i * 4 + 3] = opacity * Math.pow(Math.max(0, 1 - r), falloff)
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  return geometry
}

export function createEgg(palette: Palette, p: EggTuning = tuning.onboarding.egg): Egg {
  const disposables: { dispose(): void }[] = []
  const own = <T extends { dispose(): void }>(resource: T): T => {
    disposables.push(resource)
    return resource
  }
  const cream = new THREE.Color(p.cream)
  const primary = new THREE.Color(palette.primary)
  const tinted = (amount: number): THREE.Color => cream.clone().lerp(primary, amount)

  const root = new THREE.Group()
  root.name = 'egg'
  const rocker = new THREE.Group()
  rocker.name = 'egg-rocker'
  root.add(rocker)
  const shell = new THREE.Group()
  shell.name = 'egg-shell'
  shell.position.y = p.height / 2
  rocker.add(shell)
  const shadowMaterial = own(new THREE.MeshBasicMaterial({ name: 'egg-shadow', color: 0x000000, vertexColors: true, transparent: true, depthWrite: false }))
  const shadow = new THREE.Mesh(own(shadowGeometry(p)), shadowMaterial)
  shadow.name = 'egg-shadow'
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = p.shadow.lift
  shadow.renderOrder = -1
  root.add(shadow)

  // DoubleSide: once it parts, the inside of each half shows.
  const shellMaterial = (name: string, color: THREE.Color): THREE.MeshStandardMaterial =>
    own(new THREE.MeshStandardMaterial({ name, color, roughness: p.roughness, metalness: p.metalness, side: THREE.DoubleSide }))
  const lowerMaterial = shellMaterial('egg-lower', tinted(p.tint.lower))
  const upperMaterial = shellMaterial('egg-upper', tinted(p.tint.upper))
  const crackMaterial = own(new THREE.MeshBasicMaterial({ name: 'egg-crack', color: palette.outline }))

  const random = seeded(p.pixels.seed)
  const lower = new THREE.Group()
  lower.name = 'egg-lower'
  shell.add(lower)
  lower.add(new THREE.Mesh(own(shellGeometry(true, p, 0)), lowerMaterial))
  const lowerPixels = pixelSpeckles(true, p, [cream, new THREE.Color(palette.screenGlow), new THREE.Color(palette.accent)], 0, random)
  own(lowerPixels)
  own(lowerPixels.geometry)
  own(lowerPixels.material as THREE.Material)
  lower.add(lowerPixels)

  // The upper half pivots about the seam's middle height.
  const seamY = profile(p.seam.angle, p).y
  const upper = new THREE.Group()
  upper.name = 'egg-upper'
  upper.position.y = seamY
  shell.add(upper)
  upper.add(new THREE.Mesh(own(shellGeometry(false, p, seamY)), upperMaterial))
  const upperPixels = pixelSpeckles(false, p, [primary, new THREE.Color(palette.secondary), new THREE.Color(palette.accent)], seamY, random)
  own(upperPixels)
  own(upperPixels.geometry)
  own(upperPixels.material as THREE.Material)
  upper.add(upperPixels)

  const cracks = ([1, -1] as const).map((side) => {
    const geometry = own(crackGeometry(side, p, 0))
    const mesh = new THREE.Mesh(geometry, crackMaterial)
    mesh.name = side === 1 ? 'egg-crack-right' : 'egg-crack-left'
    mesh.visible = false
    lower.add(mesh)
    return { mesh, geometry, total: geometry.index?.count ?? 0 }
  })
  const radialIndices = p.segments.crackSides * 6 // indices per tube segment (its sides × two triangles of 3)

  const materials: THREE.Material[] = [lowerMaterial, upperMaterial, crackMaterial, lowerPixels.material as THREE.Material, upperPixels.material as THREE.Material]
  let opacity = 1

  return {
    root,
    wobble(t, intensity = null) {
      const angle = wobbleAngle(t, intensity)
      rocker.rotation.z = angle
      return angle
    },
    crack(progress) {
      const pr = THREE.MathUtils.clamp(Number.isFinite(progress) ? progress : 0, 0, 1)
      const draw = THREE.MathUtils.clamp(pr / p.crack.drawUntil, 0, 1)
      for (const c of cracks) {
        const count = Math.floor((c.total / radialIndices) * draw) * radialIndices
        c.mesh.visible = count > 0
        c.geometry.setDrawRange(0, count)
      }
      const s = THREE.MathUtils.smootherstep(pr, p.crack.drawUntil, 1)
      upper.position.set(p.part.side * s, seamY + p.part.lift * s, 0)
      upper.rotation.z = -p.part.tilt * s
      lower.rotation.z = p.part.lowerTilt * s
    },
    setOpacity(alpha) {
      const a = THREE.MathUtils.clamp(Number.isFinite(alpha) ? alpha : 1, 0, 1)
      if (a === opacity) return
      const wasTransparent = opacity < 1
      opacity = a
      for (const material of materials) {
        material.opacity = a
        material.transparent = a < 1
        if (wasTransparent !== a < 1) material.needsUpdate = true
      }
      shadowMaterial.opacity = a // always transparent (its alpha is in its vertex colours)
      root.visible = a > 0
    },
    dispose() {
      root.removeFromParent()
      for (const resource of disposables) resource.dispose()
      disposables.length = 0
    },
  }
}
