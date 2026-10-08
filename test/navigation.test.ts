import { describe, expect, it } from 'vitest'
import { findRoute, placeOf, pointOf, surfaceBelow, type Move, type PetPlace } from '../src/main/sim/world/navigation'
import { PARAMS, W1, W2, W3, win, world } from './worldFixtures'

// Navigation over the world (BITBOT_SPEC.md §8.4, §14.2 worldModel: A* reachability, nearest reachable point).

const W = world([W1, W2, W3])
const onGround = (x: number): PetPlace => ({ on: 'segment', id: 'ground', x })
const kinds = (moves: Move[]): string[] => moves.map((m) => m.kind)

describe('placeOf', () => {
  it('finds the segment a contact point is on (within groundSnapPt by default)', () => {
    expect(placeOf(W, { x: 1000, y: 1022 })).toEqual(onGround(1000))
    expect(placeOf(W, { x: 600, y: 700 })).toEqual({ on: 'segment', id: 'top:1:0', x: 600 })
    expect(placeOf(W, { x: 600, y: 700.5 })).toEqual({ on: 'segment', id: 'top:1:0', x: 600 })
    expect(placeOf(W, { x: 600, y: 701 })).toBeNull()
    expect(placeOf(W, { x: 600, y: 400 })).toBeNull()
  })

  it('clamps onto the surface within the tolerance', () => {
    expect(placeOf(W, { x: 790, y: 700 })).toBeNull()
    expect(placeOf(W, { x: 790, y: 700 }, 20)).toEqual({ on: 'segment', id: 'top:1:0', x: 780 })
  })

  it('finds walls: the screen walls and window sides, at their x', () => {
    expect(placeOf(W, { x: 400, y: 800 })).toEqual({ on: 'wall', id: 'side:1:left:0', y: 800 })
    expect(placeOf(W, { x: 0, y: 500 })).toEqual({ on: 'wall', id: 'wall:left', y: 500 })
    expect(placeOf(W, { x: 1710, y: 50 }, 40)).toEqual({ on: 'wall', id: 'wall:right', y: 87 })
  })

  it('the nearest surface wins, a segment on a tie', () => {
    // (400, 700): the corner of W1, 20 pt from top:1:0's end, 50 above side:1:left:0's top.
    expect(placeOf(W, { x: 400, y: 700 }, 60)).toEqual({ on: 'segment', id: 'top:1:0', x: 420 })
    expect(placeOf(W, { x: 400, y: 740 }, 60)).toEqual({ on: 'wall', id: 'side:1:left:0', y: 750 })
  })
})

describe('pointOf and surfaceBelow', () => {
  it('pointOf: the contact point of a place', () => {
    expect(pointOf(W, { on: 'segment', id: 'top:2:0', x: 1000 })).toEqual({ x: 1000, y: 600 })
    expect(pointOf(W, { on: 'wall', id: 'side:1:right:0', y: 800 })).toEqual({ x: 800, y: 800 })
  })

  it('surfaceBelow: the first segment at or below y whose x-range holds x', () => {
    expect(surfaceBelow(W, 600, 0)?.id).toBe('top:1:0')
    expect(surfaceBelow(W, 600, 700)?.id).toBe('top:1:0')
    expect(surfaceBelow(W, 600, 701)?.id).toBe('ground')
    expect(surfaceBelow(W, 790, 0)?.id).toBe('ground') // past top:1:0's inset end
    expect(surfaceBelow(W, 10, 0)).toBeNull() // outside the pet's area
  })
})

