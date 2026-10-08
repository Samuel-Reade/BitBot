// The pet's mode and hangout spots as the app keeps them (BITBOT_SPEC.md §10.3, §10.4, §10.5). Pure: the glue feeds it
// the pet's place and the world's window lookups; M8 saves `settings` (§16 SaveFile.behavior).
// - Roam / Stay / Hangout. ⌥⌘S toggles Stay and the mode before it (§10.5).
// - "Hang out here" makes a screen spot at the pet's place, named after where it is ("Dock, left side",
//   "Top-right"); "Hang out on <App>" an app-anchored spot at the pet's place along that app's window top (one per app:
//   choosing it again moves it). Either makes it the active spot and the mode Hangout.
// - Where a spot is now (spotPoint): a screen spot is its point; an app spot is on the app's frontmost visible window,
//   or, while the app has none, its fallback spot (else the default home), returning when the window reappears.
// - Stay remembers where it keeps the pet (the drop point, §10.4: "the drop location becomes the new stay location").

import type { PetArea, Point } from '../../shared/geometry'
import { DEFAULT_MODE_SETTINGS, type HangoutSpot, type ModeSettings, type PetMode } from '../../shared/modes'

/** What a spot's point needs from the world. */
export interface SpotLookup {
  /** The point relativeX along `bundleId`'s frontmost visible window top (WorldDriver.appSpot); null: no such window. */
  appSpot(bundleId: string, relativeX: number): Point | null
  /** The default home: the middle of the Dock unless settings chose a spot (M8). */
  defaultHome: Point
}

export interface SpotPlace {
  point: Point
  /** An app spot whose window is away: the point is its fallback. */
  fallback: boolean
}

/** A screen spot closer than this to an existing one reuses it (pt): "Hang out here" twice at one place makes one spot. */
const SAME_SPOT_PT = 24

export class ModeState {
  private s: ModeSettings
  /** The mode before Stay (⌥⌘S goes back to it). */
  private beforeStay: PetMode = 'roam'
  private nextId = 1

  constructor(initial: ModeSettings = DEFAULT_MODE_SETTINGS) {
    this.s = structuredClone(initial)
    for (const spot of this.s.hangouts) {
      const n = Number(/^spot-(\d+)$/.exec(spot.id)?.[1])
      if (Number.isFinite(n) && n >= this.nextId) this.nextId = n + 1
    }
    if (this.s.mode === 'hangout' && !this.active) this.s.mode = 'roam'
  }

  /** A copy (M8 saves it). */
  get settings(): ModeSettings {
    return structuredClone(this.s)
  }

  get mode(): PetMode {
    return this.s.mode
  }

  get spots(): readonly HangoutSpot[] {
    return this.s.hangouts
  }

  /** The active hangout spot; null: none. */
  get active(): HangoutSpot | null {
    return this.s.hangouts.find((h) => h.id === this.s.activeHangoutId) ?? null
  }

  /** Roam or Stay (Hangout needs a spot: selectSpot / hangOutHere / hangOutOnApp). */
  setMode(mode: 'roam' | 'stay', at?: Point): void {
    if (mode === 'stay') {
      if (this.s.mode !== 'stay') this.beforeStay = this.s.mode
      this.s.stayPoint = at ? { ...at } : null
    }
    this.s.mode = mode
  }

  /** §10.5 ⌥⌘S: Stay, or back to the mode before it. */
  toggleStay(at?: Point): void {
    if (this.s.mode === 'stay') this.s.mode = this.beforeStay === 'hangout' && !this.active ? 'roam' : this.beforeStay
    else this.setMode('stay', at)
  }

  /** Stay keeps the pet here from now on (a drop, §10.4; the end of a command). */
  stayAt(p: Point): void {
    if (this.s.mode === 'stay') this.s.stayPoint = { ...p }
  }

  /** "Hang out here": a screen spot at `p` (reusing one this close), active, mode Hangout. */
  hangOutHere(p: Point, displayId: number, area: PetArea): HangoutSpot {
    const same = this.s.hangouts.find((h) => h.kind === 'screen' && Math.hypot(h.x - p.x, h.y - p.y) < SAME_SPOT_PT)
    const spot = same ?? {
      id: this.newId(),
      name: this.uniqueName(screenSpotName(p, area)),
      kind: 'screen' as const,
      displayId,
      x: p.x,
      y: p.y,
    }
    if (!same) this.s.hangouts.push(spot)
    this.activate(spot.id)
    return spot
  }

