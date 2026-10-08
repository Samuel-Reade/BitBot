// The behavior state machine (BITBOT_SPEC.md §10.1): which BehaviorState the pet shows, from what locomotion is doing,
// what the brain has it doing in place, and the developer panel's forced state. Pure.
//
// Interruption priorities (§10.1 "Held > Fall > Land > Greet > Eat > (everything else)"), highest first:
//   held, fall, land          locomotion's involuntary states: the user has it, it is falling, it is landing;
//   greet, eat                the brain's two activities that beat moving (an app launch's treat, welcome back);
//   walk, run, climb, jump    locomotion moving (a goal being walked);
//   sit, sleep, peek, celebrate  the brain's other in-place activities;
//   forced                    the dev panel's state picker, only when the pet would otherwise be idle;
//   idle.
// Locomotion and the brain execute; this only picks what is shown (pet:state's state).
//
// Modes (§10.3, M7) don't change these priorities (a Stay pet still falls when its window goes, and is still held when
// grabbed); they constrain which goals the brain may choose (goalAllowed, used by brain.ts):
//   roam     every goal (M6);
//   stay     no movement goals: explore, climb, peek and approachCursor are refused; eat and nap happen in place, and
//            so does sleeping when the computer is idle (§10.3 "eats in place when food arrives, sleeps in place");
//   hangout  (M7) every goal, but movement targets kept within ~300 pt along connected surfaces of the spot, and sit /
//            nap / sleep at the spot; still runs to eat on an app launch, then returns. Until M7 it behaves as roam.

import type { BrainActivity, GoalKind } from '../../../shared/life'
import type { BehaviorState } from '../../../shared/types'
import type { LocomotionBehavior } from '../locomotion/locomotion'

/** §10.3 modes. M6 has only Roam; Stay's goal constraint is in place (goalAllowed), Hangout comes with M7. */
export const PET_MODES = ['roam', 'stay', 'hangout'] as const
export type PetMode = (typeof PET_MODES)[number]

/** Goals that move the pet somewhere for their own sake (eat and nap also move, but have an in-place form). */
export const MOVEMENT_GOALS: readonly GoalKind[] = ['explore', 'climb', 'peek', 'approachCursor']

/** May the brain choose `goal` in `mode`? */
export function goalAllowed(goal: GoalKind, mode: PetMode = 'roam'): boolean {
  if (mode === 'stay') return !MOVEMENT_GOALS.includes(goal)
  return true
}

/** May the brain walk the pet anywhere in `mode` (else eat, nap and sleep happen where it is)? */
export function mayMove(mode: PetMode = 'roam'): boolean {
  return mode !== 'stay'
}

export interface StateInput {
  behavior: LocomotionBehavior
  /** Brain.activity. */
  activity: BrainActivity | null
  /** The dev panel's forced state; null: none. */
  forced: BehaviorState | null
}

/** The state shown (see the file comment for the priorities). */
export function resolveState(input: StateInput): BehaviorState {
  const { behavior, activity, forced } = input
  if (behavior === 'held' || behavior === 'fall' || behavior === 'land') return behavior
  if (activity === 'greet' || activity === 'eat') return activity
  if (behavior !== 'idle') return behavior
  if (activity !== null) return activity
  return forced ?? 'idle'
}
