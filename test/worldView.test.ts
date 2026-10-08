import { describe, expect, it } from 'vitest'
import { tuning } from '../src/shared/tuning'
import { boxFor, isDebugWorldMsg, type DebugWorldMsg } from '../src/shared/world'
import {
  backingSize,
  drawWorldView,
  petBoxRect,
  toOverlayLocal,
  worldViewShapes,
  type WorldViewContext,
  type WorldViewShape,
} from '../src/renderer/pet/worldView'

// The world's debug view (src/renderer/pet/worldView.ts): what a debug:world message draws, where (global pt → the
// overlay page's CSS px), and how it reaches a 2D context (a recording fake here).

const V = tuning.dev.worldView
/** Not at the origin, so a missing "− overlay origin" shows. */
const ORIGIN = { x: 100, y: 40 }

const MSG: DebugWorldMsg = {
  show: true,
  windows: [{ wid: 7, x: 300, y: 200, width: 600, height: 400 }],
  segments: [
    { id: 'ground', kind: 'ground', windowId: null, y: 1000, x0: 150, x1: 1650 },
    { id: 'top:7:0', kind: 'windowTop', windowId: 7, y: 200, x0: 330, x1: 870 },
  ],
  walls: [{ id: 'side:7:left:0', kind: 'windowSide', windowId: 7, x: 300, y0: 230, y1: 600, wallOn: 'right' }],
  links: [
    { kind: 'drop', from: { x: 870, y: 200 }, to: { x: 870, y: 1000 } },
    { kind: 'climb', from: { x: 290, y: 1000 }, to: { x: 300, y: 600 } },
  ],
  path: [
    { x: 500, y: 1000 },
    { x: 290, y: 1000 },
    { x: 300, y: 230 },
  ],
}

class RecordingContext implements WorldViewContext {
  strokeStyle: unknown = ''
  lineWidth = 1
  lineCap = 'butt'
  lineJoin = 'miter'
  readonly calls: unknown[][] = []
  private dash: number[] = []
  setTransform(...args: number[]): void {
    this.calls.push(['setTransform', ...args])
  }
  clearRect(...args: number[]): void {
    this.calls.push(['clearRect', ...args])
  }
  setLineDash(segments: number[]): void {
    this.dash = segments
  }
  beginPath(): void {
    this.calls.push(['beginPath'])
  }
  moveTo(x: number, y: number): void {
    this.calls.push(['moveTo', x, y])
  }
  lineTo(x: number, y: number): void {
    this.calls.push(['lineTo', x, y])
  }
  strokeRect(...args: number[]): void {
    this.calls.push(['strokeRect', ...args, this.style()])
  }
  stroke(): void {
    this.calls.push(['stroke', this.style()])
  }
  private style(): string {
    return `${String(this.strokeStyle)} ${this.lineWidth} [${this.dash.join(',')}]`
  }
}

describe('world debug view: coordinates', () => {
  it('global pt → the overlay page’s CSS px, by the overlay origin', () => {
    expect(toOverlayLocal({ x: 350, y: 90 }, ORIGIN)).toEqual({ x: 250, y: 50 })
    expect(toOverlayLocal({ x: -20, y: 0 }, { x: -1440, y: 0 })).toEqual({ x: 1420, y: 0 })
  })

  it('the pet’s box: the measured box turned for its attach, at the drawn ground point', () => {
    const petBox = { left: -40, top: -120, right: 40, bottom: 0 }
    expect(petBoxRect({ x: 800, y: 1000 }, petBox, ORIGIN)).toEqual({ x: 660, y: 840, width: 80, height: 120 })
    // Climbing a wall on its right at (1200, 500): the head points left, the box lies on its side left of the wall.
    expect(petBoxRect({ x: 1200, y: 500 }, boxFor(petBox, 'wallRight'), ORIGIN)).toEqual({ x: 980, y: 420, width: 120, height: 80 })
  })

  it('the backing store follows the pixel ratio (at least one device pixel)', () => {
    expect(backingSize(1600, 1000, 2)).toEqual({ width: 3200, height: 2000 })
    expect(backingSize(1512, 982, 1.5)).toEqual({ width: 2268, height: 1473 })
    expect(backingSize(0, 10, Number.NaN)).toEqual({ width: 1, height: 10 })
  })
})

