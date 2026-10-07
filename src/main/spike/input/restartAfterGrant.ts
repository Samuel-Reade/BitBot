// §15.1 "macOS may require relaunching after granting": with the helper architecture a fresh helper
// process may be enough, which would turn "Relaunch Bitbot" into an invisible helper restart. This probe
// answers that for the Spike B input harness. No Electron imports: unit-tested in test/spikeB-input.test.ts.
//
// Flow (driven by the harness): the grant is detected → the tap is retried once in the same helper
// process → if macOS refuses it ('tapCreateFailed') the probe SIGTERMs the helper; HelperClient sees an
// unexpected exit, respawns it after its backoff and re-applies the tap configuration, and the outcome
// arrives as an 'inputTap' event with id null (onReapplied).

import type { InputTapMsg } from '../../helper/protocol'
import type { CheckStatus } from '../windows/checks'

export const RESTART_AFTER_GRANT = 'helper restart after grant (fresh helper process, same app)'

export type RetryFollowUp = 'notNeeded' | 'restartHelper' | 'none'

/** What follows the same-process retry: nothing to test, a helper restart, or nothing (another failure). */
export function followUpAfterRetry(reply: Pick<InputTapMsg, 'active' | 'reason'>): RetryFollowUp {
  if (reply.active) return 'notNeeded'
  return reply.reason === 'tapCreateFailed' ? 'restartHelper' : 'none'
}

export interface RestartProbeDeps {
  kill: (pid: number, signal: 'SIGTERM') => void
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  nowMs: () => number
  /** The running helper's pid (the new one once HelperClient has respawned it). */
  currentPid: () => number | null
  record: (name: string, status: CheckStatus, detail: string) => void
  log: (line: string) => void
}

export interface RestartProbeState {
  oldPid: number
  newPid: number | null
  result: { active: boolean; reason: InputTapMsg['reason']; error: string | null; afterMs: number } | null
  failure: string | null
  done: boolean
}

export class RestartAfterGrantProbe {
  private current: RestartProbeState | null = null
  private startedAtMs = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deps: RestartProbeDeps,
    private readonly timeoutMs: number,
  ) {}

  /** The probe's record for the results file (null when it never ran). */
  get state(): RestartProbeState | null {
    return this.current ? { ...this.current } : null
  }

  get pending(): boolean {
    return this.current !== null && !this.current.done
  }

  /** Records 'not needed' (the same-process retry worked). */
  notNeeded(): void {
    this.deps.record(RESTART_AFTER_GRANT, 'SKIP', 'not needed: the tap started in the same helper process')
  }

  /** Restarts the helper `pid`; at most once per run. */
  start(pid: number): void {
    if (this.current) return
    this.current = { oldPid: pid, newPid: null, result: null, failure: null, done: false }
    this.startedAtMs = this.deps.nowMs()
    this.deps.log(
      `${RESTART_AFTER_GRANT}: SIGTERM helper pid ${pid}; HelperClient respawns it and re-applies the tap ` +
        `(waiting up to ${this.timeoutMs} ms)`,
    )
    this.timer = this.deps.setTimer(() => this.finish(null, `no re-applied tap within ${this.timeoutMs} ms`), this.timeoutMs)
    try {
      this.deps.kill(pid, 'SIGTERM')
    } catch (err) {
      this.finish(null, `SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** A tap re-applied by HelperClient after a restart (inputTap with id null). Ignored unless pending. */
  onReapplied(message: InputTapMsg): void {
    if (this.pending) this.finish(message, null)
  }

  /** The run is ending before a result arrived: inconclusive, not a failure. */
  abort(reason: string): void {
    if (this.pending) this.finish(null, reason, true)
  }

  private finish(message: InputTapMsg | null, failure: string | null, inconclusive = false): void {
    const state = this.current
    if (!state || state.done) return
    state.done = true
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    state.newPid = this.deps.currentPid()
    const afterMs = Math.round(this.deps.nowMs() - this.startedAtMs)
    state.failure = failure
    if (message) state.result = { active: message.active, reason: message.reason, error: message.error, afterMs }
    if (inconclusive) {
      this.deps.record(RESTART_AFTER_GRANT, 'WARN', `inconclusive: ${failure ?? 'stopped'} ${afterMs} ms after the SIGTERM`)
      return
    }
    if (message?.active) {
      this.deps.record(
        RESTART_AFTER_GRANT,
        'PASS',
        `the re-applied tap is active in the new helper pid ${state.newPid ?? '-'} ${afterMs} ms after the SIGTERM: a helper ` +
          'restart is enough, the app itself needs no relaunch (§15.1)',
      )
      return
    }
    const why = message
      ? `the re-applied tap in helper pid ${state.newPid ?? '-'} is inactive: reason=${message.reason ?? '-'} error=${message.error ?? '-'}`
      : (failure ?? 'no result')
    this.deps.record(RESTART_AFTER_GRANT, 'FAIL', `${why} — the app itself needs a relaunch (§15.1 "Relaunch Bitbot"); confirm with test 2`)
  }
}
