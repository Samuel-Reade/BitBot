import * as THREE from 'three'
import { tuning } from '../../../shared/tuning'
import type { Palette } from '../../../shared/types'

// §6.3 pixel face: chunky pixels on a 128×96 grid, shown on the screen through a CanvasTexture.
// The face is composed as eyes × mouth × overlays, each element drawn by its own drawer, so later
// milestones add states by adding a union member plus a drawer (the Record types make the
// compiler insist on both). It is redrawn only when the state changes (§11), never per frame.
//
// This module stays DOM-free (structural canvas types, injectable canvas factory) so it runs in
// Node under Vitest and type-checks under both tsconfigs.

/** The face's pixel grid (§6.3). Drawers work in these units. */
export const FACE_WIDTH = 128
export const FACE_HEIGHT = 96
/** Canvas pixels per face pixel: the canvas is FACE_WIDTH·k × FACE_HEIGHT·k (see createPixelFace). */
export const FACE_TEXTURE_SCALE: number = tuning.render.face.sampling.textureScale

/** Base screen background (§6.2); tinted toward the palette's screen glow. */
const SCREEN_BACKGROUND = '#10201F'
const HIGHLIGHT = '#FFFFFF'
const SCANLINE = '#000000'

// ---- State -----------------------------------------------------------------------------------

const EYES = ['open', 'blink'] as const
const MOUTHS = ['smile'] as const
/** Overlays are drawn in this order (later = on top), whatever order the state lists them in. */
const OVERLAYS = ['blush'] as const

export type EyesState = (typeof EYES)[number]
export type MouthState = (typeof MOUTHS)[number]
export type FaceOverlay = (typeof OVERLAYS)[number]

export interface FaceState {
  readonly eyes: EyesState
  readonly mouth: MouthState
  readonly overlays: readonly FaceOverlay[]
}

export const DEFAULT_FACE_STATE: FaceState = { eyes: 'open', mouth: 'smile', overlays: [] }

export function isEyesState(value: unknown): value is EyesState {
  return typeof value === 'string' && (EYES as readonly string[]).includes(value)
}
export function isMouthState(value: unknown): value is MouthState {
  return typeof value === 'string' && (MOUTHS as readonly string[]).includes(value)
}
export function isFaceOverlay(value: unknown): value is FaceOverlay {
  return typeof value === 'string' && (OVERLAYS as readonly string[]).includes(value)
}

// ---- Canvas abstraction ----------------------------------------------------------------------

/** The part of CanvasRenderingContext2D the face uses. */
export interface FaceContext2D {
  fillStyle: unknown
  globalAlpha: number
  fillRect(x: number, y: number, w: number, h: number): void
}

/** The part of HTMLCanvasElement / OffscreenCanvas the face uses. */
export interface FaceCanvas {
  width: number
  height: number
  getContext(contextId: '2d'): FaceContext2D | null
}

export type CanvasFactory = (width: number, height: number) => FaceCanvas

/** Default factory: a DOM <canvas>. Inject another one where there is no document (tests). */
export const createDomCanvas: CanvasFactory = (width, height) => {
  const doc = (globalThis as unknown as { document?: { createElement(tag: 'canvas'): FaceCanvas } }).document
  if (!doc) throw new Error('pixel face: no DOM document; pass options.createCanvas')
  const canvas = doc.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

// ---- Layout and drawers ----------------------------------------------------------------------
// Canvas pixels, origin top-left. "Left"/"right" here are the viewer's (canvas) sides.

interface EyeSlot {
  /** Center of the 14×18 eye block. */
  readonly cx: number
  readonly cy: number
  /** −1 = viewer's left eye, +1 = viewer's right eye (lets asymmetric looks mirror). */
  readonly side: -1 | 1
}

// Eyes 44 px apart; eyes + mouth form a cluster centered on the screen (rows 31..65).
const LAYOUT = {
  eyes: [
    { cx: 42, cy: 40, side: -1 },
    { cx: 86, cy: 40, side: 1 },
  ] as const satisfies readonly EyeSlot[],
  mouth: { cx: 64, top: 56 },
} as const

interface FaceColors {
  readonly background: string
  readonly glow: string
  readonly accent: string
}

/**
 * Thin painter over the 2D context. Coordinates are face pixels; it scales them to whole canvas
 * pixels (k per face pixel), so every face pixel is a solid k×k block and every edge lands on a texel.
 */
class Painter {
  constructor(
    private readonly ctx: FaceContext2D,
    private readonly k: number,
  ) {}

  rect(color: string, x: number, y: number, w: number, h: number): void {
    this.ctx.fillStyle = color
    this.fillRect(x, y, w, h)
  }

  /** Pixel pattern: rows of '#' (filled) and '.' (empty), each cell `cell` px square, top-left at (x, y). */
  pattern(color: string, x: number, y: number, rows: readonly string[], cell: number): void {
    this.ctx.fillStyle = color
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) if (row[i] === '#') this.fillRect(x + i * cell, y + j * cell, cell, cell)
    })
  }

  /** Pattern centered horizontally on cx (snapped to whole pixels: fractional rects would blur). */
  patternCentered(color: string, cx: number, y: number, rows: readonly string[], cell: number): void {
    const width = Math.max(0, ...rows.map((row) => row.length)) * cell
    this.pattern(color, Math.floor(cx - width / 2), y, rows, cell)
  }

  overlay(color: string, alpha: number, draw: () => void): void {
    const previous = this.ctx.globalAlpha
    this.ctx.globalAlpha = alpha
    this.ctx.fillStyle = color
    draw()
    this.ctx.globalAlpha = previous
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const k = this.k
    this.ctx.fillRect(x * k, y * k, w * k, h * k)
  }
}

