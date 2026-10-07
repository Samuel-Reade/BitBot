import * as THREE from 'three'
import { ATTACH_POINTS, type AttachPoint } from '../../../shared/types'
import { ARM_HAND_OFFSET, BASE_FORM, BODY_OUTER, armShoulder, outerSize, type Side, type Vec3 } from './construction'

// §6.5 attach points: named Object3D anchors that Phase 3 cosmetics parent to. Each anchor is
// parented to the joint it must move with (hands swing with the arms, the antenna tip sways with
// the antenna, feet step, everything else bobs/squashes with the body).
//
// Conventions for cosmetic authors:
// - L/R are the pet's own left/right. The pet faces +z, so *_L anchors sit on +x.
// - Anchors carry no rotation: items are authored in the pet's frame (+y up, +z forward).
// - Positions below are in the joint's local frame (spec units).

export type AttachJoint = 'body' | 'armL' | 'armR' | 'antenna' | 'footL' | 'footR'

export interface AttachSpec {
  readonly joint: AttachJoint
  readonly position: Vec3
}

const screenFrontZ = BASE_FORM.screen.position[2] + BASE_FORM.screen.forwardOffset + BASE_FORM.screen.bulgeBase
const casingBackZ = BASE_FORM.rearCasing.position[2] - outerSize(BASE_FORM.rearCasing).depth / 2
/** A hair off the surface so an item's origin is never inside the mesh it decorates. */
const SURFACE_GAP = 0.01

export const ATTACH_LAYOUT: Readonly<Record<AttachPoint, AttachSpec>> = {
  // Top center of the body (the antenna base is at x +0.15, z −0.05 — hats must leave room for it).
  head_top: { joint: 'body', position: [0, BODY_OUTER.h / 2, 0] },
  // Upper side walls, above the vents.
  head_side_L: { joint: 'body', position: [BODY_OUTER.w / 2, 0.35, BASE_FORM.sideVents.z] },
  head_side_R: { joint: 'body', position: [-BODY_OUTER.w / 2, 0.35, BASE_FORM.sideVents.z] },
  // Screen center, just in front of the bulged glass (face themes).
  face_screen: { joint: 'body', position: [0, BASE_FORM.screen.position[1], screenFrontZ + SURFACE_GAP] },
  // Just behind the CRT back.
  back_casing: { joint: 'body', position: [0, BASE_FORM.rearCasing.position[1], casingBackZ - SURFACE_GAP] },
  // Center of the tip ball.
  antenna_tip: { joint: 'antenna', position: BASE_FORM.antenna.tip.position },
  // Center of the outer end cap of each arm.
  hand_L: { joint: 'armL', position: [0, ARM_HAND_OFFSET, 0] },
  hand_R: { joint: 'armR', position: [0, ARM_HAND_OFFSET, 0] },
  // Lower front, between the belly lights and the keys, on the body face.
  belly: { joint: 'body', position: [0, -0.5, BODY_OUTER.depth / 2] },
  // Foot centers.
  foot_L: { joint: 'footL', position: [0, 0, 0] },
  foot_R: { joint: 'footR', position: [0, 0, 0] },
}

export interface AttachFrames {
  /** Spec space, moving with the body (bob/squash). */
  readonly body: THREE.Object3D
  /** Spec space, NOT moving with the body: fallback frame for feet when the feet part is absent. */
  readonly ground: THREE.Object3D
  readonly armL: THREE.Object3D | null
  readonly armR: THREE.Object3D | null
  readonly antenna: THREE.Object3D | null
  readonly footL: THREE.Object3D | null
  readonly footR: THREE.Object3D | null
}

/**
 * Creates every §6.5 anchor. When a joint's part is not built (e.g. a form without arms) the
 * anchor falls back to where the joint would hold it at rest, in the body (or ground) frame.
 */
export function createAttachPoints(frames: AttachFrames): Record<AttachPoint, THREE.Object3D> {
  const out = {} as Record<AttachPoint, THREE.Object3D>
  for (const name of ATTACH_POINTS) {
    const { joint, position } = ATTACH_LAYOUT[name]
    const anchor = new THREE.Object3D()
    anchor.name = `attach:${name}`
    const parent = joint === 'body' ? frames.body : frames[joint]
    if (parent) {
      anchor.position.set(...position)
      parent.add(anchor)
    } else {
      anchor.position.set(...restPositionInSpec(joint, position))
      ;(joint === 'footL' || joint === 'footR' ? frames.ground : frames.body).add(anchor)
    }
    out[name] = anchor
  }
  return out
}

/** Spec-space rest position of a point given in a joint's local frame. */
export function restPositionInSpec(joint: AttachJoint, local: Vec3): Vec3 {
  const [lx, ly, lz] = local
  switch (joint) {
    case 'body':
      return local
    case 'armL':
    case 'armR': {
      const side: Side = joint === 'armL' ? 1 : -1
      const { position, rotationZ } = armShoulder(side)
      const c = Math.cos(rotationZ)
      const s = Math.sin(rotationZ)
      return [position[0] + lx * c - ly * s, position[1] + lx * s + ly * c, position[2] + lz]
    }
    case 'antenna': {
      const [ax, ay, az] = BASE_FORM.antenna.position
      return [ax + lx, ay + ly, az + lz]
    }
    case 'footL':
    case 'footR': {
      const side = joint === 'footL' ? 1 : -1
      const { x, y, z } = BASE_FORM.feet
      return [side * x + lx, y + ly, z + lz]
    }
  }
}
