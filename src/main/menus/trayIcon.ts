// The menu-bar icon (BITBOT_SPEC.md §15.2): "a tiny monochrome template image of the CRT silhouette", drawn here so
// no image asset ships. A chunky CRT body with rounded corners, its screen cut out with two eye pixels left in, a short
// antenna with a ball (a little right of centre, like the model's) and two little feet. Template images use only their
// alpha (macOS tints them for the menu bar's appearance), so this renders an anti-aliased alpha mask per scale; the
// glue turns each into a nativeImage representation (alphaToBgra) and marks the image as a template.
//
// The shape is art data (like construction.ts), not tuning: points on the 18 pt canvas, y down. Straight edges sit on
// whole points so both the 1× and the 2× render stay crisp; every stroke and gap is at least 1 pt at 1×.

export const TRAY_ICON_PT = 18

interface RoundRect {
  x0: number
  y0: number
  x1: number
  y1: number
  r: number
}

interface Ellipse {
  cx: number
  cy: number
  rx: number
  ry: number
}

const SHAPE = {
  /** The CRT body, 14 × 11 pt (about the model's proportions). */
  body: { x0: 2, y0: 5, x1: 16, y1: 16, r: 3 },
  /** The screen, cut out: a 2 pt frame on top and at the sides, a 3 pt chin below. */
  screen: { x0: 4, y0: 7, x1: 14, y1: 13, r: 1.5 },
  /** Two 2 × 2 pt eye pixels, left solid inside the screen. */
  eyes: [
    { x0: 6, y0: 9, x1: 8, y1: 11, r: 0 },
    { x0: 10, y0: 9, x1: 12, y1: 11, r: 0 },
  ],
  /** Antenna: a 1 pt stem from the body's top into a ball. */
  stem: { x0: 10, y0: 2, x1: 11, y1: 5.5, r: 0 },
  ball: { cx: 10.5, cy: 2, rx: 1.5, ry: 1.5 },
  /** Feet: half ellipses under the body, 3 pt wide and 1.75 pt tall, under the model's feet (±45% of the half-width). */
  feet: [
    { cx: 6, cy: 16, rx: 1.5, ry: 1.75 },
    { cx: 12, cy: 16, rx: 1.5, ry: 1.75 },
  ],
} as const satisfies {
  body: RoundRect
  screen: RoundRect
  eyes: readonly RoundRect[]
  stem: RoundRect
  ball: Ellipse
  feet: readonly Ellipse[]
}

/** Samples per pixel along each axis (anti-aliasing: 64 coverage levels). */
const SUPERSAMPLE = 8

/** Row-major alpha mask, (18·scale)² bytes, anti-aliased (supersampled). scale 1 or 2 (any whole scale works). */
export function trayIconAlpha(scale: number): Uint8Array {
  if (!Number.isInteger(scale) || scale < 1 || scale > 8) throw new RangeError(`trayIconAlpha: unsupported scale ${scale}`)
  const size = TRAY_ICON_PT * scale
  const out = new Uint8Array(size * size)
  const samples = SUPERSAMPLE * SUPERSAMPLE
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const y = (py + (sy + 0.5) / SUPERSAMPLE) / scale
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          if (inShape((px + (sx + 0.5) / SUPERSAMPLE) / scale, y)) hits++
        }
      }
      out[py * size + px] = Math.round((255 * hits) / samples)
    }
  }
  return out
}

/** Black pixels with the given alpha, BGRA order (template image; colour channels 0, so the byte order only matters for alpha). */
export function alphaToBgra(alpha: Uint8Array): Uint8Array {
  const out = new Uint8Array(alpha.length * 4)
  for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = alpha[i] ?? 0
  return out
}

/** Is the point (pt) inside the silhouette? */
function inShape(x: number, y: number): boolean {
  if (SHAPE.eyes.some((eye) => inRoundRect(eye, x, y))) return true
  if (inRoundRect(SHAPE.screen, x, y)) return false
  return (
    inRoundRect(SHAPE.body, x, y) ||
    inRoundRect(SHAPE.stem, x, y) ||
    inEllipse(SHAPE.ball, x, y) ||
    SHAPE.feet.some((foot) => inEllipse(foot, x, y))
  )
}

function inRoundRect(r: RoundRect, x: number, y: number): boolean {
  if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return false
  // Distance past the straight part of the edges, toward the nearest corner.
  const dx = Math.max(r.x0 + r.r - x, 0, x - (r.x1 - r.r))
  const dy = Math.max(r.y0 + r.r - y, 0, y - (r.y1 - r.r))
  return dx * dx + dy * dy <= r.r * r.r
}

function inEllipse(e: Ellipse, x: number, y: number): boolean {
  const nx = (x - e.cx) / e.rx
  const ny = (y - e.cy) / e.ry
  return nx * nx + ny * ny <= 1
}
