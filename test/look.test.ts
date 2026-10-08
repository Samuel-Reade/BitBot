import { describe, expect, it } from 'vitest'
import { eyePoint, lookDirection, type LookParams } from '../src/main/sim/look'
import type { Box, Point } from '../src/shared/geometry'
import { tuning } from '../src/shared/tuning'
import type { LookDirection } from '../src/shared/types'

// Where the eyes look (BITBOT_SPEC.md §6.3; the rule documented on tuning.anim.look).

/** The production params: tuning.anim.look must satisfy LookParams as is. */
const LOOK: LookParams = tuning.anim.look
/** Round numbers: eyes 50 pt above the ground point (0.5 × a 100 pt box above it). */
const P: LookParams = { radiusPt: 300, eyeHeight: 0.5, upPt: 40, sidePt: 24, hysteresisPt: 8 }
/** The same without hysteresis: the boundaries themselves. */
const EXACT: LookParams = { ...P, hysteresisPt: 0 }
const BOX: Box = { left: -50, top: -100, right: 60, bottom: 2 }
const GROUND: Point = { x: 500, y: 1000 }
const EYES: Point = { x: 500, y: 950 }

/** The direction for a cursor at (dx, dy) from the eyes (dy > 0: above them); no hysteresis unless `params` has it. */
const at = (dx: number, dy: number, previous: LookDirection | null = null, params: LookParams = EXACT): LookDirection | null =>
  lookDirection({ x: EYES.x + dx, y: EYES.y - dy }, GROUND, BOX, previous, params)

describe('eyePoint', () => {
  it('is eyeHeight of the box above the ground point, straight above it', () => {
    expect(eyePoint(GROUND, BOX, 0.5)).toEqual(EYES)
    expect(eyePoint(GROUND, BOX, 0)).toEqual(GROUND)
    expect(eyePoint({ x: -20, y: 10 }, BOX, 0.25)).toEqual({ x: -20, y: -15 })
  })

  it('a box that is all below the ground point puts the eyes on it', () => {
    expect(eyePoint(GROUND, { left: -5, top: 3, right: 5, bottom: 9 }, 0.5)).toEqual(GROUND)
  })
})

describe('lookDirection', () => {
  it('tuning.anim.look is a valid parameter set, with the §6.3 radius', () => {
    expect(LOOK.radiusPt).toBe(300)
    expect(LOOK.eyeHeight).toBeGreaterThan(0)
    expect(LOOK.eyeHeight).toBeLessThanOrEqual(1)
    expect(LOOK.hysteresisPt).toBeLessThan(LOOK.sidePt)
    expect(lookDirection({ x: GROUND.x - 200, y: GROUND.y - 50 }, GROUND, BOX, null, LOOK)).toBe('left')
  })

  it('straight ahead (null) on the face and below it', () => {
    expect(at(0, 0)).toBeNull()
    expect(at(20, 30)).toBeNull()
    expect(at(-20, -200)).toBeNull()
    expect(at(0, -290)).toBeNull()
  })

  it('left and right beyond sidePt, from the viewer side', () => {
    expect(at(-25, 0)).toBe('left')
    expect(at(25, 0)).toBe('right')
    expect(at(-24, 0)).toBeNull()
    expect(at(24, 0)).toBeNull()
    expect(at(-100, -150)).toBe('left') // below and to the side
    expect(at(200, 20)).toBe('right')
  })

  it('up beyond upPt when more above than beside', () => {
    expect(at(0, 41)).toBe('up')
    expect(at(0, 40)).toBeNull()
    expect(at(60, 61)).toBe('up')
    expect(at(-61, 60)).toBe('left')
    expect(at(0, 299)).toBe('up')
  })

  it('beyond radiusPt it does not look at all', () => {
    expect(at(-301, 0)).toBeNull()
    expect(at(0, 301)).toBeNull()
    expect(at(-212, 213)).toBeNull() // just past 300 pt diagonally
    expect(at(-299, 0)).toBe('left')
  })

  describe('hysteresis', () => {
    it('keeps a side until the cursor is past the boundary by hysteresisPt the other way', () => {
      expect(at(-20, 0, 'left', P)).toBe('left')
      expect(at(-17, 0, 'left', P)).toBe('left')
      expect(at(-16, 0, 'left', P)).toBeNull()
      // Starting to look needs the boundary plus hysteresisPt.
      expect(at(-32, 0, null, P)).toBeNull()
      expect(at(-33, 0, null, P)).toBe('left')
    })

    it('switches between up and a side only by hysteresisPt across their diagonal', () => {
      expect(at(-100, 105, 'left', P)).toBe('left')
      expect(at(-100, 109, 'left', P)).toBe('up')
      expect(at(-100, 95, 'up', P)).toBe('up')
      expect(at(-100, 91, 'up', P)).toBe('left')
      expect(at(0, 33, 'up', P)).toBe('up')
      expect(at(0, 32, 'up', P)).toBeNull()
    })

    it('holds the radius edge both ways', () => {
      expect(at(-305, 0, 'left', P)).toBe('left')
      expect(at(-309, 0, 'left', P)).toBeNull()
      expect(at(-295, 0, null, P)).toBeNull()
      expect(at(-291, 0, null, P)).toBe('left')
    })

    it('a cursor resting on a boundary never flickers', () => {
      let previous: LookDirection | null = null
      const seen = new Set<LookDirection | null>()
      for (let i = 0; i < 100; i++) {
        previous = at(-24 + (i % 2 === 0 ? 3 : -3), 0, previous, P)
        if (i > 0) seen.add(previous)
      }
      expect(seen.size).toBe(1)
    })

    it('with hysteresisPt 0 the previous answer changes nothing', () => {
      for (const previous of [null, 'left', 'right', 'up'] as const) {
        expect(at(-25, 0, previous)).toBe('left')
        expect(at(-24, 0, previous)).toBeNull()
        expect(at(0, 41, previous)).toBe('up')
      }
    })
  })

  it('anything that is not finite gives null', () => {
    expect(lookDirection({ x: Number.NaN, y: 0 }, GROUND, BOX, 'left', P)).toBeNull()
    expect(lookDirection({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }, BOX, null, P)).toBeNull()
  })
})
