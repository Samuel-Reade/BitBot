import { describe, expect, it } from 'vitest'
import { tuning } from '../src/shared/tuning'
import type { DebugWorldMsg } from '../src/shared/world'
import { Locomotion } from '../src/main/sim/locomotion/locomotion'
import { WorldDriver } from '../src/main/sim/worldDriver'
import { BOX, DISPLAY, PARAMS, W1, W3, win } from './worldFixtures'

// The world as the running app keeps it (src/main/sim/worldDriver.ts): snapshots → world → the pet, the snapshot
// rate, wandering, the dev panel's actions and the debug view, with a real Locomotion and fake helper outputs.

const STEP_S = 1 / tuning.sim.hz

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function setup(debug = true) {
  const rates: number[] = []
  const debugMsgs: DebugWorldMsg[] = []
  const driver = new WorldDriver({
    params: PARAMS,
    setPollRate: (hz) => rates.push(hz),
    sendDebug: debug ? (m) => debugMsgs.push(m) : null,
    random: mulberry32(7),
  })
  const world = driver.setScene(DISPLAY, BOX, null, 0)
  const loco = new Locomotion(world, tuning.move, { x: 300, y: world.area.groundY })
  let now = 0
  /** Runs the simulation for `s` seconds, ticking the driver every step (as afterSteps does). */
  const run = (s: number): void => {
    for (let i = 0; i < Math.round(s / STEP_S); i++) {
      now += STEP_S * 1000
      loco.step(STEP_S, null)
      driver.tick(now, loco)
    }
  }
  return { driver, loco, rates, debugMsgs, run, now: () => now }
}

