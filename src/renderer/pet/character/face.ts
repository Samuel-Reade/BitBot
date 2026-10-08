import * as THREE from 'three'
import { tuning } from '../../../shared/tuning'
import type { Palette } from '../../../shared/types'
import {
  ANIMATED_FACE_OVERLAYS,
  DEFAULT_FACE_STATE,
  FACE_OVERLAYS,
  isAnimatedOverlay,
  isEyesState,
  isMouthState,
  type EyesState,
  type FaceOverlay,
  type FaceState,
  type MouthState,
} from '../../../shared/faceStates'

// §6.3 pixel face: chunky pixels on a 128×96 grid, shown on the screen through a CanvasTexture.
// The face is composed as eyes × mouth × overlays, each element drawn by its own drawer, so later
// milestones add states by adding a union member plus a drawer (the Record types make the
// compiler insist on both). It is redrawn only when the state changes (§11): for the animated
// overlays that includes FaceState.frame, which the animator advances; a static face never
// redraws per frame.
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
// The vocabulary is shared (src/shared/faceStates.ts); re-exported so renderer callers import the face from one place.

export {
  DEFAULT_FACE_STATE,
  FACE_OVERLAYS,
  isAnimatedOverlay,
  isEyesState,
  isFaceOverlay,
  isMouthState,
  type EyesState,
  type FaceOverlay,
  type FaceState,
  type MouthState,
} from '../../../shared/faceStates'

type AnimatedFaceOverlay = (typeof ANIMATED_FACE_OVERLAYS)[number]

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
  // Plain fields, not parameter properties: scripts/face-sheet.mts runs this file with Node's type stripping.
  private readonly ctx: FaceContext2D
  private readonly k: number

  constructor(ctx: FaceContext2D, k: number) {
    this.ctx = ctx
    this.k = k
  }

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
/** Overlays also get FaceState.frame: the animated ones loop on their own period, the static ones ignore it. */
type OverlayDrawer = (p: Painter, c: FaceColors, frame: number) => void

const EYE_W = 14
const EYE_H = 18
const HIGHLIGHT_SIZE = 4

/**
 * The open eye's 14×18 block shifted by (dx, dy), with its 4×4 highlight at (hx, hy) inside the
 * block. The look-* eyes move both toward where they look (both eyes look the same way).
 */
function openEye(p: Painter, e: EyeSlot, c: FaceColors, dx: number, dy: number, hx: number, hy: number): void {
  const x = e.cx - EYE_W / 2 + dx
  const y = e.cy - EYE_H / 2 + dy
  p.rect(c.glow, x, y, EYE_W, EYE_H)
  p.rect(HIGHLIGHT, x + hx, y + hy, HIGHLIGHT_SIZE, HIGHLIGHT_SIZE)
}

/** A pattern mirrored left↔right (an asymmetric shape on the viewer's right eye). */
function mirrored(rows: readonly string[]): string[] {
  return rows.map((row) => [...row].reverse().join(''))
}

// Eye patterns on a 2 px grid, at most 16 px wide (an eye slot is 14×18 around its center).
/** A lid line sagging in the middle (‿), a little lower than blink's straight line. */
const CLOSED_EYE = ['#......#', '.######.']
/** Upside-down U (^). */
const HAPPY_EYE = ['..####..', '.######.', '##....##', '#......#']
/** Viewer's left eye: the brow's inner (right) end is raised. Mirrored for the right eye. */
const SAD_BROW = ['....##', '..##..', '##....']
const SAD_EYE_H = 10
/** The sad eye's outer upper corner cut away (a drooping lid). */
const SAD_LID_DROOP = { w: 4, h: 2 }
const WIDE_EYE = { w: 18, h: 22 }
/** A bold X: reads as dizzy down to size S, where a spiral's 2 px turns blur into a blob. */
const DIZZY_EYE = ['##...##', '###.###', '.#####.', '..###..', '.#####.', '###.###', '##...##']
const HEART = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...']

