// Anti-gaming: raw activity → credited units (BITBOT_SPEC.md §7.3, scroll ticks decided 2026-10-08). Everything here
// is transient, in memory, over sliding windows: key codes, timing traces and cursor positions live only in these
// objects and are never part of the economy's state (§2). Only the resulting counts are kept.
//
//   KeyCounter     auto-repeat (the repeat flag, or a key already held: a Set cleared on keyup) → ignored;
//                  same-key hammering (one code over share of the last `window` keydowns) → those keys at `credit`;
//                  robotic timing (CV of the last `intervals` inter-key intervals under minCv) → 0;
//                  burst ceiling (keys per second) → the rest 0.
//   ClickCounter   robotic timing and the burst ceiling, for clicks (no hammering rule for clicks in §7.3).
//   ScrollCounter  wheel: |lines| of both axes; continuous (trackpad): |px| of both axes in ticks of tickPt;
//                  momentum and zero deltas: nothing; at most maxTicksPerS.
//   MileageCounter mouse travel, credited only while the cursor's bounding box over the last windowS exceeds
//                  minBoxPt in width or height (a jiggle inside a minBoxPt square earns nothing).
//   TreatRules     app flapping: an activation at most once per app per activationCooldownMin; a relaunch within
//                  relaunchWindowMin of the last credited launch gives nothing; first-ever / returning / plain.
//
// Times are epoch ms from the caller's clock. Pure (no clock of its own).

/** Population coefficient of variation (σ / μ); Infinity for a zero mean (no regularity to speak of). */
export function coefficientOfVariation(xs: readonly number[]): number {
  if (xs.length === 0) return Infinity
  let sum = 0
  for (const x of xs) sum += x
  const mean = sum / xs.length
  if (!(mean > 0)) return Infinity
  let sq = 0
  for (const x of xs) sq += (x - mean) * (x - mean)
  return Math.sqrt(sq / xs.length) / mean
}

export interface RoboticParams {
  intervals: number
  minCv: number
}

/** The last n inter-event intervals; robotic once full and too regular (§7.3). */
class IntervalWindow {
  private last: number | null = null
  private readonly intervals: number[] = []

  constructor(private readonly params: RoboticParams) {}

  /** Records an event at t; true if the interval history now looks machine-made. */
  push(t: number): boolean {
    if (this.last !== null) {
      this.intervals.push(Math.max(0, t - this.last))
      if (this.intervals.length > this.params.intervals) this.intervals.shift()
    }
    this.last = t
    return this.intervals.length >= this.params.intervals && coefficientOfVariation(this.intervals) < this.params.minCv
  }

  clear(): void {
    this.last = null
    this.intervals.length = 0
  }
}

/** Credited amounts in the trailing second; at most perS (§7.3 burst ceiling, the scroll cap). */
class PerSecondCap {
  private readonly events: { t: number; n: number }[] = []
  private sum = 0

  constructor(private readonly perS: number) {}

  /** Admits up to n units at t; returns how many fit under the cap. */
  admit(t: number, n: number): number {
    while (this.events.length > 0 && this.events[0]!.t <= t - 1000) this.sum -= this.events.shift()!.n
    const fit = Math.max(0, Math.min(n, this.perS - this.sum))
    if (fit > 0) {
      this.events.push({ t, n: fit })
      this.sum += fit
    }
    return fit
  }

  clear(): void {
    this.events.length = 0
    this.sum = 0
  }
}

export interface KeyParams {
  hammering: { window: number; share: number; credit: number }
  robotic: RoboticParams
  burstPerS: number
}

export class KeyCounter {
  /** Keys down now (auto-repeat detection). Transient. */
  private readonly held = new Set<number>()
  /** The last hammering.window keydown codes. Transient. */
  private readonly recent: number[] = []
  private readonly timing: IntervalWindow
  private readonly burst: PerSecondCap

  constructor(private readonly params: KeyParams) {
    this.timing = new IntervalWindow(params.robotic)
    this.burst = new PerSecondCap(params.burstPerS)
  }

  /** A keydown at t: the credit (0 ignored or rejected, hammering.credit hammered, 1 a good key). */
  keyDown(code: number, repeat: boolean, t: number): number {
    if (repeat || this.held.has(code)) return 0
    this.held.add(code)
    const { window, share, credit } = this.params.hammering
    this.recent.push(code)
    if (this.recent.length > window) this.recent.shift()
    const robotic = this.timing.push(t)
    if (robotic) return 0
    // Out of the full window (missing keydowns count as other keys), so the first few keys of a session can't trip it.
    let same = 0
    for (const c of this.recent) if (c === code) same++
    const c = same / window > share ? credit : 1
    return this.burst.admit(t, 1) > 0 ? c : 0
  }

  keyUp(code: number): void {
    this.held.delete(code)
  }

  /** Forget everything (the tap stopped: keyups may never arrive). */
  clear(): void {
    this.held.clear()
    this.recent.length = 0
    this.timing.clear()
    this.burst.clear()
  }
}

export interface ClickParams {
  robotic: RoboticParams
  burstPerS: number
}

export class ClickCounter {
  private readonly timing: IntervalWindow
  private readonly burst: PerSecondCap

  constructor(params: ClickParams) {
    this.timing = new IntervalWindow(params.robotic)
    this.burst = new PerSecondCap(params.burstPerS)
  }

