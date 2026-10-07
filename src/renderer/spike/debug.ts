// Spike B debug page (BITBOT_SPEC.md §12 Spike B "draw debug rectangles over windows"). Two roles,
// chosen by the ?role= query (see src/shared/spikeWindows.ts):
//   overlay  outlines every window of the newest helper snapshot over the real desktop so alignment can be
//            eyeballed on the Retina display: green solid = §8.2 eligible surface, grey dashed =
//            ineligible (label lists why), blue dashed = Electron display bounds, orange dashed = work area,
//            red = cursor crosshair. Outlines are drawn on the outermost point INSIDE each window's bounds.
//   probe    the small window the harness moves around: a magenta frame on its own bounds plus a caption.
// Main computes everything (eligibility, window-local coordinates); this page only draws.

import {
  SPIKE_WINDOWS_IPC,
  isDebugCursorMsg,
  isDebugProbeMsg,
  isDebugSceneMsg,
  isDebugStatusMsg,
  placeLabel,
  windowLabel,
  type DebugCursorMsg,
  type DebugDrawnMsg,
  type DebugPageRole,
  type DebugReadyMsg,
  type DebugRect,
  type DebugSceneMsg,
  type DebugWindowItem,
} from '../../shared/spikeWindows'
import { tuning } from '../../shared/tuning'

const O = tuning.spikeWindows.overlay

const COLORS = {
  eligible: '#22c55e',
  eligibleText: '#bbf7d0',
  ineligible: 'rgba(170, 170, 170, 0.95)',
  ineligibleText: '#e5e7eb',
  display: '#3b82f6',
  workArea: '#f59e0b',
  cursor: '#ef4444',
  labelBg: 'rgba(0, 0, 0, 0.72)',
  probe: '#ec4899',
  probeFill: 'rgba(236, 72, 153, 0.12)',
} as const

const FONT = `${O.labelFontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`

const role: DebugPageRole = new URLSearchParams(location.search).get('role') === 'probe' ? 'probe' : 'overlay'
if (role === 'probe') startProbe()
else startOverlay()

function sendReady(): void {
  const message: DebugReadyMsg = { role, dpr: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight }
  window.bitbot.send(SPIKE_WINDOWS_IPC.ready, message)
}

// ───────────────────────────── overlay ─────────────────────────────