type EyeDrawer = (p: Painter, eye: EyeSlot, c: FaceColors) => void
type FaceDrawer = (p: Painter, c: FaceColors) => void

const EYE_W = 14
const EYE_H = 18
const HIGHLIGHT_SIZE = 4

const EYE_DRAWERS: Record<EyesState, EyeDrawer> = {
  // 14×18 block with a 4×4 white highlight in its upper-right corner (the key light's side), inset 2 px.
  open(p, e, c) {
    const x = e.cx - EYE_W / 2
    const y = e.cy - EYE_H / 2
    p.rect(c.glow, x, y, EYE_W, EYE_H)
    p.rect(HIGHLIGHT, x + EYE_W - 2 - HIGHLIGHT_SIZE, y + 2, HIGHLIGHT_SIZE, HIGHLIGHT_SIZE)
  },
  // 16×4 line through the eye's center.
  blink(p, e, c) {
    p.rect(c.glow, e.cx - 8, e.cy - 2, 16, 4)
  },
}

const SMILE = ['#....#', '#....#', '.####.']

const MOUTH_DRAWERS: Record<MouthState, FaceDrawer> = {
  // Pixel "U" (18×9) on a 3 px grid: strokes as chunky as the eyes, legible down to size S.
  smile(p, c) {
    p.patternCentered(c.glow, LAYOUT.mouth.cx, LAYOUT.mouth.top, SMILE, 3)
  },
}

const BLUSH = ['#.#.#']

const OVERLAY_DRAWERS: Record<FaceOverlay, FaceDrawer> = {
  // Accent-colored dots on the cheeks, below the outer half of each eye.
  blush(p, c) {
    for (const eye of LAYOUT.eyes) {
      const x = eye.cx + eye.side * 6 - 5
      p.pattern(c.accent, x, eye.cy + EYE_H / 2 + 4, BLUSH, 2)
    }
  },
}

// ---- Pixel face ------------------------------------------------------------------------------

export interface PixelFace {
  /** FACE_WIDTH·k × FACE_HEIGHT·k canvas pixels (k = FACE_TEXTURE_SCALE). */
  readonly canvas: FaceCanvas
  readonly texture: THREE.CanvasTexture<FaceCanvas>
  readonly state: FaceState
  /** How many times the canvas has been drawn (1 after creation). */
  readonly drawCount: number
  /**
   * Applies a partial state, field by field: fields that are missing, undefined or not a known
   * value keep their current value (so `{ eyes: blinking ? 'blink' : undefined }` is safe).
   * Redraws and re-uploads the texture only if the result differs; returns whether it did.
   */
  setState(next: Partial<FaceState>): boolean
  dispose(): void
}

export interface PixelFaceOptions {
  createCanvas?: CanvasFactory
  state?: Partial<FaceState>
}

