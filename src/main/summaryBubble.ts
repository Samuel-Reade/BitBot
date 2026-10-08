// The daily summary bubble's lifecycle in main (BITBOT_SPEC.md §9.4): when it is due, when it goes up, its 12-second
// timer, the click, and the box the grab area must cover while it is up. The words come from summary.ts; the overlay
// draws it (src/renderer/pet/bubble.ts) and reports its measured size (pet:bubble-shown). Pure: the ledger, the save,
// the overlay, the clock and timers are injected (test/summaryBubble.test.ts).
//
// - trigger(wake | unlock | launch): if the summary is due (shouldShowSummary) its text is worked out now and kept
//   pending; it goes up showDelayMs later, once canShow() (overlay shown and drawn, nothing fullscreen, screen
//   unlocked). While it can't, it waits: retry() (pet:ready, shown again, unlocked, fullscreen left) tries again.
//   A day with nothing to say is marked done at once, so it isn't worked out again until the next day.
// - Up: pet:bubble {id, text}; the day is marked shown (SaveFile.meta.lastSummaryShownDay) when it is sent. Main owns
//   the timer (autoDismissMs from then): the grab area is main's, so it shrinks back the moment main hides the bubble,
//   whatever the overlay does.
// - Down: the timer, a click (PetInteraction.bubbleClicked), or hide() (the overlay page went away, hidden by the
//   user, sleep, lock): pet:bubble {id, hide: true}; boxAt() is null from then on.
// - boxAt(): null until the overlay reports the bubble's size for the current id; then the box layoutBubble gives,
//   relative to the ground point, for PetInteraction's bubbleBox.

import type { Box, Point, Rect } from '../shared/geometry'
import { bubbleBoxRelative, layoutBubble, type BubbleSize } from '../shared/bubbleLayout'
import { isPetBubbleShownMsg, type PetBubbleMsg } from '../shared/petProtocol'
import { tuning } from '../shared/tuning'
import { shouldShowSummary, summaryFor, type SummaryLedger, type SummaryTrigger } from './summary'

export interface SummaryBubbleDeps {
  /** The economy's ledger (Economy.state.economy: rolled over to today first). */
  ledger(): SummaryLedger
  /** The economy's day, 'YYYY-MM-DD' with the 4 AM rollover (Economy.snapshot().day). */
  today(): string
  /** SaveFile.meta.lastSummaryShownDay (null: never). */
  lastShownDay(): string | null
  /** Records SaveFile.meta.lastSummaryShownDay = day (and saves). */
  markShown(day: string): void
  /** The bubble can be seen now: the overlay shown by the user and drawn, nothing fullscreen, the screen unlocked. */
  canShow(): boolean
  /** pet:bubble to the overlay. */
  send(msg: PetBubbleMsg): void
  /** The overlay's bounds, global pt (PetConfig.overlay as last sent); null before the first configuration. */
  overlayBounds(): Rect | null
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  random(): number
  log(line: string): void
}

export interface SummaryBubbleTuning {
  autoDismissMs: number
  showDelayMs: number
}

interface Shown {
  id: number
  size: BubbleSize | null
  timer: unknown
}

export class SummaryBubble {
  private pending: { shownFor: string; text: string } | null = null
  private delay: unknown = null
  private shown: Shown | null = null
  private nextId = 1

  constructor(
    private readonly deps: SummaryBubbleDeps,
    private readonly t: SummaryBubbleTuning = tuning.ui.summary,
  ) {}

  /** A bubble is up (sent and not hidden yet). */
  get showing(): boolean {
    return this.shown !== null
  }

  /** The id of the bubble that is up, or null. */
  get currentId(): number | null {
    return this.shown?.id ?? null
  }

  /** A wake, unlock or app launch: works out today's summary if it is due and schedules it. */
  trigger(kind: SummaryTrigger): void {
    this.guard('trigger', () => {
      const today = this.deps.today()
      if (this.shown || this.pending?.shownFor === today) {
        this.schedule()
        return
      }
      if (!shouldShowSummary({ today, lastSummaryShownDay: this.deps.lastShownDay(), trigger: kind })) return
      const summary = summaryFor(this.deps.ledger(), today, () => this.deps.random())
      if (!summary) {
        this.pending = null
        this.deps.markShown(today)
        this.deps.log(`[bitbot] daily summary (${kind}): nothing to say for ${today}`)
        return
      }
      this.pending = { shownFor: summary.shownFor, text: summary.text }
      this.deps.log(`[bitbot] daily summary (${kind}): ${summary.kind} line for ${summary.day}, due in ${this.t.showDelayMs} ms`)
      this.schedule()
    })
  }

