import { describe, expect, it } from 'vitest'
import {
  ClickCounter,
  coefficientOfVariation,
  KeyCounter,
  MileageCounter,
  ScrollCounter,
  TreatRules,
  type ScrollEvent,
} from '../src/main/economy/antiGaming'
import { tuning } from '../src/shared/tuning'

// Anti-gaming (src/main/economy/antiGaming.ts, BITBOT_SPEC.md §7.3; scroll ticks decided 2026-10-08): auto-repeat,
// same-key hammering, robotic timing (CV), burst ceilings, jiggle, app flapping, scroll ticks.

const AG = tuning.economy.antiGaming
const keyCounter = (): KeyCounter =>
  new KeyCounter({ hammering: AG.hammering, robotic: AG.robotic, burstPerS: AG.burstPerS.keys })
const clickCounter = (): ClickCounter => new ClickCounter({ robotic: AG.robotic, burstPerS: AG.burstPerS.clicks })

/** A deterministic pseudo-random sequence in [0, 1) (test data only). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Human-ish gaps between keys: 80–330 ms, irregular. */
function humanGaps(n: number, seed = 1): number[] {
  const r = rng(seed)
  return Array.from({ length: n }, () => 80 + 250 * r())
}

/** Presses and releases `codes` at the given gaps; the total credit. */
function type(k: KeyCounter, codes: number[], gaps: number[], t0 = 0): number {
  let t = t0
  let credit = 0
  codes.forEach((code, i) => {
    t += gaps[i % gaps.length]!
    credit += k.keyDown(code, false, t)
    k.keyUp(code)
  })
  return credit
}

describe('coefficientOfVariation', () => {
  it('σ / μ', () => {
    expect(coefficientOfVariation([100, 100, 100])).toBe(0)
    expect(coefficientOfVariation([50, 150])).toBeCloseTo(0.5, 12)
    expect(coefficientOfVariation([])).toBe(Infinity)
    expect(coefficientOfVariation([0, 0])).toBe(Infinity)
  })
})

describe('KeyCounter', () => {
  it('varied human typing credits every key', () => {
    const r = rng(7)
    const codes = Array.from({ length: 500 }, () => Math.floor(r() * 30))
    expect(type(keyCounter(), codes, humanGaps(500))).toBe(500)
  })

  it('auto-repeat: the repeat flag is ignored', () => {
    const k = keyCounter()
    expect(k.keyDown(4, false, 0)).toBe(1)
    for (let i = 1; i <= 300; i++) expect(k.keyDown(4, true, i * 33)).toBe(0)
  })

  it('auto-repeat: a keydown for a key already held is ignored until its keyup', () => {
    const k = keyCounter()
    expect(k.keyDown(4, false, 0)).toBe(1)
    expect(k.keyDown(4, false, 500)).toBe(0)
    expect(k.keyDown(5, false, 650)).toBe(1) // another key while 4 is held (rollover typing)
    k.keyUp(4)
    expect(k.keyDown(4, false, 900)).toBe(1)
  })

  it('same-key hammering: past 60% of the last 40 keydowns, that key credits 10%', () => {
    const k = keyCounter()
    const codes = new Array<number>(100).fill(9)
    const gaps = humanGaps(100, 3)
    let t = 0
    const credits = codes.map((code, i) => {
      t += gaps[i]!
      const c = k.keyDown(code, false, t)
      k.keyUp(code)
      return c
    })
    // 24 of 40 is exactly 60%: still fine; the 25th is over.
    expect(credits.slice(0, 24).every((c) => c === 1)).toBe(true)
    expect(credits.slice(24).every((c) => c === AG.hammering.credit)).toBe(true)
  })

  it('hammering credits only the hammered key: the other keys in between count fully', () => {
    const k = keyCounter()
    // 9 of every 10 keys are code 1: hammering; the 10th is another key.
    const codes = Array.from({ length: 200 }, (_, i) => (i % 10 === 9 ? 100 + i : 1))
    const gaps = humanGaps(200, 5)
    let t = 0
    let others = 0
    let hammered = 0
    codes.forEach((code, i) => {
      t += gaps[i]!
      const c = k.keyDown(code, false, t)
      k.keyUp(code)
      if (code === 1 && i >= 40) hammered += c
      if (code !== 1) others += c
    })
    expect(others).toBe(20)
    expect(hammered).toBeCloseTo(144 * AG.hammering.credit, 9) // 160 hammered keys after the first 40, minus 16 others
  })

  it('a key used often in ordinary typing (half the keys) is not hammering', () => {
    const codes = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 49 : i))
    expect(type(keyCounter(), codes, humanGaps(400, 11))).toBe(400)
  })

  it('robotic timing: 30 intervals with a CV under 0.08 credit 0, even with varied keys', () => {
    const k = keyCounter()
    const r = rng(2)
    const credits: number[] = []
    for (let i = 0; i < 100; i++) {
      const code = Math.floor(r() * 40)
      credits.push(k.keyDown(code, false, i * 120 + (r() - 0.5) * 10)) // ±5 ms jitter: CV ≈ 0.024
      k.keyUp(code)
    }
    // The 31st key completes 30 intervals.
    expect(credits.slice(0, 30).every((c) => c === 1)).toBe(true)
    expect(credits.slice(30).every((c) => c === 0)).toBe(true)
  })

  it('robotic timing: a human pace comes back to full credit once the intervals vary again', () => {
    const k = keyCounter()
    for (let i = 0; i < 40; i++) {
      k.keyDown(i, false, i * 100)
      k.keyUp(i)
    }
    expect(k.keyDown(99, false, 4000)).toBe(0)
    k.keyUp(99)
    const r = rng(4)
    const codes = Array.from({ length: 60 }, () => Math.floor(r() * 30) + 200)
    const gaps = humanGaps(60, 9)
    let t = 4000
    const credits = codes.map((code, i) => {
      t += gaps[i]!
      const c = k.keyDown(code, false, t)
      k.keyUp(code)
      return c
    })
    expect(credits.slice(-30).every((c) => c === 1)).toBe(true)
  })

  it('burst ceiling: at most 15 keys credited per second', () => {
    const k = keyCounter()
    const r = rng(6)
    let credited = 0
    // 40 keys within one second, irregular (CV well above 0.08), varied codes.
    let t = 0
    for (let i = 0; i < 40; i++) {
      t += 5 + 40 * r()
      if (t >= 1000) break
      credited += k.keyDown(i, false, t)
      k.keyUp(i)
    }
    expect(credited).toBe(AG.burstPerS.keys)
  })

  it('clear() forgets held keys (a keyup missed while the tap was down)', () => {
    const k = keyCounter()
    k.keyDown(4, false, 0)
    k.clear()
    expect(k.keyDown(4, false, 300)).toBe(1)
  })
})

