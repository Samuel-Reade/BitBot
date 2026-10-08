// Navigation (BITBOT_SPEC.md §8.4): routes over the world's surfaces and transitions (worldModel.ts). Pure.
//
// The graph's nodes are places on surfaces: where the pet starts, both ends of every transition, and on each surface
// the point nearest the target. Along a segment the pet walks between neighbouring nodes, along a wall it climbs;
// transitions are drops, jumps and mounts. Costs are travel time (walkSpeed, climbSpeed, time in the air under
// gravity) plus navPenaltyS per move: walk (none) < drop < mount < climb < jump, the climb penalty paid on mounting a
// wall. An unreachable target routes to the reachable place nearest to it (reached false).
//
// SPEC-DEVIATION (§8.4 "A*"): the search is Dijkstra, A* with a zero heuristic: finding the reachable place nearest
// to an unreachable target needs the cost of every reachable place anyway, and the graphs are small (a few hundred
// nodes).

import { distance, type Point } from '../../../shared/geometry'
import { tuning } from '../../../shared/tuning'
import type { Segment } from '../../../shared/world'
import { arcBetween } from '../locomotion/physics'
import { placePoint, segmentBelow, type PetPlace, type Transition, type World, type WorldParams } from './worldModel'

export type { PetPlace } from './worldModel'

export type Move =
  | { kind: 'walk'; segment: string; toX: number }
  | { kind: 'climb'; wall: string; toY: number }
  /** Between a segment and a wall (a short hop: at its foot, beside it, or over a window's top corner). */
  | { kind: 'mount'; to: PetPlace }
  /** A ballistic arc from where it is onto that segment. */
  | { kind: 'jump'; segment: string; toX: number }
  /** Walk off at edgeX (just past the end), fall onto segment. */
  | { kind: 'drop'; edgeX: number; segment: string }

export interface Route {
  moves: Move[]
  end: PetPlace
  /** The end is the target (within occlusionTolerance); false: the reachable place nearest to it. */
  reached: boolean
  /** Seconds, with the penalties. */
  cost: number
  /** The route as a polyline, for the debug view (starts where the pet is). */
  points: Point[]
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Which surface a contact point is on: a segment within tolerancePt of its line and x-range, or a wall within
 * tolerancePt of its x and y-range; the nearest, a segment on a tie. The place's coordinate is clamped onto the surface.
 */
export function placeOf(world: World, p: Point, tolerancePt: number = tuning.move.groundSnapPt): PetPlace | null {
  let best: PetPlace | null = null
  let bestD = Infinity
  for (const s of world.segments) {
    const out = Math.max(0, s.x0 - p.x, p.x - s.x1)
    const d = Math.abs(p.y - s.y)
    if (d > tolerancePt || out > tolerancePt) continue
    if (d + out < bestD) {
      bestD = d + out
      best = { on: 'segment', id: s.id, x: clamp(p.x, s.x0, s.x1) }
    }
  }
  for (const w of world.walls) {
    const out = Math.max(0, w.y0 - p.y, p.y - w.y1)
    const d = Math.abs(p.x - w.x)
    if (d > tolerancePt || out > tolerancePt) continue
    if (d + out < bestD) {
      bestD = d + out
      best = { on: 'wall', id: w.id, y: clamp(p.y, w.y0, w.y1) }
    }
  }
  return best
}

/** The contact point for a place. */
export function pointOf(world: World, place: PetPlace): Point {
  return placePoint(world, place)
}

/** The first segment at or below y whose x-range contains x (the highest such); null if none. */
export function surfaceBelow(world: World, x: number, y: number): Segment | null {
  return segmentBelow(world.segments, x, y)
}

/** Seconds in the air for a transition. */
function airTimeS(from: Point, to: Point, apexPt: number, gravity: number): number {
  return arcBetween(from, to, apexPt, gravity).durationS
}

interface Edge {
  to: number
  cost: number
  /** null: along the surface (walk or climb). */
  transition: Transition | null
}

interface Node {
  place: PetPlace
  point: Point
  edges: Edge[]
}

/** A binary min-heap of [cost, node]. */
class Heap {
  private readonly items: [number, number][] = []
  get size(): number {
    return this.items.length
  }
  push(item: [number, number]): void {
    const a = this.items
    a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if ((a[parent] as [number, number])[0] <= item[0]) break
      a[i] = a[parent] as [number, number]
      i = parent
    }
    a[i] = item
  }
  pop(): [number, number] | undefined {
    const a = this.items
    const top = a[0]
    const last = a.pop()
    if (top === undefined || last === undefined || a.length === 0) return top
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      if (l >= a.length) break
      const r = l + 1
      const c = r < a.length && (a[r] as [number, number])[0] < (a[l] as [number, number])[0] ? r : l
      if ((a[c] as [number, number])[0] >= last[0]) break
      a[i] = a[c] as [number, number]
      i = c
    }
    a[i] = last
    return top
  }
}

/** `place` with its coordinate clamped onto its surface; null if the surface is not in the world. */
function clampedPlace(world: World, place: PetPlace): PetPlace | null {
  if (place.on === 'segment') {
    const s = world.segment(place.id)
    return s ? { on: 'segment', id: s.id, x: clamp(place.x, s.x0, s.x1) } : null
  }
  const w = world.wall(place.id)
  return w ? { on: 'wall', id: w.id, y: clamp(place.y, w.y0, w.y1) } : null
}

/**
 * The cheapest route from `from` to `target`, or to the reachable place nearest to it (reached false; nearer wins,
 * then cheaper). Null if `from` is not on a surface of this world.
 */
