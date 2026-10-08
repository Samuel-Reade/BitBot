import { describe, expect, it } from 'vitest'
import {
  DrawnGate,
  drawnPoint,
  fullscreenOnDisplay,
  PetStateSender,
  PresentedPoint,
  recreateDelayMs,
  sameArea,
  sameSimState,
  type PetSimState,
} from '../src/main/windows/overlaySession'
import { tuning } from '../src/shared/tuning'
import { isPetStateMsg, type PetStateMsg } from '../src/shared/petProtocol'

// The overlay session rules in main (src/main/windows/overlaySession.ts): when pet:state goes out, main's estimate of
// where the overlay draws the pet, and whether the pet counts as drawn for the current configuration.

const STEP = 1000 / 30
const IDLE: PetSimState = { x: 855, y: 1068, facing: 1, state: 'idle', mood: 'content', dust: 0, look: null, attach: 'floor', reaction: null, supportY: 1068 }

function sender(): { s: PetStateSender; sent: PetStateMsg[] } {
  const sent: PetStateMsg[] = []
  return { s: new PetStateSender((m) => sent.push(m)), sent }
}

describe('PetStateSender', () => {
  it('sends nothing before the page load is ready; the first state after ready is a snap', () => {
    const { s, sent } = sender()
    expect(s.offer(IDLE, 100, 101)).toBe(false)
    s.requestSnap()
    expect(s.offer(IDLE, 133, 134)).toBe(false)
    expect(sent).toEqual([])
    s.setReady(true)
    expect(s.offer(IDLE, 166, 167)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ seq: 1, t: 166, sentAt: 167, ...IDLE, snap: true })
    expect(isPetStateMsg(sent[0])).toBe(true)
  })

  it('sends only when x, y, facing, state or supportY changed', () => {
    const { s, sent } = sender()
    s.setReady(true)
    s.offer(IDLE, 0, 0)
    for (let i = 1; i <= 5; i++) expect(s.offer({ ...IDLE }, i * STEP, i * STEP)).toBe(false)
    const changes: Partial<PetSimState>[] = [{ x: 856 }, { y: 1000 }, { facing: -1 }, { state: 'fall' }, { supportY: null }]
    let t = 10 * STEP
    for (const change of changes) {
      const next = { ...IDLE, ...change }
      expect(s.offer(next, (t += STEP), t)).toBe(true)
      expect(s.offer(next, (t += STEP), t)).toBe(false)
      s.offer(IDLE, (t += STEP), t) // back
    }
    expect(sent.filter((m) => !m.snap)).toHaveLength(2 * changes.length)
    expect(sent.map((m) => m.seq)).toEqual(sent.map((_, i) => i + 1))
    expect(s.sent).toBe(sent.length)
  })

  it('a requested snap goes out with the next state even if it did not change, then the stream continues', () => {
    const { s, sent } = sender()
    s.setReady(true)
    s.offer(IDLE, 0, 0)
    s.requestSnap()
    expect(s.snapIsPending).toBe(true)
    expect(s.offer(IDLE, STEP, STEP)).toBe(true)
    expect(sent[1]?.snap).toBe(true)
    expect(s.snapIsPending).toBe(false)
    expect(s.offer(IDLE, 2 * STEP, 2 * STEP)).toBe(false)
    expect(s.offer({ ...IDLE, y: 1000 }, 3 * STEP, 3 * STEP)).toBe(true)
    expect(sent[2]?.snap).toBe(false)
  })

  it('a page that went away stops the stream; the next ready starts it again with a snap', () => {
    const { s, sent } = sender()
    s.setReady(true)
    s.offer(IDLE, 0, 0)
    s.setReady(false)
    expect(s.isReady).toBe(false)
    expect(s.offer({ ...IDLE, x: 1 }, STEP, STEP)).toBe(false)
    s.setReady(true)
    expect(s.offer(IDLE, 2 * STEP, 2 * STEP)).toBe(true) // unchanged since the last one sent, but a fresh page needs it
    expect(sent[1]).toMatchObject({ snap: true, t: 2 * STEP })
  })

  it('a send that throws counts as not sent: the next offer tries again', () => {
    let fail = true
    const sent: PetStateMsg[] = []
    const s = new PetStateSender((m) => {
      if (fail) throw new Error('renderer gone')
      sent.push(m)
    })
    s.setReady(true)
    expect(() => s.offer(IDLE, 0, 0)).toThrow('renderer gone')
    expect(s.sent).toBe(0)
    fail = false
    expect(s.offer(IDLE, STEP, STEP)).toBe(true)
    expect(sent[0]).toMatchObject({ seq: 1, snap: true })
  })

  it('copies the state it remembers (the simulation state is a live view)', () => {
    const { s, sent } = sender()
    s.setReady(true)
    const live = { ...IDLE }
    s.offer(live, 0, 0)
    live.y = 900
    expect(s.offer(live, STEP, STEP)).toBe(true)
    expect(sent[1]?.y).toBe(900)
  })

  it('sameSimState compares every field', () => {
    expect(sameSimState(IDLE, { ...IDLE })).toBe(true)
    expect(sameSimState(IDLE, { ...IDLE, supportY: null })).toBe(false)
  })
})

