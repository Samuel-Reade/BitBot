// Mood (BITBOT_SPEC.md §9.2): the most pressing need picks one; ties go by tuning.needs.moodPriority. Pure.
//
// A need presses once it is past its threshold: hungry (hunger ≥ hunger.hungryAt), sleepy (energy ≤ energy.sleepyAt),
// stuffed (fullness ≥ fullness.stuffedAt, or continuous activity ≥ stuffed.continuousMin, §9.3), lonely (dust ≥
// dust.lonelyAt), bored (boredom ≥ boredom.boredAt). "Most pressing" is how far past its threshold each one is, as a
// fraction of the room left beyond it (0 at the threshold, 1 at the end of the scale; continuous activity counts 1 at
// twice continuousMin), so hunger 62 doesn't outrank energy 3. Equal severities (all of them exactly at their
// thresholds, say) go by moodPriority, the earlier first. Nothing pressing: happy after an interaction within
// happyAfterInteractionMin, else content.

import type { NeedLevels } from '../../../shared/life'
import type { Mood } from '../../../shared/types'

export interface MoodParams {
  hunger: { hungryAt: number }
  energy: { sleepyAt: number }
  fullness: { stuffedAt: number }
  boredom: { boredAt: number }
  dust: { lonelyAt: number }
  stuffed: { continuousMin: number }
  moodPriority: readonly Mood[]
  happyAfterInteractionMin: number
}

export interface MoodInput {
  levels: NeedLevels
  /** Minutes of continuous activity (§9.3). */
  continuousActiveMin: number
  /** Life-clock seconds since the last interaction (pet, drag, command, app launch); null: none yet. */
  sinceInteractionS: number | null
}

/** The needs moods; happy and content are what is left when none of them presses. */
export type NeedMood = 'hungry' | 'sleepy' | 'stuffed' | 'lonely' | 'bored'

/** How far value is at or past `at` towards `end` (0 at the threshold, 1 at the end); null below the threshold. */
function past(value: number, at: number, end: number): number | null {
  const toward = end - at
  const over = toward >= 0 ? value - at : at - value
  if (!(over >= 0)) return null
  return Math.abs(toward) > 0 ? Math.min(1, over / Math.abs(toward)) : 1
}

/** §9.3 stuffed: fullness ≥ stuffedAt or continuous activity ≥ continuousMin. */
export function isStuffed(levels: NeedLevels, continuousActiveMin: number, params: MoodParams): boolean {
  return levels.fullness >= params.fullness.stuffedAt || continuousActiveMin >= params.stuffed.continuousMin
}

/** The severity (0..1) of each need that presses now; needs that don't press are absent. */
export function pressingNeeds(input: MoodInput, params: MoodParams): Partial<Record<NeedMood, number>> {
  const { levels } = input
  const out: Partial<Record<NeedMood, number>> = {}
  const put = (mood: NeedMood, severity: number | null): void => {
    if (severity !== null) out[mood] = Math.max(out[mood] ?? 0, severity)
  }
  put('hungry', past(levels.hunger, params.hunger.hungryAt, 100))
  put('sleepy', past(levels.energy, params.energy.sleepyAt, 0))
  put('stuffed', past(levels.fullness, params.fullness.stuffedAt, 100))
  const limit = params.stuffed.continuousMin
  put('stuffed', past(input.continuousActiveMin, limit, 2 * limit))
  put('lonely', past(levels.dust, params.dust.lonelyAt, 100))
  put('bored', past(levels.boredom, params.boredom.boredAt, 100))
  return out
}

/** §9.2: the mood for these needs. */
export function moodOf(input: MoodInput, params: MoodParams): Mood {
  const pressing = pressingNeeds(input, params)
  let best: NeedMood | null = null
  let bestSeverity = -1
  // moodPriority first (the earlier wins a tie), then any need it leaves out, in a fixed order.
  const order: readonly string[] = [...params.moodPriority, 'hungry', 'sleepy', 'stuffed', 'lonely', 'bored']
  for (const mood of order) {
    const severity = pressing[mood as NeedMood]
    if (severity !== undefined && severity > bestSeverity) {
      best = mood as NeedMood
      bestSeverity = severity
    }
  }
  if (best !== null) return best
  const since = input.sinceInteractionS
  return since !== null && since >= 0 && since <= params.happyAfterInteractionMin * 60 ? 'happy' : 'content'
}
