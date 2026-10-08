import { describe, expect, it } from 'vitest'
import { moodOf, pressingNeeds, type MoodInput, type MoodParams } from '../src/main/sim/needs/mood'
import { Needs } from '../src/main/sim/needs/needs'
import type { NeedLevels } from '../src/shared/life'
import { tuning } from '../src/shared/tuning'

// Mood (src/main/sim/needs/mood.ts, BITBOT_SPEC.md §9.2): the most pressing need, ties by moodPriority, happy after an
// interaction, content otherwise; and Needs.mood over the life clock.

const N = tuning.needs
const P: MoodParams = N
const calm: NeedLevels = { hunger: 20, energy: 80, fullness: 10, boredom: 20, dust: 0 }
const input = (levels: Partial<NeedLevels> = {}, extra: Partial<MoodInput> = {}): MoodInput => ({
  levels: { ...calm, ...levels },
  continuousActiveMin: 0,
  sinceInteractionS: null,
  ...extra,
})

describe('moodOf', () => {
  it('content when nothing presses and no recent interaction', () => {
    expect(moodOf(input(), P)).toBe('content')
  })

  it('each need picks its mood once past its threshold', () => {
    expect(moodOf(input({ hunger: N.hunger.hungryAt }), P)).toBe('hungry')
    expect(moodOf(input({ hunger: N.hunger.hungryAt - 1 }), P)).toBe('content')
    expect(moodOf(input({ energy: N.energy.sleepyAt }), P)).toBe('sleepy')
    expect(moodOf(input({ fullness: N.fullness.stuffedAt }), P)).toBe('stuffed')
    expect(moodOf(input({}, { continuousActiveMin: N.stuffed.continuousMin }), P)).toBe('stuffed')
    expect(moodOf(input({ dust: N.dust.lonelyAt }), P)).toBe('lonely')
    expect(moodOf(input({ dust: N.dust.visibleAt }), P)).toBe('content')
    expect(moodOf(input({ boredom: N.boredom.boredAt }), P)).toBe('bored')
  })

  it('the most pressing need wins', () => {
    // Just hungry vs nearly out of energy: sleepy.
    expect(moodOf(input({ hunger: N.hunger.hungryAt + 2, energy: 3 }), P)).toBe('sleepy')
    // Starving vs just sleepy: hungry.
    expect(moodOf(input({ hunger: 98, energy: N.energy.sleepyAt - 1 }), P)).toBe('hungry')
    // Very bored vs just lonely: bored.
    expect(moodOf(input({ boredom: 99, dust: N.dust.lonelyAt }), P)).toBe('bored')
    expect(pressingNeeds(input({ hunger: 100, energy: 0 }), P)).toEqual({ hungry: 1, sleepy: 1 })
  })

  it('ties go by moodPriority', () => {
    const all = input(
      { hunger: N.hunger.hungryAt, energy: N.energy.sleepyAt, fullness: N.fullness.stuffedAt, dust: N.dust.lonelyAt, boredom: N.boredom.boredAt },
      { continuousActiveMin: N.stuffed.continuousMin },
    )
    expect(moodOf(all, P)).toBe(N.moodPriority[0])
    const reversed: MoodParams = { ...P, moodPriority: [...N.moodPriority].reverse() }
    expect(moodOf(all, reversed)).toBe('bored')
    // Stuffed at its limit vs bored at its threshold, both severity 0: stuffed comes first in the list.
    expect(moodOf(input({ boredom: N.boredom.boredAt }, { continuousActiveMin: N.stuffed.continuousMin }), P)).toBe('stuffed')
  })

  it('a need missing from moodPriority still counts, after the listed ones', () => {
    const short: MoodParams = { ...P, moodPriority: ['bored'] }
    expect(moodOf(input({ hunger: N.hunger.hungryAt, boredom: N.boredom.boredAt }), short)).toBe('bored')
    expect(moodOf(input({ hunger: N.hunger.hungryAt }), short)).toBe('hungry')
  })

  it('happy after an interaction within happyAfterInteractionMin, unless a need presses', () => {
    const window = N.happyAfterInteractionMin * 60
    expect(moodOf(input({}, { sinceInteractionS: 0 }), P)).toBe('happy')
    expect(moodOf(input({}, { sinceInteractionS: window }), P)).toBe('happy')
    expect(moodOf(input({}, { sinceInteractionS: window + 1 }), P)).toBe('content')
    expect(moodOf(input({ hunger: 90 }, { sinceInteractionS: 0 }), P)).toBe('hungry')
  })
})

describe('Needs.mood', () => {
  const day = '2026-10-08'

  it('happy after petting, content once it wears off', () => {
    const n = new Needs(N, tuning.economy.activity.activeIdleS, undefined, 0)
    expect(n.mood(0)).toBe('content')
    n.interaction(100)
    expect(n.mood(100)).toBe('happy')
    // Between ticks, mood(nowS) counts the time since the last call...
    expect(n.mood(100 + N.happyAfterInteractionMin * 60 + 1)).toBe('content')
    // ...and advancing does the same.
    n.advance(N.happyAfterInteractionMin * 60 - 10, 100 + N.happyAfterInteractionMin * 60 - 10, { userIdleS: 0, computerAsleep: false, dayKey: day })
    expect(n.mood(100 + N.happyAfterInteractionMin * 60 - 10)).toBe('happy')
    n.advance(20, 100 + N.happyAfterInteractionMin * 60 + 10, { userIdleS: 0, computerAsleep: false, dayKey: day })
    expect(n.mood(100 + N.happyAfterInteractionMin * 60 + 10)).toBe('content')
  })

  it('a dusty return is lonely until the shake-off, then happy', () => {
    const n = new Needs(N, tuning.economy.activity.activeIdleS, undefined, 0)
    n.advance(60, 60, { userIdleS: 0, computerAsleep: false, dayKey: day })
    n.advance(3600, 3660, { userIdleS: 3600, computerAsleep: true, dayKey: '2026-10-14' })
    expect(n.levels.dust).toBeGreaterThanOrEqual(N.dust.lonelyAt)
    expect(n.mood(3660)).toBe('lonely')
    expect(n.interaction(3660).shakeOff).toBe(true)
    expect(n.mood(3660)).toBe('happy')
  })
})
