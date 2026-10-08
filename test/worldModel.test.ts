import { describe, expect, it } from 'vitest'
import { buildWorld, worldParamsFor, type Transition } from '../src/main/sim/world/worldModel'
import { tuning } from '../src/shared/tuning'
import { isDebugWorldMsg } from '../src/shared/world'
import { BOX, DISPLAY, OWN_PID, PARAMS, W1, W2, W3, win, world } from './worldFixtures'

// The world model (BITBOT_SPEC.md §8.1–8.4, §14.2 worldModel): surfaces from the display and a window snapshot, and
// the transitions between them.

const has = (ts: readonly Transition[], t: Transition): boolean => ts.some((x) => JSON.stringify(x) === JSON.stringify(t))
const seg = (id: string, x: number) => ({ on: 'segment', id, x }) as const
const wall = (id: string, y: number) => ({ on: 'wall', id, y }) as const

describe('buildWorld: the screen (§8.1)', () => {
  const w = world()

  it('the ground is one segment across the pet area; the ceiling is the work area top', () => {
    expect(w.area).toEqual({ minX: 50, maxX: 1660, minY: 147, groundY: 1022 })
    expect(w.ceilingY).toBe(37)
    expect(w.segments).toEqual([{ id: 'ground', kind: 'ground', windowId: null, y: 1022, x0: 50, x1: 1660 }])
    expect(w.segment('ground')).toBe(w.segments[0])
  })

  it('the screen walls: the work area edges, climbable from the ground to the ceiling, petHalfWidthPt clear of both', () => {
    expect(w.walls).toEqual([
      { id: 'wall:left', kind: 'screenWall', windowId: null, x: 0, y0: 87, y1: 972, wallOn: 'left' },
      { id: 'wall:right', kind: 'screenWall', windowId: null, x: 1710, y0: 87, y1: 972, wallOn: 'right' },
    ])
    expect(w.wall('wall:right')?.x).toBe(1710)
    expect(w.wall('nope')).toBeUndefined()
  })

  it('the ground connects to both screen walls by mounts at its ends', () => {
    expect(w.transitions).toEqual([
      { kind: 'mount', from: seg('ground', 50), to: wall('wall:left', 972) },
      { kind: 'mount', from: wall('wall:left', 972), to: seg('ground', 50) },
      { kind: 'mount', from: seg('ground', 1660), to: wall('wall:right', 972) },
      { kind: 'mount', from: wall('wall:right', 972), to: seg('ground', 1660) },
    ])
  })

  it('a Dock at the left: the left wall is the Dock edge; the ground is the display bottom', () => {
    const left = world([], PARAMS, { ...DISPLAY, workArea: { x: 80, y: 37, width: 1630, height: 1070 } })
    expect(left.wall('wall:left')?.x).toBe(80)
    expect(left.segments[0]?.y).toBe(1107)
  })

  it('is read-only', () => {
    expect(Object.isFrozen(w.area)).toBe(true)
    expect(Object.isFrozen(w.segments)).toBe(true)
    expect(Object.isFrozen(w.segments[0])).toBe(true)
  })

  it('its debug lines fit debug:world', () => {
    const full = world([W1, W2, W3])
    expect(full.links).toHaveLength(full.transitions.length)
    expect(
      isDebugWorldMsg({ show: true, segments: full.segments, walls: full.walls, links: full.links, path: [], windows: [] }),
    ).toBe(true)
  })
})

describe('buildWorld: eligible windows (§8.2)', () => {
  const only = (w: ReturnType<typeof win>): number[] => [...world([w]).windows.keys()]

  it('takes an ordinary window, with its rect', () => {
    expect(only(win(7, 400, 300, 400, 300))).toEqual([7])
    expect(world([win(7, 400, 300, 400, 300)]).windows.get(7)).toEqual({ x: 400, y: 300, width: 400, height: 300 })
  })

  it('rejects other layers, off-screen, alpha at or below minAlpha, too small, its own and excluded bundles', () => {
    expect(only(win(7, 400, 300, 400, 300, { layer: 3 }))).toEqual([])
    expect(only(win(7, 400, 300, 400, 300, { onScreen: false }))).toEqual([])
    expect(only(win(7, 400, 300, 400, 300, { alpha: 0.5 }))).toEqual([])
    expect(only(win(7, 400, 300, 400, 300, { alpha: 0.51 }))).toEqual([7])
    expect(only(win(7, 400, 300, 159, 300))).toEqual([])
    expect(only(win(7, 400, 300, 160, 119))).toEqual([])
    expect(only(win(7, 400, 300, 160, 120))).toEqual([7])
    expect(only(win(7, 400, 300, 400, 300, { pid: OWN_PID }))).toEqual([])
    expect(only(win(7, 400, 300, 400, 300, { bundleId: 'com.apple.dock' }))).toEqual([])
    expect(only(win(7, 400, 300, 400, 300, { bundleId: 'COM.APPLE.SPOTLIGHT' }))).toEqual([])
    expect(only(win(7, 400, 300, 400, 300, { bundleId: null }))).toEqual([7])
  })

  it('ignores windows on other displays (§8.7), keeps one partly on the primary', () => {
    expect(only(win(7, 1800, 300, 400, 300))).toEqual([])
    expect(only(win(7, -500, 300, 400, 300))).toEqual([])
    expect(only(win(7, 1500, 300, 400, 300))).toEqual([7])
  })

  it('keeps an eligible window with no surface (for riding: it may move back)', () => {
    const covered = world([win(9, 300, 200, 700, 700), win(7, 400, 300, 400, 300)])
    expect([...covered.windows.keys()]).toEqual([9, 7])
    expect(covered.segments.some((s) => s.windowId === 7)).toBe(false)
  })
})

