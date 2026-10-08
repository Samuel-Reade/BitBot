// Pure event counting for the Spike B input harness (unit-tested in test/spikeB-input.test.ts).
//
// Privacy (§2, §7.3): only counts leave this module. Key codes are used transiently for the held-key
// set (to cross-check the helper's auto-repeat flag, like §7.3's anti-gaming) and are never stored
// anywhere else, returned, formatted, logged or persisted. Mouse buttons are counted by index only.

import type { InputMsg } from '../../helper/protocol'

export interface InputCounts {
  keyDown: number
  keyUp: number
  /** Key downs the helper flagged as auto-repeat. */
  keyRepeat: number
  mouseDown: { left: number; right: number; other: number }
  scroll: {
    /** Every CG scroll event. */
    events: number
    /** Trackpad / Magic Mouse. */
    continuous: number
    /** Inertia after the fingers lifted: not a user action. */
    momentum: number
    /** All deltas zero: a gesture begin/end edge, not a scroll. */
    zeroDelta: number
    /** Any horizontal component. */
    horizontal: number
  }
  /** The helper's repeat flag vs the held-key set; both should stay 0. */
  repeatDisagreements: {
    /** Flagged repeat for a key that is not held (a keyUp went missing, or the flag is wrong). */
    flaggedNotHeld: number
    /** A second down for a held key without the repeat flag. */
    heldNotFlagged: number
  }
}

export function emptyCounts(): InputCounts {
  return {
    keyDown: 0,
    keyUp: 0,
    keyRepeat: 0,
    mouseDown: { left: 0, right: 0, other: 0 },
    scroll: { events: 0, continuous: 0, momentum: 0, zeroDelta: 0, horizontal: 0 },
    repeatDisagreements: { flaggedNotHeld: 0, heldNotFlagged: 0 },
  }
}

function addCounts(into: InputCounts, from: InputCounts): void {
  into.keyDown += from.keyDown
  into.keyUp += from.keyUp
  into.keyRepeat += from.keyRepeat
  into.mouseDown.left += from.mouseDown.left
  into.mouseDown.right += from.mouseDown.right
  into.mouseDown.other += from.mouseDown.other
  into.scroll.events += from.scroll.events
  into.scroll.continuous += from.scroll.continuous
  into.scroll.momentum += from.scroll.momentum
  into.scroll.zeroDelta += from.scroll.zeroDelta
  into.scroll.horizontal += from.scroll.horizontal
  into.repeatDisagreements.flaggedNotHeld += from.repeatDisagreements.flaggedNotHeld
  into.repeatDisagreements.heldNotFlagged += from.repeatDisagreements.heldNotFlagged
}

export function totalEvents(counts: InputCounts): number {
  const m = counts.mouseDown
  return counts.keyDown + counts.keyUp + m.left + m.right + m.other + counts.scroll.events
}

/** One line of counts. Contains no key codes (there are none in InputCounts). */
export function formatCounts(counts: InputCounts): string {
  const m = counts.mouseDown
  const s = counts.scroll
  const d = counts.repeatDisagreements
  return (
    `keys down ${counts.keyDown} (repeat ${counts.keyRepeat}) up ${counts.keyUp} · ` +
    `clicks left ${m.left} right ${m.right} other ${m.other} · ` +
    `scroll ${s.events} (continuous ${s.continuous}, momentum ${s.momentum}, zero-delta ${s.zeroDelta}, horizontal ${s.horizontal}) · ` +
    `repeat-flag disagreements ${d.flaggedNotHeld}/${d.heldNotFlagged}`
  )
}

/** Counts for the current report interval plus the run total. */
abstract class IntervalCounter {
  protected interval: InputCounts = emptyCounts()
  private readonly totals: InputCounts = emptyCounts()

  /** The interval's counts; starts a new interval. */
  takeInterval(): InputCounts {
    const taken = this.interval
    addCounts(this.totals, taken)
    this.interval = emptyCounts()
    return taken
  }

  /** Everything counted so far (including the open interval). */
  get total(): InputCounts {
    const total = emptyCounts()
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
    super()
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
          if (message.repeat && !wasHeld) d.flaggedNotHeld += 1
          if (!message.repeat && wasHeld) d.heldNotFlagged += 1
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
        if (message.continuous) s.continuous += 1
        if (message.momentum) s.momentum += 1
        if (message.lines === 0 && message.px === 0 && message.linesX === 0 && message.pxX === 0) s.zeroDelta += 1
        if (message.linesX !== 0 || message.pxX !== 0) s.horizontal += 1
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
