import { describe, expect, it } from 'vitest'
import { LifeClock } from '../src/main/sim/lifeClock'

// The pet's life clock (src/main/sim/lifeClock.ts): real time × the dev panel's time scale, never jumping.

describe('LifeClock', () => {
  it('runs at real time, then `scale` times faster, continuous across the change', () => {
    let real = 1_000_000
    const clock = new LifeClock(() => real)
    expect(clock.now()).toBe(1000)
    real += 10_000
    expect(clock.now()).toBe(1010)
    clock.setScale(60)
    expect(clock.now()).toBe(1010) // no jump
    real += 1000
    expect(clock.now()).toBe(1070)
    clock.setScale(1)
    real += 1000
    expect(clock.now()).toBe(1071)
  })

  it('ignores invalid scales', () => {
    let real = 0
    const clock = new LifeClock(() => real)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) clock.setScale(bad)
    real += 1000
    expect(clock.scale).toBe(1)
    expect(clock.now()).toBe(1)
  })
})