describe('ClickCounter', () => {
  it('human clicking credits every click', () => {
    const c = clickCounter()
    const r = rng(8)
    let t = 0
    let credited = 0
    for (let i = 0; i < 200; i++) {
      t += 300 + 2000 * r()
      credited += c.click(t)
    }
    expect(credited).toBe(200)
  })

  it('an auto-clicker (fixed interval) is robotic after 30 intervals', () => {
    const c = clickCounter()
    let credited = 0
    for (let i = 0; i < 1000; i++) credited += c.click(i * 500)
    expect(credited).toBe(30)
  })

  it('burst ceiling: at most 8 clicks credited per second', () => {
    const c = clickCounter()
    const r = rng(10)
    let t = 0
    let credited = 0
    for (let i = 0; i < 20; i++) {
      t += 10 + 30 * r()
      credited += c.click(t)
    }
    expect(t).toBeLessThan(1000)
    expect(credited).toBe(AG.burstPerS.clicks)
  })
})

describe('ScrollCounter (decided 2026-10-08)', () => {
  const S = tuning.economy.scroll
  const ev = (e: Partial<ScrollEvent>): ScrollEvent => ({
    lines: 0,
    px: 0,
    linesX: 0,
    pxX: 0,
    continuous: false,
    momentum: false,
    ...e,
  })

  it('a notched wheel counts |lines| of both axes', () => {
    const s = new ScrollCounter(S)
    expect(s.scroll(ev({ lines: -3, px: -30 }), 0)).toEqual({ raw: 3, credited: 3 })
    expect(s.scroll(ev({ linesX: 2, lines: 1 }), 100)).toEqual({ raw: 3, credited: 3 })
  })

  it('a trackpad accumulates |px| of both axes into ticks of tickPt, carrying the rest', () => {
    const s = new ScrollCounter(S)
    expect(s.scroll(ev({ continuous: true, px: -(S.tickPt - 1), lines: -1 }), 0)).toEqual({ raw: 0, credited: 0 })
    expect(s.scroll(ev({ continuous: true, px: 1 }), 10)).toEqual({ raw: 1, credited: 1 })
    expect(s.scroll(ev({ continuous: true, px: S.tickPt * 1.5, pxX: -S.tickPt }), 20)).toEqual({ raw: 2, credited: 2 })
    expect(s.scroll(ev({ continuous: true, px: S.tickPt / 2 }), 30)).toEqual({ raw: 1, credited: 1 })
  })

  it('momentum and zero-delta gesture edges count nothing', () => {
    const s = new ScrollCounter(S)
    expect(s.scroll(ev({ continuous: true, momentum: true, px: 500, lines: 12 }), 0)).toEqual({ raw: 0, credited: 0 })
    expect(s.scroll(ev({ momentum: true, lines: 5 }), 0)).toEqual({ raw: 0, credited: 0 })
    expect(s.scroll(ev({ continuous: true }), 0)).toEqual({ raw: 0, credited: 0 })
    expect(s.scroll(ev({}), 0)).toEqual({ raw: 0, credited: 0 })
  })

  it('at most maxTicksPerS ticks per second', () => {
    const s = new ScrollCounter(S)
    let credited = 0
    for (let i = 0; i < 10; i++) credited += s.scroll(ev({ lines: 5 }), i * 50).credited
    expect(credited).toBe(S.maxTicksPerS)
    // A second later there's room again.
    expect(s.scroll(ev({ lines: 5 }), 1500).credited).toBe(5)
  })
})

