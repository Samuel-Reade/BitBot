import { describe, expect, it } from 'vitest'
import type { SummaryLedger } from '../src/main/summary'
import { SummaryBubble, type SummaryBubbleTuning } from '../src/main/summaryBubble'
import { CURRENCIES } from '../src/shared/economy'
import type { Box, Rect } from '../src/shared/geometry'
import type { PetBubbleMsg } from '../src/shared/petProtocol'
import { tuning } from '../src/shared/tuning'

// The daily summary bubble's lifecycle in main (src/main/summaryBubble.ts): due or not, the delay, waiting until it
// can be seen, the 12 s timer, the click, hide, the overlay's size report and the box for the grab area.

const T: SummaryBubbleTuning = { autoDismissMs: 12_000, showDelayMs: 2_500 }
const PET: Box = { left: -60, top: -130, right: 60, bottom: 4 }
const OVERLAY: Rect = { x: 0, y: 0, width: 1600, height: 1000 }

/** Yesterday (the 7th) Bitbot ate crumbs and pellets; the ledger has rolled to the 8th. */
function ledger(): SummaryLedger {
  const perCurrency = {} as SummaryLedger['perCurrency']
  for (const c of CURRENCIES) {
    const earned = c === 'crumbs' ? 4000 : c === 'pellets' ? 300 : 0
    perCurrency[c] = { lifetimeEarned: earned + 1, today: 0, dailyHistory: [{ day: '2026-10-06', earned: 1 }, { day: '2026-10-07', earned }] }
  }
  return { perCurrency, currentDay: '2026-10-08' }
}

class Harness {
  now = 0
  today = '2026-10-08'
  lastShown: string | null = '2026-10-07'
  canShow = true
  overlay: Rect | null = OVERLAY
  ledgerValue: SummaryLedger = ledger()
  failLedger = false
  readonly sent: PetBubbleMsg[] = []
  readonly marked: string[] = []
  readonly logs: string[] = []
  private timers: { at: number; fn: () => void; id: number }[] = []
  private nextTimer = 1
  readonly bubble: SummaryBubble

  constructor() {
    this.bubble = new SummaryBubble(
      {
        ledger: () => {
          if (this.failLedger) throw new Error('no ledger')
          return this.ledgerValue
        },
        today: () => this.today,
        lastShownDay: () => this.lastShown,
        markShown: (day) => {
          this.marked.push(day)
          this.lastShown = day
        },
        canShow: () => this.canShow,
        send: (msg) => this.sent.push(msg),
        overlayBounds: () => this.overlay,
        setTimer: (fn, ms) => {
          const id = this.nextTimer++
          this.timers.push({ at: this.now + ms, fn, id })
          return id
        },
        clearTimer: (handle) => {
          this.timers = this.timers.filter((t) => t.id !== handle)
        },
        random: () => 0,
        log: (line) => this.logs.push(line),
      },
      T,
    )
  }

  /** Advances the clock, running due timers in order. */
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((t) => t !== due)
      this.now = due.at
      due.fn()
    }
    this.now = end
  }

  get pendingTimers(): number {
    return this.timers.length
  }
}