const EYE_DRAWERS: Record<EyesState, EyeDrawer> = {
  // 14×18 block with a 4×4 white highlight in its upper-right corner (the key light's side), inset 2 px.
  open(p, e, c) {
    openEye(p, e, c, 0, 0, EYE_W - 2 - HIGHLIGHT_SIZE, 2)
  },
  // 16×4 line through the eye's center.
  blink(p, e, c) {
    p.rect(c.glow, e.cx - 8, e.cy - 2, 16, 4)
  },
  // 16×4 curve just below the center.
  closed(p, e, c) {
    p.patternCentered(c.glow, e.cx, e.cy + 1, CLOSED_EYE, 2)
  },
  // 16×8 arc around the center.
  happy(p, e, c) {
    p.patternCentered(c.glow, e.cx, e.cy - 4, HAPPY_EYE, 2)
  },
  // The open block's lower 10 rows with a drooping outer corner, under a 12×6 brow slanting down
  // to the outside (inner ends raised).
  sad(p, e, c) {
    const x = e.cx - EYE_W / 2
    const top = e.cy + EYE_H / 2 - SAD_EYE_H
    const droop = SAD_LID_DROOP
    p.rect(c.glow, x, top + droop.h, EYE_W, SAD_EYE_H - droop.h)
    p.rect(c.glow, e.side < 0 ? x + droop.w : x, top, EYE_W - droop.w, droop.h)
    p.patternCentered(c.glow, e.cx, e.cy - 10, e.side < 0 ? SAD_BROW : mirrored(SAD_BROW), 2)
  },
  // Surprised: an 18×22 block with the 4×4 highlight and a 2×2 glint in the opposite corner.
  wide(p, e, c) {
    const x = e.cx - WIDE_EYE.w / 2
    const y = e.cy - WIDE_EYE.h / 2
    p.rect(c.glow, x, y, WIDE_EYE.w, WIDE_EYE.h)
    p.rect(HIGHLIGHT, x + WIDE_EYE.w - 2 - HIGHLIGHT_SIZE, y + 2, HIGHLIGHT_SIZE, HIGHLIGHT_SIZE)
    p.rect(HIGHLIGHT, x + 2, y + WIDE_EYE.h - 4, 2, 2)
  },
  // The open eye 2 px toward the look, its highlight (the "pupil") against that edge.
  'look-left'(p, e, c) {
    openEye(p, e, c, -2, 0, 1, (EYE_H - HIGHLIGHT_SIZE) / 2)
  },
  'look-right'(p, e, c) {
    openEye(p, e, c, 2, 0, EYE_W - 1 - HIGHLIGHT_SIZE, (EYE_H - HIGHLIGHT_SIZE) / 2)
  },
  'look-up'(p, e, c) {
    openEye(p, e, c, 0, -2, (EYE_W - HIGHLIGHT_SIZE) / 2, 1)
  },
  // 14×14 X on the eye's center.
  dizzy(p, e, c) {
    p.patternCentered(c.glow, e.cx, e.cy - 7, DIZZY_EYE, 2)
  },
  // 14×12 heart with a 2×2 white glint on its left lobe.
  heart(p, e, c) {
    const top = e.cy - 6
    p.patternCentered(c.glow, e.cx, top, HEART, 2)
    p.rect(HIGHLIGHT, e.cx - 5, top + 2, 2, 2)
  },
}

// Mouth patterns on a 3 px grid (like the smile), centered under the eyes near LAYOUT.mouth.top.
const SMILE = ['#....#', '#....#', '.####.']
const FLAT = ['######']
const WAVY = ['.##..##.', '#..##..#']
/** Eating alternates these two (the animator flips them, ~12 Hz): wide open, then half closed. */
const CHEW_A = ['######', '#....#', '#....#', '######']
const CHEW_B = ['.####.', '#....#', '.####.']
const O_MOUTH = ['.##.', '#..#', '#..#', '.##.']
const YAWN = ['.####.', '#....#', '#....#', '#....#', '#....#', '#....#', '.####.']

const MOUTH_DRAWERS: Record<MouthState, FaceDrawer> = {
  // Pixel "U" (18×9) on a 3 px grid: strokes as chunky as the eyes, legible down to size S.
  smile(p, c) {
    p.patternCentered(c.glow, LAYOUT.mouth.cx, LAYOUT.mouth.top, SMILE, 3)
  },
  // 18×3 line at the smile's middle height.
  flat(p, c) {
    p.patternCentered(c.glow, LAYOUT.mouth.cx, LAYOUT.mouth.top + 3, FLAT, 3)
  },
  // 24×6 wave (hungry).
  wavy(p, c) {
    p.patternCentered(c.glow, LAYOUT.mouth.cx, LAYOUT.mouth.top + 2, WAVY, 3)
  },
  // 18×12 open box; B (18×9, rounded) shares its center, so the mouth chomps in place.
  'open-chew-A'(p, c) {
    p.patternCentered(c.glow, LAYOUT.mouth.cx, LAYOUT.mouth.top, CHEW_A, 3)
  },
  'open-chew-B'(p, c) {
    p.patternCentered(c.glow, LAYOUT.mouth.cx, LAYOUT.mouth.top + 1, CHEW_B, 3)
  },
  // 12×12 round "o" (surprised).
  o(p, c) {
    p.patternCentered(c.glow, LAYOUT.mouth.cx, LAYOUT.mouth.top, O_MOUTH, 3)
  },
  // 18×21 tall oval, starting a pixel above the other mouths.
  yawn(p, c) {
    p.patternCentered(c.glow, LAYOUT.mouth.cx, LAYOUT.mouth.top - 1, YAWN, 3)
  },
}