export function findRoute(world: World, from: PetPlace, target: Point, params: WorldParams): Route | null {
  const start = clampedPlace(world, from)
  if (!start) return null
  const pen = params.navPenaltyS

  // Nodes, by surface and coordinate.
  const nodes: Node[] = []
  const index = new Map<string, number>()
  const nodeFor = (place: PetPlace): number => {
    const key = `${place.on}|${place.id}|${place.on === 'segment' ? place.x : place.y}`
    const found = index.get(key)
    if (found !== undefined) return found
    nodes.push({ place, point: pointOf(world, place), edges: [] })
    index.set(key, nodes.length - 1)
    return nodes.length - 1
  }
  const startNode = nodeFor(start)
  for (const s of world.segments) nodeFor({ on: 'segment', id: s.id, x: clamp(target.x, s.x0, s.x1) })
  for (const w of world.walls) nodeFor({ on: 'wall', id: w.id, y: clamp(target.y, w.y0, w.y1) })
  for (const t of world.transitions) {
    const a = nodeFor(t.from)
    const b = nodeFor(t.to)
    const pa = (nodes[a] as Node).point
    const pb = (nodes[b] as Node).point
    let cost: number
    if (t.kind === 'drop') {
      const edgeX = t.edgeX ?? pa.x
      cost = Math.abs(edgeX - pa.x) / params.walkSpeed + airTimeS({ x: edgeX, y: pa.y }, pb, 0, params.gravity) + pen.drop
    } else if (t.kind === 'jump') {
      cost = airTimeS(pa, pb, params.jumpApexPt, params.gravity) + pen.jump
    } else {
      cost = airTimeS(pa, pb, params.jumpApexPt, params.gravity) + pen.mount + (t.to.on === 'wall' ? pen.climb : 0)
    }
    ;(nodes[a] as Node).edges.push({ to: b, cost, transition: t })
  }

  // Along each surface, between neighbouring nodes.
  const bySurface = new Map<string, number[]>()
  nodes.forEach((n, i) => {
    const key = `${n.place.on}|${n.place.id}`
    const list = bySurface.get(key)
    if (list) list.push(i)
    else bySurface.set(key, [i])
  })
  for (const list of bySurface.values()) {
    const coord = (i: number): number => {
      const pl = (nodes[i] as Node).place
      return pl.on === 'segment' ? pl.x : pl.y
    }
    list.sort((a, b) => coord(a) - coord(b))
    const first = (nodes[list[0] as number] as Node).place
    const speed = first.on === 'segment' ? params.walkSpeed : params.climbSpeed
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1] as number
      const b = list[k] as number
      const cost = Math.abs(coord(b) - coord(a)) / speed
      ;(nodes[a] as Node).edges.push({ to: b, cost, transition: null })
      ;(nodes[b] as Node).edges.push({ to: a, cost, transition: null })
    }
  }

  // Dijkstra.
  const cost = new Array<number>(nodes.length).fill(Infinity)
  const prev = new Array<{ node: number; edge: Edge } | null>(nodes.length).fill(null)
  cost[startNode] = 0
  const heap = new Heap()
  heap.push([0, startNode])
  while (heap.size > 0) {
    const [c, i] = heap.pop() as [number, number]
    if (c > (cost[i] as number)) continue
    for (const e of (nodes[i] as Node).edges) {
      const nc = c + e.cost
      if (nc < (cost[e.to] as number)) {
        cost[e.to] = nc
        prev[e.to] = { node: i, edge: e }
        heap.push([nc, e.to])
      }
    }
  }

  // The reachable node nearest the target, then the cheapest.
  let end = startNode
  let endD = distance((nodes[startNode] as Node).point, target)
  nodes.forEach((n, i) => {
    const c = cost[i] as number
    if (c === Infinity) return
    const d = distance(n.point, target)
    if (d < endD - 1e-9 || (Math.abs(d - endD) <= 1e-9 && c < (cost[end] as number))) {
      end = i
      endD = d
    }
  })

  // Back to the start, then forward into moves.
  const path: Edge[] = []
  for (let i = end; prev[i]; ) {
    const step = prev[i] as { node: number; edge: Edge }
    path.unshift(step.edge)
    i = step.node
  }
  const moves: Move[] = []
  const points: Point[] = [(nodes[startNode] as Node).point]
  for (const e of path) {
    const to = nodes[e.to] as Node
    const t = e.transition
    if (t === null) {
      // Along a surface: one walk or climb to the last node on it, one line in the polyline.
      const last = moves[moves.length - 1]
      if (to.place.on === 'segment' && last?.kind === 'walk' && last.segment === to.place.id) {
        last.toX = to.place.x
        points[points.length - 1] = to.point
        continue
      }
      if (to.place.on === 'wall' && last?.kind === 'climb' && last.wall === to.place.id) {
        last.toY = to.place.y
        points[points.length - 1] = to.point
        continue
      }
      if (to.place.on === 'segment') moves.push({ kind: 'walk', segment: to.place.id, toX: to.place.x })
      else moves.push({ kind: 'climb', wall: to.place.id, toY: to.place.y })
    } else if (t.kind === 'drop') {
      const edgeX = t.edgeX ?? to.point.x
      moves.push({ kind: 'drop', edgeX, segment: t.to.id })
      points.push({ x: edgeX, y: (points[points.length - 1] as Point).y })
    } else if (t.kind === 'jump') {
      moves.push({ kind: 'jump', segment: t.to.id, toX: to.point.x })
    } else {
      moves.push({ kind: 'mount', to: t.to })
    }
    points.push(to.point)
  }
  return {
    moves,
    end: (nodes[end] as Node).place,
    reached: endD <= params.occlusionTolerance,
    cost: cost[end] as number,
    points,
  }
}