describe('MileageCounter (jiggle)', () => {
  const J = AG.jiggle
  const STEP = 1000 / tuning.economy.cursorPollHz

  it('a mouse jiggler (tiny oscillation) earns nothing, all day', () => {
    const m = new MileageCounter(J)
    let raw = 0
    let credited = 0
    for (let i = 0; i < 20 * 3600; i++) {
      const r = m.sample(500 + (i % 2) * 8, 300 + (i % 4 < 2 ? 0 : 5), i * STEP)
      raw += r.raw
      credited += r.credited
    }
    expect(raw).toBeGreaterThan(100_000)
    expect(credited).toBe(0)
  })

  it('a slow circle inside a 40×40 box earns nothing', () => {
    const m = new MileageCounter(J)
    let credited = 0
    for (let i = 0; i < 2000; i++) {
      const a = i / 10
      credited += m.sample(800 + 19 * Math.cos(a), 400 + 19 * Math.sin(a), i * STEP).credited
    }
    expect(credited).toBe(0)
  })

  it('a real move is credited in full, its start included', () => {
    const m = new MileageCounter(J)
    let credited = 0
    // 600 pt to the right at 10 pt per sample.
    for (let i = 0; i <= 60; i++) credited += m.sample(100 + i * 10, 200, i * STEP).credited
    expect(credited).toBeCloseTo(600, 9)
  })

  it('a drift of at most minBoxPt per windowS never leaves the box: nothing', () => {
    const m = new MileageCounter(J)
    let credited = 0
    // 1 pt per sample = 20 pt/s: the 2-s box is 40 pt wide, not more.
    for (let i = 0; i <= 400; i++) credited += m.sample(i, 0, i * STEP).credited
    expect(credited).toBe(0)
  })

  it('jiggling, then a real move: the move counts, jiggle older than windowS never does', () => {
    const m = new MileageCounter(J)
    let t = 0
    for (let i = 0; i < 200; i++, t += STEP) m.sample(500 + (i % 2) * 8, 300, t)
    let credited = 0
    for (let i = 1; i <= 10; i++, t += STEP) credited += m.sample(500 + i * 20, 300, t).credited
    // 200 pt of move (the first step from 508 or 500), plus at most the window's jiggle (≤ 40 samples × 8 pt).
    expect(credited).toBeGreaterThanOrEqual(192)
    expect(credited).toBeLessThanOrEqual(200 + 40 * 8)
  })

  it('a gap longer than windowS travels nothing', () => {
    const m = new MileageCounter(J)
    m.sample(0, 0, 0)
    expect(m.sample(1000, 1000, 5000)).toEqual({ raw: 0, credited: 0 })
  })
})

describe('TreatRules (app flapping)', () => {
  const T = tuning.economy.treats
  const MIN = 60_000
  const DAY = 86_400_000

  it('first-ever, returning (not opened for returningDays) and plain launches', () => {
    const r = new TreatRules(T)
    expect(r.launch('com.a', 0, undefined)).toBe('firstEver')
    expect(r.launch('com.b', 0, -T.returningDays * DAY)).toBe('returning')
    expect(r.launch('com.c', 0, -(T.returningDays * DAY - 1))).toBe('launch')
  })

  it('relaunching the same app within the hour gives only the first launch', () => {
    const r = new TreatRules(T)
    expect(r.launch('com.a', 0, -DAY)).toBe('launch')
    for (let m = 5; m < T.relaunchWindowMin; m += 5) expect(r.launch('com.a', m * MIN, (m - 5) * MIN)).toBeNull()
    expect(r.launch('com.a', T.relaunchWindowMin * MIN, 55 * MIN)).toBe('launch')
    // Other apps are independent.
    expect(r.launch('com.b', 1, undefined)).toBe('firstEver')
  })

  it('activations at most once per app per 10 min', () => {
    const r = new TreatRules(T)
    expect(r.activate('com.a', 0)).toBe('activation')
    expect(r.activate('com.b', 1000)).toBe('activation')
    expect(r.activate('com.a', 2000)).toBeNull()
    expect(r.activate('com.a', T.activationCooldownMin * MIN - 1)).toBeNull()
    expect(r.activate('com.a', T.activationCooldownMin * MIN)).toBe('activation')
  })

  it('flapping between two apps all day earns one activation per app per 10 min', () => {
    const r = new TreatRules(T)
    let n = 0
    for (let t = 0; t < 8 * 60 * MIN; t += 3000) if (r.activate(t % 6000 === 0 ? 'com.a' : 'com.b', t)) n++
    expect(n).toBe(2 * ((8 * 60) / T.activationCooldownMin))
  })

  it('a launch starts the activation cooldown (a launch comes with an activation)', () => {
    const r = new TreatRules(T)
    r.launch('com.a', 0, undefined)
    expect(r.activate('com.a', 1000)).toBeNull()
  })
})