describe('buildWorld: window tops and sides (§8.1, §8.3)', () => {
  it('a top is a segment inset by edgeInsetPt; its sides are walls with the body outside the window', () => {
    const w = world([W1])
    expect(w.segments[1]).toEqual({ id: 'top:1:0', kind: 'windowTop', windowId: 1, y: 700, x0: 420, x1: 780 })
    expect(w.walls.slice(2)).toEqual([
      { id: 'side:1:left:0', kind: 'windowSide', windowId: 1, x: 400, y0: 750, y1: 972, wallOn: 'right' },
      { id: 'side:1:right:0', kind: 'windowSide', windowId: 1, x: 800, y0: 750, y1: 972, wallOn: 'left' },
    ])
  })

  it('a window in front splits a top into numbered pieces, left to right', () => {
    const w = world([win(5, 550, 650, 200, 200), win(4, 300, 700, 700, 300)])
    expect(w.segments.filter((s) => s.windowId === 4)).toEqual([
      { id: 'top:4:0', kind: 'windowTop', windowId: 4, y: 700, x0: 320, x1: 530 },
      { id: 'top:4:1', kind: 'windowTop', windowId: 4, y: 700, x0: 770, x1: 980 },
    ])
  })

  it('a window behind covers nothing of one in front', () => {
    const w = world([win(4, 300, 700, 700, 300), win(5, 550, 650, 200, 200)])
    expect(w.segments.filter((s) => s.windowId === 4).map((s) => s.id)).toEqual(['top:4:0'])
  })

  it('occluders: a small window or one of its own in front hides; another layer or a faint window does not', () => {
    const top = (front: ReturnType<typeof win>): string[] =>
      world([front, win(4, 300, 700, 700, 300)])
        .segments.filter((s) => s.windowId === 4)
        .map((s) => `${s.x0}..${s.x1}`)
    expect(top(win(5, 600, 690, 100, 50))).toEqual(['320..580', '720..980']) // smaller than minWindowSize
    expect(top(win(5, 600, 690, 100, 50, { pid: OWN_PID }))).toEqual(['320..580', '720..980'])
    expect(top(win(5, 0, 0, 1710, 1107, { layer: 20, bundleId: 'com.apple.dock' }))).toEqual(['320..980']) // the Dock's
    expect(top(win(5, 600, 690, 100, 50, { alpha: 0.3 }))).toEqual(['320..980'])
    expect(top(win(5, 600, 690, 100, 50, { onScreen: false }))).toEqual(['320..980'])
  })

  it('drops a top that is fully covered or too short once the in-front windows are taken out', () => {
    expect(world([win(5, 250, 600, 800, 200), win(4, 300, 700, 700, 300)]).segments.some((s) => s.windowId === 4)).toBe(false)
    // 300..390 is left: 90 pt, under minSegmentPt (100).
    expect(world([win(5, 390, 600, 700, 200), win(4, 300, 700, 700, 300)]).segments.some((s) => s.windowId === 4)).toBe(false)
  })

  it('a top too near the ceiling for the pet, at or below the ground, is not walkable (its sides may still be)', () => {
    const high = world([win(4, 300, 100, 700, 600)]) // area.minY is 147
    expect(high.segments).toHaveLength(1)
    expect(high.walls.map((w) => w.id)).toEqual(['wall:left', 'wall:right', 'side:4:left:0', 'side:4:right:0'])
    expect(high.wall('side:4:left:0')).toMatchObject({ y0: 150, y1: 650 })
    expect(world([win(4, 300, 147, 700, 600)]).segment('top:4:0')).toBeDefined()
    expect(world([win(4, 300, 1022, 700, 200)]).segments).toHaveLength(1)
  })

  it('a top running off the screen is kept in the area; a side too near the screen edge for the body is no wall', () => {
    const w = world([win(4, -200, 500, 500, 300)])
    expect(w.segment('top:4:0')).toMatchObject({ x0: 50, x1: 280 })
    expect(w.walls.some((x) => x.windowId === 4 && x.wallOn === 'right')).toBe(false) // its left side is off screen
    expect(w.wall('side:4:right:0')).toMatchObject({ x: 300, wallOn: 'left' })
    // The left side at x 100: the turned body reaches 110 pt left of it, past the screen edge.
    expect(world([win(4, 100, 500, 500, 300)]).walls.some((x) => x.id.startsWith('side:4:left'))).toBe(false)
    expect(world([win(4, 110, 500, 500, 300)]).wall('side:4:left:0')).toBeDefined()
  })

  it('a side below the ground is clipped to it; one covered in the middle splits', () => {
    expect(world([win(4, 300, 700, 700, 600)]).wall('side:4:left:0')).toMatchObject({ y0: 750, y1: 972 })
    const split = world([win(5, 200, 800, 200, 60), win(4, 300, 600, 700, 400)])
    expect(split.walls.filter((w) => w.id.startsWith('side:4:left')).map((w) => [w.y0, w.y1])).toEqual([
      [650, 750],
      [910, 950],
    ])
  })
})

