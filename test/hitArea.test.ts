import { describe, expect, it } from 'vitest'
import {
  cursorNearPet,
  decideHitWindow,
  grabAreaBounds,
  HIT_WINDOW_HIDDEN,
  shouldForceClickThrough,
  type HitAreaInput,
  type HitAreaTuning,
  type HitWindowPlacement,
} from '../src/main/windows/hitArea'
import { boxAt, inflateRect, rectContainsRect, type Box, type Point, type Rect } from '../src/shared/geometry'
import { tuning } from '../src/shared/tuning'

// The grab area's placement rules (src/main/windows/hitArea.ts): when it exists, where it goes, and the safety net.

const T: HitAreaTuning = { nearMarginPt: 32, farMarginPt: 56, slackPt: 48, innerMarginPt: 4 }
// The production values satisfy the same interface (compile-time check).
const production: HitAreaTuning = tuning.hitArea

// The pet's box at PET spans x 440..560, y 670..804.
const BOX: Box = { left: -60, top: -130, right: 60, bottom: 4 }
const PET: Point = { x: 500, y: 800 }
const ON_PET: Point = { x: 500, y: 740 }
/**
 * The grab area's bounds when it is placed around the pet at PET: the box grown by slackPt (x 392..608, y 622..852), one
 * point wider and taller (the size every placement of this box gets, see grabAreaBounds).
 */
const AROUND_PET: Rect = { x: 392, y: 622, width: 217, height: 231 }

function input(overrides: Partial<HitAreaInput> = {}): HitAreaInput {
  return {
    cursor: ON_PET,
    pet: PET,
    petBox: BOX,
    overlayShown: true,
    overlayOnScreen: true,
    petDrawn: true,
    engaged: false,
    current: HIT_WINDOW_HIDDEN,
    ...overrides,
  }
}

const shownAt = (bounds: Rect): HitWindowPlacement => ({ shown: true, bounds })

