// The overlay's debug view of the world (§14.1 "Toggle debug overlay: surfaces, visible segments, nav graph edges,
// current path, pet hitbox"), the drawing math: pure (no DOM; the 2D context is an interface), so Vitest checks what is
// drawn where. overlay.ts owns the canvas: created on the first debug:world with show true, removed with show false,
// redrawn only when a new message comes or the configuration (or pixel ratio) changes. The pet's box is a separate
// outline element moved only in frames that run anyway (petBoxRect), so a still pet costs no frames for it.
//
// Coordinates: messages are in global pt (y down); the overlay window's content starts at the configuration's overlay
// origin, and a CSS px of the overlay page is a pt.

import type { Box, Point, Rect } from '../../shared/geometry'
import { tuning } from '../../shared/tuning'
import type { DebugWorldMsg, WorldLink } from '../../shared/world'

export interface StrokeStyle {
  color: string
  /** CSS px. */
  width: number
  /** Dash pattern, CSS px; empty = solid. */
  dash: readonly number[]
}

/** What the view draws, overlay-local CSS px, in drawing order (later on top). */
export type WorldViewShape =
  | { kind: 'rect'; what: 'window'; rect: Rect; style: StrokeStyle }
  | { kind: 'line'; what: 'segment' | 'wall' | 'link' | 'path'; points: Point[]; style: StrokeStyle }

type ViewTuning = typeof tuning.dev.worldView

/** A global point (pt) in the overlay page's coordinates (CSS px from its top-left). */
export function toOverlayLocal(p: Point, overlayOrigin: Point): Point {
  return { x: p.x - overlayOrigin.x, y: p.y - overlayOrigin.y }
}

const solid = (s: { color: string; width: number }): StrokeStyle => ({ color: s.color, width: s.width, dash: [] })

function linkStyle(kind: WorldLink['kind'], T: ViewTuning): StrokeStyle {
  return { color: T.link.colors[kind], width: T.link.width, dash: [...T.link.dash] }
}

/**
 * Everything a debug:world message draws: eligible window outlines (thin), segments (thick) and walls (thick, another
 * colour), links (thin, dashed, coloured by kind), then the route (a polyline; nothing for fewer than two points).
 * Empty for show false.
 */
export function worldViewShapes(msg: DebugWorldMsg, overlayOrigin: Point, T: ViewTuning = tuning.dev.worldView): WorldViewShape[] {
  if (!msg.show) return []
  const local = (p: Point): Point => toOverlayLocal(p, overlayOrigin)
  const shapes: WorldViewShape[] = []
  for (const w of msg.windows) {
    const { x, y } = local(w)
    shapes.push({ kind: 'rect', what: 'window', rect: { x, y, width: w.width, height: w.height }, style: solid(T.window) })
  }
  for (const s of msg.segments) {
    shapes.push({ kind: 'line', what: 'segment', points: [local({ x: s.x0, y: s.y }), local({ x: s.x1, y: s.y })], style: solid(T.segment) })
  }
  for (const w of msg.walls) {
    shapes.push({ kind: 'line', what: 'wall', points: [local({ x: w.x, y: w.y0 }), local({ x: w.x, y: w.y1 })], style: solid(T.wall) })
  }
  for (const l of msg.links) {
    shapes.push({ kind: 'line', what: 'link', points: [local(l.from), local(l.to)], style: linkStyle(l.kind, T) })
  }
  if (msg.path.length >= 2) shapes.push({ kind: 'line', what: 'path', points: msg.path.map(local), style: solid(T.path) })
  return shapes
}

/** The pet's box (relative to its ground-contact point `ground`, global pt) as an overlay-local rect. */
export function petBoxRect(ground: Point, box: Box, overlayOrigin: Point): Rect {
  const topLeft = toOverlayLocal({ x: ground.x + box.left, y: ground.y + box.top }, overlayOrigin)
  return { x: topLeft.x, y: topLeft.y, width: box.right - box.left, height: box.bottom - box.top }
}

/** The canvas's backing store for a CSS size and pixel ratio, device px (at least 1 × 1). */
export function backingSize(cssWidth: number, cssHeight: number, devicePixelRatio: number): { width: number; height: number } {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return { width: Math.max(1, Math.round(cssWidth * dpr)), height: Math.max(1, Math.round(cssHeight * dpr)) }
}

/** The part of CanvasRenderingContext2D the view uses (no DOM types: the tests' fake implements it in Node). */
export interface WorldViewContext {
  strokeStyle: unknown
  lineWidth: number
  lineCap: string
  lineJoin: string
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  setLineDash(segments: number[]): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  stroke(): void
}

/** Clears the canvas (`backing`: its size, device px) and strokes `shapes` in CSS px, scaled by the pixel ratio. */
export function drawWorldView(
  ctx: WorldViewContext,
  shapes: readonly WorldViewShape[],
  backing: { width: number; height: number },
  devicePixelRatio: number,
): void {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, backing.width, backing.height)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'
  for (const shape of shapes) {
    ctx.strokeStyle = shape.style.color
    ctx.lineWidth = shape.style.width
    ctx.setLineDash([...shape.style.dash])
    if (shape.kind === 'rect') {
      // Inside the window's bounds, so neighbouring windows' outlines don't merge.
      const inset = shape.style.width / 2
      const { x, y, width, height } = shape.rect
      ctx.strokeRect(x + inset, y + inset, Math.max(0, width - 2 * inset), Math.max(0, height - 2 * inset))
      continue
    }
    const [first, ...rest] = shape.points
    if (!first || rest.length === 0) continue
    ctx.beginPath()
    ctx.moveTo(first.x, first.y)
    for (const p of rest) ctx.lineTo(p.x, p.y)
    ctx.stroke()
  }
}