describe('findRoute', () => {
  it('walks along the segment it stands on', () => {
    const r = findRoute(W, onGround(1000), { x: 200, y: 1022 }, PARAMS)
    expect(r).toEqual({
      moves: [{ kind: 'walk', segment: 'ground', toX: 200 }],
      end: onGround(200),
      reached: true,
      cost: 800 / PARAMS.walkSpeed,
      points: [
        { x: 1000, y: 1022 },
        { x: 200, y: 1022 },
      ],
    })
  })

  it('already there: no moves, reached', () => {
    expect(findRoute(W, onGround(1000), { x: 1000, y: 1022 }, PARAMS)).toMatchObject({ moves: [], reached: true, cost: 0 })
  })

  it('climbs a window side onto its top: walk, mount, climb, mount over the corner, walk', () => {
    const r = findRoute(W, onGround(1000), { x: 600, y: 700 }, PARAMS)
    expect(r?.moves).toEqual([
      { kind: 'walk', segment: 'ground', toX: 850 },
      { kind: 'mount', to: { on: 'wall', id: 'side:1:right:0', y: 972 } },
      { kind: 'climb', wall: 'side:1:right:0', toY: 750 },
      { kind: 'mount', to: { on: 'segment', id: 'top:1:0', x: 780 } },
      { kind: 'walk', segment: 'top:1:0', toX: 600 },
    ])
    expect(r?.reached).toBe(true)
    expect(r?.end).toEqual({ on: 'segment', id: 'top:1:0', x: 600 })
    expect(r?.points).toEqual([
      { x: 1000, y: 1022 },
      { x: 850, y: 1022 },
      { x: 800, y: 972 },
      { x: 800, y: 750 },
      { x: 780, y: 700 },
      { x: 600, y: 700 },
    ])
  })

  it('climbs back down from a wall', () => {
    const r = findRoute(W, { on: 'wall', id: 'side:1:left:0', y: 950 }, { x: 100, y: 1022 }, PARAMS)
    expect(r?.moves).toEqual([
      { kind: 'climb', wall: 'side:1:left:0', toY: 972 },
      { kind: 'mount', to: onGround(350) },
      { kind: 'walk', segment: 'ground', toX: 100 },
    ])
  })

  it('drops off a top rather than climbing down (drop < climb); dear drops and jumps make it climb', () => {
    const from: PetPlace = { on: 'segment', id: 'top:1:0', x: 600 }
    const r = findRoute(W, from, { x: 1000, y: 1022 }, PARAMS)
    expect(r?.moves).toEqual([
      { kind: 'walk', segment: 'top:1:0', toX: 780 },
      { kind: 'drop', edgeX: 850, segment: 'ground' },
      { kind: 'walk', segment: 'ground', toX: 1000 },
    ])
    expect(r?.points).toEqual([
      { x: 600, y: 700 },
      { x: 780, y: 700 },
      { x: 850, y: 700 },
      { x: 850, y: 1022 },
      { x: 1000, y: 1022 },
    ])
    const dear = { ...PARAMS, navPenaltyS: { ...PARAMS.navPenaltyS, drop: 100, jump: 100 } }
    expect(kinds(findRoute(W, from, { x: 1000, y: 1022 }, dear)?.moves ?? [])).toEqual([
      'walk',
      'mount',
      'climb',
      'mount',
      'walk',
    ])
  })

  it('jumps between window tops', () => {
    const r = findRoute(W, { on: 'segment', id: 'top:1:0', x: 600 }, { x: 1000, y: 600 }, PARAMS)
    expect(r?.moves).toEqual([
      { kind: 'walk', segment: 'top:1:0', toX: 780 },
      { kind: 'jump', segment: 'top:2:0', toX: 920 },
      { kind: 'walk', segment: 'top:2:0', toX: 1000 },
    ])
  })

  it('jumps up onto a low top from beside it rather than climbing (cheaper)', () => {
    const r = findRoute(W, onGround(1100), { x: 1450, y: 880 }, PARAMS)
    expect(r?.moves).toEqual([
      { kind: 'walk', segment: 'ground', toX: 1250 },
      { kind: 'jump', segment: 'top:3:0', toX: 1320 },
      { kind: 'walk', segment: 'top:3:0', toX: 1450 },
    ])
  })

  it('a target in the air: the reachable place nearest to it, not reached', () => {
    const r = findRoute(W, onGround(1000), { x: 1000, y: 300 }, PARAMS)
    expect(r?.end).toEqual({ on: 'segment', id: 'top:2:0', x: 1000 })
    expect(r?.reached).toBe(false)
    // Up W1's side, then from the corner straight on to W2 (no walk on W1's top).
    expect(kinds(r?.moves ?? [])).toEqual(['walk', 'mount', 'climb', 'mount', 'jump', 'walk'])
  })

  it('an unreachable top: the nearest reachable place instead (here up the screen wall)', () => {
    // Window 9 floats high: its top is out of jump reach, its sides end too far above anything.
    const w = world([win(9, 200, 200, 300, 150), W1])
    expect(w.segment('top:9:0')).toBeDefined()
    const r = findRoute(w, onGround(1000), { x: 350, y: 200 }, PARAMS)
    expect(r?.reached).toBe(false)
    expect(r?.end).toEqual({ on: 'wall', id: 'wall:left', y: 200 })
    expect(r?.moves.at(-1)).toEqual({ kind: 'climb', wall: 'wall:left', toY: 200 })
  })

  it('climbs the screen wall up to the ceiling and no further', () => {
    const r = findRoute(W, onGround(100), { x: 0, y: 0 }, PARAMS)
    expect(r?.end).toEqual({ on: 'wall', id: 'wall:left', y: 87 })
    expect(r?.reached).toBe(false)
  })

  it('costs: travel time plus a penalty per move', () => {
    const walk = findRoute(W, onGround(1000), { x: 880, y: 1022 }, PARAMS)
    expect(walk?.cost).toBeCloseTo(1)
    const climb = findRoute(W, onGround(850), { x: 800, y: 900 }, PARAMS)
    expect(climb?.moves).toEqual([
      { kind: 'mount', to: { on: 'wall', id: 'side:1:right:0', y: 972 } },
      { kind: 'climb', wall: 'side:1:right:0', toY: 900 },
    ])
    // The hop (850, 1022) → (800, 972), peaking 40 above its end: √(2·90/g) + √(2·40/g).
    const hop = Math.sqrt(180 / PARAMS.gravity) + Math.sqrt(80 / PARAMS.gravity)
    expect(climb?.cost).toBeCloseTo(hop + PARAMS.navPenaltyS.mount + PARAMS.navPenaltyS.climb + 72 / PARAMS.climbSpeed)
  })

  it('null from a place that is not in the world; a place off its surface is clamped onto it', () => {
    expect(findRoute(W, { on: 'segment', id: 'top:99:0', x: 0 }, { x: 0, y: 0 }, PARAMS)).toBeNull()
    expect(findRoute(W, { on: 'wall', id: 'nope', y: 0 }, { x: 0, y: 0 }, PARAMS)).toBeNull()
    expect(findRoute(W, onGround(0), { x: 60, y: 1022 }, PARAMS)?.points[0]).toEqual({ x: 50, y: 1022 })
  })

  it('every walk is along a segment and every climb along a wall of the world', () => {
    for (const target of [
      { x: 600, y: 700 },
      { x: 1000, y: 600 },
      { x: 1500, y: 880 },
      { x: 1710, y: 100 },
      { x: 900, y: 700 },
    ]) {
      for (const m of findRoute(W, onGround(200), target, PARAMS)?.moves ?? []) {
        if (m.kind === 'walk') expect(W.segment(m.segment)).toBeDefined()
        if (m.kind === 'climb') expect(W.wall(m.wall)).toBeDefined()
      }
    }
  })
})