describe('decideHitWindow', () => {
  it('uses production tuning with hysteresis (far > near) and slack covering the inner margin', () => {
    expect(production.farMarginPt).toBeGreaterThan(production.nearMarginPt)
    expect(production.slackPt).toBeGreaterThan(production.innerMarginPt)
  })

  it('places the grab area around the pet box plus slack when the cursor is on the pet', () => {
    expect(decideHitWindow(input(), T)).toEqual(shownAt(AROUND_PET))
  })

  it('is hidden without a pet box, while the overlay is hidden, or while the pet is not drawn — even when engaged', () => {
    for (const engaged of [false, true]) {
      expect(decideHitWindow(input({ engaged, petBox: null }), T)).toEqual({ shown: false })
      expect(decideHitWindow(input({ engaged, overlayShown: false }), T)).toEqual({ shown: false })
      expect(decideHitWindow(input({ engaged, petDrawn: false }), T)).toEqual({ shown: false })
      expect(decideHitWindow(input({ engaged, petDrawn: false, current: shownAt(AROUND_PET) }), T)).toEqual({ shown: false })
    }
  })

  it('not engaged: shown only when the overlay is known to be on screen (unknown fails closed)', () => {
    expect(decideHitWindow(input({ overlayOnScreen: null }), T)).toEqual({ shown: false })
    expect(decideHitWindow(input({ overlayOnScreen: false }), T)).toEqual({ shown: false })
    expect(decideHitWindow(input({ overlayOnScreen: null, current: shownAt(AROUND_PET) }), T)).toEqual({ shown: false })
  })

  it('engaged: stays while on-screen is unknown, goes when it is known to be false', () => {
    const current = shownAt(AROUND_PET)
    expect(decideHitWindow(input({ engaged: true, overlayOnScreen: null, current }), T)).toEqual(current)
    expect(decideHitWindow(input({ engaged: true, overlayOnScreen: true, current }), T)).toEqual(current)
    expect(decideHitWindow(input({ engaged: true, overlayOnScreen: false, current }), T)).toEqual({ shown: false })
  })

  it('engaged: stays wherever the cursor is (a drag or the open menu may take it far away)', () => {
    const far = { x: 1400, y: 100 }
    expect(decideHitWindow(input({ engaged: true, cursor: far }), T)).toEqual(shownAt(AROUND_PET))
    expect(decideHitWindow(input({ engaged: false, cursor: far }), T)).toEqual({ shown: false })
  })

  it('appears within nearMarginPt of the pet box and stays until the cursor is past farMarginPt', () => {
    const at = (dx: number): Point => ({ x: 560 + dx, y: 740 }) // dx pt right of the box
    const hidden = HIT_WINDOW_HIDDEN
    const shown = shownAt(AROUND_PET)
    expect(decideHitWindow(input({ cursor: at(32), current: hidden }), T).shown).toBe(true) // edge counts
    expect(decideHitWindow(input({ cursor: at(33), current: hidden }), T).shown).toBe(false)
    expect(decideHitWindow(input({ cursor: at(40), current: hidden }), T).shown).toBe(false)
    expect(decideHitWindow(input({ cursor: at(40), current: shown }), T).shown).toBe(true)
    expect(decideHitWindow(input({ cursor: at(56), current: shown }), T).shown).toBe(true)
    expect(decideHitWindow(input({ cursor: at(57), current: shown }), T).shown).toBe(false)
    // Above and below the box too.
    expect(decideHitWindow(input({ cursor: { x: 500, y: 670 - 30 }, current: hidden }), T).shown).toBe(true)
    expect(decideHitWindow(input({ cursor: { x: 500, y: 804 + 50 }, current: hidden }), T).shown).toBe(false)
    expect(decideHitWindow(input({ cursor: { x: 500, y: 804 + 50 }, current: shown }), T).shown).toBe(true)
  })

  it('places on whole points, covering the pet box plus slack', () => {
    const pet = { x: 500.3, y: 799.6 }
    const placement = decideHitWindow(input({ pet, cursor: { x: 500.3, y: 740 } }), T)
    if (!placement.shown) throw new Error('expected the grab area to be shown')
    const { bounds } = placement
    for (const v of [bounds.x, bounds.y, bounds.width, bounds.height]) expect(Number.isInteger(v)).toBe(true)
    expect(rectContainsRect(bounds, inflateRect(boxAt(pet, BOX), T.slackPt))).toBe(true)
    // At most a point and a bit larger on each axis (the size every placement of this box gets).
    expect(bounds.width - (120 + 2 * T.slackPt)).toBeLessThan(2)
    expect(bounds.height - (134 + 2 * T.slackPt)).toBeLessThan(2)
  })

  it('keeps one size wherever the pet is, so moving it never resizes the window', () => {
    // The dev check measured the cost: rounding the grown box outward gave 268 or 269 pt by the pet's fractional
    // position, so most moves were resizes too (about 2 points of main CPU in a 600 pt/s chase).
    for (const box of [BOX, { left: -85.8, top: -160.3, right: 85.8, bottom: 11.5 }]) {
      const sizes = new Set<string>()
      for (let i = 0; i < 300; i++) {
        const pet = { x: 500 + i * 0.37, y: 800 - i * 0.29 }
        const placement = decideHitWindow(input({ pet, petBox: box, cursor: { x: pet.x, y: pet.y - 60 } }), T)
        if (!placement.shown) throw new Error('expected the grab area to be shown')
        expect(rectContainsRect(placement.bounds, inflateRect(boxAt(pet, box), T.slackPt))).toBe(true)
        sizes.add(`${placement.bounds.width}x${placement.bounds.height}`)
      }
      expect(sizes.size).toBe(1)
    }
    expect(grabAreaBounds({ x: 10.5, y: 20, width: 100.2, height: 50 }, 0)).toEqual({ x: 10, y: 20, width: 102, height: 51 })
  })

  it('keeps its bounds while the pet box stays innerMarginPt inside them, then moves around the pet', () => {
    const current = shownAt(AROUND_PET) // x 392..609, y 622..853
    const decideAt = (pet: Point): HitWindowPlacement => decideHitWindow(input({ engaged: true, pet, current }), T)
    // Right: the box (+4) reaches x 605 at +41 and 609 (the edge) at +45.
    expect(decideAt({ x: 541, y: 800 })).toBe(current)
    expect(decideAt({ x: 545, y: 800 })).toBe(current)
    expect(decideAt({ x: 545.5, y: 800 })).toEqual(shownAt({ x: 437, y: 622, width: 217, height: 231 }))
    // Up: the box (+4) reaches y 622 (the edge) at −44.
    expect(decideAt({ x: 500, y: 756 })).toBe(current)
    expect(decideAt({ x: 500, y: 755 })).toEqual(shownAt({ x: 392, y: 577, width: 217, height: 231 }))
  })

  it('production tuning: a pet moving at 600 pt/s stays inside the grab area from one simulation wake to the next', () => {
    // The dev check's chase and drag at 600 pt/s found the leading edge outside the grab area in a quarter of the wakes
    // while innerMarginPt (4) was below the 20 pt the pet covers between two wakes.
    const perWake = tuning.dev.overlayCheck.chase.speed / tuning.sim.hz
    for (const dir of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 0.6, y: 0.8 }]) {
      let current: HitWindowPlacement = HIT_WINDOW_HIDDEN
      let pet: Point = { x: 800, y: 400 }
      for (let k = 0; k < 90; k++) {
        current = decideHitWindow(input({ engaged: true, pet, current }), production)
        if (!current.shown) throw new Error('expected the grab area to be shown')
        pet = { x: pet.x + dir.x * perWake, y: pet.y + dir.y * perWake }
        expect(rectContainsRect(current.bounds, boxAt(pet, BOX))).toBe(true)
      }
    }
  })

  it('re-places around the pet when it jumped out of the current bounds', () => {
    const current = shownAt(AROUND_PET)
    const pet = { x: 1500, y: 300 }
    expect(decideHitWindow(input({ engaged: true, pet, current }), T)).toEqual(shownAt({ x: 1392, y: 122, width: 217, height: 231 }))
  })

  it('is hidden for a non-finite pet position, even when engaged or already shown', () => {
    const current = shownAt(AROUND_PET)
    expect(decideHitWindow(input({ engaged: true, pet: { x: Number.NaN, y: 800 } }), T)).toEqual({ shown: false })
    expect(decideHitWindow(input({ engaged: true, pet: { x: Number.NaN, y: 800 }, current }), T)).toEqual({ shown: false })
    expect(decideHitWindow(input({ engaged: true, pet: { x: Number.POSITIVE_INFINITY, y: 800 }, current }), T)).toEqual({ shown: false })
    // Finite inputs whose bounds overflow.
    const huge = 1.7e308
    expect(decideHitWindow(input({ engaged: true, pet: { x: huge, y: 800 }, petBox: { ...BOX, right: huge } }), T)).toEqual({ shown: false })
  })
})

