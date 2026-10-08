// The pet's life clock (§9 "updated using real elapsed time", §14.1 "time scale … applied to the simulation clock so a
// 'day' can be tested in minutes"): real time × the dev panel's time scale, continuous across scale changes (changing
// the scale never jumps the clock). The needs and the brain's timers run on it; movement and the economy's local days
// stay on real time. Pure: the real clock is injected.

export class LifeClock {
  private baseLifeS: number
  private baseRealMs: number
  private factor = 1

  constructor(private readonly realNowMs: () => number) {
    this.baseRealMs = realNowMs()
    this.baseLifeS = this.baseRealMs / 1000
  }

  /** Life-clock seconds now. Starts at real time (s); runs `scale` times faster since the last setScale. */
  now(): number {
    return this.baseLifeS + ((this.realNowMs() - this.baseRealMs) / 1000) * this.factor
  }

  get scale(): number {
    return this.factor
  }

  setScale(scale: number): void {
    if (!(Number.isFinite(scale) && scale > 0) || scale === this.factor) return
    this.baseLifeS = this.now()
    this.baseRealMs = this.realNowMs()
    this.factor = scale
  }
}
