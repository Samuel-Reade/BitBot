// Drift-free fixed-step clock (pure; unit-tested). Mirrors the production loop in BITBOT_SPEC.md §5.1:
// real elapsed time from a monotonic clock is accumulated and consumed in whole steps, so the
// simulation advances at exactly 1/stepMs on average no matter how late or early the timer fires.
//
// Step k produces the state that is valid at nominal time T_k = T_0 + k·stepMs. A state is only
// computed once real time has reached its nominal time, so presentation renders at `now − stepMs`
// and interpolates between the two latest states.

export class FixedStepClock {
  private latest: number
  private steps = 0
  private dropped = 0

  constructor(
    readonly stepMs: number,
    startMs: number,
    private readonly maxStepsPerAdvance: number,
  ) {
    if (!(stepMs > 0)) throw new Error('FixedStepClock: stepMs must be > 0')
    if (!(maxStepsPerAdvance >= 1)) throw new Error('FixedStepClock: maxStepsPerAdvance must be >= 1')
    this.latest = startMs
  }

  /**
   * Returns the nominal times of the steps due at real time `nowMs`, oldest first, and marks them done.
   * If more than maxStepsPerAdvance are due (process stalled), the oldest excess steps are skipped
   * (time is dropped rather than replayed in a burst) and counted in `droppedSteps`.
   */
  advance(nowMs: number): number[] {
    let due = Math.floor((nowMs - this.latest) / this.stepMs)
    if (due <= 0) return []
    if (due > this.maxStepsPerAdvance) {
      const skip = due - this.maxStepsPerAdvance
      this.dropped += skip
      this.latest += skip * this.stepMs
      due = this.maxStepsPerAdvance
    }
    const times: number[] = []
    for (let i = 1; i <= due; i++) times.push(this.latest + i * this.stepMs)
    this.latest += due * this.stepMs
    this.steps += due
    return times
  }

  /** Nominal time of the newest computed state. */
  get latestStepTime(): number {
    return this.latest
  }

  get stepCount(): number {
    return this.steps
  }

  get droppedSteps(): number {
    return this.dropped
  }

  /** Delay until the next step becomes due (>= 0). */
  msUntilNextStep(nowMs: number): number {
    return Math.max(0, this.latest + this.stepMs - nowMs)
  }
}