describe('PresentedPoint', () => {
  it('is one step behind the newest step, interpolated', () => {
    const p = new PresentedPoint(STEP, { t: 0, x: 0, y: 0 })
    p.push(STEP, { x: 30, y: 0 })
    p.push(2 * STEP, { x: 60, y: 0 })
    expect(p.at(2 * STEP).x).toBeCloseTo(30)
    expect(p.at(2.5 * STEP).x).toBeCloseTo(45)
    expect(p.at(3 * STEP).x).toBeCloseTo(60)
    expect(p.at(10 * STEP)).toEqual({ x: 60, y: 0 }) // starved: holds the newest
    expect(p.latest).toEqual({ t: 2 * STEP, x: 60, y: 0 })
  })

  it('a restart (snap) never interpolates from before it', () => {
    const p = new PresentedPoint(STEP, { t: 0, x: 0, y: 0 })
    p.push(STEP, { x: 30, y: 0 })
    p.restart(STEP, { x: 500, y: 400 })
    expect(p.at(STEP)).toEqual({ x: 500, y: 400 })
    expect(p.at(STEP / 2)).toEqual({ x: 500, y: 400 })
    p.push(2 * STEP, { x: 510, y: 400 })
    expect(p.at(2.5 * STEP).x).toBeCloseTo(505)
  })

  it('ignores non-finite input and always answers a finite point', () => {
    const p = new PresentedPoint(STEP, { t: 0, x: 5, y: 6 })
    p.push(Number.NaN, { x: 1, y: 1 })
    p.push(STEP, { x: Number.POSITIVE_INFINITY, y: 1 })
    p.restart(STEP, { x: Number.NaN, y: 0 })
    expect(p.at(STEP)).toEqual({ x: 5, y: 6 })
    expect(p.at(Number.NaN)).toEqual({ x: 5, y: 6 })
  })
})

