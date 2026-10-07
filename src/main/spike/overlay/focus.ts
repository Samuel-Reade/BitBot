import { app } from 'electron'

// Logs every app activation / window focus change with the interaction in progress, so the
// "never steals focus" rule (§2.2, §5.2) can be checked per interaction.

export type FocusEventName = 'did-become-active' | 'did-resign-active' | 'browser-window-focus' | 'browser-window-blur'

export interface FocusEvent {
  /** Harness clock (performance.now()), ms. */
  tMs: number
  event: FocusEventName
  interaction: string
}

/** Events that mean Bitbot took focus away from the user's app. */
const ACTIVATION_EVENTS: ReadonlySet<FocusEventName> = new Set<FocusEventName>(['did-become-active', 'browser-window-focus'])

export class FocusMonitor {
  readonly events: FocusEvent[] = []
  private readonly detach: (() => void)[] = []

  constructor(
    private readonly now: () => number,
    private readonly interaction: () => string,
    private readonly onEvent: (event: FocusEvent) => void,
  ) {}

  start(): void {
    const names: FocusEventName[] = ['did-become-active', 'did-resign-active', 'browser-window-focus', 'browser-window-blur']
    for (const name of names) {
      const listener = (): void => {
        const entry: FocusEvent = { tMs: this.now(), event: name, interaction: this.interaction() }
        this.events.push(entry)
        this.onEvent(entry)
      }
      // The app event overloads differ only in listener arguments, which we ignore.
      app.on(name as 'did-become-active', listener)
      this.detach.push(() => app.off(name as 'did-become-active', listener))
    }
  }

  stop(): void {
    for (const off of this.detach.splice(0)) off()
  }

  /** Activation events (app became active / our window got focus) at or after `sinceMs`. */
  activationsSince(sinceMs: number): FocusEvent[] {
    return this.events.filter((e) => e.tMs >= sinceMs && ACTIVATION_EVENTS.has(e.event))
  }

  get activationCount(): number {
    return this.events.filter((e) => ACTIVATION_EVENTS.has(e.event)).length
  }
}
