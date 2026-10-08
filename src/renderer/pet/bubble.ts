// The speech bubble on the overlay page (BITBOT_SPEC.md §9.4 daily summary): an HTML element over the pet's canvas,
// warm and readable (the system font, light and dark aware), with a tail pointing at the pet. It pops in and fades
// out (opacity only with prefers-reduced-motion). It takes no input itself: the overlay window ignores the mouse (§2);
// clicks reach it through the grab area, which OverlayModel hit-tests against bubbleLayout (placement.ts).
//
// overlay.ts calls show() on pet:bubble (it measures the text, so main and OverlayModel can lay it out), place() in
// every frame with OverlayModel.bubbleLayout (moved only when that changed: a compositor transform), and hide() when
// main takes it down. All sizes and colours are tuning.ui.bubble's (the stylesheet: bubbleStyle.ts).

import type { BubbleLayout, BubbleSize } from '../../shared/bubbleLayout'
import type { Rect } from '../../shared/geometry'
import { tuning } from '../../shared/tuning'
import { bubbleCss, bubbleTransform } from './bubbleStyle'

export interface Bubble {
  /** Shows bubble `id` saying `text` (replacing any other) and returns its measured size, pt (whole points). */
  show(id: number, text: string): BubbleSize
  /** Moves the bubble to `layout` (global pt) inside the overlay at `overlay`; null keeps it where it is. */
  place(layout: BubbleLayout | null, overlay: Rect | null, devicePixelRatio: number): void
  /** Fades bubble `id` out and removes it (another id: nothing). */
  hide(id: number): void
}

export function createBubble(doc: Document): Bubble {
  let style: HTMLStyleElement | null = null
  let current: { id: number; root: HTMLDivElement; body: HTMLDivElement; key: string } | null = null

  return {
    show(id, text) {
      if (!style) {
        style = doc.createElement('style')
        style.textContent = bubbleCss()
        doc.head.append(style)
      }
      current?.root.remove()
      const root = doc.createElement('div')
      root.className = 'bitbot-bubble'
      root.style.visibility = 'hidden' // until place() puts it somewhere
      const body = doc.createElement('div')
      body.className = 'bitbot-bubble-body'
      body.textContent = text // never HTML
      const tail = doc.createElement('div')
      tail.className = 'bitbot-bubble-tail'
      body.append(tail)
      root.append(body)
      doc.body.append(root)
      // Measured before any scale: offsetWidth/Height ignore transforms anyway.
      const size = { width: Math.max(1, Math.ceil(body.offsetWidth)), height: Math.max(1, Math.ceil(body.offsetHeight)) }
      current = { id, root, body, key: '' }
      return size
    },

    place(layout, overlay, devicePixelRatio) {
      const c = current
      if (!c || !layout || !overlay || c.root.classList.contains('out')) return
      const transform = bubbleTransform(layout, overlay, devicePixelRatio)
      const key = `${transform}|${layout.below}|${layout.tailX}`
      if (key === c.key) return
      const first = c.key === ''
      c.key = key
      c.root.style.transform = transform
      c.root.classList.toggle('below', layout.below)
      c.root.style.setProperty('--bb-tail-x', `${layout.tailX}px`)
      // It pops out of its tail.
      c.body.style.transformOrigin = `${layout.tailX}px ${layout.below ? 0 : layout.rect.height}px`
      if (first) {
        c.root.style.visibility = 'visible'
        void c.body.offsetWidth // start the transition from the hidden style
        c.root.classList.add('in')
      }
    },

    hide(id) {
      const c = current
      if (!c || c.id !== id) return
      current = null
      if (c.key === '') {
        c.root.remove() // never placed, never seen
        return
      }
      c.root.classList.remove('in')
      c.root.classList.add('out')
      // A timer rather than transitionend: the page may be hidden (no transitions run), and it must go either way.
      setTimeout(() => c.root.remove(), tuning.ui.bubble.popOutMs + tuning.ui.bubble.removeAfterFadeMs)
    },
  }
}
