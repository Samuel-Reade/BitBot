// The world as the running app keeps it (BITBOT_SPEC.md §8, §5.3, §11; milestone 3): bitbot-helper's window
// snapshots become the World (sim/world/worldModel.ts) the pet moves through, each one handed to Locomotion (riding,
// falling, re-planning). Pure (no Electron): BitbotApp feeds it and wires its outputs; unit-tested with fakes
// (test/worldDriver.test.ts).
// - The scene: the primary display and the pet's measured box decide the area; a change rebuilds the world.
// - Snapshot rate (snapshotRate.ts, decided adaptive): normal, fast while the ridden window moves, none while hidden.
// - The dev panel's actions send the pet somewhere once (sim/brain/wander.ts pickTarget), or stop it. (What the pet
//   does by itself is the brain's, petLife.ts.)
// - The debug view (debug:world, dev builds): sent when the world or the route changes while it is shown.

import type { DevPanelAction, DevWorldStatus } from '../../shared/devPanel'
import type { Box, Point } from '../../shared/geometry'
import { tuning } from '../../shared/tuning'
import type { DebugWorldMsg } from '../../shared/world'
import type { HelperWindow } from '../helper/protocol'
import { pickTarget, type WanderKind } from './brain/wander'
import type { Locomotion } from './locomotion/locomotion'
import type { DisplayGeometry } from './world/screenArea'
import { snapshotHz } from './world/snapshotRate'
import { buildWorld, type World, type WorldParams } from './world/worldModel'

export interface WorldDriverDeps {
  params: WorldParams
  /** bitbot-helper's push rate (HelperClient.setPollRate); called only when it changes. */
  setPollRate(hz: number): void
  /** debug:world to the overlay (dev builds; null in packaged builds: nothing is ever sent). */
  sendDebug: ((msg: DebugWorldMsg) => void) | null
  random(): number
}

const HIDDEN_DEBUG: DebugWorldMsg = { show: false, segments: [], walls: [], links: [], path: [], windows: [] }

export class WorldDriver {
  private display: DisplayGeometry | null = null
  private petBox: Box | null = null
  private windows: readonly HelperWindow[] = []
  private current: World | null = null
  private hz: number | null = null
  private rideMovedAtMs = Number.NEGATIVE_INFINITY
  private hidden = false
  private asleep = false
  private showWorld = false
  private debugKey: string | null = null
  private params: WorldParams
  constructor(private readonly deps: WorldDriverDeps) {
    this.params = deps.params
  }

  /** The pet's size changed (§15.4): the next scene (the reloaded page's pet:ready → setScene) uses these. */
  setParams(params: WorldParams): void {
    this.params = params
  }

  /** The newest world; null until the scene is known. */
  get world(): World | null {
    return this.current
  }

  /** The snapshot rate asked of the helper (null: none asked yet). */
  get snapshotHz(): number | null {
    return this.hz
  }

  /**
   * The primary display or the pet's box (re)known: builds the world from them and the newest windows, and hands it to
   * `loco` (null before the pet exists). Returns the world (to construct the pet with).
   */
  setScene(display: DisplayGeometry, petBox: Box, loco: Locomotion | null, tMs: number): World {
    this.display = display
    this.petBox = petBox
    const world = buildWorld(display, petBox, this.windows, this.params)
    this.current = world
    loco?.setWorld(world, tMs)
    return world
  }

  /** A snapshot pushed by the helper (or answered on request): the world as it is now. */
  onSnapshot(windows: readonly HelperWindow[], tMs: number, loco: Locomotion | null): void {
    this.windows = windows
    if (!this.display || !this.petBox) return
    const world = buildWorld(this.display, this.petBox, windows, this.params)
    this.current = world
    if (loco && loco.setWorld(world, tMs).ridingMoved) this.rideMovedAtMs = tMs
    this.updateRate(tMs, loco)
  }

  setHidden(hidden: boolean, tMs: number, loco: Locomotion | null): void {
    this.hidden = hidden
    this.updateRate(tMs, loco)
  }

  /** The pet sleeps (§9.3): snapshots at the asleep rate. */
  setAsleep(asleep: boolean, tMs: number, loco: Locomotion | null): void {
    if (asleep === this.asleep) return
    this.asleep = asleep
    this.updateRate(tMs, loco)
  }

  /** The dev panel's "show world". Off sends one hidden message. */
  setShowWorld(on: boolean): void {
    if (on === this.showWorld) return
    this.showWorld = on
    this.debugKey = null
    if (!on) this.deps.sendDebug?.(HIDDEN_DEBUG)
  }

  /** A new overlay page: the debug view (if shown) is sent again. */
  pageReady(): void {
    this.debugKey = null
  }

  /** Every simulation wake: the snapshot rate, the debug view. */
  tick(nowMs: number, loco: Locomotion | null): void {
    this.updateRate(nowMs, loco)
    this.sendDebug(loco)
  }