const BLUSH = ['#.#.#']

/** Grey that reads on the near-black screen without competing with the glow. */
const DUST_GREY = '#8A9390'
/** Fixed 2×2 specks (top-left corners), kept off the eyes and mouth. */
const DUST_SPECKS: readonly (readonly [number, number])[] = [
  [8, 10], [22, 5], [15, 25], [5, 44], [19, 63], [9, 80], [28, 87], [41, 74], [55, 88], [79, 83],
  [97, 71], [111, 86], [120, 57], [105, 41], [117, 21], [101, 8], [66, 15], [84, 22], [27, 52], [60, 43],
]

/** Static: 2×2 noise specks plus one glitch line (16..47 px), a new pattern each frame, repeating after STATIC_PERIOD frames. */
const STATIC_PERIOD = 32
const STATIC_SPECKS = 40
const STATIC_SPECK_ALPHA = 0.8
const STATIC_LINE_ALPHA = 0.5

/** Spinner in the lower-right corner: 8 dots (3×3) on a circle, the bright one stepping clockwise each frame. */
const LOADING = { cx: 114, cy: 80, dot: 3, dimAlpha: 0.25, trailAlpha: 0.6 }
const LOADING_DOTS: readonly (readonly [number, number])[] = [
  [0, -7], [5, -5], [7, 0], [5, 5], [0, 7], [-5, 5], [-7, 0], [-5, -5],
]

/** Three z's rising up and right from beside the right eye, each looping every ZZZ_PERIOD frames, a third of a loop apart. */
const ZZZ_PERIOD = 15
const ZZZ_COUNT = 3
const ZZZ_START = { x: 96, y: 30 }
const Z_SMALL = ['####', '..#.', '.#..', '####']
const Z_LARGE = ['#####', '...#.', '..#..', '.#...', '#####']

