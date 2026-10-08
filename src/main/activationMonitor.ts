// The self-reporting focus check (BITBOT_SPEC.md §2 "it must never steal focus"; docs/decisions/overlay.md "Focus, the
// gate" and manual check 1). Every app activation and window focus change is logged with the interaction in progress
// (PetInteraction.label), and after every press and every menu one verdict line says whether Bitbot became the active
// app:
//   [bitbot] drag -> Bitbot became the active app: NO (PASS)
//   [bitbot] right-click menu (chose Hide) -> Bitbot became the active app: YES (FAIL: did-become-active)
// so the manual focus check reports itself. Logged in dev and packaged builds alike: it is one line per interaction.
// The idea is the Spike A harness's focus.ts and its verdicts, rewritten for production (spike code is never imported).
//
// Interactions are found by watching the label: the glue calls observe() after every call into PetInteraction and on
// every simulation wake, so a press is seen from its 'down' to its release however short it is. A press whose label
// ever read 'drag' is reported as a drag, otherwise as a click. A verdict counts the activations from a little before
// the interaction began (AppKit would activate the app on the mouse-down itself, before the overlay's 'down' reaches
// main) until a little after it ended (menu item clicks and activations arrive late).
//
// Pure: Electron's `app` events come in through a FocusEventSource, and the clock and the timers are injected, so it
// is unit-tested (test/activationMonitor.test.ts).

import type { Scheduler } from './sim/loop'
import type { InteractionLabel } from './windows/petInteraction'

export type FocusEventName = 'did-become-active' | 'did-resign-active' | 'browser-window-focus' | 'browser-window-blur'

export const FOCUS_EVENTS: readonly FocusEventName[] = [
  'did-become-active',
  'did-resign-active',
  'browser-window-focus',
  'browser-window-blur',
]

/** True for the events that mean Bitbot took focus away from the user's app. */
export function isActivation(name: FocusEventName): boolean {
  return name === 'did-become-active' || name === 'browser-window-focus'
}

/** Electron's `app` through a small adapter (its overloaded on/off don't take a union of event names). */
export interface FocusEventSource {
  on(name: FocusEventName, listener: () => void): void
  off(name: FocusEventName, listener: () => void): void
}

export interface FocusEntry {
  /** Monotonic ms. */
  tMs: number
  event: FocusEventName
  /** The interaction in progress when it happened. */
  interaction: InteractionLabel
}

/** The activation events among `entries` at or after `sinceMs`, oldest first. */
export function activationsSince(entries: readonly FocusEntry[], sinceMs: number): FocusEventName[] {
  return entries.filter((e) => e.tMs >= sinceMs && isActivation(e.event)).map((e) => e.event)
}

/** The verdict for one interaction, e.g. "click -> Bitbot became the active app: NO (PASS)". */
export function verdictLine(what: string, activations: readonly FocusEventName[]): string {
  const answer = activations.length > 0 ? `YES (FAIL: ${activations.join(', ')})` : 'NO (PASS)'
  return `${what} -> Bitbot became the active app: ${answer}`
}

export interface ActivationVerdict {
  what: string
  becameActive: boolean
  events: FocusEventName[]
}

/** For the dev check. */
export interface ActivationCounters {
  /** Focus events seen since start(), by name. */
  events: Record<FocusEventName, number>
  /** did-become-active and browser-window-focus events seen. */
  activations: number
  verdicts: number
  passes: number
  fails: number
  /** Interactions that ended and whose verdict is still waiting for its delay. */
  pending: number
  last: ActivationVerdict | null
}

export interface ActivationMonitorOptions {
  source: FocusEventSource
  /** Monotonic ms (the simulation's clock). */
  now(): number
  scheduler: Scheduler
  /** The interaction in progress (PetInteraction.label), for the focus-event lines. */
  label(): InteractionLabel
  log(line: string): void
  /** tuning.app.activationVerdictDelayMs */
  verdictDelayMs: number
  /** tuning.app.activationLookBackMs */
  lookBackMs: number
  /** tuning.app.activationEventCap */
  eventCap: number
}

interface Ongoing {
  kind: 'press' | 'menu'
  startedAt: number
  dragged: boolean
  choice: string | null
  /** The choice opens a Bitbot window the user asked for (Settings…): activating Bitbot is expected. */
  opensWindow?: boolean
}

interface Pending {
  ended: Ongoing
  handle: unknown
}

export class ActivationMonitor {
  private readonly entries: FocusEntry[] = []
  private readonly detach: (() => void)[] = []
  private readonly pending = new Set<Pending>()
  private ongoing: Ongoing | null = null
  private readonly counts: Omit<ActivationCounters, 'pending'> = {
    events: { 'did-become-active': 0, 'did-resign-active': 0, 'browser-window-focus': 0, 'browser-window-blur': 0 },
    activations: 0,
    verdicts: 0,
    passes: 0,
    fails: 0,
    last: null,
  }