describe('world debug view: what a message draws', () => {
  it('validates as the contract’s message', () => {
    expect(isDebugWorldMsg(MSG)).toBe(true)
  })

  it('windows thin, segments and walls thick in their colours, links dashed by kind, then the route', () => {
    const shapes = worldViewShapes(MSG, ORIGIN)
    expect(shapes.map((s) => s.what)).toEqual(['window', 'segment', 'segment', 'wall', 'link', 'link', 'path'])
    expect(shapes[0]).toEqual({
      kind: 'rect',
      what: 'window',
      rect: { x: 200, y: 160, width: 600, height: 400 },
      style: { color: V.window.color, width: V.window.width, dash: [] },
    })
    expect(shapes[1]).toMatchObject({ points: [{ x: 50, y: 960 }, { x: 1550, y: 960 }], style: { color: V.segment.color, width: V.segment.width } })
    expect(shapes[3]).toMatchObject({ points: [{ x: 200, y: 190 }, { x: 200, y: 560 }], style: { color: V.wall.color, width: V.wall.width } })
    expect(shapes[4]?.style).toEqual({ color: V.link.colors.drop, width: V.link.width, dash: [...V.link.dash] })
    expect(shapes[5]?.style.color).toBe(V.link.colors.climb)
    expect(shapes[6]).toMatchObject({
      kind: 'line',
      points: [
        { x: 400, y: 960 },
        { x: 190, y: 960 },
        { x: 200, y: 190 },
      ],
      style: { color: V.path.color, width: V.path.width, dash: [] },
    })
    // Segments and walls are thicker than the outlines and links.
    expect(V.segment.width).toBeGreaterThan(V.window.width)
    expect(V.wall.width).toBeGreaterThan(V.link.width)
    expect(V.segment.color).not.toBe(V.wall.color)
  })

  it('no route without two points; nothing at all for show false', () => {
    expect(worldViewShapes({ ...MSG, path: [{ x: 1, y: 2 }] }, ORIGIN).some((s) => s.what === 'path')).toBe(false)
    expect(worldViewShapes({ ...MSG, path: [] }, ORIGIN).some((s) => s.what === 'path')).toBe(false)
    expect(worldViewShapes({ ...MSG, show: false }, ORIGIN)).toEqual([])
  })
})

describe('world debug view: drawing', () => {
  it('clears the whole backing store, then strokes in CSS px scaled by the pixel ratio', () => {
    const ctx = new RecordingContext()
    const shapes = worldViewShapes(MSG, ORIGIN)
    drawWorldView(ctx, shapes, { width: 3200, height: 2000 }, 2)
    expect(ctx.calls.slice(0, 3)).toEqual([
      ['setTransform', 1, 0, 0, 1, 0, 0],
      ['clearRect', 0, 0, 3200, 2000],
      ['setTransform', 2, 0, 0, 2, 0, 0],
    ])
    // The window's outline lies just inside its bounds.
    const inset = V.window.width / 2
    expect(ctx.calls).toContainEqual(['strokeRect', 200 + inset, 160 + inset, 600 - 2 * inset, 400 - 2 * inset, `${V.window.color} ${V.window.width} []`])
    expect(ctx.calls.filter((c) => c[0] === 'stroke')).toEqual([
      ['stroke', `${V.segment.color} ${V.segment.width} []`],
      ['stroke', `${V.segment.color} ${V.segment.width} []`],
      ['stroke', `${V.wall.color} ${V.wall.width} []`],
      ['stroke', `${V.link.colors.drop} ${V.link.width} [${V.link.dash.join(',')}]`],
      ['stroke', `${V.link.colors.climb} ${V.link.width} [${V.link.dash.join(',')}]`],
      ['stroke', `${V.path.color} ${V.path.width} []`],
    ])
    // The route: one path through its points.
    const last = ctx.calls.lastIndexOf(ctx.calls.filter((c) => c[0] === 'beginPath').at(-1) as unknown[])
    expect(ctx.calls.slice(last + 1, last + 4)).toEqual([
      ['moveTo', 400, 960],
      ['lineTo', 190, 960],
      ['lineTo', 200, 190],
    ])
  })

  it('an empty view only clears; a degenerate line is skipped', () => {
    const ctx = new RecordingContext()
    const lonely: WorldViewShape = { kind: 'line', what: 'path', points: [{ x: 1, y: 1 }], style: { color: 'red', width: 1, dash: [] } }
    drawWorldView(ctx, [lonely], { width: 10, height: 10 }, 1)
    expect(ctx.calls.map((c) => c[0])).toEqual(['setTransform', 'clearRect', 'setTransform'])
  })
})
