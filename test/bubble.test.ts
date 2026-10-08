import { describe, expect, it } from 'vitest'
import { withBubbleBox } from '../src/main/windows/hitArea'
import { bubbleCss, bubbleTransform } from '../src/renderer/pet/bubbleStyle'
import { bubbleBoxRelative, layoutBubble, type BubbleLayoutTuning } from '../src/shared/bubbleLayout'
import type { Box, Rect } from '../src/shared/geometry'
import { IPC, isAllowedChannel } from '../src/shared/ipc'
import { BUBBLE_TEXT_MAX, isPetBubbleMsg, isPetBubbleShownMsg, isPetPointerMsg } from '../src/shared/petProtocol'
import { tuning } from '../src/shared/tuning'

// The speech bubble's shared parts (BITBOT_SPEC.md §9.4): its layout (src/shared/bubbleLayout.ts), the box union the
// grab area uses (hitArea.ts withBubbleBox), the protocol, and the overlay's pure helpers (bubble.ts).

const T: BubbleLayoutTuning = { tailPt: 8, gapPt: 2, screenMarginPt: 8, topInsetPt: 40, tailInsetPt: 20 }
const OVERLAY: Rect = { x: 0, y: 0, width: 1600, height: 1000 }
/** A pet 120 pt wide, 134 tall, standing on its ground point. */
const PET: Box = { left: -60, top: -130, right: 60, bottom: 4 }
const SIZE = { width: 220, height: 56 }

describe('layoutBubble', () => {
  it('sits centred above the pet, its tail gap + tail above the box, pointing at the middle', () => {
    const l = layoutBubble({ x: 800, y: 900 }, PET, SIZE, OVERLAY, T)
    expect(l).toEqual({ rect: { x: 690, y: 900 - 130 - 2 - 8 - 56, width: 220, height: 56 }, below: false, tailX: 110 })
  })

  it('production tuning is a BubbleLayoutTuning', () => {
    const production: BubbleLayoutTuning = tuning.ui.bubble
    expect(layoutBubble({ x: 800, y: 900 }, PET, SIZE, OVERLAY, production)).not.toBeNull()
  })

  it('flips below the pet when there is no room above (under the menu bar inset)', () => {
    const l = layoutBubble({ x: 800, y: 150 }, PET, SIZE, OVERLAY, T)
    expect(l?.below).toBe(true)
    expect(l?.rect.y).toBe(150 + 4 + 2 + 8)
    // Exactly enough room above: stays above.
    const ground = 40 + 56 + 8 + 2 + 130
    expect(layoutBubble({ x: 800, y: ground }, PET, SIZE, OVERLAY, T)?.below).toBe(false)
    expect(layoutBubble({ x: 800, y: ground - 1 }, PET, SIZE, OVERLAY, T)?.below).toBe(true)
  })

  it('stays inside the overlay at the sides, the tail still pointing at the pet within its inset', () => {
    const left = layoutBubble({ x: 20, y: 900 }, PET, SIZE, OVERLAY, T)
    expect(left?.rect.x).toBe(8)
    expect(left?.tailX).toBe(T.tailInsetPt) // the pet's middle (20) is left of 8 + 20
    const nearLeft = layoutBubble({ x: 60, y: 900 }, PET, SIZE, OVERLAY, T)
    expect(nearLeft?.rect.x).toBe(8)
    expect(nearLeft?.tailX).toBe(52)
    const right = layoutBubble({ x: 1590, y: 900 }, PET, SIZE, OVERLAY, T)
    expect(right?.rect.x).toBe(1600 - 8 - 220)
    expect(right?.tailX).toBe(220 - T.tailInsetPt)
  })

  it('works in an overlay that does not start at the origin (a display placed left of or above the primary)', () => {
    const overlay = { x: -1440, y: -900, width: 1440, height: 900 }
    const l = layoutBubble({ x: -1430, y: -300 }, PET, SIZE, overlay, T)
    expect(l?.rect.x).toBe(-1440 + 8)
    const top = layoutBubble({ x: -700, y: -820 }, PET, SIZE, overlay, T)
    expect(top?.below).toBe(true)
  })

  it('never leaves the overlay’s vertical bounds when neither above nor below fits', () => {
    const tiny = { x: 0, y: 0, width: 400, height: 200 }
    const l = layoutBubble({ x: 200, y: 150 }, PET, SIZE, tiny, T)
    expect(l?.below).toBe(false)
    expect(l?.rect.y).toBe(40)
  })

  it('a bubble wider than the overlay starts at its left margin; the tail sits in the middle of a tiny bubble', () => {
    const narrow = { x: 0, y: 0, width: 200, height: 1000 }
    expect(layoutBubble({ x: 100, y: 900 }, PET, SIZE, narrow, T)?.rect.x).toBe(8)
    expect(layoutBubble({ x: 100, y: 900 }, PET, { width: 30, height: 20 }, OVERLAY, T)?.tailX).toBe(15)
  })

  it('a turned (climbing) box centres on that box, not on the ground point', () => {
    const climbing: Box = { left: -134, top: -60, right: 4, bottom: 60 }
    const l = layoutBubble({ x: 800, y: 500 }, climbing, SIZE, OVERLAY, T)
    expect(l?.rect.x).toBe(800 - 65 - 110)
    expect(l?.rect.y).toBe(500 - 60 - 2 - 8 - 56)
  })

  it('null for non-finite inputs or an empty size', () => {
    expect(layoutBubble({ x: Number.NaN, y: 0 }, PET, SIZE, OVERLAY, T)).toBeNull()
    expect(layoutBubble({ x: 0, y: 0 }, { ...PET, top: Number.POSITIVE_INFINITY }, SIZE, OVERLAY, T)).toBeNull()
    expect(layoutBubble({ x: 0, y: 0 }, PET, { width: 0, height: 10 }, OVERLAY, T)).toBeNull()
    expect(layoutBubble({ x: 0, y: 0 }, PET, SIZE, { ...OVERLAY, width: Number.NaN }, T)).toBeNull()
  })

  it('gives the box relative to the ground point, and the grab area holds both', () => {
    const ground = { x: 800, y: 900 }
    const l = layoutBubble(ground, PET, SIZE, OVERLAY, T)
    if (!l) throw new Error('no layout')
    const rel = bubbleBoxRelative(l, ground)
    expect(rel).toEqual({ left: -110, top: -196, right: 110, bottom: -140 })
    expect(withBubbleBox(PET, rel)).toEqual({ left: -110, top: -196, right: 110, bottom: 4 })
    expect(withBubbleBox(PET, null)).toBe(PET)
    expect(withBubbleBox(PET, { left: 1, top: 1, right: 0, bottom: 0 })).toBe(PET) // malformed
    expect(withBubbleBox(PET, { left: -1, top: Number.NaN, right: 1, bottom: 1 })).toBe(PET)
  })
})

