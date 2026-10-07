// Ctrl+C / SIGTERM handling for the Spike A harness (pure; unit-tested).
//
// One Ctrl+C in a terminal reaches Electron twice, a few ms apart: the terminal sends SIGINT to the
// whole foreground process group (node_modules/electron/cli.js, Electron and its helpers), and cli.js
// forwards every SIGINT/SIGTERM it gets to Electron again. So the first signal starts a clean finish
// (results are written), repeats within `graceMs` of it are that same key press and are ignored, and
// only a later one (a deliberate second Ctrl+C while results are being written) forces an exit.

export type SignalAction = 'finish' | 'ignore' | 'force-exit'

export class SignalGate {
  private firstMs: number | null = null

  constructor(private readonly graceMs: number) {}

  /** What to do about a termination signal received at `nowMs`. */
  onSignal(nowMs: number): SignalAction {
    if (this.firstMs === null) {
      this.firstMs = nowMs
      return 'finish'
    }
    return nowMs - this.firstMs < this.graceMs ? 'ignore' : 'force-exit'
  }
}
