// The onboarding step machine (BITBOT_SPEC.md §15.1): welcome → privacy → permission → identity ("Name & color") →
// hatch. Pure and time-driven: every method takes the time (ms, any monotonic clock) and says whether the view
// changed. Main runs one per onboarding window (src/main/windows/onboardingWindow.ts), feeds it the grant every
// tuning.onboarding.permissionPollMs while on the permission step (grant() then tick()), and pushes the view.
//
// Rules:
// - Next moves on from welcome and privacy; from the permission step only once Input Monitoring is granted (otherwise
//   "Skip for now", §7.1 degraded mode). Name & color moves on only by hatch() with a valid name and palette (the
//   caller validates). Back exists on privacy, permission and identity; hatch has no way back.
// - Auto-advance: when the grant turns on while the permission step is shown, the step shows it ("Input Monitoring is
//   on") for grantedAdvanceMs, then moves on to Name & color by itself. Arriving at the permission step already granted
//   (e.g. Back from Name & color, or a relaunch) does not bounce forward: the step shows Continue instead.
// - Relaunch: macOS may need Bitbot restarted before a new grant takes effect (the tap only starts in a fresh
//   process). "Relaunch Bitbot" is offered on the permission step once "Allow Input Monitoring" was pressed and
//   relaunchHintMs went by without the grant being seen; it then stays offered (that session) until the grant shows.
//   relaunchHintMs is longer than the app's own grant re-check (tuning.app.inputAccessPollS), so a grant that works
//   without a relaunch is seen before the button appears.
// - finish() is accepted once, on the hatch step, and returns the chosen name and palette.

import type { OnboardingHatch, OnboardingStep, OnboardingView } from './onboarding'

export interface OnboardingFlowParams {
  /** "Allow" pressed this long ago and still not granted: offer "Relaunch Bitbot", ms. */
  relaunchHintMs: number
  /** The grant was seen on the permission step this long ago: move on to Name & color, ms. */
  grantedAdvanceMs: number
}

/** Where a window may start: the beginning, or (after "Relaunch Bitbot") back at the permission step. */
export type OnboardingStart = 'welcome' | 'permission'

const BACK: Partial<Record<OnboardingStep, OnboardingStep>> = { privacy: 'welcome', permission: 'privacy', identity: 'permission' }

export class OnboardingFlow {
  private stepNow: OnboardingStep
  private granted: boolean
  /** When "Allow Input Monitoring" was first pressed (null: not yet). */
  private requestedAt: number | null = null
  /** When the grant turned on while the permission step was shown (null: no auto-advance pending). */
  private grantedAt: number | null = null
  private relaunchOffered = false
  private hatching: OnboardingHatch | null = null
  private finished = false

  constructor(
    private readonly params: OnboardingFlowParams,
    granted: boolean,
    start: OnboardingStart = 'welcome',
  ) {
    this.stepNow = start
    this.granted = granted
  }

  get step(): OnboardingStep {
    return this.stepNow
  }

  get isFinished(): boolean {
    return this.finished
  }

  /** The name and palette chosen at hatch (null before). */
  get chosen(): OnboardingHatch | null {
    return this.hatching ? { ...this.hatching } : null
  }

  get view(): OnboardingView {
    const step = this.stepNow
    return {
      step,
      granted: this.granted,
      requested: this.requestedAt !== null,
      showRelaunch: this.relaunchShown,
      canBack: BACK[step] !== undefined,
      canSkip: step === 'permission' && !this.granted,
      hatching: this.hatching ? { ...this.hatching } : null,
    }
  }

  /** "Relaunch Bitbot" is on offer now (the only time the request is honoured). */
  get relaunchShown(): boolean {
    return this.stepNow === 'permission' && !this.granted && this.relaunchOffered
  }

  next(): boolean {
    switch (this.stepNow) {
      case 'welcome':
        return this.go('privacy')
      case 'privacy':
        return this.go('permission')
      case 'permission':
        return this.granted ? this.go('identity') : false
      default:
        return false
    }
  }

  back(): boolean {
    const to = BACK[this.stepNow]
    return to !== undefined && this.go(to)
  }

  /** "Allow Input Monitoring" pressed: true if the caller should ask macOS and open System Settings. */
  requestAccess(now: number): boolean {
    if (this.stepNow !== 'permission' || this.granted) return false
    this.requestedAt ??= now
    return true
  }

  /** "Skip for now". */
  skip(): boolean {
    return this.stepNow === 'permission' && !this.granted && this.go('identity')
  }

  /** The grant as main sees it now (polled). True if the view changed. */
  grant(granted: boolean, now: number): boolean {
    if (granted === this.granted) return false
    this.granted = granted
    this.grantedAt = granted && this.stepNow === 'permission' ? now : null
    return true
  }

  /** The grant as it is on arriving at the permission step (or on a page reload): never starts an auto-advance. */
  setGranted(granted: boolean): boolean {
    if (granted === this.granted) return false
    this.granted = granted
    this.grantedAt = null
    return true
  }

  /** Time passes: the pending auto-advance, the relaunch offer. True if the view changed. */
  tick(now: number): boolean {
    if (this.stepNow !== 'permission') return false
    if (this.grantedAt !== null && now - this.grantedAt >= this.params.grantedAdvanceMs) return this.go('identity')
    if (!this.granted && !this.relaunchOffered && this.requestedAt !== null && now - this.requestedAt >= this.params.relaunchHintMs) {
      this.relaunchOffered = true
      return true
    }
    return false
  }

  /** Name & color chosen (validated by the caller): the egg hatches. */
  hatch(chosen: OnboardingHatch): boolean {
    if (this.stepNow !== 'identity') return false
    this.hatching = { ...chosen }
    return this.go('hatch')
  }

  /** The hatch is over (or the window closed during it): the chosen name and palette, once; null otherwise. */
  finish(): OnboardingHatch | null {
    if (this.stepNow !== 'hatch' || this.finished || !this.hatching) return null
    this.finished = true
    return { ...this.hatching }
  }

  private go(step: OnboardingStep): boolean {
    if (step === this.stepNow) return false
    this.stepNow = step
    this.grantedAt = null
    return true
  }
}