/** Heart-pop: grows and rises above the eyes over these frames (pattern, bottom edge), bursts, then loops. */
const HEART_TINY = ['#.#', '###', '.#.']
const HEART_SMALL = ['##.##', '#####', '.###.', '..#..']
const HEART_LARGE = ['.##...##.', '####.####', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....']
/** The pop: a ring of sparks where the heart was. */
const HEART_BURST = ['#...#...#', '.........', '#.......#', '.........', '#...#...#']
const HEART_POP_FRAMES: readonly { readonly rows: readonly string[]; readonly bottom: number }[] = [
  { rows: HEART_TINY, bottom: 30 },
  { rows: HEART_TINY, bottom: 28 },
  { rows: HEART_SMALL, bottom: 26 },
  { rows: HEART_SMALL, bottom: 24 },
  { rows: HEART, bottom: 22 },
  { rows: HEART, bottom: 20 },
  { rows: HEART_LARGE, bottom: 18 },
  { rows: HEART_BURST, bottom: 15 },
]

const OVERLAY_DRAWERS: Record<FaceOverlay, OverlayDrawer> = {
  // Grey specks scattered over the screen.
  dust(p) {
    for (const [x, y] of DUST_SPECKS) p.rect(DUST_GREY, x, y, 2, 2)
  },
  // Accent-colored dots on the cheeks, below the outer half of each eye.
  blush(p, c) {
    for (const eye of LAYOUT.eyes) {
      const x = eye.cx + eye.side * 6 - 5
      p.pattern(c.accent, x, eye.cy + EYE_H / 2 + 4, BLUSH, 2)
    }
  },
  // Glow-colored specks on a 2 px grid and a glitch line, pseudo-random from the frame.
  static(p, c, frame) {
    const random = noise(frame % STATIC_PERIOD)
    const below = (n: number): number => Math.floor(random() * n)
    p.overlay(c.glow, STATIC_SPECK_ALPHA, () => {
      for (let i = 0; i < STATIC_SPECKS; i++) p.fillRect(below(FACE_WIDTH / 2) * 2, below(FACE_HEIGHT / 2) * 2, 2, 2)
    })
    p.overlay(c.glow, STATIC_LINE_ALPHA, () => {
      const length = 16 + below(32)
      p.fillRect(below(FACE_WIDTH - length), below(FACE_HEIGHT), length, 1)
    })
  },
  // The bright dot, a half-bright one behind it, the rest dim.
  loading(p, c, frame) {
    const n = LOADING_DOTS.length
    const bright = frame % n
    const half = Math.floor(LOADING.dot / 2)
    LOADING_DOTS.forEach(([dx, dy], i) => {
      const behind = (bright - i + n) % n
      const alpha = behind === 0 ? 1 : behind === 1 ? LOADING.trailAlpha : LOADING.dimAlpha
      p.overlay(c.glow, alpha, () => p.fillRect(LOADING.cx + dx - half, LOADING.cy + dy - half, LOADING.dot, LOADING.dot))
    })
  },
  // Each z moves 1 px right and 2 px up per frame, small then large, fading in and out at the ends of its loop.
  zzz(p, c, frame) {
    for (let i = 0; i < ZZZ_COUNT; i++) {
      const t = (frame + (i * ZZZ_PERIOD) / ZZZ_COUNT) % ZZZ_PERIOD
      const alpha = t === 0 ? 0.4 : t >= ZZZ_PERIOD - 3 ? (ZZZ_PERIOD - t) / 4 : 1
      const rows = t < ZZZ_PERIOD / 2 ? Z_SMALL : Z_LARGE
      p.overlay(c.glow, alpha, () => p.pattern(c.glow, ZZZ_START.x + t, ZZZ_START.y - 2 * t, rows, 2))
    }
  },
  // Accent pixel heart centered above the eyes.
  'heart-pop'(p, c, frame) {
    const step = HEART_POP_FRAMES[frame % HEART_POP_FRAMES.length]
    if (!step) return
    p.patternCentered(c.accent, LAYOUT.mouth.cx, step.bottom - step.rows.length * 2, step.rows, 2)
  },
}

/** Loop length in frames of each animated overlay: frame and frame + period draw the same. */
export const OVERLAY_PERIOD_FRAMES: Readonly<Record<AnimatedFaceOverlay, number>> = {
  static: STATIC_PERIOD,
  loading: LOADING_DOTS.length,
  zzz: ZZZ_PERIOD,
  'heart-pop': HEART_POP_FRAMES.length,
}

/** Deterministic pseudo-random numbers in [0, 1) from a seed (mulberry32), so a frame always draws the same static. */
function noise(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
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
   * Redraws and re-uploads the texture only if the result looks different; returns whether it
   * did. A new `frame` only counts while an animated overlay is shown (it is still recorded).
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
    for (const overlay of s.overlays) OVERLAY_DRAWERS[overlay](painter, colors, s.frame)
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
      if (sameState(candidate, state)) {
        state = candidate // same picture; keeps a new frame for when an animated overlay appears
        return false
      }
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
 * value (e.g. from an untyped IPC message; a frame that is not an integer ≥ 0) keeps base's value.
 * Overlays come out canonical: unknown ones dropped, duplicates removed, fixed draw order.
 */
function resolveState(base: FaceState, patch: Partial<FaceState> | undefined): FaceState {
  const eyes: unknown = patch?.eyes
  const mouth: unknown = patch?.mouth
  const overlays: unknown = patch?.overlays
  const frame: unknown = patch?.frame
  const requested: readonly unknown[] = Array.isArray(overlays) ? overlays : base.overlays
  return {
    eyes: isEyesState(eyes) ? eyes : base.eyes,
    mouth: isMouthState(mouth) ? mouth : base.mouth,
    overlays: FACE_OVERLAYS.filter((o) => requested.includes(o)),
    frame: Number.isSafeInteger(frame) && (frame as number) >= 0 ? (frame as number) : base.frame,
  }
}

/** Whether a and b draw the same picture: the frame only matters while an animated overlay is shown. */
function sameState(a: FaceState, b: FaceState): boolean {
  const sameParts =
    a.eyes === b.eyes && a.mouth === b.mouth && a.overlays.length === b.overlays.length && a.overlays.every((o, i) => o === b.overlays[i])
  return sameParts && (a.frame === b.frame || !a.overlays.some(isAnimatedOverlay))
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
