import { afterEach, describe, expect, it, vi } from 'vitest'
import { PALETTES } from '../src/shared/palettes'
import { tuning } from '../src/shared/tuning'
import { ANIMATED_FACE_OVERLAYS, EYES_STATES, FACE_OVERLAYS, MOUTH_STATES } from '../src/shared/faceStates'
import {
  DEFAULT_FACE_STATE,
  FACE_HEIGHT,
  FACE_TEXTURE_SCALE,
  FACE_WIDTH,
  OVERLAY_PERIOD_FRAMES,
  createPixelFace,
  mixHex,
  type CanvasFactory,
  type FaceCanvas,
  type FaceContext2D,
  type FaceState,
} from '../src/renderer/pet/character/face'

// The full §6.3 face vocabulary in Node, drawn into a small software canvas (as in character.test.ts).

/** Minimal software 2D canvas: integer fillRect with globalAlpha blending; counts rects that leave the canvas. */
class RasterContext implements FaceContext2D {
  fillStyle: unknown = '#000000'
  globalAlpha = 1
  outOfBounds = 0
  readonly data: Uint8ClampedArray

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4)
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    // Fractional rects blur on a real canvas; the face must only ever draw whole pixels.
    if (![x, y, w, h].every(Number.isInteger)) throw new Error(`non-integer fillRect(${x}, ${y}, ${w}, ${h})`)
    if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > this.width || y + h > this.height) this.outOfBounds++
    const [r, g, b] = rgb(String(this.fillStyle))
    const a = this.globalAlpha
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) {
        const o = (j * this.width + i) * 4
        this.data[o] = (this.data[o] ?? 0) * (1 - a) + r * a
        this.data[o + 1] = (this.data[o + 1] ?? 0) * (1 - a) + g * a
        this.data[o + 2] = (this.data[o + 2] ?? 0) * (1 - a) + b * a
        this.data[o + 3] = 255
      }
    }
  }

  pixel(x: number, y: number): [number, number, number] {
    const o = (y * this.width + x) * 4
    return [this.data[o] ?? 0, this.data[o + 1] ?? 0, this.data[o + 2] ?? 0]
  }
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`fake canvas: unsupported color ${hex}`)
  return [parseInt(m[1] ?? '', 16), parseInt(m[2] ?? '', 16), parseInt(m[3] ?? '', 16)]
}

const mint = PALETTES.mint
const K = FACE_TEXTURE_SCALE
const WHITE: [number, number, number] = [255, 255, 255]

function makeFace(state?: Partial<FaceState>) {
  const contexts: RasterContext[] = []
  const factory: CanvasFactory = (width, height) => {
    const ctx = new RasterContext(width, height)
    contexts.push(ctx)
    const canvas: FaceCanvas = { width, height, getContext: () => ctx }
    return canvas
  }
  const face = createPixelFace(mint, { createCanvas: factory, state })
  const ctx = contexts[0]
  if (!ctx) throw new Error('no canvas created')
  return { face, ctx }
}

/** The face pixels of one state (one sample per K×K block), as a comparable string key. */
function render(state: Partial<FaceState>): { key: string; ctx: RasterContext } {
  const { face, ctx } = makeFace(state)
  face.dispose()
  return { key: Buffer.from(ctx.data).toString('base64'), ctx }
}

const px = (ctx: RasterContext, x: number, y: number): [number, number, number] => ctx.pixel(x * K + (K >> 1), y * K + (K >> 1))

/** Face pixels whose color is `color` (or `color` under a scanline). */
function pixelsOf(ctx: RasterContext, color: [number, number, number]): { x: number; y: number }[] {
  const dim = shaded(color)
  const out: { x: number; y: number }[] = []
  for (let y = 0; y < FACE_HEIGHT; y++) {
    for (let x = 0; x < FACE_WIDTH; x++) {
      const p = px(ctx, x, y)
      if (same(p, color) || same(p, dim)) out.push({ x, y })
    }
  }
  return out
}

/** A color as a scanline leaves it (the canvas stores whole channels, rounded). */
function shaded(color: readonly number[]): [number, number, number] {
  const a = tuning.render.face.scanlineOpacity
  const c = Uint8ClampedArray.from(color.map((v) => v * (1 - a)))
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]
}
const same = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => v === b[i])
const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length

function expectAllDistinct(keys: Map<string, string>): void {
  const seen = new Map<string, string>()
  for (const [name, key] of keys) {
    expect(seen.get(key), `${name} draws the same as ${seen.get(key)}`).toBeUndefined()
    seen.set(key, name)
  }
}

