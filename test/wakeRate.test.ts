import { describe, expect, it } from 'vitest'
import { wakeStride, type WakeInput } from '../src/main/sim/wakeRate'
import { tuning } from '../src/shared/tuning'

// How often the simulation wakes (src/main/sim/wakeRate.ts, M9).

const T = tuning.sim.wake
const BOX = { left: 900, top: 900, right: 1000, bottom: 1022 }
const FAR = { x: 200, y: 200 }

const idle = (over: Partial<WakeInput> = {}): WakeInput => ({
  behavior: 'idle',
  hasGoal: false,
  pendingSend: false,
  interaction: 'none',
  cursor: FAR,
  petBox: BOX,
  asleep: false,
  busy: false,
  ...over,
})

describe('wakeStride', () => {
  it('idling awake with the cursor far: idleStride; asleep: asleepStride', () => {
    expect(wakeStride(idle(), T)).toBe(T.idleStride)
    expect(wakeStride(idle({ asleep: true }), T)).toBe(T.asleepStride)
  })

  it('every step whenever anything moves or may start to', () => {
    for (const behavior of ['walk', 'run', 'climb', 'jump', 'fall', 'land', 'held']) expect(wakeStride(idle({ behavior }), T)).toBe(1)
    expect(wakeStride(idle({ hasGoal: true }), T)).toBe(1)
    expect(wakeStride(idle({ pendingSend: true }), T)).toBe(1)
    for (const interaction of ['near', 'hover', 'press', 'drag', 'menu']) expect(wakeStride(idle({ interaction }), T)).toBe(1)
    expect(wakeStride(idle({ busy: true, asleep: true }), T)).toBe(1)
  })

  it('every step once the cursor approaches (within approachPt of the box), asleep too', () => {
    const near = { x: BOX.left - T.approachPt + 1, y: 950 }
    expect(wakeStride(idle({ cursor: near }), T)).toBe(1)
    expect(wakeStride(idle({ cursor: near, asleep: true }), T)).toBe(1)
    expect(wakeStride(idle({ cursor: { x: BOX.left - T.approachPt - 1, y: 950 } }), T)).toBe(T.idleStride)
  })

  it('every step when the cursor or the box is unknown', () => {
    expect(wakeStride(idle({ cursor: null }), T)).toBe(1)
    expect(wakeStride(idle({ petBox: null }), T)).toBe(1)
  })

  it('the strides fit the loop (≤ maxStepsPerWake) and the approach zone is wider than the near zone', () => {
    expect(T.asleepStride).toBeLessThanOrEqual(tuning.sim.maxStepsPerWake)
    expect(T.idleStride).toBeLessThanOrEqual(tuning.sim.maxStepsPerWake)
    expect(T.approachPt).toBeGreaterThan(tuning.hitArea.nearMarginPt * 3)
  })
})
