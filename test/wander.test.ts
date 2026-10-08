import { describe, expect, it } from 'vitest'
import { pickTarget, Wanderer, type WanderParams } from '../src/main/sim/brain/wander'
import { tuning } from '../src/shared/tuning'
import { W1, W2, W3, win, world } from './worldFixtures'

// Wandering, M3's stand-in for Roam (BITBOT_SPEC.md §10.2): where and when the pet goes by itself.

/** A seeded random in [0, 1) (mulberry32). */
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
/** Returns the given values in turn (then the last one). */
function draws(...values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] as number
}

const GROUND = world()
const WORLD = world([W1, W2, W3])

describe('pickTarget', () => {
  it("'any': uniform along every segment, leaving out minDistancePt either side of where it stands", () => {
    const from = { x: 850, y: 1022 }
    // The ground 50..1660 minus 700..1000: 650 + 660 pt.
    expect(pickTarget('any', GROUND, from, draws(0), 150)).toEqual({ x: 50, y: 1022 })
    expect(pickTarget('any', GROUND, from, draws(650 / 1310), 150)).toEqual({ x: 700, y: 1022 })
    expect(pickTarget('any', GROUND, from, draws(655 / 1310), 150)?.x).toBeCloseTo(1005)
    expect(pickTarget('any', GROUND, from, draws(1), 150)).toEqual({ x: 1660, y: 1022 })
  })

  it("'any' reaches window tops too", () => {
    const seen = new Set<number>()
    const random = seeded(7)
    for (let i = 0; i < 200; i++) seen.add(pickTarget('any', WORLD, { x: 850, y: 1022 }, random, 150)?.y ?? -1)
    expect([...seen].sort()).toEqual([1022, 600, 700, 880])
  })

  it("'window': only window tops; null without any (or with only the one it stands on, all within minDistancePt)", () => {
    expect(pickTarget('window', WORLD, { x: 850, y: 1022 }, draws(0), 150)).toEqual({ x: 420, y: 700 })
    const random = seeded(3)
    for (let i = 0; i < 50; i++) expect(pickTarget('window', WORLD, { x: 850, y: 1022 }, random, 150)?.y).not.toBe(1022)
    expect(pickTarget('window', GROUND, { x: 850, y: 1022 }, draws(0.5), 150)).toBeNull()
    expect(pickTarget('window', world([W1]), { x: 600, y: 700 }, draws(0.5), 400)).toBeNull()
  })

  it("'wall': the top of the nearest wall or side it can reach, never the one it is at", () => {
    expect(pickTarget('wall', WORLD, { x: 1000, y: 1022 }, draws(0.5))).toEqual({ x: 1300, y: 930 })
    expect(pickTarget('wall', WORLD, { x: 1300, y: 930 }, draws(0.5))).toEqual({ x: 1200, y: 650 })
  })

  it("'wall': skips a nearer side it cannot reach", () => {
    const high = world([win(9, 200, 200, 300, 150)])
    expect(pickTarget('wall', high, { x: 350, y: 1022 }, draws(0.5))).toEqual({ x: 0, y: 87 })
  })
})

describe('Wanderer', () => {
  const P: WanderParams = tuning.brain.wander
  const AT = { x: 850, y: 1022 }

  it('after a pause in pauseS of being idle, returns a target; nothing before', () => {
    // Draws: the pause (0.5 → 4 s), the kind (0.9: not a wall; 0.9: not a window → anywhere), the place.
    const w = new Wanderer(P, draws(0.5, 0.9, 0.9, 0))
    expect(w.tick(10, true, GROUND, AT)).toBeNull() // the pause starts
    expect(w.tick(13.9, true, GROUND, AT)).toBeNull()
    expect(w.tick(14, true, GROUND, AT)).toEqual({ x: 50, y: 1022 })
    expect(w.tick(14.1, true, GROUND, AT)).toBeNull() // the next pause starts
  })

  it('not being idle restarts the pause', () => {
    const w = new Wanderer(P, draws(0)) // pauses of 2 s
    w.tick(0, true, GROUND, AT)
    expect(w.tick(1.5, false, GROUND, AT)).toBeNull()
    expect(w.tick(2, true, GROUND, AT)).toBeNull()
    expect(w.tick(3.9, true, GROUND, AT)).toBeNull()
    expect(w.tick(4, true, GROUND, AT)).not.toBeNull()
  })

  it('climbs with climbChance, else heads for a window top with windowBias, else anywhere', () => {
    const wall = new Wanderer(P, draws(0, P.climbChance - 0.01, 0))
    wall.tick(0, true, WORLD, { x: 1000, y: 1022 })
    expect(wall.tick(2, true, WORLD, { x: 1000, y: 1022 })).toEqual({ x: 1300, y: 930 })
    const top = new Wanderer(P, draws(0, P.climbChance, P.windowBias - 0.01, 0))
    top.tick(0, true, WORLD, AT)
    expect(top.tick(2, true, WORLD, AT)).toEqual({ x: 420, y: 700 })
    const any = new Wanderer(P, draws(0, P.climbChance, P.windowBias, 0))
    any.tick(0, true, WORLD, AT)
    expect(any.tick(2, true, WORLD, AT)).toEqual({ x: 50, y: 1022 })
  })

  it('no window to go to: anywhere instead', () => {
    const w = new Wanderer(P, draws(0, 0.9, 0, 0))
    w.tick(0, true, GROUND, AT)
    expect(w.tick(2, true, GROUND, AT)).toEqual({ x: 50, y: 1022 })
  })

  it('is deterministic for a seed', () => {
    const run = (seed: number): (string | null)[] => {
      const w = new Wanderer(P, seeded(seed))
      const out: (string | null)[] = []
      for (let t = 0; t < 60; t += 0.5) {
        const p = w.tick(t, true, WORLD, AT)
        if (p) out.push(`${p.x.toFixed(2)},${p.y}`)
      }
      return out
    }
    expect(run(42)).toEqual(run(42))
    expect(run(42).length).toBeGreaterThan(5)
    expect(run(42)).not.toEqual(run(43))
  })
})
