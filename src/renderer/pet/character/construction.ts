// §6.1 construction table for the base form, in scene units, in "spec space": origin at the
// body center, +y up, +z out of the screen face, +x toward the pet's own left (it faces +z).
// These numbers are the approved concept's proportions (model data), not tunables, so they live
// here rather than in tuning.ts. Derived values below are computed, never retyped.

export type Vec3 = readonly [number, number, number]

/** A rounded box: rounded-rect Shape (w × h, corner r) extruded by depth with a bevel that ADDS to the outer size. */
export interface RoundedBoxDims {
  readonly w: number
  readonly h: number
  readonly r: number
  readonly depth: number
  readonly bevel: number
}

export const BASE_FORM = {
  body: { w: 1.6, h: 1.3, r: 0.32, depth: 0.9, bevel: 0.14, position: [0, 0, 0] as Vec3 },
  rearCasing: { w: 1.05, h: 0.85, r: 0.28, depth: 0.45, bevel: 0.12, position: [0, 0, -0.72] as Vec3 },
  sideVents: { size: [0.03, 0.06, 0.5] as Vec3, x: 0.94, yTop: 0.2, yStep: 0.13, perSide: 4, z: -0.05 },
  bezel: { w: 1.22, h: 0.94, r: 0.18, depth: 0.04, bevel: 0.03, position: [0, 0.1, 0.6] as Vec3 },
  screen: {
    w: 1.06,
    h: 0.79,
    segments: 12,
    /** Vertex z = bulgeBase − (x² + y²) · bulgeK (slight CRT bulge). */
    bulgeBase: 0.06,
    bulgeK: 0.08,
    position: [0, 0.1, 0.6] as Vec3,
    // SPEC-DEVIATION: §6.1 puts the bulged screen at z 0.6 too, where its surface (z 0.625..0.66)
    // lies mostly behind the bezel's front face (z 0.65; the bezel spans 0.55..0.65 because its
    // bevel adds to the outer size), so only a ~0.35-radius disc of the face would show. The
    // smallest fix: push the screen plane forward by 0.03 so its lowest points (the corners, local
    // z 0.025) sit 0.005 in front of the bezel face. Shape, size and bulge are unchanged.
    forwardOffset: 0.03,
  },
  bellyLights: {
    r: 0.045,
    /** Not in §6.1 ("short cylinders"): long enough to reach back into the body face at z 0.59. */
    length: 0.07,
    power: [-0.55, -0.48, 0.62] as Vec3,
    amber: [-0.4, -0.48, 0.62] as Vec3,
  },
  bellyKeys: {
    w: 0.13,
    h: 0.07,
    // Corner radius, depth and bevel are not in §6.1; chosen to read as small key caps (outer 0.154 × 0.094 × 0.054).
    r: 0.025,
    depth: 0.03,
    bevel: 0.012,
    xs: [0.25, 0.43, 0.61] as const,
    y: -0.48,
    z: 0.6,
  },
  antenna: {
    position: [0.15, 0.78, -0.05] as Vec3,
    base: { radiusTop: 0.09, radiusBottom: 0.11, height: 0.08 },
    cable: {
      radius: 0.035,
      points: [
        [0, 0, 0],
        [0.02, 0.3, 0],
        [0.12, 0.55, 0.05],
        [0.35, 0.66, 0.1],
      ] as readonly Vec3[],
    },
    tip: { radius: 0.1, position: [0.38, 0.66, 0.1] as Vec3 },
  },
  arms: {
    /** Capsule = cylinder (radius, length) + two spheres (radius). */
    radius: 0.11,
    length: 0.3,
    /** Arm centers at (±x, y, z); x > 0 is the pet's left arm. */
    x: 1.0,
    y: -0.1,
    z: 0.15,
    /** Base rotation about z is −side · rotZ (x = +1 → −0.5): the outer ends tilt up and away from the body. */
    rotZ: 0.5,
  },
  feet: { radius: 0.22, scale: [1, 0.55, 1.3] as Vec3, x: 0.42, y: -0.84, z: 0.12 },
  contactShadow: { radius: 1.1, scaleZ: 0.6, y: -0.95 },
} as const

// ---- Derived measurements -------------------------------------------------------------------

/** Outer size of a rounded box (the bevel adds on every side). */
export function outerSize(d: RoundedBoxDims): { w: number; h: number; depth: number } {
  return { w: d.w + 2 * d.bevel, h: d.h + 2 * d.bevel, depth: d.depth + 2 * d.bevel }
}

const bodyOuter = outerSize(BASE_FORM.body)

/** Outer body size: 1.88 × 1.58 × 1.18. */
export const BODY_OUTER = bodyOuter
/**
 * Body box height in scene units (the box's own height, 1.58). On screen the framing scales the
 * pet so the DRAWN body box, which also shows a sliver of its top face, is
 * tuning.render.bodyHeightPt tall at the default yaw (see framing.ts).
 */
export const BODY_HEIGHT_UNITS = bodyOuter.h
/** Spec-space y of the body's bottom face: the squash/bob pivot of the body group. */
export const BODY_BOTTOM_Y = -bodyOuter.h / 2
/** Height of the spec origin (body center) above the ground-contact point (bottom of the feet). */
export const SPEC_ORIGIN_HEIGHT = -BASE_FORM.feet.y + BASE_FORM.feet.radius * BASE_FORM.feet.scale[1]

/** Side of the pet: +1 = the pet's own left (+x), −1 = its right (−x). */
export type Side = 1 | -1

/**
 * Shoulder pivot of one arm in spec space: the center of the end cap that meets the body, i.e.
 * the cap nearer the body's center plane (for an exactly vertical arm, the upper cap).
 *
 * The pivot's local +y always runs shoulder → hand, so the arm mesh sits at
 * (0, ARM_CENTER_OFFSET, 0) and the hand at (0, ARM_HAND_OFFSET, 0) whichever way the tilt points.
 * With the §6.1 sign (x = +1 → −0.5) the outer ends tilt up, the shoulder is the lower cap and
 * rotationZ is the tilt itself. With the opposite sign (arms hanging outward) the shoulder is the
 * upper cap and rotationZ = tilt + π; the capsule is symmetric, so it looks identical.
 * `rotZ` defaults to §6.1's 0.5 (exposed so both signs can be tested).
 */
export function armShoulder(side: Side, rotZ: number = BASE_FORM.arms.rotZ): { position: Vec3; rotationZ: number } {
  const { x, y, z, length } = BASE_FORM.arms
  const tilt = -side * rotZ
  // The capsule axis is local +y rotated about z by the tilt: (−sin tilt, cos tilt, 0). Its cap
  // centers sit at center ± half·axis; the one at center − half·axis is the body-side cap iff
  // the axis points away from the body (side · axisX > 0).
  const axisX = -Math.sin(tilt)
  const axisY = Math.cos(tilt)
  const toHand = side * axisX > 0 ? 1 : -1
  const half = length / 2
  return {
    position: [side * x - toHand * half * axisX, y - toHand * half * axisY, z],
    rotationZ: toHand === 1 ? tilt : tilt + Math.PI,
  }
}

/** Distance from the shoulder pivot to the arm's center and to the hand (outer cap center), along the arm axis. */
export const ARM_CENTER_OFFSET = BASE_FORM.arms.length / 2
export const ARM_HAND_OFFSET = BASE_FORM.arms.length
