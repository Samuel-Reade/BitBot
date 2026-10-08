// The overlay page's show / hide fade (BITBOT_SPEC.md §8.6), pure: what pet:visible does to the page's opacity.
// overlay.ts applies it to document.body, so everything the page draws (the pet's canvas, and whatever else lives on
// the page, e.g. a speech bubble or the dev world view) fades together. The fade is a CSS opacity transition, run by
// the compositor: the page renders nothing for it (OverlayModel stops frames the moment the pet is hidden, so a fade
// out shows the last frame fading; a fade in runs while the first new frames render). Once it ends, nothing on the page
// changes and no frames are produced (§11: 0 fps while hidden).
//
// fade (fullscreen, the locked screen) takes tuning.overlay.fadeMs; no fade (the user's hide, macOS), or the user's
// "reduce motion" setting (prefers-reduced-motion), is instant. A fade interrupted by the opposite one turns around
// from the opacity it reached (CSS transitions reverse from their current value).

import { tuning } from '../../shared/tuning'

/** What to set on the page's root, in this order (the transition first, so it applies to this change). */
export interface FadeStyle {
  transition: string
  opacity: '0' | '1'
}

export function visibilityStyle(visible: boolean, fade: boolean, reducedMotion: boolean): FadeStyle {
  const animate = fade && !reducedMotion && tuning.overlay.fadeMs > 0
  return {
    transition: animate ? `opacity ${tuning.overlay.fadeMs}ms ${tuning.overlay.fadeEasing}` : 'none',
    opacity: visible ? '1' : '0',
  }
}