describe('bubble protocol', () => {
  it('pet:bubble shows text or hides an id', () => {
    expect(isPetBubbleMsg({ id: 1, text: 'Yesterday I ate 5 crumbs.' })).toBe(true)
    expect(isPetBubbleMsg({ id: 1, hide: true })).toBe(true)
    expect(isPetBubbleMsg({ id: 1, hide: false })).toBe(false)
    expect(isPetBubbleMsg({ id: 1, hide: true, text: 'x' })).toBe(false)
    expect(isPetBubbleMsg({ id: 1, text: '   ' })).toBe(false)
    expect(isPetBubbleMsg({ id: 1, text: 'x'.repeat(BUBBLE_TEXT_MAX + 1) })).toBe(false)
    expect(isPetBubbleMsg({ id: -1, text: 'x' })).toBe(false)
    expect(isPetBubbleMsg({ id: 1.5, text: 'x' })).toBe(false)
    expect(isPetBubbleMsg({ text: 'x' })).toBe(false)
    expect(isPetBubbleMsg(null)).toBe(false)
  })

  it('pet:bubble-shown carries a sane measured size', () => {
    expect(isPetBubbleShownMsg({ id: 3, width: 220, height: 56 })).toBe(true)
    expect(isPetBubbleShownMsg({ id: 3, width: 0, height: 56 })).toBe(false)
    expect(isPetBubbleShownMsg({ id: 3, width: 220, height: 5000 })).toBe(false)
    expect(isPetBubbleShownMsg({ id: 3, width: Number.NaN, height: 56 })).toBe(false)
    expect(isPetBubbleShownMsg({ width: 220, height: 56 })).toBe(false)
  })

  it('pet:pointer accepts a bubble or pet target on down and up, nothing else', () => {
    const down = { kind: 'down', button: 0, screenX: 1, screenY: 2, groundX: 3, groundY: 4, epoch: 1 }
    const up = { kind: 'up', button: 0, screenX: 1, screenY: 2, epoch: 1 }
    for (const msg of [down, up]) {
      expect(isPetPointerMsg(msg)).toBe(true)
      expect(isPetPointerMsg({ ...msg, target: 'bubble' })).toBe(true)
      expect(isPetPointerMsg({ ...msg, target: 'pet' })).toBe(true)
      expect(isPetPointerMsg({ ...msg, target: 'menu' })).toBe(false)
      expect(isPetPointerMsg({ ...msg, target: null })).toBe(false)
    }
  })

  it('the bubble channels pass the preload allowlist', () => {
    expect(isAllowedChannel(IPC.petBubble)).toBe(true)
    expect(isAllowedChannel(IPC.petBubbleShown)).toBe(true)
  })
})

describe('the overlay’s bubble helpers', () => {
  it('snaps the bubble to device pixels in overlay-local px', () => {
    const layout = { rect: { x: 100.3, y: 50.74, width: 10, height: 10 }, below: false, tailX: 5 }
    expect(bubbleTransform(layout, { x: 0, y: 0, width: 1, height: 1 }, 2)).toBe('translate3d(100.5px, 50.5px, 0)')
    expect(bubbleTransform(layout, { x: 100, y: 50, width: 1, height: 1 }, 1)).toBe('translate3d(0px, 1px, 0)')
    expect(bubbleTransform(layout, { x: 0, y: 0, width: 1, height: 1 }, Number.NaN)).toBe('translate3d(100px, 51px, 0)')
  })

  it('the stylesheet uses the tuning, is light/dark aware and respects reduced motion', () => {
    const css = bubbleCss()
    const B = tuning.ui.bubble
    expect(css).toContain(`max-width: ${B.maxWidthPt}px`)
    expect(css).toContain(`${B.fontSizePt}px/${B.lineHeight}`)
    expect(css).toContain('prefers-color-scheme: dark')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain(B.light.background)
    expect(css).toContain(B.dark.background)
    expect(css).toContain('pointer-events: none')
    expect(css).not.toMatch(/url\(|@import|https?:/) // §2: nothing from the network
  })
})