  /** A click at t: its credit, 0 or 1. */
  click(t: number): number {
    if (this.timing.push(t)) return 0
    return this.burst.admit(t, 1)
  }

  clear(): void {
    this.timing.clear()
    this.burst.clear()
  }
}

export interface ScrollEvent {
  lines: number
  px: number
  linesX: number
  pxX: number
  continuous: boolean
  momentum: boolean
}

export interface ScrollParams {
  tickPt: number
  maxTicksPerS: number
}

export class ScrollCounter {
  /** Continuous scrolling not yet worth a tick, pt. */
  private carryPt = 0
  private readonly cap: PerSecondCap

  constructor(private readonly params: ScrollParams) {
    this.cap = new PerSecondCap(params.maxTicksPerS)
  }

  /** A scroll event at t: its ticks before (raw) and after (credited) the per-second cap. */
  scroll(s: ScrollEvent, t: number): { raw: number; credited: number } {
    if (s.momentum) return { raw: 0, credited: 0 }
    let ticks: number
    if (s.continuous) {
      this.carryPt += Math.abs(s.px) + Math.abs(s.pxX)
      ticks = this.params.tickPt > 0 ? Math.floor(this.carryPt / this.params.tickPt) : 0
      this.carryPt -= ticks * this.params.tickPt
    } else {
      ticks = Math.abs(s.lines) + Math.abs(s.linesX)
    }
    if (!(ticks > 0)) return { raw: 0, credited: 0 }
    return { raw: ticks, credited: this.cap.admit(t, ticks) }
  }

  clear(): void {
    this.carryPt = 0
    this.cap.clear()
  }
}

export interface JiggleParams {
  windowS: number
  minBoxPt: number
}

export class MileageCounter {
  /** Cursor samples of the last windowS (positions: transient). d: travel from the previous sample. */
  private readonly samples: { t: number; x: number; y: number; d: number; credited: boolean }[] = []

  constructor(private readonly params: JiggleParams) {}

  /**
   * A cursor sample at t: the pt travelled since the last sample (raw) and the pt credited now. While the box is small
   * the travel waits; once the box over the window exceeds minBoxPt, the waiting travel still in the window is
   * credited too, so the start of a real move isn't lost. A sample more than windowS after the previous one travels 0
   * (a gap: sleep, a display change).
   */
  sample(x: number, y: number, t: number): { raw: number; credited: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { raw: 0, credited: 0 }
    const windowMs = this.params.windowS * 1000
    const prev = this.samples[this.samples.length - 1]
    const d = prev && t - prev.t <= windowMs && t >= prev.t ? Math.hypot(x - prev.x, y - prev.y) : 0
    this.samples.push({ t, x, y, d, credited: false })
    while (this.samples.length > 1 && this.samples[0]!.t < t - windowMs) this.samples.shift()
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const s of this.samples) {
      if (s.x < minX) minX = s.x
      if (s.x > maxX) maxX = s.x
      if (s.y < minY) minY = s.y
      if (s.y > maxY) maxY = s.y
    }
    let credited = 0
    if (maxX - minX > this.params.minBoxPt || maxY - minY > this.params.minBoxPt) {
      for (const s of this.samples) {
        if (!s.credited) {
          credited += s.d
          s.credited = true
        }
      }
    }
    return { raw: d, credited }
  }

  clear(): void {
    this.samples.length = 0
  }
}

export type TreatKind = 'firstEver' | 'returning' | 'launch' | 'activation'

export interface TreatParams {
  activationCooldownMin: number
  relaunchWindowMin: number
  returningDays: number
}

export class TreatRules {
  /** bundleId → the last credited launch / activation, epoch ms. Transient (lost on restart: at most one extra treat). */
  private readonly lastLaunch = new Map<string, number>()
  private readonly lastActivation = new Map<string, number>()

  constructor(private readonly params: TreatParams) {}

  /**
   * An app launched at t; lastOpenedMs from knownBundleIds (undefined: never seen). The treat it earns, or null within
   * relaunchWindowMin of the last credited launch. A credited launch also starts the activation cooldown (a launch
   * comes with an activation).
   */
  launch(bundleId: string, t: number, lastOpenedMs: number | undefined): TreatKind | null {
    const relaunchMs = this.params.relaunchWindowMin * 60_000
    prune(this.lastLaunch, t, relaunchMs)
    const last = this.lastLaunch.get(bundleId)
    if (last !== undefined && t - last < relaunchMs) return null
    this.lastLaunch.set(bundleId, t)
    this.lastActivation.set(bundleId, t)
    if (lastOpenedMs === undefined || !Number.isFinite(lastOpenedMs)) return 'firstEver'
    return t - lastOpenedMs >= this.params.returningDays * 86_400_000 ? 'returning' : 'launch'
  }

  /** Switched to an app at t: 'activation', or null within activationCooldownMin of its last credited one. */
  activate(bundleId: string, t: number): 'activation' | null {
    const cooldownMs = this.params.activationCooldownMin * 60_000
    prune(this.lastActivation, t, cooldownMs)
    const last = this.lastActivation.get(bundleId)
    if (last !== undefined && t - last < cooldownMs) return null
    this.lastActivation.set(bundleId, t)
    return 'activation'
  }
}

/** Drops entries older than ms (keeps the maps to the apps used recently). */
function prune(map: Map<string, number>, t: number, ms: number): void {
  for (const [k, at] of map) if (t - at >= ms) map.delete(k)
}
