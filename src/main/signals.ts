// Ctrl+C / SIGTERM handling for the running app (pure; unit-tested in test/appSupport.test.ts). The idea is the Spike A
// harness's signals.ts, rewritten for production (spike code is never imported).
//
// One Ctrl+C in a terminal reaches Electron twice, a few ms apart: the terminal sends SIGINT to the whole foreground
// process group (node_modules/electron/cli.js, Electron and its helpers), and cli.js forwards every SIGINT/SIGTERM it
// gets to Electron again. So the first signal starts a clean quit, repeats within `graceMs` of it are that same key
// press and are ignored, and only a later one (a deliberate second Ctrl+C while the quit hangs) exits at once.

export type SignalAction = 'quit' | 'ignore' | 'force-exit'

export class SignalGate {
  private firstMs: number | null = null

  constructor(private readonly graceMs: number) {}

  /** What to do about a termination signal received at `nowMs` (monotonic ms). */
  onSignal(nowMs: number): SignalAction {
    if (this.firstMs === null) {
      this.firstMs = nowMs
      return 'quit'
    }
    return nowMs - this.firstMs < this.graceMs ? 'ignore' : 'force-exit'
  }
}
