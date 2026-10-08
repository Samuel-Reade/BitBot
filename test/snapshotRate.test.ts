import { describe, expect, it } from 'vitest'
import { tuning } from '../src/shared/tuning'
import { snapshotHz } from '../src/main/sim/world/snapshotRate'

// The helper's snapshot rate (src/main/sim/world/snapshotRate.ts): decided adaptive polling.

const W = tuning.world

describe('snapshotHz', () => {
  it('normal rate on the ground or a still window, none while hidden', () => {
    expect(snapshotHz({ hidden: false, riding: false, sinceRideMovedS: Infinity }, W)).toBe(W.snapshotHz.normal)
    expect(snapshotHz({ hidden: false, riding: true, sinceRideMovedS: Infinity }, W)).toBe(W.snapshotHz.normal)
    expect(snapshotHz({ hidden: true, riding: true, sinceRideMovedS: 0 }, W)).toBe(0)
  })

  it('fast while the ridden window moves, until it has been still for attachedStillS', () => {
    expect(snapshotHz({ hidden: false, riding: true, sinceRideMovedS: 0 }, W)).toBe(W.snapshotHz.attached)
    expect(snapshotHz({ hidden: false, riding: true, sinceRideMovedS: W.attachedStillS - 0.01 }, W)).toBe(W.snapshotHz.attached)
    expect(snapshotHz({ hidden: false, riding: true, sinceRideMovedS: W.attachedStillS }, W)).toBe(W.snapshotHz.normal)
    // Moving windows don't matter when the pet isn't on one.
    expect(snapshotHz({ hidden: false, riding: false, sinceRideMovedS: 0 }, W)).toBe(W.snapshotHz.normal)
  })

  it('asleep: 1 Hz (§5.3), unless the window it sleeps on is moving', () => {
    expect(snapshotHz({ hidden: false, riding: false, sinceRideMovedS: Infinity, asleep: true }, W)).toBe(W.snapshotHz.asleep)
    expect(snapshotHz({ hidden: false, riding: true, sinceRideMovedS: 0, asleep: true }, W)).toBe(W.snapshotHz.attached)
    expect(snapshotHz({ hidden: true, riding: false, sinceRideMovedS: Infinity, asleep: true }, W)).toBe(0)
  })

  it('the decided rates: 4 Hz normally, 15 Hz riding a moving window', () => {
    expect(W.snapshotHz.normal).toBe(4)
    expect(W.snapshotHz.attached).toBe(15)
  })
})
