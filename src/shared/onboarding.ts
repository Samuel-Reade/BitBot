// First-launch onboarding (BITBOT_SPEC.md §15.1): the steps, the messages between the onboarding page
// (src/renderer/onboarding/) and its window (src/main/windows/onboardingWindow.ts), and their validators. Main owns the
// flow (./onboardingFlow.ts) and pushes an OnboardingView whenever it changes; the page is a view of it and sends
// requests, which main validates (everything from the page is untrusted: names go through cleanPetName, palettes
// through isPaletteId). Plain JSON, no Electron.
//
// Channels (names in ./ipc.ts, IPC.onboarding*):
//   onboarding:state           page → main (invoke)  the current OnboardingView (on load and after a reload)
//   onboarding:view            main → page           the view changed. Payload: OnboardingView
//   onboarding:nav             page → main           Next / Back. Payload: OnboardingNav
//   onboarding:request-access  page → main           "Allow Input Monitoring": ask macOS, open its System Settings pane
//   onboarding:skip-permission page → main           "Skip for now" on the permission step
//   onboarding:relaunch        page → main           "Relaunch Bitbot" (only honoured while the view offers it)
//   onboarding:hatch           page → main           name and colour chosen: the egg hatches. Payload: OnboardingHatch
//   onboarding:finish          page → main           the hatch animation is over: the pet comes out, the window closes

import { isPaletteId } from './palettes'
import { cleanPetName } from './settings'
import type { PaletteId } from './types'

/** The five steps, in order (§15.1). 'identity' is "Name & color". */
export const ONBOARDING_STEPS = ['welcome', 'privacy', 'permission', 'identity', 'hatch'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value)
}

/** What the page shows (main → page). */
export interface OnboardingView {
  step: OnboardingStep
  /** Input Monitoring is granted and keys are counted (the input tap runs). */
  granted: boolean
  /** "Allow Input Monitoring" was pressed at least once (the page then says what to do in System Settings). */
  requested: boolean
  /** Show "Relaunch Bitbot" (onboardingFlow.ts: the rule). */
  showRelaunch: boolean
  /** Show Back (steps 2–4). */
  canBack: boolean
  /** Show "Skip for now" (the permission step while not granted). */
  canSkip: boolean
  /** The name and palette chosen at hatch (null before the hatch step). */
  hatching: OnboardingHatch | null
}

export interface OnboardingNav {
  dir: 'next' | 'back'
}

export interface OnboardingHatch {
  name: string
  paletteId: PaletteId
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A valid onboarding:nav payload, or null. */
export function parseOnboardingNav(value: unknown): OnboardingNav | null {
  if (!isRecord(value)) return null
  const dir = value['dir']
  return dir === 'next' || dir === 'back' ? { dir } : null
}

/** A valid onboarding:hatch payload with the name cleaned (trimmed, control characters removed), or null. */
export function parseOnboardingHatch(value: unknown): OnboardingHatch | null {
  if (!isRecord(value)) return null
  const name = cleanPetName(value['name'])
  const paletteId = value['paletteId']
  if (name === null || !isPaletteId(paletteId)) return null
  return { name, paletteId }
}

/** The page's check of main's push (it renders only what passes). */
export function isOnboardingView(value: unknown): value is OnboardingView {
  if (!isRecord(value)) return false
  const hatching = value['hatching']
  return (
    isOnboardingStep(value['step']) &&
    typeof value['granted'] === 'boolean' &&
    typeof value['requested'] === 'boolean' &&
    typeof value['showRelaunch'] === 'boolean' &&
    typeof value['canBack'] === 'boolean' &&
    typeof value['canSkip'] === 'boolean' &&
    (hatching === null || (isRecord(hatching) && parseOnboardingHatch(hatching)?.name === hatching['name']))
  )
}

export function sameOnboardingView(a: OnboardingView, b: OnboardingView): boolean {
  return (
    a.step === b.step &&
    a.granted === b.granted &&
    a.requested === b.requested &&
    a.showRelaunch === b.showRelaunch &&
    a.canBack === b.canBack &&
    a.canSkip === b.canSkip &&
    a.hatching?.name === b.hatching?.name &&
    a.hatching?.paletteId === b.hatching?.paletteId
  )
}
