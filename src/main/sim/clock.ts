// Time sources (BITBOT_SPEC.md §14.2). Pure modules never call Date.now() or performance.now() themselves: they
// take a Clock, so tests drive time by hand and the dev panel's time scale (§14.1) can be applied in one place.

export interface Clock {
  /** Monotonic ms (does not advance while the Mac sleeps). Drives the simulation. */
  now(): number
  /** Epoch ms: wall-clock time, which jumps when the user or the system changes the time. For calendar rules (§7.4). */
  wallNow(): number
}

/** The real clocks: performance.now() (on macOS it stands still while the Mac sleeps) and Date.now(). */
export const systemClock: Clock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
}
