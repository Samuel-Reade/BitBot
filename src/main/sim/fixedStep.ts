// Drift-free fixed-step clock (pure). The simulation's timebase (BITBOT_SPEC.md §5.1): real elapsed time from a
// monotonic clock is consumed in whole steps, so the simulation advances at exactly 1/stepMs on average no matter
// how late or early its timer fires. Ported from the Spike A harness.
//
// Step k produces the state that is valid at nominal time T_k = T_0 + k·stepMs. A state is computed once the time
// passed to advance() has reached its nominal time (SimLoop passes real time plus its lead), so presentation renders
// at `now − stepMs` and interpolates between the two states around that time.

export class FixedStepClock {
  private readonly origin: number
  /** Grid steps used up, computed or dropped: the newest computed state is at origin + consumed·stepMs. */
  private consumed = 0
  private steps = 0
  private dropped = 0

  constructor(
    readonly stepMs: number,
    startMs: number,
    private readonly maxStepsPerAdvance: number,
  ) {
    if (!(Number.isFinite(stepMs) && stepMs > 0)) throw new RangeError('FixedStepClock: stepMs must be a finite number > 0')
    if (!Number.isFinite(startMs)) throw new RangeError('FixedStepClock: startMs must be finite')
    if (!(Number.isInteger(maxStepsPerAdvance) && maxStepsPerAdvance >= 1)) {
      throw new RangeError('FixedStepClock: maxStepsPerAdvance must be an integer >= 1')
    }
    this.origin = startMs
  }

  /**
   * Returns the nominal times of the steps due at real time `nowMs`, oldest first, and marks them done.
   * If more than maxStepsPerAdvance are due (process stalled), the oldest excess steps are skipped
   * (time is dropped rather than replayed in a burst) and counted in `droppedSteps`.
   * A non-finite `nowMs` (a broken clock reading) is never due, so it cannot corrupt the grid.
   */
  advance(nowMs: number): number[] {
    const next = this.timeOf(this.consumed + 1)
    if (!Number.isFinite(nowMs) || nowMs < next) return []
    let due = 1 + Math.floor((nowMs - next) / this.stepMs)
    // At an exact step boundary the division can round one step either way; settle it against the step times
    // themselves, so advance() and msUntilNextStep() always agree on what is due.
    if (due > 1 && this.timeOf(this.consumed + due) > nowMs) due -= 1
    else if (this.timeOf(this.consumed + due + 1) <= nowMs) due += 1
    if (due > this.maxStepsPerAdvance) {
      const skip = due - this.maxStepsPerAdvance
      this.dropped += skip
      this.consumed += skip
      due = this.maxStepsPerAdvance
    }
    const times: number[] = []
    for (let i = 1; i <= due; i++) times.push(this.timeOf(this.consumed + i))
    this.consumed += due
    this.steps += due
    return times
  }

  /** Nominal time of the newest computed state (startMs before the first step). */
  get latestStepTime(): number {
    return this.timeOf(this.consumed)
  }

  get stepCount(): number {
    return this.steps
  }

  get droppedSteps(): number {
    return this.dropped
  }

  /**
   * Delay until the next step becomes due (>= 0). It is 0 exactly when advance(nowMs) would return a step, so right
   * after advance(nowMs) it is > 0: a loop that re-arms for it never spins on a zero delay.
   */
  msUntilNextStep(nowMs: number): number {
    return Math.max(0, this.timeOf(this.consumed + 1) - nowMs)
  }

  /** Step times come from the step index, not from repeated addition, so they never drift off the grid. */
  private timeOf(index: number): number {
    return this.origin + index * this.stepMs
  }
}
