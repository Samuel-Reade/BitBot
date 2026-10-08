// The speech bubble's stylesheet and position (BITBOT_SPEC.md §9.4), pure so the tests run them in Node; bubble.ts
// puts them on the overlay page. Every size, colour and duration is tuning.ui.bubble's. Nothing is loaded from
// anywhere (§2): the system font, inline CSS.

import type { BubbleLayout } from '../../shared/bubbleLayout'
import type { Rect } from '../../shared/geometry'
import { tuning } from '../../shared/tuning'

const B = tuning.ui.bubble

/** The page's stylesheet for the bubble (one <style>, added on the first show). */
export function bubbleCss(): string {
  const tail = B.tailPt
  const side = Math.SQRT2 * tail // the tail is a square turned 45°, half of it outside the body
  return `
.bitbot-bubble { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 2; will-change: transform; }
.bitbot-bubble-body {
  position: relative; box-sizing: border-box; width: max-content; max-width: ${B.maxWidthPt}px;
  padding: ${B.paddingYPt}px ${B.paddingXPt}px; border-radius: ${B.cornerRadiusPt}px;
  font: ${B.fontSizePt}px/${B.lineHeight} -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  letter-spacing: 0.01em; overflow-wrap: break-word; cursor: default;
  -webkit-font-smoothing: antialiased;
  background: var(--bb-bg); color: var(--bb-text); border: 1px solid var(--bb-border);
  filter: drop-shadow(0 3px 8px var(--bb-shadow));
  opacity: 0; transform: scale(${B.popFromScale});
  transition: opacity ${B.popInMs}ms ease-out, transform ${B.popInMs}ms cubic-bezier(0.34, 1.45, 0.64, 1);
  --bb-bg: ${B.light.background}; --bb-text: ${B.light.text}; --bb-border: ${B.light.border}; --bb-shadow: ${B.light.shadow};
}
@media (prefers-color-scheme: dark) {
  .bitbot-bubble-body {
    --bb-bg: ${B.dark.background}; --bb-text: ${B.dark.text}; --bb-border: ${B.dark.border}; --bb-shadow: ${B.dark.shadow};
  }
}
.bitbot-bubble-tail {
  position: absolute; width: ${side}px; height: ${side}px; box-sizing: border-box;
  background: var(--bb-bg); border: 1px solid var(--bb-border);
  left: calc(var(--bb-tail-x) - ${side / 2}px); bottom: ${-side / 2}px;
  transform: rotate(45deg); border-left-color: transparent; border-top-color: transparent;
}
.bitbot-bubble.below .bitbot-bubble-tail {
  bottom: auto; top: ${-side / 2}px; border: 1px solid var(--bb-border);
  border-right-color: transparent; border-bottom-color: transparent;
}
.bitbot-bubble.in .bitbot-bubble-body { opacity: 1; transform: scale(1); }
.bitbot-bubble.out .bitbot-bubble-body {
  opacity: 0; transform: scale(${(1 + B.popFromScale) / 2});
  transition: opacity ${B.popOutMs}ms ease-in, transform ${B.popOutMs}ms ease-in;
}
@media (prefers-reduced-motion: reduce) {
  .bitbot-bubble-body, .bitbot-bubble.in .bitbot-bubble-body, .bitbot-bubble.out .bitbot-bubble-body { transform: none; }
}
`
}

/** The bubble's position on the device-pixel grid (overlay-local CSS px), so its text stays sharp. */
export function bubbleTransform(layout: BubbleLayout, overlay: Rect, devicePixelRatio: number): string {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const x = Math.round((layout.rect.x - overlay.x) * dpr) / dpr + 0
  const y = Math.round((layout.rect.y - overlay.y) * dpr) / dpr + 0
  return `translate3d(${x}px, ${y}px, 0)`
}
