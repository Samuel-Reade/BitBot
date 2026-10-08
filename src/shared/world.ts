// The world the pet moves through (§8): surfaces derived from the primary display and its windows, in global screen
// points (y down). Shared: main builds and walks it (src/main/sim/world/, src/main/sim/locomotion/), the overlay draws
// it in the debug view (debug:world). Pure.

import { isPoint, type Box, type Point } from './geometry'

/**
 * A horizontal surface the pet stands and walks on (§8.1 ground, §8.1 window tops, §8.3 visible parts only). x0..x1 is
 * where its ground-contact point may be (already inset from the visible edges so the pet doesn't hang off them).
 */
export interface Segment {
  /** Stable while the surface exists: 'ground', 'top:<wid>:<n>' (n: the n-th visible piece, left to right). */
  id: string
  kind: 'ground' | 'windowTop'
  /** CGWindowID of the window whose top this is; null for the ground. */
  windowId: number | null
  y: number
  x0: number
  x1: number
}

/**
 * A vertical surface the pet climbs (§8.1 screen walls, window sides; visible parts only). While climbing, the pet's
 * contact point is at (x, y) with y in y0..y1 (top..bottom, already inset so its body stays clear of what is above and
 * below), its feet against the wall.
 */
export interface Wall {
  /** 'wall:left', 'wall:right' (the screen's), 'side:<wid>:<left|right>:<n>'. */
  id: string
  kind: 'screenWall' | 'windowSide'
  windowId: number | null
  x: number
  y0: number
  y1: number
  /** Which side of the pet the wall is on while it climbs (its feet point that way). */
  wallOn: 'left' | 'right'
}

/**
 * How the pet is attached (pet:state): 'floor' stands on a segment (or falls, jumps, is held); 'wallLeft' / 'wallRight'
 * climbs a wall on its left / right: the overlay turns it a quarter turn so its feet face the wall, about the contact
 * point.
 */
export const PET_ATTACHES = ['floor', 'wallLeft', 'wallRight'] as const
export type PetAttach = (typeof PET_ATTACHES)[number]

export function isPetAttach(value: unknown): value is PetAttach {
  return typeof value === 'string' && (PET_ATTACHES as readonly string[]).includes(value)
}

/**
 * The pet's box (relative to its contact point, pt, as measured standing: PetReadyMsg.petBox) for `attach`: standing,
 * as is; on a wall, turned a quarter turn about the contact point so the feet face the wall (the head points away).
 */
export function boxFor(box: Box, attach: PetAttach): Box {
  switch (attach) {
    case 'floor':
      return { ...box }
    case 'wallRight':
      // Feet (+y, down) turn to +x (right): (x, y) → (y, −x).
      return { left: box.top, right: box.bottom, top: -box.right, bottom: -box.left }
    case 'wallLeft':
      // Feet turn to −x (left): (x, y) → (−y, x).
      return { left: -box.bottom, right: -box.top, top: box.left, bottom: box.right }
  }
}

/** A move between surfaces, for the debug view. */
export interface WorldLink {
  kind: 'walk' | 'drop' | 'jump' | 'climb' | 'mount'
  from: Point
  to: Point
}

/** debug:world — main → overlay (dev builds, while the dev panel's "show world" is on): what the debug view draws. */
export interface DebugWorldMsg {
  /** false: hide the debug view (the other fields are then empty). */
  show: boolean
  segments: Segment[]
  walls: Wall[]
  links: WorldLink[]
  /** The pet's current route, as points; empty when it isn't going anywhere. */
  path: Point[]
  /** The rectangles of the eligible windows (§8.2), for reference. */
  windows: { wid: number; x: number; y: number; width: number; height: number }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function isSegment(value: unknown): value is Segment {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    (value['kind'] === 'ground' || value['kind'] === 'windowTop') &&
    (value['windowId'] === null || finite(value['windowId'])) &&
    finite(value['y']) &&
    finite(value['x0']) &&
    finite(value['x1'])
  )
}

export function isWall(value: unknown): value is Wall {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    (value['kind'] === 'screenWall' || value['kind'] === 'windowSide') &&
    (value['windowId'] === null || finite(value['windowId'])) &&
    finite(value['x']) &&
    finite(value['y0']) &&
    finite(value['y1']) &&
    (value['wallOn'] === 'left' || value['wallOn'] === 'right')
  )
}

function isLink(value: unknown): value is WorldLink {
  return (
    isRecord(value) &&
    ['walk', 'drop', 'jump', 'climb', 'mount'].includes(value['kind'] as string) &&
    isPoint(value['from']) &&
    isPoint(value['to'])
  )
}

export function isDebugWorldMsg(value: unknown): value is DebugWorldMsg {
  if (!isRecord(value) || typeof value['show'] !== 'boolean') return false
  const list = (v: unknown, item: (x: unknown) => boolean): boolean => Array.isArray(v) && v.every(item)
  return (
    list(value['segments'], isSegment) &&
    list(value['walls'], isWall) &&
    list(value['links'], isLink) &&
    list(value['path'], isPoint) &&
    list(
      value['windows'],
      (w) => isRecord(w) && finite(w['wid']) && finite(w['x']) && finite(w['y']) && finite(w['width']) && finite(w['height']),
    )
  )
}