  /**
   * Where "go eat" goes (§10.2): the middle of the visible top of the frontmost eligible window (the helper lists
   * windows front to back, so this is the frontmost app's); null: no window top to stand on.
   */
  foodSpot(): Point | null {
    return this.topOf((w) => this.current?.windows.has(w.wid) === true)
  }

  /** The top of `bundleId`'s frontmost window (§10.2 run to the launched app's window); null: none (yet). */
  windowTopFor(bundleId: string): Point | null {
    return this.topOf((w) => w.bundleId === bundleId && this.current?.windows.has(w.wid) === true)
  }

  /**
   * An app-anchored hangout spot now (§10.3): relativeX (0 left .. 1 right) along the frame of `bundleId`'s frontmost
   * eligible window, moved onto the nearest visible piece of its top; null: the app has no window top to stand on.
   */
  appSpot(bundleId: string, relativeX: number): Point | null {
    const world = this.current
    if (!world) return null
    for (const w of this.windows) {
      if (w.bundleId !== bundleId || !world.windows.has(w.wid)) continue
      const tops = world.segments.filter((s) => s.windowId === w.wid)
      if (tops.length === 0) continue
      const want = w.x + relativeX * w.w
      let best: Point | null = null
      for (const s of tops) {
        const p = { x: Math.min(s.x1, Math.max(s.x0, want)), y: s.y }
        if (!best || Math.abs(p.x - want) < Math.abs(best.x - want)) best = p
      }
      return best
    }
    return null
  }

  /**
   * The app window the pet stands on (for "Hang out on <App>"): its bundle ID and pid, and how far along its frame the
   * pet is (0..1); null: on the ground, in the air, or on a window without a bundle ID.
   */
  standingOn(loco: Locomotion | null): { bundleId: string; pid: number; relativeX: number } | null {
    const world = this.current
    const surface = loco?.state.surface
    if (!world || !surface) return null
    const seg = world.segments.find((s) => s.id === surface)
    const w = seg?.windowId == null ? undefined : this.windows.find((x) => x.wid === seg.windowId)
    if (!w || !w.bundleId || w.w <= 0) return null
    return { bundleId: w.bundleId, pid: w.pid, relativeX: Math.min(1, Math.max(0, (loco.state.x - w.x) / w.w)) }
  }

  private topOf(match: (w: HelperWindow) => boolean): Point | null {
    const world = this.current
    if (!world) return null
    for (const w of this.windows) {
      if (!match(w)) continue
      const tops = world.segments.filter((s) => s.windowId === w.wid)
      if (tops.length === 0) continue
      // The widest visible piece of its top.
      const top = tops.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a))
      return { x: (top.x0 + top.x1) / 2, y: top.y }
    }
    return null
  }

  /** The dev panel's one-off actions. */
  action(action: DevPanelAction, loco: Locomotion | null): void {
    const world = this.current
    if (!loco || !world) return
    if (action === 'stop') {
      loco.stop()
      return
    }
    const kind: WanderKind = action === 'goWindow' ? 'window' : action === 'climbWall' ? 'wall' : 'any'
    const s = loco.state
    const target = pickTarget(kind, world, { x: s.x, y: s.y }, this.deps.random, tuning.brain.wander.minDistancePt)
    if (target) loco.goTo(target)
  }

  status(loco: Locomotion | null): DevWorldStatus | null {
    const world = this.current
    if (!world) return null
    const goal = loco?.goal ?? null
    return {
      windows: world.windows.size,
      segments: world.segments.length,
      walls: world.walls.length,
      snapshotHz: this.hz ?? 0,
      surface: loco?.state.surface ?? null,
      goal: goal ? { x: goal.x, y: goal.y } : null,
    }
  }

  private updateRate(nowMs: number, loco: Locomotion | null): void {
    if (!loco) return
    const hz = snapshotHz(
      {
        hidden: this.hidden,
        riding: loco.state.windowId !== null,
        sinceRideMovedS: (nowMs - this.rideMovedAtMs) / 1000,
        asleep: this.asleep,
      },
      tuning.world,
    )
    if (hz === this.hz) return
    this.hz = hz
    this.deps.setPollRate(hz)
  }

  private sendDebug(loco: Locomotion | null): void {
    const send = this.deps.sendDebug
    const world = this.current
    if (!send || !this.showWorld || !world) return
    const path: Point[] = loco?.route?.points.map((p) => ({ x: p.x, y: p.y })) ?? []
    const key = `${world.hash}|${path.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}`
    if (key === this.debugKey) return
    this.debugKey = key
    send({
      show: true,
      segments: world.segments.map((s) => ({ ...s })),
      walls: world.walls.map((w) => ({ ...w })),
      links: world.links.map((l) => ({ kind: l.kind, from: { ...l.from }, to: { ...l.to } })),
      path,
      windows: [...world.windows].map(([wid, r]) => ({ wid, x: r.x, y: r.y, width: r.width, height: r.height })),
    })
  }
}