function startOverlay(): void {
  const scene = makeLayer()
  const cursor = makeLayer()
  const hud = document.createElement('div')
  Object.assign(hud.style, {
    position: 'fixed',
    left: '8px',
    top: '44px',
    padding: '6px 8px',
    font: FONT,
    lineHeight: '1.45',
    color: '#f9fafb',
    background: 'rgba(15, 23, 42, 0.78)',
    borderRadius: '6px',
    whiteSpace: 'pre',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.append(scene.canvas, cursor.canvas, hud)

  let latestScene: DebugSceneMsg | null = null
  let latestCursor: DebugCursorMsg | null = null
  let sceneDirty = false
  let cursorDirty = false
  let frameRequested = false
  let readySent = false

  const schedule = (): void => {
    if (frameRequested) return
    frameRequested = true
    requestAnimationFrame(frame)
  }

  const frame = (): void => {
    frameRequested = false
    resizeLayer(scene)
    resizeLayer(cursor)
    if (sceneDirty && latestScene) {
      sceneDirty = false
      positionHud(hud, latestScene)
      drawScene(scene.ctx, latestScene, hudBox(hud))
      const drawn: DebugDrawnMsg = { seq: latestScene.seq }
      window.bitbot.send(SPIKE_WINDOWS_IPC.drawn, drawn)
    }
    if (cursorDirty && latestCursor) {
      cursorDirty = false
      drawCursor(cursor.ctx, latestCursor)
    }
    if (!readySent) {
      readySent = true
      sendReady()
    }
  }

  window.bitbot.on(SPIKE_WINDOWS_IPC.scene, (payload) => {
    if (!isDebugSceneMsg(payload)) return
    latestScene = payload
    sceneDirty = true
    schedule()
  })
  window.bitbot.on(SPIKE_WINDOWS_IPC.cursor, (payload) => {
    if (!isDebugCursorMsg(payload)) return
    latestCursor = payload
    cursorDirty = true
    schedule()
  })
  window.bitbot.on(SPIKE_WINDOWS_IPC.status, (payload) => {
    if (!isDebugStatusMsg(payload)) return
    hud.textContent = payload.lines.join('\n')
  })
  window.addEventListener('resize', () => {
    sceneDirty = latestScene !== null
    cursorDirty = latestCursor !== null
    schedule()
  })
  hud.textContent = 'Bitbot Spike B · waiting for the first helper snapshot…'
  schedule()
}

interface Layer {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

function makeLayer(): Layer {
  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none' } satisfies Partial<CSSStyleDeclaration>)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  return { canvas, ctx }
}

/** Backing store at devicePixelRatio (crisp on Retina); drawing coordinates stay in CSS px = pt. */
function resizeLayer(layer: Layer): void {
  const dpr = window.devicePixelRatio
  const width = Math.round(window.innerWidth * dpr)
  const height = Math.round(window.innerHeight * dpr)
  if (layer.canvas.width !== width || layer.canvas.height !== height) {
    layer.canvas.width = width
    layer.canvas.height = height
    layer.canvas.style.width = `${window.innerWidth}px`
    layer.canvas.style.height = `${window.innerHeight}px`
  }
  layer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function primaryWorkArea(scene: DebugSceneMsg): DebugRect {
  const primary = scene.displays.find((d) => d.primary) ?? scene.displays[0]
  return primary ? primary.workArea : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
}

function positionHud(hud: HTMLElement, scene: DebugSceneMsg): void {
  const area = primaryWorkArea(scene)
  hud.style.left = `${area.x + 8}px`
  hud.style.top = `${area.y + 8}px`
}

function hudBox(hud: HTMLElement): DebugRect {
  const r = hud.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

function drawScene(ctx: CanvasRenderingContext2D, scene: DebugSceneMsg, hud: DebugRect): void {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  ctx.font = FONT
  ctx.textBaseline = 'top'
  const placed: DebugRect[] = [hud]
  const area = primaryWorkArea(scene)

  // Back to front, so outlines of front windows end up on top.
  for (let i = scene.windows.length - 1; i >= 0; i--) {
    const item = scene.windows[i]
    if (item) drawWindow(ctx, item)
  }
  // Display bounds and work area last, so same-sized windows (the Dock's full-display window, this
  // overlay) cannot hide them.
  for (const display of scene.displays) {
    outline(ctx, display.bounds, COLORS.display, 1, true)
    outline(ctx, display.workArea, COLORS.workArea, 1, true)
  }
  for (const display of scene.displays) {
    const g = display.globalBounds
    const wa = display.globalWorkArea
    drawLabel(
      ctx,
      `display ${display.id}${display.primary ? ' (primary)' : ''} ${g.x},${g.y} ${g.w}×${g.h} @${display.scaleFactor}x · ` +
        `work area ${wa.x},${wa.y} ${wa.w}×${wa.h}`,
      { x: display.workArea.x + display.workArea.w, y: display.workArea.y + display.workArea.h },
      COLORS.workArea,
      placed,
      area,
      'bottom-right',
    )
  }
  // Labels front to back, so front windows get the best spots.
  for (const item of scene.windows) {
    if (!intersects(item.rect, area)) continue
    drawLabel(
      ctx,
      windowLabel(item),
      { x: Math.max(item.rect.x, area.x) + 2, y: Math.max(item.rect.y, area.y) + 2 },
      item.eligible ? COLORS.eligibleText : COLORS.ineligibleText,
      placed,
      area,
      'top-left',
    )
  }
}

function drawWindow(ctx: CanvasRenderingContext2D, item: DebugWindowItem): void {
  if (item.eligible) outline(ctx, item.rect, COLORS.eligible, O.eligibleLineWidth, false)
  else outline(ctx, item.rect, COLORS.ineligible, O.ineligibleLineWidth, true)
}

/** Strokes the outermost `lineWidth` points just inside `rect`. */
function outline(ctx: CanvasRenderingContext2D, rect: DebugRect, color: string, lineWidth: number, dashed: boolean): void {
  if (rect.w <= lineWidth || rect.h <= lineWidth) return
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.setLineDash(dashed ? [...O.dash] : [])
  const half = lineWidth / 2
  ctx.strokeRect(rect.x + half, rect.y + half, rect.w - lineWidth, rect.h - lineWidth)
  ctx.restore()
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  anchor: { x: number; y: number },
  color: string,
  placed: DebugRect[],
  area: DebugRect,
  corner: 'top-left' | 'bottom-right',
): void {
  const pad = O.labelPadPx
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2
  const h = O.labelFontPx + pad * 2
  const preferred = corner === 'top-left' ? anchor : { x: anchor.x - w - 2, y: anchor.y - h - 2 }
  const box = placeLabel(preferred, { w, h }, placed, area, O.maxLabelShifts)
  placed.push(box)
  ctx.fillStyle = COLORS.labelBg
  ctx.fillRect(box.x, box.y, box.w, box.h)
  ctx.fillStyle = color
  ctx.fillText(text, box.x + pad, box.y + pad)
}

function drawCursor(ctx: CanvasRenderingContext2D, cursor: DebugCursorMsg): void {
  const width = window.innerWidth
  const height = window.innerHeight
  const gap = O.crosshairGapPx
  ctx.clearRect(0, 0, width, height)
  ctx.save()
  ctx.strokeStyle = COLORS.cursor
  ctx.lineWidth = 1
  ctx.beginPath()
  // Integral coordinates: a 1 pt line at dpr 2 covers exactly two device pixels.
  const x = Math.round(cursor.x)
  const y = Math.round(cursor.y)
  ctx.moveTo(0, y)
  ctx.lineTo(x - gap, y)
  ctx.moveTo(x + gap, y)
  ctx.lineTo(width, y)
  ctx.moveTo(x, 0)
  ctx.lineTo(x, y - gap)
  ctx.moveTo(x, y + gap)
  ctx.lineTo(x, height)
  ctx.stroke()
  ctx.restore()
  ctx.font = FONT
  ctx.textBaseline = 'top'
  const text = `cursor ${cursor.gx},${cursor.gy}`
  const pad = O.labelPadPx
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2
  const h = O.labelFontPx + pad * 2
  const bx = Math.min(x + gap + 2, width - w)
  const by = Math.min(y + gap + 2, height - h)
  ctx.fillStyle = COLORS.labelBg
  ctx.fillRect(bx, by, w, h)
  ctx.fillStyle = COLORS.cursor
  ctx.fillText(text, bx + pad, by + pad)
}

function intersects(a: DebugRect, b: DebugRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

// ───────────────────────────── probe ─────────────────────────────

function startProbe(): void {
  Object.assign(document.body.style, {
    margin: '0',
    height: '100vh',
    boxSizing: 'border-box',
    border: `2px solid ${COLORS.probe}`,
    background: COLORS.probeFill,
  } satisfies Partial<CSSStyleDeclaration>)
  const caption = document.createElement('div')
  Object.assign(caption.style, {
    margin: '6px',
    padding: '3px 5px',
    font: FONT,
    color: '#fdf2f8',
    background: COLORS.labelBg,
    borderRadius: '4px',
    display: 'inline-block',
  } satisfies Partial<CSSStyleDeclaration>)
  caption.textContent = 'Bitbot coordinate probe'
  document.body.append(caption)
  window.bitbot.on(SPIKE_WINDOWS_IPC.probe, (payload) => {
    if (isDebugProbeMsg(payload)) caption.textContent = payload.text
  })
  requestAnimationFrame(() => sendReady())
}
