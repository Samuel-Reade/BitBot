// The grab area (hit window; docs/decisions/overlay.md "Decision"): the small invisible panel main shows over the pet
// while the cursor is near it. The overlay page opens it with window.open, so it lives in this renderer process, its
// document is an empty about:blank page in this page's origin, and this page handles its mouse events directly
// (OverlayModel decides).
//
// Its document paints nothing (transparent, no content), selects and drags nothing and shows no menu of its own: it
// only reports mouse events, in global pt (screenX/screenY), with times converted to this page's performance.now()
// clock. Moves come twice where the browser has pointerrawupdate (Chromium does, in secure contexts: file: pages and
// the dev server are): raw, as soon as they arrive, and as the usual mousemove, which is dispatched with the grab
// area's own next frame. OverlayModel drives a press from the raw ones (one frame less drag lag) and hover from the
// others (at most one hit test per frame).

import { HIT_WINDOW_URL } from '../../shared/petProtocol'
import type { GrabMouseEvent } from './placement'

export interface GrabAreaHandlers {
  /** mousemove (dispatched with the grab area's frames). */
  move(e: GrabMouseEvent): void
  /** pointerrawupdate (dispatched as soon as the move arrives), where supported. */
  rawMove(e: GrabMouseEvent): void
  down(e: GrabMouseEvent): void
  up(e: GrabMouseEvent): void
  contextmenu(e: GrabMouseEvent): void
  /** The cursor left the grab area's document. */
  leave(): void
}

export interface GrabArea {
  /** Detaches the listeners and closes the window (page unload). */
  close(): void
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Opens the grab area under `name` (main allows exactly this page load's name), styles its document and attaches
 * `handlers`. Null if it did not open or its document cannot be scripted: then main never gets a hover and the
 * grab area stays click-through (the pet just can't be grabbed).
 */
export function openGrabArea(name: string, handlers: GrabAreaHandlers, onError: (message: string) => void): GrabArea | null {
  let child: Window | null
  try {
    child = window.open(HIT_WINDOW_URL, name)
  } catch (err) {
    onError(`grab area: window.open failed: ${errorText(err)}`)
    return null
  }
  if (!child) {
    onError('grab area: window.open returned no window; the pet cannot be grabbed')
    return null
  }
  const win = child
  try {
    styleGrabDocument(win.document)
    const detach = attachListeners(win, handlers, onError)
    return {
      close() {
        detach()
        closeQuietly(win)
      },
    }
  } catch (err) {
    onError(`grab area: its document is not scriptable: ${errorText(err)}`)
    closeQuietly(win)
    return null
  }
}

/** Transparent, margin 0, body filling the window, no selection, the arrow cursor. */
function styleGrabDocument(doc: Document): void {
  const root = doc.documentElement ?? doc.appendChild(doc.createElement('html'))
  const body = doc.body ?? root.appendChild(doc.createElement('body'))
  const css =
    'margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;' +
    'user-select:none;-webkit-user-select:none;cursor:default'
  root.style.cssText = css
  body.style.cssText = css
}

function attachListeners(win: Window, handlers: GrabAreaHandlers, onError: (message: string) => void): () => void {
  const doc = win.document
  // Event.timeStamp counts from the grab area's own time origin, not this page's.
  const clockShift = win.performance.timeOrigin - performance.timeOrigin
  const read = (e: MouseEvent): GrabMouseEvent => ({
    screenX: e.screenX,
    screenY: e.screenY,
    button: e.button,
    buttons: e.buttons,
    ctrlKey: e.ctrlKey,
    time: e.timeStamp + clockShift,
  })
  const guarded =
    <E extends Event>(fn: (e: E) => void) =>
    (e: E): void => {
      try {
        fn(e)
      } catch (err) {
        onError(`grab area handler failed: ${errorText(err)}`)
      }
    }
  const onMove = guarded((e: MouseEvent) => handlers.move(read(e)))
  // A PointerEvent (a MouseEvent) from the grab area's realm; the DOM typings call it an Event.
  const onRawMove = guarded((e: Event) => handlers.rawMove(read(e as MouseEvent)))
  const raw = 'onpointerrawupdate' in win
  const onDown = guarded((e: MouseEvent) => {
    // A primary press does nothing here but grab the pet (no selection, drag or focus change). Right and control
    // clicks keep their default: it is what produces the contextmenu event.
    if (e.button === 0 && !e.ctrlKey) e.preventDefault()
    handlers.down(read(e))
  })
  const onUp = guarded((e: MouseEvent) => handlers.up(read(e)))
  const onContextMenu = guarded((e: MouseEvent) => {
    e.preventDefault() // never Chromium's own menu; main pops the pet menu
    handlers.contextmenu(read(e))
  })
  const onLeave = guarded(() => handlers.leave())
  const prevent = (e: Event): void => e.preventDefault()

  const root = doc.documentElement
  doc.addEventListener('mousemove', onMove, { passive: true })
  if (raw) doc.addEventListener('pointerrawupdate', onRawMove, { passive: true })
  doc.addEventListener('mousedown', onDown)
  doc.addEventListener('mouseup', onUp)
  doc.addEventListener('contextmenu', onContextMenu)
  doc.addEventListener('dragstart', prevent)
  doc.addEventListener('selectstart', prevent)
  root.addEventListener('mouseleave', onLeave)
  return () => {
    doc.removeEventListener('mousemove', onMove)
    if (raw) doc.removeEventListener('pointerrawupdate', onRawMove)
    doc.removeEventListener('mousedown', onDown)
    doc.removeEventListener('mouseup', onUp)
    doc.removeEventListener('contextmenu', onContextMenu)
    doc.removeEventListener('dragstart', prevent)
    doc.removeEventListener('selectstart', prevent)
    root.removeEventListener('mouseleave', onLeave)
  }
}

function closeQuietly(win: Window): void {
  try {
    win.close()
  } catch {
    // Already gone.
  }
}