describe('DrawnGate', () => {
  it('nothing is drawn before the page load is ready; pet:ready counts as drawn for its configSeq', () => {
    const g = new DrawnGate()
    expect(g.isDrawn(1)).toBe(false)
    g.drawn({ drawn: true, configSeq: 1 }) // before ready: doesn't count yet
    expect(g.isDrawn(1)).toBe(false)
    g.ready(1)
    expect(g.isDrawn(1)).toBe(true)
    expect(g.seq).toBe(1)
  })

  it('after a pet:config-changed, not drawn until pet:drawn reports that configSeq', () => {
    const g = new DrawnGate()
    g.ready(1)
    expect(g.isDrawn(2)).toBe(false)
    g.drawn({ drawn: true, configSeq: 2 })
    expect(g.isDrawn(2)).toBe(true)
    expect(g.isDrawn(1)).toBe(false)
  })

  it('ready with an older configuration (a config-changed overtook it) waits for the newer one', () => {
    const g = new DrawnGate()
    g.ready(3)
    expect(g.isDrawn(4)).toBe(false)
    g.drawn({ drawn: true, configSeq: 4 })
    expect(g.isDrawn(4)).toBe(true)
  })

  it('drawn:false (context lost, render failed) counts whatever its configSeq, until drawn:true again', () => {
    const g = new DrawnGate()
    g.ready(2)
    g.drawn({ drawn: false, configSeq: 1 })
    expect(g.isDrawn(2)).toBe(false)
    expect(g.seq).toBeNull()
    g.drawn({ drawn: true, configSeq: 2 })
    expect(g.isDrawn(2)).toBe(true)
  })

  it('an older configuration reported drawn never makes a newer one count', () => {
    const g = new DrawnGate()
    g.ready(5)
    g.drawn({ drawn: true, configSeq: 4 })
    expect(g.seq).toBe(5)
    expect(g.isDrawn(5)).toBe(true)
  })

  it('reset (a new page load, or the page went away) forgets everything', () => {
    const g = new DrawnGate()
    g.ready(1)
    g.reset()
    expect(g.isDrawn(1)).toBe(false)
    expect(g.seq).toBeNull()
  })
})

describe('fullscreenOnDisplay and sameArea', () => {
  it('fullscreen only when the frontmost app covers this display (or the push names no display)', () => {
    expect(fullscreenOnDisplay({ value: false, displayIds: [] }, 1)).toBe(false)
    expect(fullscreenOnDisplay({ value: true, displayIds: [1] }, 1)).toBe(true)
    expect(fullscreenOnDisplay({ value: true, displayIds: [2] }, 1)).toBe(false)
    expect(fullscreenOnDisplay({ value: true, displayIds: [] }, 1)).toBe(true)
  })

  it('compares areas field by field; null equals only null', () => {
    const a = { minX: 1, maxX: 2, minY: 3, groundY: 4 }
    expect(sameArea(a, { ...a })).toBe(true)
    expect(sameArea(a, { ...a, groundY: 5 })).toBe(false)
    expect(sameArea(null, null)).toBe(true)
    expect(sameArea(a, null)).toBe(false)
    expect(sameArea(null, a)).toBe(false)
  })
})

describe('drawnPoint', () => {
  it('a held pet is drawn where its newest step holds it (under the cursor), anything else a step behind', () => {
    // The dev check found the grab area trailing a dragged pet: main placed it one step behind, the overlay drew the
    // pet under the cursor.
    const p = new PresentedPoint(STEP, { t: 0, x: 100, y: 500 })
    p.push(STEP, { x: 120, y: 480 })
    p.push(2 * STEP, { x: 140, y: 460 })
    expect(drawnPoint(p, 2 * STEP, null)).toEqual({ x: 120, y: 480 })
    expect(drawnPoint(p, 2 * STEP, { x: 140, y: 460 })).toEqual({ x: 140, y: 460 })
    // A held point that is not a finite point falls back to the estimate.
    expect(drawnPoint(p, 2 * STEP, { x: Number.NaN, y: 0 })).toEqual({ x: 120, y: 480 })
  })
})

describe('recreateDelayMs: backing off a failing overlay', () => {
  it('doubles from the base for each loss in a row, up to the cap', () => {
    const delays = [1, 2, 3, 4, 5, 9, 10].map((n) => recreateDelayMs(n, 1000, 300_000))
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 256_000, 300_000])
    expect(recreateDelayMs(10_000, 1000, 300_000)).toBe(300_000)
  })

  it('never waits less than the base (a first loss, or a bad count)', () => {
    for (const n of [1, 0, -3, Number.NaN]) expect(recreateDelayMs(n, 1000, 300_000), String(n)).toBe(1000)
  })

  it('the production settings back off to minutes, not the ~21 s of a fixed delay plus the ready timeout', () => {
    const { recreateDelayMs: base, recreateMaxDelayMs: max } = tuning.overlay
    expect(max).toBeGreaterThanOrEqual(60_000)
    expect(recreateDelayMs(20, base, max)).toBe(max)
  })
})