  constructor(private readonly opts: ActivationMonitorOptions) {}

  /** Starts listening to the app's focus events. Idempotent. */
  start(): void {
    if (this.detach.length > 0) return
    for (const name of FOCUS_EVENTS) {
      const listener = (): void => this.onFocusEvent(name)
      this.opts.source.on(name, listener)
      this.detach.push(() => this.opts.source.off(name, listener))
    }
  }

  /** Stops listening and drops verdicts not printed yet. */
  stop(): void {
    for (const off of this.detach.splice(0)) {
      try {
        off()
      } catch {
        // Already gone (quitting).
      }
    }
    for (const p of this.pending) this.opts.scheduler.clearTimeout(p.handle)
    this.pending.clear()
  }

  /** The interaction label right after a call into PetInteraction: presses and menus begin and end here. */
  observe(label: InteractionLabel): void {
    const pressing = label === 'press' || label === 'drag'
    const menu = label === 'menu'
    const ongoing = this.ongoing
    if (ongoing) {
      if (ongoing.kind === 'press' && pressing) {
        if (label === 'drag') ongoing.dragged = true
        return
      }
      if (ongoing.kind === 'menu' && menu) return
      this.ongoing = null
      this.ended(ongoing)
    }
    if (pressing || menu) {
      this.ongoing = { kind: pressing ? 'press' : 'menu', startedAt: this.opts.now(), dragged: label === 'drag', choice: null }
    }
  }

  /**
   * A pet menu item was chosen (its click arrives after the menu closed): named in that menu's verdict. `opensWindow`:
   * it opens a window the user asked for (Settings…), which takes focus by design (§15.3), so activating is no failure.
   */
  menuChoice(item: string, opensWindow = false): void {
    if (this.ongoing?.kind === 'menu') {
      this.ongoing.choice = item
      this.ongoing.opensWindow = opensWindow
      return
    }
    let latest: Pending | null = null
    for (const p of this.pending) if (p.ended.kind === 'menu' && (!latest || p.ended.startedAt >= latest.ended.startedAt)) latest = p
    if (latest) {
      latest.ended.choice = item
      latest.ended.opensWindow = opensWindow
    }
  }

  get counters(): ActivationCounters {
    const c = this.counts
    const last = c.last ? { ...c.last, events: [...c.last.events] } : null
    return { ...c, events: { ...c.events }, pending: this.pending.size, last }
  }

  /** The focus events kept (newest last), for the dev check. */
  get focusEvents(): readonly FocusEntry[] {
    return this.entries.map((e) => ({ ...e }))
  }

  private onFocusEvent(event: FocusEventName): void {
    const interaction = this.safeLabel()
    this.entries.push({ tMs: this.opts.now(), event, interaction })
    while (this.entries.length > Math.max(1, this.opts.eventCap)) this.entries.shift()
    this.counts.events[event]++
    if (isActivation(event)) this.counts.activations++
    this.log(`[bitbot] focus: ${event} (interaction: ${interaction})`)
  }

  private ended(ongoing: Ongoing): void {
    const pending: Pending = { ended: ongoing, handle: undefined }
    pending.handle = this.opts.scheduler.setTimeout(() => this.verdict(pending), this.opts.verdictDelayMs)
    this.pending.add(pending)
  }

  private verdict(pending: Pending): void {
    if (!this.pending.delete(pending)) return
    const { ended } = pending
    const chosen = ended.choice ? `chose ${ended.choice}` : 'nothing chosen'
    const what = ended.kind === 'menu' ? `right-click menu (${chosen})` : ended.dragged ? 'drag' : 'click'
    const events = activationsSince(this.entries, ended.startedAt - this.opts.lookBackMs)
    const becameActive = events.length > 0
    if (ended.opensWindow === true) {
      // Not a verdict: the user asked for a window, and showing it activates Bitbot.
      this.log(`[bitbot] ${what} -> opens a Bitbot window: activating is expected${becameActive ? ` (${events.join(', ')})` : ''}`)
      return
    }
    this.counts.verdicts++
    if (becameActive) this.counts.fails++
    else this.counts.passes++
    this.counts.last = { what, becameActive, events }
    this.log(`[bitbot] ${verdictLine(what, events)}`)
  }

  private safeLabel(): InteractionLabel {
    try {
      return this.opts.label()
    } catch {
      return 'none'
    }
  }

  private log(line: string): void {
    try {
      this.opts.log(line)
    } catch {
      // Nowhere left to report it.
    }
  }
}
