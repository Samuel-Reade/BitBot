/** Append-only Float64 sample buffer with a hard cap (renderer-side twin of main's SampleSeries). */
export class Series {
  private data: Float64Array
  private count = 0
  private droppedCount = 0

  constructor(private readonly cap: number) {
    this.data = new Float64Array(Math.min(cap, 4096))
  }

  push(value: number): void {
    if (this.count >= this.cap) {
      this.droppedCount++
      return
    }
    if (this.count === this.data.length) {
      const grown = new Float64Array(Math.min(this.cap, this.data.length * 2))
      grown.set(this.data)
      this.data = grown
    }
    this.data[this.count++] = value
  }

  get dropped(): number {
    return this.droppedCount
  }

  toArray(): number[] {
    return Array.from(this.data.subarray(0, this.count))
  }

  reset(): void {
    this.count = 0
    this.droppedCount = 0
  }
}
