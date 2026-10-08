// Face contact sheet (§6.3) for review: every pixel-face state drawn by the real face.ts into a
// software canvas, written as one PNG. Run with plain Node (it strips the types itself):
//
//   node scripts/face-sheet.mts [out.png]     (default docs/images/face-sheet.png)
//
// Mint palette, each face scaled ×3 (face pixels, not the k× texture), no labels. Rows, left to right:
//   1. eyes:     open blink closed happy sad wide look-left look-right look-up dizzy heart   (smile mouth)
//   2. mouths:   smile flat wavy open-chew-A open-chew-B o yawn                              (open eyes)
//   3. overlays: dust, blush                                                               (default face)
//   4. static    at frames 0 1 2 3
//   5. loading   at frames 0 1 2 3 4 5 6 7
//   6. zzz       at frames 0 2 4 6 8 10 12 14
//   7. heart-pop at frames 0 1 2 3 4 5 6 7
// The shapes are the ones the pet shows; scanlines included.

import { writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { deflateSync, crc32 } from 'node:zlib'
import type * as FaceModule from '../src/renderer/pet/character/face'
import type * as PalettesModule from '../src/shared/palettes'
import type * as FaceStatesModule from '../src/shared/faceStates'

// The app's sources import each other without extensions (bundler resolution): point Node at the .ts files.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const relativeTs = specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith('.ts')
    const result = nextResolve(relativeTs ? `${specifier}.ts` : specifier, context)
    // They are ES modules (package.json has no "type"; saying so skips Node's reparse warning).
    return result.url.endsWith('.ts') ? { ...result, format: 'module-typescript' } : result
  },
})
const load = async <T,>(path: string): Promise<T> => (await import(new URL(path, import.meta.url).href)) as T
const face = await load<typeof FaceModule>('../src/renderer/pet/character/face.ts')
const { PALETTES } = await load<typeof PalettesModule>('../src/shared/palettes.ts')
const { EYES_STATES, MOUTH_STATES } = await load<typeof FaceStatesModule>('../src/shared/faceStates.ts')

const SCALE = 3
const GAP = 12
const SHEET_BACKGROUND: Rgb = [40, 40, 44]

type Rgb = [number, number, number]

/** Minimal software 2D canvas (as in test/character.test.ts): integer fillRect with globalAlpha blending. */
class RasterContext {
  fillStyle: unknown = '#000000'
  globalAlpha = 1
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.data = new Uint8ClampedArray(width * height * 3)
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (![x, y, w, h].every(Number.isInteger)) throw new Error(`non-integer fillRect(${x}, ${y}, ${w}, ${h})`)
    const [r, g, b] = rgb(String(this.fillStyle))
    const a = this.globalAlpha
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) {
        const o = (j * this.width + i) * 3
        this.data[o] = (this.data[o] ?? 0) * (1 - a) + r * a
        this.data[o + 1] = (this.data[o + 1] ?? 0) * (1 - a) + g * a
        this.data[o + 2] = (this.data[o + 2] ?? 0) * (1 - a) + b * a
      }
    }
  }

  pixel(x: number, y: number): Rgb {
    const o = (y * this.width + x) * 3
    return [this.data[o] ?? 0, this.data[o + 1] ?? 0, this.data[o + 2] ?? 0]
  }
}

function rgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`unsupported color ${hex}`)
  return [parseInt(m[1] ?? '', 16), parseInt(m[2] ?? '', 16), parseInt(m[3] ?? '', 16)]
}

/** Draws one face state; returns its 128×96 face pixels (sampled at the center of each k×k block). */
function renderFace(state: Partial<FaceModule.FaceState>): Rgb[] {
  let ctx: RasterContext | null = null
  const pixelFace = face.createPixelFace(PALETTES.mint, {
    state,
    createCanvas: (width, height) => {
      const context = new RasterContext(width, height)
      ctx = context
      return { width, height, getContext: () => context }
    },
  })
  pixelFace.dispose()
  const context = ctx as RasterContext | null
  if (!context) throw new Error('no canvas created')
  const k = face.FACE_TEXTURE_SCALE
  const out: Rgb[] = []
  for (let y = 0; y < face.FACE_HEIGHT; y++) {
    for (let x = 0; x < face.FACE_WIDTH; x++) out.push(context.pixel(x * k + (k >> 1), y * k + (k >> 1)))
  }
  return out
}

const frames = (list: readonly number[], overlay: FaceModule.FaceOverlay): Partial<FaceModule.FaceState>[] =>
  list.map((frame) => ({ overlays: [overlay], frame }))
const rows: Partial<FaceModule.FaceState>[][] = [
  EYES_STATES.map((eyes) => ({ eyes })),
  MOUTH_STATES.map((mouth) => ({ mouth })),
  [{ overlays: ['dust'] }, { overlays: ['blush'] }],
  frames([0, 1, 2, 3], 'static'),
  frames([0, 1, 2, 3, 4, 5, 6, 7], 'loading'),
  frames([0, 2, 4, 6, 8, 10, 12, 14], 'zzz'),
  frames([0, 1, 2, 3, 4, 5, 6, 7], 'heart-pop'),
]

const cellW = face.FACE_WIDTH * SCALE
const cellH = face.FACE_HEIGHT * SCALE
const columns = Math.max(...rows.map((row) => row.length))
const width = GAP + columns * (cellW + GAP)
const height = GAP + rows.length * (cellH + GAP)
const sheet = new Uint8Array(width * height * 3)
for (let i = 0; i < width * height; i++) sheet.set(SHEET_BACKGROUND, i * 3)

rows.forEach((row, r) => {
  row.forEach((state, c) => {
    const pixels = renderFace(state)
    const left = GAP + c * (cellW + GAP)
    const top = GAP + r * (cellH + GAP)
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const color = pixels[Math.floor(y / SCALE) * face.FACE_WIDTH + Math.floor(x / SCALE)] ?? SHEET_BACKGROUND
        sheet.set(color, ((top + y) * width + left + x) * 3)
      }
    }
  })
})

const out = process.argv[2] ?? new URL('../docs/images/face-sheet.png', import.meta.url).pathname
writeFileSync(out, encodePng(width, height, sheet))
console.log(`face sheet: ${width}×${height} → ${out}`)

/** Minimal PNG encoder: 8-bit RGB, one IDAT, no row filters. */
function encodePng(w: number, h: number, rgbData: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) raw.set(rgbData.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0)
  header.writeUInt32BE(h, 4)
  header.set([8, 2, 0, 0, 0], 8) // bit depth 8, color type RGB, deflate, no filter method, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
