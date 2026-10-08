// The pet's inner life (§9 needs and mood, §10.1–§10.2 behavior): what main's needs model and brain decide, as the
// developer panel shows it (§14.1 "live view: needs, mood, current state…"). Pure.

import type { Mood } from './types'

/** §9.1, all 0..100. */
export const NEEDS = ['hunger', 'energy', 'fullness', 'boredom', 'dust'] as const
export type Need = (typeof NEEDS)[number]
export type NeedLevels = Record<Need, number>

/** §10.2 utility-AI goals. */
export const GOAL_KINDS = ['eat', 'nap', 'explore', 'climb', 'sit', 'peek', 'approachCursor', 'idle'] as const
export type GoalKind = (typeof GOAL_KINDS)[number]

/**
 * What the pet does in place once it got where it was going (§10.1 states that aren't movement). The state machine
 * shows it unless something with a higher priority is happening (held, fall, land; §10.1).
 */
export const BRAIN_ACTIVITIES = ['sit', 'sleep', 'eat', 'peek', 'greet', 'celebrate'] as const
export type BrainActivity = (typeof BRAIN_ACTIVITIES)[number]

/** §14.1 "Time scale slider (1×, 10×, 60×, 600×)": how fast the pet's life clock runs (needs, brain timers). */
export const TIME_SCALES = [1, 10, 60, 600] as const
export type TimeScale = (typeof TIME_SCALES)[number]

export function isTimeScale(value: unknown): value is TimeScale {
  return typeof value === 'number' && (TIME_SCALES as readonly number[]).includes(value)
}

/** The developer panel's live view of the pet's life. */
export interface LifeSnapshot {
  needs: NeedLevels
  /** The needs' own mood (§9.2), before any dev override. */
  mood: Mood
  /** §9.3: continuous activity over the limit, or fullness ≥ stuffedAt. */
  stuffed: boolean
  /** The computer is idle long enough (or asleep) that the pet sleeps (§9.3). */
  asleep: boolean
  /** What the brain has the pet doing in place; null: nothing (moving, or idling). */
  activity: BrainActivity | null
  /** The goal the brain chose last; null before the first. */
  goal: GoalKind | null
  /** The utility scores at the last decision (§10.2), for tuning; null before the first. */
  scores: Record<GoalKind, number> | null
  /** Minutes of continuous activity (§9.3 stuffed after 90 without a 5-minute break). */
  continuousActiveMin: number
  timeScale: TimeScale
}
