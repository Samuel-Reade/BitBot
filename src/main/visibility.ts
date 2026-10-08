// Whether the pet is shown (BITBOT_SPEC.md §8.6 fullscreen and hiding, §15.4 "hide in fullscreen"). Pure: BitbotApp
// feeds it the facts and acts on the changes it returns (unit-tested in test/visibility.test.ts).
//
// The pet is shown only while nothing hides it. The reasons are kept separately, so each one ends on its own:
//   user        the user hid it (⌥⌘B, the tray, the pet's menu). Instant, both ways (as since M1).
//   macHidden   macOS hides Bitbot (app.isHidden(), e.g. another app's Hide Others). Instant: macOS already hid the
//               windows.
//   fullscreen  the helper says a fullscreen app covers the pet's display, counted only while settings.hideInFullscreen
//               is on. Fades (tuning.overlay.fadeMs), both ways.
//   locked      the screen is locked (powerMonitor lock-screen … unlock-screen). Fades, both ways.
// A change is reported only when the outcome changes (shown ↔ hidden), with fade from the reason that changed it:
// unlocking while the user had hidden the pet changes nothing (it stays hidden, no message); turning on hide in
// fullscreen while a fullscreen app is in front fades it out; the user's hide while fullscreen already hid it
// changes nothing visible either (it stays hidden afterwards).
//
// The user's choice is about the user's wish only: userShown (no user or macOS hide) is what the tray item ("Hide
// Bitbot" / "Show Bitbot") shows and what ⌥⌘B toggles. Decision: "Show Bitbot" while a fullscreen app is in front
// (hide in fullscreen on) clears the user's hide but does not show the pet over the fullscreen app: it fades in when
// the fullscreen app goes, as it would have had the user never hidden it. (macOS keeps the overlay, a normal window,
// off fullscreen Spaces anyway: showing it there is not possible without making it a panel, docs/decisions/overlay.md.)
// §8.6 "The manual hide hotkey toggles visibility at any time": ⌥⌘B always flips the user's wish, also while fullscreen
// or locked, so it never gets stuck on a pet that some other reason hides.

/** Why the pet is not shown. */
export type HideReason = 'user' | 'macHidden' | 'fullscreen' | 'locked'

/** In this order in reasons() (logs, the dev panel). */
export const HIDE_REASONS: readonly HideReason[] = ['user', 'macHidden', 'fullscreen', 'locked']

/** Reasons whose hide and show fade (§8.6); the others are instant. */
const FADING: ReadonlySet<HideReason> = new Set<HideReason>(['fullscreen', 'locked'])

/** The outcome changed: show or hide the pet, with or without the fade. */
export interface VisibilityChange {
  shown: boolean
  fade: boolean
}

export class PetVisibility {
  private readonly facts: Record<HideReason, boolean> = { user: false, macHidden: false, fullscreen: false, locked: false }
  private hideInFullscreen: boolean

  constructor(options: { hideInFullscreen: boolean }) {
    this.hideInFullscreen = options.hideInFullscreen
  }

  /** Nothing hides the pet: draw it, run the 30 Hz simulation, take window snapshots, allow the grab area. */
  get shown(): boolean {
    return HIDE_REASONS.every((r) => !this.has(r))
  }

  /** Neither the user nor macOS hides it: the tray says "Hide Bitbot", ⌥⌘B hides. (Fullscreen and lock don't count.) */
  get userShown(): boolean {
    return !this.facts.user && !this.facts.macHidden
  }

  /** The reason hides the pet now (fullscreen only while hide in fullscreen is on). */
  has(reason: HideReason): boolean {
    if (reason === 'fullscreen') return this.facts.fullscreen && this.hideInFullscreen
    return this.facts[reason]
  }

  /** The reasons that hide it now, in HIDE_REASONS order (empty: shown). */
  reasons(): HideReason[] {
    return HIDE_REASONS.filter((r) => this.has(r))
  }

  /**
   * A fact changed: the user hid / showed it, macOS hid / showed Bitbot, a fullscreen app came / went (the raw helper
   * fact, whatever the setting), the screen locked / unlocked. Returns the change, or null when the outcome is the same.
   */
  set(reason: HideReason, on: boolean): VisibilityChange | null {
    const before = this.shown
    this.facts[reason] = on
    return this.changed(before, FADING.has(reason))
  }

  /** The settings toggle (§15.4 "hide in fullscreen"), live: a fullscreen app in front fades the pet out or in. */
  setHideInFullscreen(on: boolean): VisibilityChange | null {
    const before = this.shown
    this.hideInFullscreen = on
    return this.changed(before, true)
  }

  private changed(before: boolean, fade: boolean): VisibilityChange | null {
    const shown = this.shown
    return shown === before ? null : { shown, fade }
  }
}