describe('buildWorld: transitions (§8.4)', () => {
  const w = world([W1, W2, W3])

  it('drops: off each end once the body clears the visible end, onto the first segment below', () => {
    expect(has(w.transitions, { kind: 'drop', from: seg('top:1:0', 420), to: seg('ground', 350), edgeX: 350 })).toBe(true)
    expect(has(w.transitions, { kind: 'drop', from: seg('top:1:0', 780), to: seg('ground', 850), edgeX: 850 })).toBe(true)
    expect(w.transitions.filter((t) => t.kind === 'drop' && t.from.id === 'ground')).toEqual([])
    // Onto a lower top when it is the first one below.
    const stacked = world([win(6, 500, 500, 300, 200), win(4, 300, 800, 700, 222)])
    expect(has(stacked.transitions, { kind: 'drop', from: seg('top:6:0', 520), to: seg('top:4:0', 450), edgeX: 450 })).toBe(
      true,
    )
  })

  it('no drop off an end at the screen edge', () => {
    const edge = world([win(4, 0, 700, 400, 322)])
    expect(edge.transitions.filter((t) => t.kind === 'drop' && t.from.id === 'top:4:0' && t.from.on === 'segment' && t.from.x === 50)).toEqual([])
  })

  it('jumps between neighbouring tops within reach, both ways when both are within reach', () => {
    expect(has(w.transitions, { kind: 'jump', from: seg('top:1:0', 780), to: seg('top:2:0', 920) })).toBe(true)
    expect(has(w.transitions, { kind: 'jump', from: seg('top:2:0', 920), to: seg('top:1:0', 780) })).toBe(true)
    // W2 → W3: 280 down is a jump; back up 280 is beyond maxUp (160).
    expect(has(w.transitions, { kind: 'jump', from: seg('top:2:0', 1180), to: seg('top:3:0', 1320) })).toBe(true)
    expect(w.transitions.some((t) => t.kind === 'jump' && t.from.id === 'top:3:0' && t.to.id === 'top:2:0')).toBe(false)
    // W1 → W3: 540 apart, beyond maxHorizontal (220).
    expect(w.transitions.some((t) => t.kind === 'jump' && t.from.id === 'top:1:0' && t.to.id === 'top:3:0')).toBe(false)
  })

  it('jumps up onto a top from beside it, never up through its window; the ground is too far below W1 and W2', () => {
    const ups = w.transitions.filter((t) => t.kind === 'jump' && t.from.id === 'ground')
    expect(ups).toEqual([
      { kind: 'jump', from: seg('ground', 1250), to: seg('top:3:0', 1320) },
      { kind: 'jump', from: seg('ground', 1650), to: seg('top:3:0', 1580) },
    ])
    for (const t of ups) expect(t.from.on === 'segment' && (t.from.x < 1300 || t.from.x > 1600)).toBe(true)
  })

  it('mounts: the ground to a side that stands on it, beside the window; a side top to its window top at the corner', () => {
    expect(has(w.transitions, { kind: 'mount', from: seg('ground', 350), to: wall('side:1:left:0', 972) })).toBe(true)
    expect(has(w.transitions, { kind: 'mount', from: wall('side:1:left:0', 972), to: seg('ground', 350) })).toBe(true)
    expect(has(w.transitions, { kind: 'mount', from: wall('side:1:left:0', 750), to: seg('top:1:0', 420) })).toBe(true)
    expect(has(w.transitions, { kind: 'mount', from: seg('top:1:0', 780), to: wall('side:1:right:0', 750) })).toBe(true)
  })

  it('mounts at a foot hanging above a segment: up within maxUp, down within maxDown', () => {
    // W3's sides end 12 pt above where the ground's pet would hold on: both ways.
    expect(has(w.transitions, { kind: 'mount', from: seg('ground', 1250), to: wall('side:3:left:0', 960) })).toBe(true)
    expect(has(w.transitions, { kind: 'mount', from: wall('side:3:left:0', 960), to: seg('ground', 1250) })).toBe(true)
    // W2's sides end 222 pt above: only down.
    expect(has(w.transitions, { kind: 'mount', from: wall('side:2:left:0', 750), to: seg('ground', 850) })).toBe(true)
    expect(w.transitions.some((t) => t.kind === 'mount' && t.to.id === 'side:2:left:0' && t.from.id === 'ground')).toBe(false)
  })

  it('mounts from a top onto a window side in front that rises from it, and onto the screen wall at the screen edge', () => {
    // Window 5 in front of window 4, its left side rising from 4's top.
    const w2 = world([win(5, 700, 500, 400, 400), win(4, 300, 700, 700, 322)])
    expect(w2.segment('top:4:0')).toMatchObject({ x0: 320, x1: 680 })
    expect(has(w2.transitions, { kind: 'mount', from: seg('top:4:0', 650), to: wall('side:5:left:0', 650) })).toBe(true)
    const edge = world([win(4, 0, 700, 400, 322)])
    expect(has(edge.transitions, { kind: 'mount', from: seg('top:4:0', 50), to: wall('wall:left', 650) })).toBe(true)
  })

  it('every transition joins places that exist, inside their surfaces', () => {
    for (const t of w.transitions) {
      for (const p of [t.from, t.to]) {
        if (p.on === 'segment') {
          const s = w.segment(p.id)
          expect(s && p.x >= s.x0 && p.x <= s.x1).toBe(true)
        } else {
          const x = w.wall(p.id)
          expect(x && p.y >= x.y0 && p.y <= x.y1).toBe(true)
        }
      }
    }
  })
})

