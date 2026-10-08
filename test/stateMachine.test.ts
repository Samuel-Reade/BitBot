import { describe, expect, it } from 'vitest'
import { goalAllowed, mayMove, MOVEMENT_GOALS, PET_MODES, resolveState } from '../src/main/sim/brain/stateMachine'
import type { LocomotionBehavior } from '../src/main/sim/locomotion/locomotion'
import { BRAIN_ACTIVITIES, GOAL_KINDS, type BrainActivity } from '../src/shared/life'
import { BEHAVIOR_STATES, type BehaviorState } from '../src/shared/types'

// The behavior state machine (BITBOT_SPEC.md §10.1 interruption priorities, §10.3 mode constraints; §14.2).

const BEHAVIORS: readonly LocomotionBehavior[] = ['idle', 'walk', 'run', 'climb', 'jump', 'fall', 'land', 'held']

/** §10.1, highest first: held > fall > land > greet > eat > movement > the other activities > forced > idle. */
const PRIORITY: readonly string[] = ['held', 'fall', 'land', 'greet', 'eat', 'walk', 'run', 'climb', 'jump', 'sit', 'sleep', 'peek', 'celebrate']

describe('resolveState', () => {
  it('every combination follows the §10.1 priorities (forced only when the pet would idle)', () => {
    let checked = 0
    for (const behavior of BEHAVIORS) {
      for (const activity of [null, ...BRAIN_ACTIVITIES] as (BrainActivity | null)[]) {
        for (const forced of [null, ...BEHAVIOR_STATES] as (BehaviorState | null)[]) {
          const present: string[] = [behavior, activity].filter((x) => x !== null && x !== 'idle') as string[]
          const top = PRIORITY.find((s) => present.includes(s))
          const expected = top ?? forced ?? 'idle'
          expect(resolveState({ behavior, activity, forced }), `${behavior} ${activity} ${forced}`).toBe(expected)
          checked++
        }
      }
    }
    expect(checked).toBe(BEHAVIORS.length * (BRAIN_ACTIVITIES.length + 1) * (BEHAVIOR_STATES.length + 1))
  })

  it('held beats everything; fall beats land, greet and eat; land beats greet', () => {
    expect(resolveState({ behavior: 'held', activity: 'greet', forced: 'sleep' })).toBe('held')
    expect(resolveState({ behavior: 'fall', activity: 'eat', forced: null })).toBe('fall')
    expect(resolveState({ behavior: 'land', activity: 'greet', forced: null })).toBe('land')
  })

  it('greet beats eat; both beat movement; movement beats sit, sleep, peek and celebrate', () => {
    // greet and eat can't both be the activity; greet is above eat in the list, and each beats walking.
    expect(resolveState({ behavior: 'walk', activity: 'greet', forced: null })).toBe('greet')
    expect(resolveState({ behavior: 'run', activity: 'eat', forced: null })).toBe('eat')
    for (const a of ['sit', 'sleep', 'peek', 'celebrate'] as const) {
      expect(resolveState({ behavior: 'climb', activity: a, forced: null })).toBe('climb')
      expect(resolveState({ behavior: 'idle', activity: a, forced: 'walk' })).toBe(a)
    }
  })

  it('the forced state shows only while the pet would idle', () => {
    expect(resolveState({ behavior: 'idle', activity: null, forced: 'celebrate' })).toBe('celebrate')
    expect(resolveState({ behavior: 'walk', activity: null, forced: 'celebrate' })).toBe('walk')
    expect(resolveState({ behavior: 'idle', activity: null, forced: null })).toBe('idle')
  })
})

describe('modes (§10.3)', () => {
  it('Roam (the default) allows every goal and movement', () => {
    for (const g of GOAL_KINDS) {
      expect(goalAllowed(g)).toBe(true)
      expect(goalAllowed(g, 'roam')).toBe(true)
    }
    expect(mayMove()).toBe(true)
  })

  it('Stay refuses the movement goals and moving; eat, nap, sit and idle stay (in place)', () => {
    expect([...MOVEMENT_GOALS].sort()).toEqual(['approachCursor', 'climb', 'explore', 'peek'])
    for (const g of GOAL_KINDS) expect(goalAllowed(g, 'stay')).toBe(!MOVEMENT_GOALS.includes(g))
    expect(mayMove('stay')).toBe(false)
  })

  it('Hangout behaves as Roam until M7', () => {
    expect(PET_MODES).toEqual(['roam', 'stay', 'hangout'])
    for (const g of GOAL_KINDS) expect(goalAllowed(g, 'hangout')).toBe(true)
    expect(mayMove('hangout')).toBe(true)
  })
})
