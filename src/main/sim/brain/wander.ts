// Wandering: Milestone 3's stand-in for Roam (BITBOT_SPEC.md §10.2) until the utility AI (M6). After the pet has been
// idle a while it picks somewhere to go: a window top, up a wall or window side, or anywhere. Pure: randomness and
// time are passed in.

import { distance, type Point } from '../../../shared/geometry'
import type { tuning } from '../../../shared/tuning'
import { findRoute, placeOf } from '../world/navigation'
import type { World } from '../world/worldModel'

export type WanderKind = 'any' | 'window' | 'wall'

export type WanderParams = typeof tuning.brain.wander

/**
 * A place to go:
 * 'any'     a random point on any segment, uniform along their total length, at least minDistancePt from `from`
 *           along its own segment;
 * 'window'  the same on window tops only;
 * 'wall'    the top of the nearest wall or window side the pet can reach (else the nearest one; never the top it is
 *           already at).
 * Null when there is nowhere to go. One draw of `random` for 'any' and 'window', none for 'wall'.
 */
export function pickTarget(kind: WanderKind, world: World, from: Point, random: () => number, minDistancePt = 0): Point | null {
  if (kind === 'wall') return wallTarget(world, from)
  const pieces: { y: number; x0: number; x1: number }[] = []
  for (const s of world.segments) {
    if (kind === 'window' && s.kind !== 'windowTop') continue
    const here = Math.abs(from.y - s.y) <= world.params.occlusionTolerance && from.x >= s.x0 && from.x <= s.x1
    if (!here) {
      pieces.push({ y: s.y, x0: s.x0, x1: s.x1 })
      continue
    }
    // Not too near where it stands.
    if (from.x - minDistancePt > s.x0) pieces.push({ y: s.y, x0: s.x0, x1: from.x - minDistancePt })
    if (from.x + minDistancePt < s.x1) pieces.push({ y: s.y, x0: from.x + minDistancePt, x1: s.x1 })
  }
  const total = pieces.reduce((sum, p) => sum + (p.x1 - p.x0), 0)
  if (pieces.length === 0) return null
  let u = Math.min(Math.max(random(), 0), 1) * total
  for (const p of pieces) {
    const len = p.x1 - p.x0
    if (u <= len) return { x: p.x0 + u, y: p.y }
    u -= len
  }
  const last = pieces[pieces.length - 1] as { y: number; x0: number; x1: number }
  return { x: last.x1, y: last.y }
}

function wallTarget(world: World, from: Point): Point | null {
  const tops = world.walls
    .map((w) => ({ x: w.x, y: w.y0 }))
    .filter((p) => distance(p, from) > world.params.occlusionTolerance)
    .sort((a, b) => distance(a, from) - distance(b, from))
  if (tops.length === 0) return null
  const start = placeOf(world, from, world.params.occlusionTolerance)
  if (start) {
    for (const top of tops) {
      if (findRoute(world, start, top, world.params)?.reached) return top
    }
  }
  return tops[0] as Point
}

/**
 * Decides when and where the pet wanders: once it has been idle for a pause (random in pauseS), it returns a target:
 * up a wall with climbChance, else a window top with windowBias, else anywhere (falling back to anywhere when there is
 * no such place). Then it waits for the next idle pause.
 */
export class Wanderer {
  private idleSince: number | null = null
  private pauseS = 0

  constructor(
    private readonly params: WanderParams,
    private readonly random: () => number,
  ) {}

  /** nowS: any monotonic clock, s. idle: the pet stands (or holds on to a wall) still with no goal. */
  tick(nowS: number, idle: boolean, world: World, at: Point): Point | null {
    if (!idle) {
      this.idleSince = null
      return null
    }
    if (this.idleSince === null) {
      this.idleSince = nowS
      const [lo, hi] = this.params.pauseS
      this.pauseS = lo + this.random() * (hi - lo)
      return null
    }
    if (nowS - this.idleSince < this.pauseS) return null
    this.idleSince = null
    const p = this.params
    const kind: WanderKind =
      this.random() < p.climbChance ? 'wall' : this.random() < p.windowBias ? 'window' : 'any'
    const target = pickTarget(kind, world, at, this.random, p.minDistancePt)
    return target ?? (kind === 'any' ? null : pickTarget('any', world, at, this.random, p.minDistancePt))
  }
}