describe('buildWorld: hash', () => {
  it('equal for equal geometry, whatever the objects', () => {
    expect(world([{ ...W1 }, { ...W2 }]).hash).toBe(world([W1, W2]).hash)
  })

  it('changes when a window that matters moves, resizes, or the z order changes', () => {
    const h = world([W1, W2]).hash
    expect(world([{ ...W1, x: 401 }, W2]).hash).not.toBe(h)
    expect(world([W1, { ...W2, h: 201 }]).hash).not.toBe(h)
    expect(world([W2, W1]).hash).not.toBe(h)
  })

  it('changes with the display, the pet and the params', () => {
    const h = world([W1]).hash
    expect(world([W1], PARAMS, { ...DISPLAY, workArea: { ...DISPLAY.workArea, height: 1000 } }).hash).not.toBe(h)
    expect(world([W1], { ...PARAMS, edgeInsetPt: 21 }).hash).not.toBe(h)
    expect(buildWorld(DISPLAY, { ...BOX, top: -111 }, [W1], PARAMS).hash).not.toBe(h)
  })

  it('ignores windows that cannot matter: ineligible ones behind every eligible one, other layers, other displays', () => {
    const h = world([W1]).hash
    expect(world([W1, win(8, 10, 10, 50, 50)]).hash).toBe(h)
    expect(world([win(8, 10, 10, 1700, 1100, { layer: 20 }), W1]).hash).toBe(h)
    expect(world([win(8, 2000, 10, 500, 500), W1]).hash).toBe(h)
    expect(world([win(8, 10, 10, 50, 50), W1]).hash).not.toBe(h) // in front: it may hide something
  })
})

describe('worldParamsFor', () => {
  it('scales the pet sizes by the body height and takes the rest from tuning', () => {
    const p = worldParamsFor(100, 7)
    expect(p).toMatchObject({
      ownPid: 7,
      petHalfWidthPt: tuning.world.pet.halfWidthBodies * 100,
      minSegmentPt: tuning.world.pet.minSegmentBodies * 100,
      edgeInsetPt: tuning.world.pet.edgeInsetBodies * 100,
      jump: tuning.move.jump,
      walkSpeed: tuning.move.walkSpeed,
      navPenaltyS: tuning.world.navPenaltyS,
    })
    const w = buildWorld(DISPLAY, BOX, [W1, W2], worldParamsFor(tuning.render.bodyHeightPt.M, 7))
    expect(w.segments.length).toBe(3)
  })
})