export function createPixelFace(palette: Palette, options: PixelFaceOptions = {}): PixelFace {
  const k = FACE_TEXTURE_SCALE
  const canvas = (options.createCanvas ?? createDomCanvas)(FACE_WIDTH * k, FACE_HEIGHT * k)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('pixel face: 2D canvas context unavailable')
  const painter = new Painter(ctx, k)
  const { backgroundTint, scanlineOpacity, scanlinePeriodPx } = tuning.render.face
  const colors: FaceColors = {
    background: mixHex(SCREEN_BACKGROUND, palette.screenGlow, backgroundTint),
    glow: palette.screenGlow,
    accent: palette.accent,
  }

  let state = resolveState(DEFAULT_FACE_STATE, options.state)
  let drawCount = 0

  const draw = (s: FaceState): void => {
    painter.rect(colors.background, 0, 0, FACE_WIDTH, FACE_HEIGHT)
    for (const eye of LAYOUT.eyes) EYE_DRAWERS[s.eyes](painter, eye, colors)
    MOUTH_DRAWERS[s.mouth](painter, colors)
    for (const overlay of s.overlays) OVERLAY_DRAWERS[overlay](painter, colors)
    // Faint scanlines over everything: one dark row every `scanlinePeriodPx` rows.
    painter.overlay(SCANLINE, scanlineOpacity, () => {
      for (let y = scanlinePeriodPx - 1; y < FACE_HEIGHT; y += scanlinePeriodPx) painter.fillRect(0, y, FACE_WIDTH, 1)
    })
    drawCount++
  }

  draw(state)
  const texture = new THREE.CanvasTexture(canvas)
  texture.name = 'bitbot-face'
  texture.colorSpace = THREE.SRGBColorSpace
  // SPEC-DEVIATION: §6.3 asks for NearestFilter (no mipmaps) on the 128×96 canvas. Nearest only
  // looks crisp at whole-number magnifications, but the screen is drawn at 0.3–1.4 device px per
  // face pixel (S/M/L × DPR 1/2, foreshortened by the 3/4 view and the bulge), so it dropped or
  // doubled face rows and columns, and which ones changed with every bob and turn (eyes shearing,
  // highlights vanishing, scanlines crawling; worst on DPR-1 displays). The face keeps its 128×96
  // pixel grid, but each face pixel is a solid k×k block of a k× larger canvas, sampled with
  // linear filtering, trilinear mipmaps and anisotropic filtering, at a slightly sharpened mip
  // level (createFaceMaterial): pixels stay crisp and evenly sized, and nothing shimmers at any
  // size, DPR, yaw or bob phase (compared side by side in snapshots at S/M/L × DPR 1/2).
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = tuning.render.face.sampling.anisotropy

  return {
    canvas,
    texture,
    get state() {
      return state
    },
    get drawCount() {
      return drawCount
    },
    setState(next) {
      const candidate = resolveState(state, next)
      if (sameState(candidate, state)) return false
      // Draw first, commit after: if drawing throws, `state` and the uploaded texture both still
      // show the previous face (a half-drawn canvas is never uploaded; the next draw repaints it).
      draw(candidate)
      state = candidate
      texture.needsUpdate = true
      return true
    },
    dispose() {
      texture.dispose()
    },
  }
}

/**
 * The unlit screen material (§6.1) showing `face`. It samples the face texture at a mip level
 * offset by tuning.render.face.sampling.mipBias (negative = sharper; plain trilinear filtering
 * blurs a texture shown at about 1:1), by passing a bias to the texture() call in three's
 * map_fragment chunk. If a future three.js changes that chunk, the patch does nothing and the
 * face is merely a little softer.
 */
export function createFaceMaterial(face: PixelFace): THREE.MeshBasicMaterial {
  const bias = tuning.render.face.sampling.mipBias.toFixed(3)
  const material = new THREE.MeshBasicMaterial({ name: 'screen', map: face.texture })
  material.onBeforeCompile = (shader) => {
    const chunk = THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', `texture2D( map, vMapUv, ${bias} )`)
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', chunk)
  }
  // Programs are cached by this key: keep biased and plain map materials apart.
  material.customProgramCacheKey = () => `bitbot-face-mip-bias:${bias}`
  return material
}

/**
 * `base` with `patch` applied field by field. A field that is missing, undefined or not a known
 * value (e.g. from an untyped IPC message) keeps base's value. Overlays come out canonical:
 * unknown ones dropped, duplicates removed, fixed draw order.
 */
function resolveState(base: FaceState, patch: Partial<FaceState> | undefined): FaceState {
  const eyes: unknown = patch?.eyes
  const mouth: unknown = patch?.mouth
  const overlays: unknown = patch?.overlays
  const requested: readonly unknown[] = Array.isArray(overlays) ? overlays : base.overlays
  return {
    eyes: isEyesState(eyes) ? eyes : base.eyes,
    mouth: isMouthState(mouth) ? mouth : base.mouth,
    overlays: OVERLAYS.filter((o) => requested.includes(o)),
  }
}

function sameState(a: FaceState, b: FaceState): boolean {
  return a.eyes === b.eyes && a.mouth === b.mouth && a.overlays.length === b.overlays.length && a.overlays.every((o, i) => o === b.overlays[i])
}

/** Mixes two #rrggbb colors in sRGB space (t = 0 → a, 1 → b). */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  return `#${pa.map((v, i) => Math.round(v + ((pb[i] ?? v) - v) * t).toString(16).padStart(2, '0')).join('')}`
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`bad color ${hex}`)
  return [parseInt(m[1] ?? '0', 16), parseInt(m[2] ?? '0', 16), parseInt(m[3] ?? '0', 16)]
}
