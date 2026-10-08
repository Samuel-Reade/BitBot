import { describe, expect, it } from 'vitest'
import type { DevOverrides } from '../src/shared/devPanel'
import { GOAL_KINDS, NEEDS, TIME_SCALES, type LifeSnapshot } from '../src/shared/life'
import { NONE } from '../src/renderer/devpanel/economyView'
import {
  dustInEffect,
  isLifeSnapshot,
  lifeDetails,
  moodInEffect,
  needBars,
  scoreRows,
  TIME_SCALE_CHOICES,
  timeScaleFrom,
} from '../src/renderer/devpanel/lifeView'

// The developer panel's Life section and mood / dust / time-scale controls (src/renderer/devpanel/lifeView.ts): what
// it accepts from main, the text of the need bars, status lines and goal scores, and what mood and dust are in effect.

const LIFE: LifeSnapshot = {
  needs: { hunger: 62.4, energy: 80, fullness: 41.6, boredom: 12, dust: 45 },
  mood: 'hungry',
  stuffed: false,
  asleep: false,
  activity: 'eat',
  goal: 'eat',
  scores: { eat: 0.624, nap: 0.2, explore: 0.096, climb: 0.036, sit: 0.35, peek: 0.018, approachCursor: 0.048, idle: 0.45 },
  continuousActiveMin: 37.6,
  timeScale: 60,
}

const OVERRIDES: DevOverrides = {
  state: null,
  mood: null,
  dust: null,
  facing: null,
  face: null,
  idleMode: 'event',
  showWorld: false,
  wander: true,
  timeScale: 1,
}

describe('isLifeSnapshot', () => {
  it('accepts a whole snapshot (also round-tripped through JSON, as IPC does), and one before the first decision', () => {
    expect(isLifeSnapshot(LIFE)).toBe(true)
    expect(isLifeSnapshot(JSON.parse(JSON.stringify(LIFE)))).toBe(true)
    expect(isLifeSnapshot({ ...LIFE, activity: null, goal: null, scores: null })).toBe(true)
  })

  it('rejects a missing need or goal score', () => {
    const { boredom: _b, ...needs } = LIFE.needs
    expect(isLifeSnapshot({ ...LIFE, needs })).toBe(false)
    const { approachCursor: _a, ...scores } = LIFE.scores ?? {}
    expect(isLifeSnapshot({ ...LIFE, scores })).toBe(false)
  })

  it('rejects bad levels, scores and fields', () => {
    expect(isLifeSnapshot({ ...LIFE, needs: { ...LIFE.needs, hunger: 101 } })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, needs: { ...LIFE.needs, dust: -1 } })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, needs: { ...LIFE.needs, energy: Number.NaN } })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, scores: { ...LIFE.scores, nap: 'high' } })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, mood: 'grumpy' })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, stuffed: 'no' })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, asleep: 1 })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, activity: 'walk' })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, goal: 'fly' })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, continuousActiveMin: -1 })).toBe(false)
    expect(isLifeSnapshot({ ...LIFE, timeScale: 2 })).toBe(false)
    expect(isLifeSnapshot(null)).toBe(false)
    expect(isLifeSnapshot([])).toBe(false)
  })
})

describe('the Life section text', () => {
  it('one bar per need, in NEEDS order, with whole numbers', () => {
    const bars = needBars(LIFE)
    expect(bars.map((b) => b.need)).toEqual([...NEEDS])
    expect(bars[0]).toEqual({ need: 'hunger', value: 62.4, text: '62' })
    expect(bars[2]?.text).toBe('42')
  })

  it('the status lines and the goal scores, the chosen goal marked', () => {
    expect(lifeDetails(LIFE)).toEqual({ mood: 'hungry', stuffed: 'no', asleep: 'no', activity: 'eat', goal: 'eat', continuous: '38 min' })
    expect(lifeDetails({ ...LIFE, stuffed: true, asleep: true, activity: null }).activity).toBe(NONE)
    const rows = scoreRows(LIFE)
    expect(rows.map((r) => r.goal)).toEqual([...GOAL_KINDS])
    expect(rows[0]).toEqual({ goal: 'eat', score: '0.62', chosen: true })
    expect(rows.filter((r) => r.chosen)).toHaveLength(1)
  })

  it('"—" everywhere before the pet exists or decides', () => {
    expect(needBars(null).every((b) => b.text === NONE && b.value === 0)).toBe(true)
    expect(Object.values(lifeDetails(null)).every((t) => t === NONE)).toBe(true)
    expect(scoreRows(null).every((r) => r.score === NONE && !r.chosen)).toBe(true)
    expect(scoreRows({ ...LIFE, scores: null, goal: null }).every((r) => r.score === NONE && !r.chosen)).toBe(true)
  })
})

describe('mood and dust in effect', () => {
  it('auto shows the needs’ own; forced shows the forced value', () => {
    expect(moodInEffect(OVERRIDES, LIFE)).toBe('hungry (needs)')
    expect(moodInEffect({ ...OVERRIDES, mood: 'happy' }, LIFE)).toBe('happy (forced)')
    expect(moodInEffect(OVERRIDES, null)).toBe(NONE)
    expect(dustInEffect(OVERRIDES, LIFE)).toBe('0.45 (needs)')
    expect(dustInEffect({ ...OVERRIDES, dust: 0.8 }, LIFE)).toBe('0.80 (forced)')
    expect(dustInEffect({ ...OVERRIDES, dust: 0 }, null)).toBe('0.00 (forced)')
    expect(dustInEffect(OVERRIDES, null)).toBe(NONE)
  })
})

describe('time scale choices', () => {
  it('one per §14.1 scale, and back', () => {
    expect(TIME_SCALE_CHOICES).toEqual([
      ['1', '1×'],
      ['10', '10×'],
      ['60', '60×'],
      ['600', '600×'],
    ])
    for (const s of TIME_SCALES) expect(timeScaleFrom(String(s))).toBe(s)
    expect(timeScaleFrom('2')).toBeNull()
    expect(timeScaleFrom('')).toBeNull()
    expect(timeScaleFrom('auto')).toBeNull()
  })
})