describe('§6.3 pixel face: every state', () => {
  const defaultKey = render(DEFAULT_FACE_STATE).key

  it('every eyes state draws something of its own', () => {
    const keys = new Map(EYES_STATES.map((eyes) => [eyes, render({ eyes }).key] as const))
    for (const [eyes, key] of keys) if (eyes !== DEFAULT_FACE_STATE.eyes) expect(key, eyes).not.toBe(defaultKey)
    expectAllDistinct(keys)
  })

  it('every mouth state draws something of its own', () => {
    const keys = new Map(MOUTH_STATES.map((mouth) => [mouth, render({ mouth }).key] as const))
    for (const [mouth, key] of keys) if (mouth !== DEFAULT_FACE_STATE.mouth) expect(key, mouth).not.toBe(defaultKey)
    expectAllDistinct(keys)
  })

  it('every overlay draws something of its own over the default face', () => {
    const keys = new Map(FACE_OVERLAYS.map((overlay) => [overlay, render({ overlays: [overlay] }).key] as const))
    for (const [overlay, key] of keys) expect(key, overlay).not.toBe(defaultKey)
    expectAllDistinct(keys)
  })

  it('everything stays inside the 128×96 grid, on whole pixels, at every frame of every loop', () => {
    const states: Partial<FaceState>[] = [
      ...EYES_STATES.map((eyes) => ({ eyes })),
      ...MOUTH_STATES.map((mouth) => ({ mouth })),
      ...FACE_OVERLAYS.flatMap((overlay) => {
        const period = (OVERLAY_PERIOD_FRAMES as Record<string, number>)[overlay] ?? 1
        return Array.from({ length: period }, (_, frame) => ({ overlays: [overlay], frame }))
      }),
    ]
    for (const state of states) expect(render(state).ctx.outOfBounds, JSON.stringify(state)).toBe(0)
  })

  it('eyes and mouths use only the glow and the white highlight over the background', () => {
    const background = rgb(mixHex('#10201F', mint.screenGlow, tuning.render.face.backgroundTint))
    const allowed = [background, rgb(mint.screenGlow), WHITE].flatMap((c) => [c, shaded(c)])
    const states: Partial<FaceState>[] = [...EYES_STATES.map((eyes) => ({ eyes })), ...MOUTH_STATES.map((mouth) => ({ mouth }))]
    for (const state of states) {
      const { ctx } = render(state)
      for (let y = 0; y < FACE_HEIGHT; y++) {
        for (let x = 0; x < FACE_WIDTH; x++) {
          expect(allowed.some((c) => same(c, px(ctx, x, y))), `${JSON.stringify(state)} at ${x},${y}`).toBe(true)
        }
      }
    }
  })

  it('blush and heart-pop are accent colored, dust is grey', () => {
    const accent = rgb(mint.accent)
    expect(pixelsOf(render({ overlays: ['blush'] }).ctx, accent).length).toBeGreaterThan(0)
    for (let frame = 0; frame < OVERLAY_PERIOD_FRAMES['heart-pop']; frame++) {
      expect(pixelsOf(render({ overlays: ['heart-pop'], frame }).ctx, accent).length, `frame ${frame}`).toBeGreaterThan(0)
    }
    const { ctx } = render({ overlays: ['dust'] })
    const specks = new Set<string>()
    for (let y = 0; y < FACE_HEIGHT; y++) {
      for (let x = 0; x < FACE_WIDTH; x++) {
        const [r, g, b] = px(ctx, x, y)
        if (Math.max(r, g, b) - Math.min(r, g, b) < 16 && r > 100 && r < 200) specks.add(`${x},${y}`)
      }
    }
    expect(specks.size).toBeGreaterThanOrEqual(20)
  })

  it('look-left/right/up move both eyes and their highlights the same way', () => {
    const glow = rgb(mint.screenGlow)
    const centroid = (eyes: FaceState['eyes'], color: [number, number, number], side: 'left' | 'right') => {
      const points = pixelsOf(render({ eyes }).ctx, color).filter((p) => (side === 'left' ? p.x < 64 : p.x >= 64))
      return { x: mean(points.map((p) => p.x)), y: mean(points.map((p) => p.y)) }
    }
    for (const side of ['left', 'right'] as const) {
      for (const color of [glow, WHITE]) {
        const open = centroid('open', color, side)
        expect(centroid('look-left', color, side).x).toBeLessThan(open.x)
        expect(centroid('look-right', color, side).x).toBeGreaterThan(open.x)
        expect(centroid('look-up', color, side).y).toBeLessThan(open.y)
      }
    }
  })
})

