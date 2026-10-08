// The developer panel's Life section and the mood / dust / time-scale controls, the pure part (BITBOT_SPEC.md §14.1
// "live view: needs, mood, current state…", "time scale slider (1×, 10×, 60×, 600×)", "force mood"): validating the
// life in a debug:panel-status, the text of the need bars, status lines and goal-score table, what mood and dust are
// in effect (forced or the needs' own), and the time scale choices. No DOM: the page (./main.ts) puts these in place.

import type { DevOverrides } from '../../shared/devPanel'
import {
  BRAIN_ACTIVITIES,
  GOAL_KINDS,
  isTimeScale,
  NEEDS,
  TIME_SCALES,
  type GoalKind,
  type LifeSnapshot,
  type Need,
  type TimeScale,
} from '../../shared/life'
import { tuning } from '../../shared/tuning'
import { isMood } from '../../shared/types'
import { formatNumber, NONE } from './economyView'

const D = tuning.dev.panel.life.decimals

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

/** DevPanelStatus.life when not null: every need 0..100, every goal scored (or no scores yet), sane fields. */
export function isLifeSnapshot(value: unknown): value is LifeSnapshot {
  if (!isRecord(value)) return false
  const { needs, scores, activity, goal, continuousActiveMin } = value
  return (
    isRecord(needs) &&
    NEEDS.every((n) => isLevel(needs[n])) &&
    isMood(value['mood']) &&
    typeof value['stuffed'] === 'boolean' &&
    typeof value['asleep'] === 'boolean' &&
    (activity === null || isOneOf(BRAIN_ACTIVITIES, activity)) &&
    (goal === null || isOneOf(GOAL_KINDS, goal)) &&
    (scores === null || (isRecord(scores) && GOAL_KINDS.every((g) => typeof scores[g] === 'number' && Number.isFinite(scores[g])))) &&
    typeof continuousActiveMin === 'number' &&
    Number.isFinite(continuousActiveMin) &&
    continuousActiveMin >= 0 &&
    isTimeScale(value['timeScale'])
  )
}

export interface NeedBar {
  need: Need
  /** The bar's fill, 0..100; 0 before the pet exists. */
  value: number
  /** The number beside it; NONE before the pet exists. */
  text: string
}

/** One bar per need in NEEDS order. */
export function needBars(life: LifeSnapshot | null): NeedBar[] {
  return NEEDS.map((need) => {
    if (!life) return { need, value: 0, text: NONE }
    const value = life.needs[need]
    return { need, value, text: formatNumber(value, D.need) }
  })
}

/** The status lines under the bars; NONE everywhere before the pet exists. */
export interface LifeDetails {
  mood: string
  stuffed: string
  asleep: string
  /** What the brain has it doing in place ("—": nothing). */
  activity: string
  goal: string
  continuous: string
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')

export function lifeDetails(life: LifeSnapshot | null): LifeDetails {
  if (!life) return { mood: NONE, stuffed: NONE, asleep: NONE, activity: NONE, goal: NONE, continuous: NONE }
  return {
    mood: life.mood,
    stuffed: yesNo(life.stuffed),
    asleep: yesNo(life.asleep),
    activity: life.activity ?? NONE,
    goal: life.goal ?? NONE,
    continuous: `${formatNumber(life.continuousActiveMin, D.continuousMin)} min`,
  }
}

export interface ScoreRow {
  goal: GoalKind
  score: string
  /** The goal the brain chose last (the page marks the row). */
  chosen: boolean
}

/** The goal-score table, one row per goal in GOAL_KINDS order; NONE before the first decision. */
export function scoreRows(life: LifeSnapshot | null): ScoreRow[] {
  return GOAL_KINDS.map((goal) => ({
    goal,
    score: life?.scores ? formatNumber(life.scores[goal], D.score) : NONE,
    chosen: life?.goal === goal,
  }))
}

/** The mood the pet shows: the forced one, else the needs' own (NONE before the pet exists). */
export function moodInEffect(overrides: DevOverrides, life: LifeSnapshot | null): string {
  if (overrides.mood !== null) return `${overrides.mood} (forced)`
  return life ? `${life.mood} (needs)` : NONE
}

/** The dust the pet shows, 0..1 as the slider: the forced level, else the needs' dust (NONE before the pet exists). */
export function dustInEffect(overrides: DevOverrides, life: LifeSnapshot | null): string {
  if (overrides.dust !== null) return `${formatNumber(overrides.dust, D.dust)} (forced)`
  return life ? `${formatNumber(life.needs.dust / 100, D.dust)} (needs)` : NONE
}

/** The time scale choices: radio value and label ("60×"). */
export const TIME_SCALE_CHOICES: readonly (readonly [string, string])[] = TIME_SCALES.map((s) => [String(s), `${s}×`] as const)

/** A time scale radio's value back to a scale; null for anything else. */
export function timeScaleFrom(value: string): TimeScale | null {
  const scale = Number(value)
  return isTimeScale(scale) ? scale : null
}