  /** Something that kept a pending summary from showing may have changed (pet:ready, shown again, unlock…). */
  retry(): void {
    this.guard('retry', () => this.schedule())
  }

  /** pet:bubble-shown from the overlay (validated here): the size main lays the bubble out with. */
  onShown(raw: unknown): void {
    this.guard('onShown', () => {
      if (!isPetBubbleShownMsg(raw)) {
        this.deps.log('[bitbot] overlay: ignored a malformed pet:bubble-shown')
        return
      }
      const shown = this.shown
      if (!shown || raw.id !== shown.id) return // an old bubble's late answer
      shown.size = { width: raw.width, height: raw.height }
    })
  }

  /** The user clicked the bubble (PetInteraction's bubbleClicked). */
  clicked(): void {
    this.guard('clicked', () => this.dismiss('clicked'))
  }

  /**
   * Takes the bubble down now (the overlay page went away, hidden by the user, sleep, lock, quit). A pending summary
   * stays pending (it shows after the next retry), but one that was already up isn't shown again: its day is done.
   */
  hide(reason: string): void {
    this.guard('hide', () => this.dismiss(reason))
  }

  /**
   * The bubble's box relative to the ground point, for a pet drawn at `ground` with `petBox` (PetInteraction's
   * bubbleBox); null while no bubble is up, until the overlay reported its size, or before the overlay's bounds are
   * known.
   */
  boxAt(ground: Point, petBox: Box): Box | null {
    const size = this.shown?.size
    const overlay = this.deps.overlayBounds()
    if (!size || !overlay) return null
    const layout = layoutBubble(ground, petBox, size, overlay)
    return layout ? bubbleBoxRelative(layout, ground) : null
  }

  /** Cancels the timers (quit). */
  dispose(): void {
    this.clearDelay()
    if (this.shown) this.deps.clearTimer(this.shown.timer)
    this.shown = null
    this.pending = null
  }

  // ── internals ──

  private schedule(): void {
    if (!this.pending || this.shown || this.delay !== null) return
    this.delay = this.deps.setTimer(() => this.guard('show', () => this.showNow()), this.t.showDelayMs)
  }

  private showNow(): void {
    this.delay = null
    const pending = this.pending
    if (!pending || this.shown) return
    if (pending.shownFor !== this.deps.today()) {
      // The day moved on while it waited: yesterday's summary is stale; the next trigger works out a new one.
      this.pending = null
      return
    }
    if (!this.deps.canShow()) return // retry() tries again
    this.pending = null
    const id = this.nextId++
    const timer = this.deps.setTimer(() => this.guard('timeout', () => this.dismiss('timed out', id)), this.t.autoDismissMs)
    this.shown = { id, size: null, timer }
    this.deps.markShown(pending.shownFor)
    this.deps.send({ id, text: pending.text })
    this.deps.log(`[bitbot] daily summary shown (bubble ${id}): "${pending.text}"`)
  }

  /** Hides the bubble that is up (only bubble `id`, when given). */
  private dismiss(reason: string, id?: number): void {
    const shown = this.shown
    if (!shown || (id !== undefined && shown.id !== id)) return
    this.shown = null
    this.deps.clearTimer(shown.timer)
    this.deps.send({ id: shown.id, hide: true })
    this.deps.log(`[bitbot] daily summary bubble ${shown.id} dismissed (${reason})`)
  }

  private clearDelay(): void {
    if (this.delay !== null) this.deps.clearTimer(this.delay)
    this.delay = null
  }

  /** Never throws at its caller (IPC handlers, timers, power events): a failure is logged and the bubble taken down. */
  private guard(what: string, body: () => void): void {
    try {
      body()
    } catch (err) {
      try {
        this.deps.log(`[bitbot] daily summary: ${what} failed: ${err instanceof Error ? err.message : String(err)}`)
        const shown = this.shown
        this.shown = null
        if (shown) {
          this.deps.clearTimer(shown.timer)
          this.deps.send({ id: shown.id, hide: true })
        }
      } catch {
        // Nothing more to do.
      }
    }
  }
}
