// Pure event counting for the Spike B input harness (unit-tested in test/spikeB-input.test.ts).
//
// Privacy (§2, §7.3): only counts leave this module. Key codes are used transiently for the held-key
// set (to cross-check the helper's auto-repeat flag, like §7.3's anti-gaming) and are never stored
// anywhere else, returned, formatted, logged or persisted. Mouse buttons are counted by index only.
//
// The two sources do not see the same scroll events (libuiohook src/darwin/input_hook.c,
// process_mouse_wheel): uiohook dispatches a wheel event only when the integer line delta
// (kCGScrollWheelEventDeltaAxis1 or Axis2) is non-zero, so sub-line trackpad scrolls and gesture
// begin/end edges never arrive, it labels a scroll with both axes vertical, and uiohook-napi exposes
// no continuous/momentum flag. Counts a source cannot observe are null (not 0), so a 0 is always data.
// Comparable between the sources: keys, clicks, and notched-wheel scrolls (one event per notch in both).

import type { InputMsg } from '../../helper/protocol'

export type CountSource = 'helper' | 'uiohook'

export interface InputCounts {
  keyDown: number
  keyUp: number
  /** Key downs that were auto-repeat: the helper's flag, or (uiohook) a down for a key already held. */
  keyRepeat: number
  mouseDown: { left: number; right: number; other: number }
  scroll: {
    /** helper: every CG scroll event; uiohook: only events with a whole-line delta (see above). */
    events: number
    /** Trackpad / Magic Mouse. null = the source cannot tell (uiohook). */
    continuous: number | null
    /** Inertia after the fingers lifted: not a user action. null = the source cannot tell (uiohook). */
    momentum: number | null
    /** All deltas zero: a gesture begin/end edge, not a scroll. null = never delivered (uiohook). */
    zeroDelta: number | null
    /** Any horizontal component. null = not comparable (uiohook labels diagonal scrolls vertical). */
    horizontal: number | null
  }
  /**
   * helper only: its repeat flag vs the held-key set; both should stay 0. null for uiohook, whose
   * repeats are derived from that same set, so there is nothing to disagree with.
   */
  repeatDisagreements: {
    /** Flagged repeat for a key that is not held (a keyUp went missing, or the flag is wrong). */
    flaggedNotHeld: number
    /** A second down for a held key without the repeat flag. */
    heldNotFlagged: number
  } | null
}

export function emptyCounts(source: CountSource): InputCounts {
  const helper = source === 'helper'
  const breakdown = helper ? 0 : null
  return {
    keyDown: 0,
    keyUp: 0,
    keyRepeat: 0,
    mouseDown: { left: 0, right: 0, other: 0 },
    scroll: { events: 0, continuous: breakdown, momentum: breakdown, zeroDelta: breakdown, horizontal: breakdown },
    repeatDisagreements: helper ? { flaggedNotHeld: 0, heldNotFlagged: 0 } : null,
  }
}

/** Sum of two counts of which either may be unobservable (null + null stays null). */
function addMaybe(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0)
}

function addCounts(into: InputCounts, from: InputCounts): void {
  into.keyDown += from.keyDown
  into.keyUp += from.keyUp
  into.keyRepeat += from.keyRepeat
  into.mouseDown.left += from.mouseDown.left
  into.mouseDown.right += from.mouseDown.right
  into.mouseDown.other += from.mouseDown.other
  into.scroll.events += from.scroll.events
  into.scroll.continuous = addMaybe(into.scroll.continuous, from.scroll.continuous)
  into.scroll.momentum = addMaybe(into.scroll.momentum, from.scroll.momentum)
  into.scroll.zeroDelta = addMaybe(into.scroll.zeroDelta, from.scroll.zeroDelta)
  into.scroll.horizontal = addMaybe(into.scroll.horizontal, from.scroll.horizontal)
  if (from.repeatDisagreements) {
    const d = into.repeatDisagreements ?? { flaggedNotHeld: 0, heldNotFlagged: 0 }
    d.flaggedNotHeld += from.repeatDisagreements.flaggedNotHeld
    d.heldNotFlagged += from.repeatDisagreements.heldNotFlagged
    into.repeatDisagreements = d
  }
}

export function totalEvents(counts: InputCounts): number {
  const m = counts.mouseDown
  return counts.keyDown + counts.keyUp + m.left + m.right + m.other + counts.scroll.events
}