describe('§6.3 pixel face: animated overlays', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('every animated overlay has a period, changes every frame and repeats after its period', () => {
    expect(Object.keys(OVERLAY_PERIOD_FRAMES).sort()).toEqual([...ANIMATED_FACE_OVERLAYS].sort())
    for (const overlay of ANIMATED_FACE_OVERLAYS) {
      const period = OVERLAY_PERIOD_FRAMES[overlay]
      expect(Number.isInteger(period) && period >= 2, overlay).toBe(true)
      const keys = Array.from({ length: period }, (_, frame) => render({ overlays: [overlay], frame }).key)
      keys.forEach((key, frame) => expect(key, `${overlay} frame ${frame}→${frame + 1}`).not.toBe(keys[(frame + 1) % period]))
      expect(render({ overlays: [overlay], frame: period }).key, overlay).toBe(keys[0])
      expect(render({ overlays: [overlay], frame: 1000 * period + 3 }).key, overlay).toBe(keys[3 % period])
    }
  })

  it('static noise is deterministic per frame, a new pattern each frame, without Math.random', () => {
    const period = OVERLAY_PERIOD_FRAMES.static
    const keys = Array.from({ length: period }, (_, frame) => render({ overlays: ['static'], frame }).key)
    expect(new Set(keys).size).toBe(period)
    // Drawing a frame again, on another face, gives the same pixels (three.js uses Math.random for
    // texture ids, so the spy only watches the redraws).
    const { face, ctx } = makeFace({ overlays: ['static'] })
    const random = vi.spyOn(Math, 'random')
    for (const frame of [5, 9, 5]) {
      expect(face.setState({ frame })).toBe(true)
      expect(Buffer.from(ctx.data).toString('base64'), `frame ${frame}`).toBe(keys[frame])
    }
    expect(random).not.toHaveBeenCalled()
    face.dispose()
  })

  it('a new frame does not redraw a static face, but is recorded', () => {
    const { face, ctx } = makeFace({ overlays: ['blush', 'dust'] })
    const before = Buffer.from(ctx.data)
    const version = face.texture.version
    expect(face.setState({ frame: 5 })).toBe(false)
    expect(face.setState({ frame: 6, eyes: 'open' })).toBe(false)
    expect(face.drawCount).toBe(1)
    expect(face.texture.version).toBe(version)
    expect(Buffer.from(ctx.data).equals(before)).toBe(true)
    expect(face.state.frame).toBe(6)
    // An animated overlay then starts at the recorded frame.
    expect(face.setState({ overlays: ['zzz'] })).toBe(true)
    expect(face.state).toEqual({ ...DEFAULT_FACE_STATE, overlays: ['zzz'], frame: 6 })
    expect(Buffer.from(ctx.data).toString('base64')).toBe(render({ overlays: ['zzz'], frame: 6 }).key)
    face.dispose()
  })

  it('a new frame redraws while an animated overlay is shown', () => {
    const { face } = makeFace({ overlays: ['loading'] })
    const version = face.texture.version
    expect(face.setState({ frame: 1 })).toBe(true)
    expect(face.drawCount).toBe(2)
    expect(face.texture.version).toBe(version + 1)
    expect(face.setState({ frame: 1 })).toBe(false)
    expect(face.setState({ overlays: [] })).toBe(true)
    expect(face.setState({ frame: 2 })).toBe(false)
    expect(face.drawCount).toBe(3)
    face.dispose()
  })
})

describe('§6.3 pixel face: state patches', () => {
  it('keeps overlays in the canonical order, whatever order they come in', () => {
    const shuffled = [...FACE_OVERLAYS].reverse()
    const { face, ctx } = makeFace({ overlays: shuffled })
    expect(face.state.overlays).toEqual(FACE_OVERLAYS)
    expect(face.setState({ overlays: [...FACE_OVERLAYS] })).toBe(false)
    expect(Buffer.from(ctx.data).toString('base64')).toBe(render({ overlays: [...FACE_OVERLAYS] }).key)
    face.dispose()
  })

  it('ignores invalid fields and keeps the current ones', () => {
    const { face } = makeFace({ eyes: 'happy', mouth: 'o', overlays: ['zzz'], frame: 4 })
    const state = face.state
    for (const frame of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '3', null]) {
      expect(face.setState({ frame: frame as never }), String(frame)).toBe(false)
    }
    expect(face.setState({ eyes: 'squint' as never, mouth: 'grin' as never, overlays: ['sparkles' as never, 'zzz'] })).toBe(false)
    expect(face.setState({ overlays: 'zzz' as never })).toBe(false)
    expect(face.state).toEqual(state)
    expect(face.state).toEqual({ eyes: 'happy', mouth: 'o', overlays: ['zzz'], frame: 4 })
    expect(face.drawCount).toBe(1)
    face.dispose()
  })
})