describe('WorldDriver', () => {
  it('builds the world from snapshots and hands it to the pet', () => {
    const { driver, loco } = setup()
    driver.onSnapshot([W1, W3], 100, loco)
    expect(driver.world?.windows.size).toBe(2)
    expect(loco.world).toBe(driver.world)
    expect(driver.status(loco)).toMatchObject({ windows: 2, surface: 'ground', goal: null })
  })

  it('asks for the normal snapshot rate, none while hidden, and the fast one while a ridden window moves', () => {
    const { driver, loco, rates, run } = setup()
    driver.onSnapshot([W1], 0, loco)
    expect(rates.at(-1)).toBe(tuning.world.snapshotHz.normal)
    driver.setHidden(true, 10, loco)
    expect(rates.at(-1)).toBe(0)
    driver.setHidden(false, 20, loco)
    expect(rates.at(-1)).toBe(tuning.world.snapshotHz.normal)
    // Onto W1's top (and staying there), then W1 moves under it.
    driver.setWandering(false)
    driver.action('goWindow', loco)
    run(15)
    expect(loco.state.surface).toMatch(/^top:1:/)
    const t = 20_000
    driver.onSnapshot([{ ...W1, x: W1.x + 20 }], t, loco)
    expect(rates.at(-1)).toBe(tuning.world.snapshotHz.attached)
    driver.tick(t + tuning.world.attachedStillS * 1000 + 1, loco)
    expect(rates.at(-1)).toBe(tuning.world.snapshotHz.normal)
    // Only changes are sent.
    expect(rates.filter((r, i) => i > 0 && r === rates[i - 1])).toEqual([])
  })

  it('wanders while on and idle, never while hidden or off', () => {
    const on = setup()
    on.driver.onSnapshot([W1, W3], 0, on.loco)
    on.run(tuning.brain.wander.pauseS[1] + 1)
    expect(on.loco.goal ?? on.loco.state.x !== 300).toBeTruthy()

    const off = setup()
    off.driver.onSnapshot([W1, W3], 0, off.loco)
    off.driver.setWandering(false)
    off.run(20)
    expect(off.loco.state.x).toBe(300)

    const hidden = setup()
    hidden.driver.onSnapshot([W1, W3], 0, hidden.loco)
    hidden.driver.setHidden(true, 0, hidden.loco)
    hidden.run(20)
    expect(hidden.loco.state.x).toBe(300)
  })

  it('the dev panel actions: onto a window, up a wall, somewhere, stop', () => {
    const { driver, loco, run } = setup()
    driver.setWandering(false)
    driver.onSnapshot([W1, W3], 0, loco)
    driver.action('goWindow', loco)
    expect(loco.goal).not.toBeNull()
    run(15)
    expect(loco.state.surface).toMatch(/^top:/)
    driver.action('climbWall', loco)
    run(0.5)
    driver.action('stop', loco)
    expect(loco.goal).toBeNull()
    run(2) // a hop in progress finishes first: a pet in the air can't be sent anywhere
    driver.action('goRandom', loco)
    expect(loco.goal).not.toBeNull()
  })

  it('a ridden window that closes drops the pet onto what is below', () => {
    const { driver, loco, run } = setup()
    driver.setWandering(false)
    driver.onSnapshot([W1], 0, loco)
    driver.action('goWindow', loco)
    run(15)
    expect(loco.state.windowId).toBe(1)
    driver.onSnapshot([], 16_000, loco)
    run(3)
    expect(loco.state.surface).toBe('ground')
  })

  it('sends the debug view while shown, only when the world or the route changes; one hidden message when turned off', () => {
    const { driver, loco, debugMsgs, run } = setup()
    driver.setWandering(false)
    driver.onSnapshot([W1], 0, loco)
    driver.tick(1, loco)
    expect(debugMsgs).toEqual([])
    driver.setShowWorld(true)
    driver.tick(2, loco)
    driver.tick(3, loco)
    expect(debugMsgs).toHaveLength(1)
    expect(debugMsgs[0]?.show).toBe(true)
    expect(debugMsgs[0]?.windows.map((w) => w.wid)).toEqual([1])
    driver.action('goWindow', loco)
    run(0.1)
    expect(debugMsgs.at(-1)?.path.length).toBeGreaterThan(1)
    driver.onSnapshot([W1, win(5, 1000, 500, 300, 200)], 500, loco)
    driver.tick(600, loco)
    expect(debugMsgs.at(-1)?.windows).toHaveLength(2)
    const n = debugMsgs.length
    driver.setShowWorld(false)
    expect(debugMsgs).toHaveLength(n + 1)
    expect(debugMsgs.at(-1)).toEqual({ show: false, segments: [], walls: [], links: [], path: [], windows: [] })
    // A new page gets it again.
    driver.setShowWorld(true)
    driver.tick(700, loco)
    driver.pageReady()
    driver.tick(800, loco)
    expect(debugMsgs.slice(n + 1)).toHaveLength(2)
  })

  it('packaged builds never send the debug view', () => {
    const { driver, loco, debugMsgs } = setup(false)
    driver.setShowWorld(true)
    driver.onSnapshot([W1], 0, loco)
    driver.tick(1, loco)
    driver.setShowWorld(false)
    expect(debugMsgs).toEqual([])
  })
})

describe('WorldDriver food spots', () => {
  it('the frontmost eligible window’s top, and a given app’s window top', () => {
    const { driver, loco } = setup()
    expect(driver.foodSpot()).toBeNull()
    const front = win(7, 1000, 600, 300, 200, { bundleId: 'com.apple.Safari' })
    driver.onSnapshot([front, W1, W3], 0, loco)
    const spot = driver.foodSpot()
    expect(spot?.y).toBe(600)
    expect(spot?.x).toBeCloseTo(1150, 0)
    expect(driver.windowTopFor('com.example.app')?.y).toBe(W1.y) // W1 is the first com.example.app window
    expect(driver.windowTopFor('com.nope')).toBeNull()
    // A window too small to be a surface is skipped.
    driver.onSnapshot([win(8, 100, 100, 50, 50, { bundleId: 'com.tiny' }), W1], 10, loco)
    expect(driver.windowTopFor('com.tiny')).toBeNull()
    expect(driver.foodSpot()?.y).toBe(W1.y)
  })
})
