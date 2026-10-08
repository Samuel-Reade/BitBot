// The onboarding page's pure parts (BITBOT_SPEC.md §15.1; the page is ./main.ts): the name field's live validation and
// the hatch animation's timeline (what the egg and the pet do t seconds into the hatch). No DOM, no three.js: unit-tested
// in test/onboarding.test.ts.

import { cleanPetName, PET_NAME_MAX } from '../../shared/settings'
import { tuning } from '../../shared/tuning'

export interface NameStatus {
  /** The name to send (cleaned), or null while it is not valid. */
  name: string | null
  /** Characters used, as cleanPetName counts them (code points after trimming). */
  length: number
  /** What to tell the user (null: nothing wrong). */
  error: string | null
}

/** The name field as typed → what the page shows under it and whether Hatch is allowed. */
export function nameStatus(value: string): NameStatus {
  // eslint-disable-next-line no-control-regex
  const length = [...value.replace(/[\u0000-\u001f\u007f]/g, '').trim()].length
  const name = cleanPetName(value)
  if (name !== null) return { name, length, error: null }
  return { name: null, length, error: length === 0 ? 'Your Bitbot needs a name.' : `Up to ${PET_NAME_MAX} characters, please.` }
}

type HatchTuning = typeof tuning.onboarding.hatch

/** What the hatch shows at one moment. */
export interface HatchFrame {
  /** Egg wobble intensity (tuning.onboarding.wobble.amplitude units), 0 = still. */
  wobble: number
  /** Egg.crack() progress 0..1. */
  crack: number
  eggOpacity: number
  /** The pet is shown (from the pop on). */
  petVisible: boolean
  /** The pet's scale (it grows out of the egg) and how high it hops, scene units. */
  petScale: number
  petHop: number
  /** The page shows its hello (from the end of the pop). */
  hello: boolean
  /** The hatch is over: say goodbye (onboarding:finish). */
  done: boolean
}

/** The hatch's phases end at these times, s. */
export function hatchSchedule(reducedMotion: boolean, h: HatchTuning = tuning.onboarding.hatch): { wobbleEnd: number; crackEnd: number; popEnd: number; end: number } {
  const wobbleEnd = reducedMotion ? 0 : h.wobbleS
  const crackEnd = wobbleEnd + (reducedMotion ? h.reducedCrackS : h.crackS)
  const popEnd = crackEnd + (reducedMotion ? 0 : h.popS)
  return { wobbleEnd, crackEnd, popEnd, end: popEnd + (reducedMotion ? h.reducedHoldS : h.holdS) }
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const smooth = (x: number): number => x * x * (3 - 2 * x)
/** Overshoots a little before settling at 1 (the pet pops out): the standard ease-out-back curve and its constant. */
const easeOutBack = (x: number): number => {
  const c = 1.70158
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2
}

/**
 * The hatch t seconds in. Normally: the wobble grows; the crack draws round the seam (with a dying wobble); the shell
 * parts and fades, and the pet grows out of it with a hop; it celebrates while the page says hello; done. Reduced
 * motion: no wobble, no hop; the crack draws and the shell parts and fades in one short phase, the pet simply appears.
 */
export function hatchFrame(t: number, reducedMotion: boolean, h: HatchTuning = tuning.onboarding.hatch, crackDrawUntil: number = tuning.onboarding.egg.crack.drawUntil): HatchFrame {
  const s = hatchSchedule(reducedMotion, h)
  const time = Number.isFinite(t) ? Math.max(0, t) : 0
  const frame: HatchFrame = { wobble: 0, crack: 0, eggOpacity: 1, petVisible: false, petScale: 1, petHop: 0, hello: false, done: time >= s.end }

  if (reducedMotion) {
    const u = clamp01((time - s.wobbleEnd) / Math.max(1e-6, s.crackEnd - s.wobbleEnd))
    frame.crack = u
    frame.eggOpacity = 1 - smooth(clamp01((u - crackDrawUntil) / (1 - crackDrawUntil)))
    frame.petVisible = u >= 1
    frame.hello = u >= 1
    return frame
  }

  if (time < s.wobbleEnd) {
    frame.wobble = h.maxIntensity * smooth(time / s.wobbleEnd)
    return frame
  }
  if (time < s.crackEnd) {
    const u = (time - s.wobbleEnd) / (s.crackEnd - s.wobbleEnd)
    frame.wobble = h.maxIntensity * h.crackWobble * (1 - u)
    frame.crack = crackDrawUntil * u
    return frame
  }
  const u = clamp01((time - s.crackEnd) / Math.max(1e-6, s.popEnd - s.crackEnd))
  frame.crack = crackDrawUntil + (1 - crackDrawUntil) * clamp01(u / h.partShare)
  frame.eggOpacity = 1 - smooth(clamp01((u - h.fadeFrom) / Math.max(1e-6, h.fadeUntil - h.fadeFrom)))
  const grow = clamp01((u - h.growFrom) / Math.max(1e-6, 1 - h.growFrom))
  frame.petVisible = u >= h.growFrom
  frame.petScale = h.popFrom + (1 - h.popFrom) * easeOutBack(grow)
  frame.petHop = h.popHop * Math.sin(Math.PI * grow)
  frame.hello = u >= 1
  return frame
}