describe('cursorNearPet', () => {
  it('is true inside the pet box grown by the margin (edges count), false outside', () => {
    expect(cursorNearPet(ON_PET, PET, BOX, 0)).toBe(true)
    expect(cursorNearPet({ x: 560, y: 804 }, PET, BOX, 0)).toBe(true)
    expect(cursorNearPet({ x: 560.01, y: 804 }, PET, BOX, 0)).toBe(false)
    expect(cursorNearPet({ x: 440 - 10, y: 700 }, PET, BOX, 10)).toBe(true)
    expect(cursorNearPet({ x: 440 - 10.01, y: 700 }, PET, BOX, 10)).toBe(false)
    // A corner of the grown box.
    expect(cursorNearPet({ x: 570, y: 660 }, PET, BOX, 10)).toBe(true)
    expect(cursorNearPet({ x: 570, y: 659.9 }, PET, BOX, 10)).toBe(false)
  })

  it('moves with the pet', () => {
    expect(cursorNearPet({ x: 1500, y: 740 }, { x: 1500, y: 800 }, BOX, 0)).toBe(true)
    expect(cursorNearPet(ON_PET, { x: 1500, y: 800 }, BOX, 32)).toBe(false)
  })

  it('is false for a non-finite cursor or pet', () => {
    expect(cursorNearPet({ x: Number.NaN, y: 740 }, PET, BOX, 32)).toBe(false)
    expect(cursorNearPet(ON_PET, { x: 500, y: Number.NaN }, BOX, 32)).toBe(false)
  })
})

describe('shouldForceClickThrough', () => {
  const base = { mouseEnabled: true, engaged: false, cursor: { x: 560 + 9, y: 740 }, pet: PET, petBox: BOX, marginPt: 8 }

  it('fires when the mouse is on, nothing is engaged and the cursor is outside the pet box + margin', () => {
    expect(shouldForceClickThrough(base)).toBe(true)
    expect(shouldForceClickThrough({ ...base, cursor: { x: 500, y: 600 } })).toBe(true)
  })

  it('does not fire inside the margin (edge included)', () => {
    expect(shouldForceClickThrough({ ...base, cursor: { x: 568, y: 740 } })).toBe(false)
    expect(shouldForceClickThrough({ ...base, cursor: ON_PET })).toBe(false)
  })

  it('does not fire while click-through is already on, while engaged, or without a pet box', () => {
    expect(shouldForceClickThrough({ ...base, mouseEnabled: false })).toBe(false)
    expect(shouldForceClickThrough({ ...base, engaged: true })).toBe(false)
    expect(shouldForceClickThrough({ ...base, petBox: null })).toBe(false)
  })

  it('treats a non-finite cursor as outside (fails closed)', () => {
    expect(shouldForceClickThrough({ ...base, cursor: { x: Number.NaN, y: Number.NaN } })).toBe(true)
  })
})