/** One line of counts. Contains no key codes (there are none in InputCounts); unobservable counts are left out. */
export function formatCounts(counts: InputCounts): string {
  const m = counts.mouseDown
  const s = counts.scroll
  const breakdown = (
    [
      ['continuous', s.continuous],
      ['momentum', s.momentum],
      ['zero-delta', s.zeroDelta],
      ['horizontal', s.horizontal],
    ] as const
  )
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label} ${value}`)
  const d = counts.repeatDisagreements
  return (
    `keys down ${counts.keyDown} (repeat ${counts.keyRepeat}) up ${counts.keyUp} · ` +
    `clicks left ${m.left} right ${m.right} other ${m.other} · ` +
    `scroll ${s.events} (${breakdown.length > 0 ? breakdown.join(', ') : 'whole-line events only, no breakdown'})` +
    (d ? ` · repeat-flag disagreements ${d.flaggedNotHeld}/${d.heldNotFlagged}` : '')
  )
}

/** Counts for the current report interval plus the run total. */
abstract class IntervalCounter {
  protected interval: InputCounts
  private readonly totals: InputCounts

  constructor(private readonly source: CountSource) {
    this.interval = emptyCounts(source)
    this.totals = emptyCounts(source)
  }

  /** The interval's counts; starts a new interval. */
  takeInterval(): InputCounts {
    const taken = this.interval
    addCounts(this.totals, taken)
    this.interval = emptyCounts(this.source)
    return taken
  }

  /** Everything counted so far (including the open interval). */
  get total(): InputCounts {
    const total = emptyCounts(this.source)
    addCounts(total, this.totals)
    addCounts(total, this.interval)
    return total
  }
}

export interface AgeStats {
  /** Event age at receipt (ms), capped sample. */
  samplesMs: number[]
  /** Ages below -0.01 s or above maxPlausibleS: the timestamp unit or clock is off. */
  implausible: number
}

/** bitbot-helper `input` messages (protocol v2). */
export class HelperInputCounter extends IntervalCounter {
  /** Codes of keys currently down. Transient (§7.3); never exposed. */
  private readonly held = new Set<number>()
  readonly ages: AgeStats = { samplesMs: [], implausible: 0 }

  constructor(
    private readonly maxPlausibleAgeS: number,
    private readonly ageSampleCap: number,
  ) {
    super('helper')
  }

  /** `receivedAtS`: unix seconds when main received the line (for the event-age check of the ts unit). */
  record(message: InputMsg, receivedAtS: number): void {
    const c = this.interval
    switch (message.kind) {
      case 'key': {
        if (message.down) {
          const wasHeld = this.held.has(message.code)
          c.keyDown += 1
          if (message.repeat) c.keyRepeat += 1
          const d = c.repeatDisagreements
          if (d && message.repeat && !wasHeld) d.flaggedNotHeld += 1
          if (d && !message.repeat && wasHeld) d.heldNotFlagged += 1
          this.held.add(message.code)
        } else {
          c.keyUp += 1
          this.held.delete(message.code)
        }
        break
      }
      case 'mouseDown': {
        if (message.button === 0) c.mouseDown.left += 1
        else if (message.button === 1) c.mouseDown.right += 1
        else c.mouseDown.other += 1
        break
      }
      case 'scroll': {
        const s = c.scroll
        s.events += 1
        if (message.continuous) s.continuous = (s.continuous ?? 0) + 1
        if (message.momentum) s.momentum = (s.momentum ?? 0) + 1
        if (message.lines === 0 && message.px === 0 && message.linesX === 0 && message.pxX === 0) s.zeroDelta = (s.zeroDelta ?? 0) + 1
        if (message.linesX !== 0 || message.pxX !== 0) s.horizontal = (s.horizontal ?? 0) + 1
        break
      }
    }
    const ageS = receivedAtS - message.ts
    if (ageS < -0.01 || ageS > this.maxPlausibleAgeS) this.ages.implausible += 1
    else if (this.ages.samplesMs.length < this.ageSampleCap) this.ages.samplesMs.push(ageS * 1000)
  }

  /** Forget held keys (the tap stopped, so their key-ups will never arrive). */
  clearHeld(): void {
    this.held.clear()
  }
}

/**
 * uiohook-napi events. libuiohook reports auto-repeat as plain keydowns, so a keydown for a key that is
 * already held counts as a repeat. Its mouse buttons are 1-based (1 left, 2 right, 3+ other). Its wheel
 * events are counted, nothing more (see the header: no comparable breakdown exists).
 */
export class UiohookInputCounter extends IntervalCounter {
  /** Codes of keys currently down. Transient (§7.3); never exposed. */
  private readonly held = new Set<number>()

  constructor() {
    super('uiohook')
  }

  keydown(keycode: number): void {
    this.interval.keyDown += 1
    if (this.held.has(keycode)) this.interval.keyRepeat += 1
    this.held.add(keycode)
  }

  keyup(keycode: number): void {
    this.interval.keyUp += 1
    this.held.delete(keycode)
  }

  mousedown(button: unknown): void {
    if (button === 1) this.interval.mouseDown.left += 1
    else if (button === 2) this.interval.mouseDown.right += 1
    else this.interval.mouseDown.other += 1
  }

  wheel(): void {
    this.interval.scroll.events += 1
  }
}