  /** "Hang out on <App>": the app's spot (moved to relativeX if it exists), active, mode Hangout. */
  hangOutOnApp(bundleId: string, appName: string, relativeX: number): HangoutSpot {
    const x = Math.min(1, Math.max(0, Number.isFinite(relativeX) ? relativeX : 0.5))
    const existing = this.s.hangouts.find((h): h is Extract<HangoutSpot, { kind: 'app' }> => h.kind === 'app' && h.bundleId === bundleId)
    if (existing) {
      existing.relativeX = x
      existing.appName = appName
      this.activate(existing.id)
      return existing
    }
    const spot: HangoutSpot = {
      id: this.newId(),
      name: this.uniqueName(`On ${appName}`),
      kind: 'app',
      bundleId,
      appName,
      relativeX: x,
      fallbackId: null,
    }
    this.s.hangouts.push(spot)
    this.activate(spot.id)
    return spot
  }

  /** Hang out at an existing spot; false if there is no such spot. */
  selectSpot(id: string): boolean {
    if (!this.s.hangouts.some((h) => h.id === id)) return false
    this.activate(id)
    return true
  }

  /** Forgets a spot (an active one ends Hangout: back to Roam; fallbacks and the default home pointing at it are cleared). */
  forgetSpot(id: string): void {
    this.s.hangouts = this.s.hangouts.filter((h) => h.id !== id)
    for (const h of this.s.hangouts) if (h.kind === 'app' && h.fallbackId === id) h.fallbackId = null
    if (this.s.defaultHomeId === id) this.s.defaultHomeId = null
    if (this.s.activeHangoutId === id) {
      this.s.activeHangoutId = null
      if (this.s.mode === 'hangout') this.s.mode = 'roam'
    }
  }

  /** Where `spot` is now (see the header). */
  spotPoint(spot: HangoutSpot, lookup: SpotLookup): SpotPlace {
    if (spot.kind === 'screen') return { point: { x: spot.x, y: spot.y }, fallback: false }
    const onApp = lookup.appSpot(spot.bundleId, spot.relativeX)
    if (onApp) return { point: onApp, fallback: false }
    const fb = spot.fallbackId ? this.s.hangouts.find((h) => h.id === spot.fallbackId && h.kind === 'screen') : undefined
    return { point: fb && fb.kind === 'screen' ? { x: fb.x, y: fb.y } : { ...lookup.defaultHome }, fallback: true }
  }

  /** Where "Go home" goes (§10.4): the active spot, else the default home spot, else the default home point. */
  home(lookup: SpotLookup): Point {
    const spot = this.active ?? this.s.hangouts.find((h) => h.id === this.s.defaultHomeId) ?? null
    return spot ? this.spotPoint(spot, lookup).point : { ...lookup.defaultHome }
  }

  private activate(id: string): void {
    if (this.s.mode === 'stay') this.beforeStay = 'hangout'
    this.s.activeHangoutId = id
    this.s.mode = 'hangout'
  }

  private newId(): string {
    return `spot-${this.nextId++}`
  }

  private uniqueName(name: string): string {
    const taken = new Set(this.s.hangouts.map((h) => h.name))
    if (!taken.has(name)) return name
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`
  }
}

/**
 * A screen spot's name from where it is (§10.3 "Dock, left side", "Bottom-right corner"): on the ground, the Dock's
 * left side / middle / right side; elsewhere, its third of the area (Top-left … Bottom-right; the middle one is
 * "Middle").
 */
export function screenSpotName(p: Point, area: PetArea): string {
  const fx = area.maxX > area.minX ? (p.x - area.minX) / (area.maxX - area.minX) : 0.5
  const col = fx < 1 / 3 ? 0 : fx < 2 / 3 ? 1 : 2
  if (Math.abs(p.y - area.groundY) < 1) return ['Dock, left side', 'Dock, middle', 'Dock, right side'][col] as string
  const fy = area.groundY > area.minY ? (p.y - area.minY) / (area.groundY - area.minY) : 0.5
  const row = fy < 1 / 3 ? 0 : fy < 2 / 3 ? 1 : 2
  const rows = ['Top', 'Middle', 'Bottom']
  const cols = ['left', 'centre', 'right']
  if (row === 1 && col === 1) return 'Middle'
  return `${rows[row]}-${cols[col]}`
}