describe('SummaryBubble', () => {
  it('production tuning is a SummaryBubbleTuning', () => {
    const production: SummaryBubbleTuning = tuning.ui.summary
    expect(production.autoDismissMs).toBe(12_000) // §9.4
  })

  it('a due trigger shows the summary after the delay, marks the day and dismisses it after 12 s', () => {
    const h = new Harness()
    h.bubble.trigger('wake')
    expect(h.sent).toEqual([])
    h.advance(T.showDelayMs - 1)
    expect(h.sent).toEqual([])
    h.advance(1)
    expect(h.sent).toEqual([{ id: 1, text: 'Yesterday I ate 4,000 crumbs and 300 pellets. Yum!' }])
    expect(h.marked).toEqual(['2026-10-08'])
    expect(h.bubble.showing).toBe(true)
    expect(h.bubble.currentId).toBe(1)
    h.advance(T.autoDismissMs - 1)
    expect(h.sent).toHaveLength(1)
    h.advance(1)
    expect(h.sent.at(-1)).toEqual({ id: 1, hide: true })
    expect(h.bubble.showing).toBe(false)
    expect(h.pendingTimers).toBe(0)
  })

  it('once a day: later triggers the same day do nothing, the next day shows again', () => {
    const h = new Harness()
    h.bubble.trigger('launch')
    h.advance(20_000)
    expect(h.sent).toHaveLength(2)
    h.bubble.trigger('wake')
    h.bubble.trigger('unlock')
    h.advance(20_000)
    expect(h.sent).toHaveLength(2)
    h.today = '2026-10-09'
    h.bubble.trigger('unlock')
    h.advance(T.showDelayMs)
    expect(h.sent).toHaveLength(3)
    expect(h.marked).toEqual(['2026-10-08', '2026-10-09'])
  })

  it('not due when already shown today', () => {
    const h = new Harness()
    h.lastShown = '2026-10-08'
    h.bubble.trigger('wake')
    h.advance(20_000)
    expect(h.sent).toEqual([])
    expect(h.pendingTimers).toBe(0)
  })

  it('nothing to say: the day is marked done at once and nothing is shown', () => {
    const h = new Harness()
    h.ledgerValue = { ...ledger(), perCurrency: Object.fromEntries(CURRENCIES.map((c) => [c, { lifetimeEarned: 0, today: 0, dailyHistory: [] }])) as unknown as SummaryLedger['perCurrency'] }
    h.bubble.trigger('launch')
    expect(h.marked).toEqual(['2026-10-08'])
    h.advance(20_000)
    expect(h.sent).toEqual([])
  })

  it('waits while it can’t be seen (locked, hidden, fullscreen) and shows on the next retry', () => {
    const h = new Harness()
    h.canShow = false
    h.bubble.trigger('wake')
    h.advance(60_000)
    expect(h.sent).toEqual([])
    expect(h.marked).toEqual([])
    h.bubble.retry() // still can't: tries again after the delay, then waits again
    h.advance(T.showDelayMs)
    expect(h.sent).toEqual([])
    h.canShow = true
    h.bubble.retry()
    expect(h.sent).toEqual([]) // the delay again: the screen just became visible
    h.advance(T.showDelayMs)
    expect(h.sent).toHaveLength(1)
    expect(h.marked).toEqual(['2026-10-08'])
  })

  it('a pending summary from a day that has passed is dropped; the next trigger works out a new one', () => {
    const h = new Harness()
    h.canShow = false
    h.bubble.trigger('wake')
    h.advance(T.showDelayMs)
    h.today = '2026-10-09'
    h.canShow = true
    h.bubble.retry()
    h.advance(T.showDelayMs)
    expect(h.sent).toEqual([])
    h.bubble.trigger('unlock')
    h.advance(T.showDelayMs)
    expect(h.sent).toHaveLength(1)
    expect(h.marked).toEqual(['2026-10-09'])
  })

  it('repeated triggers and retries schedule one show', () => {
    const h = new Harness()
    h.bubble.trigger('wake')
    h.bubble.trigger('unlock')
    h.bubble.retry()
    h.bubble.retry()
    expect(h.pendingTimers).toBe(1)
    h.advance(T.showDelayMs)
    expect(h.sent).toHaveLength(1)
  })

  it('a click dismisses it at once and cancels the timer; a second click does nothing', () => {
    const h = new Harness()
    h.bubble.trigger('wake')
    h.advance(T.showDelayMs + 1000)
    h.bubble.clicked()
    expect(h.sent.at(-1)).toEqual({ id: 1, hide: true })
    expect(h.pendingTimers).toBe(0)
    h.bubble.clicked()
    h.advance(20_000)
    expect(h.sent).toHaveLength(2)
  })

  it('hide() takes it down (page lost, hidden, sleep); the day stays done', () => {
    const h = new Harness()
    h.bubble.trigger('wake')
    h.advance(T.showDelayMs)
    h.bubble.hide('the overlay page went away')
    expect(h.sent.at(-1)).toEqual({ id: 1, hide: true })
    h.bubble.retry()
    h.bubble.trigger('wake')
    h.advance(20_000)
    expect(h.sent).toHaveLength(2)
    h.bubble.hide('again') // nothing up: nothing sent
    expect(h.sent).toHaveLength(2)
  })

  it('boxAt: null until the overlay reports the current bubble’s size, then the laid-out box; null again once down', () => {
    const h = new Harness()
    const ground = { x: 800, y: 900 }
    expect(h.bubble.boxAt(ground, PET)).toBeNull()
    h.bubble.trigger('wake')
    h.advance(T.showDelayMs)
    expect(h.bubble.boxAt(ground, PET)).toBeNull() // no size yet
    h.bubble.onShown({ id: 99, width: 220, height: 56 }) // another bubble's
    expect(h.bubble.boxAt(ground, PET)).toBeNull()
    h.bubble.onShown({ id: 1, width: 0, height: 56 }) // malformed
    expect(h.bubble.boxAt(ground, PET)).toBeNull()
    expect(h.logs.some((l) => l.includes('malformed pet:bubble-shown'))).toBe(true)
    h.bubble.onShown({ id: 1, width: 220, height: 56 })
    const box = h.bubble.boxAt(ground, PET)
    expect(box).not.toBeNull()
    expect(box?.bottom).toBeLessThan(PET.top) // above the pet
    expect(box && box.right - box.left).toBe(220)
    h.overlay = null
    expect(h.bubble.boxAt(ground, PET)).toBeNull()
    h.overlay = OVERLAY
    h.bubble.clicked()
    expect(h.bubble.boxAt(ground, PET)).toBeNull()
    h.bubble.onShown({ id: 1, width: 220, height: 56 }) // late, after it went down
    expect(h.bubble.boxAt(ground, PET)).toBeNull()
  })

  it('never throws at its caller; a failure is logged', () => {
    const h = new Harness()
    h.failLedger = true
    expect(() => h.bubble.trigger('wake')).not.toThrow()
    expect(h.logs.some((l) => l.includes('trigger failed: no ledger'))).toBe(true)
    expect(() => h.bubble.onShown(null)).not.toThrow()
  })

  it('dispose cancels everything', () => {
    const h = new Harness()
    h.bubble.trigger('wake')
    h.bubble.dispose()
    expect(h.pendingTimers).toBe(0)
    h.bubble.trigger('wake') // a new day's work after dispose is allowed (tests only)
    h.bubble.dispose()
  })
})
