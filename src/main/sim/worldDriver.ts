// The world as the running app keeps it (BITBOT_SPEC.md §8, §5.3, §11; milestone 3): bitbot-helper's window
// snapshots become the World (sim/world/worldModel.ts) the pet moves through, each one handed to Locomotion (riding,
// falling, re-planning). Pure (no Electron): BitbotApp feeds it and wires its outputs; unit-tested with fakes
// (test/worldDriver.test.ts).
// - The scene: the primary display and the pet's measured box decide the area; a change rebuilds the world.
// - Snapshot rate (snapshotRate.ts, decided adaptive): normal, fast while the ridden window moves, none while hidden.
// - Wandering (sim/brain/wander.ts): M3's stand-in for Roam, while on and nothing is forced; the dev panel's actions
//   send the pet somewhere once, or stop it.
// - The debug view (debug:world, dev builds): sent when the world or the route changes while it is shown.

import type { DevPanelAction, DevWorldStatus } from '../../shared/devPanel'
import type { Box, Point } from '../../shared/geometry'
import { tuning } from '../../shared/tuning'
import type { DebugWorldMsg } from '../../shared/world'
import type { HelperWindow } from '../helper/protocol'
import { pickTarget, Wanderer, type WanderKind } from './brain/wander'
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
  private wandering = true
  private showWorld = false
  private debugKey: string | null = null
  private readonly wanderer: Wanderer

  constructor(private readonly deps: WorldDriverDeps) {
    this.wanderer = new Wanderer(tuning.brain.wander, deps.random)
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
    const world = buildWorld(display, petBox, this.windows, this.deps.params)
    this.current = world
    loco?.setWorld(world, tMs)
    return world
  }

  /** A snapshot pushed by the helper (or answered on request): the world as it is now. */
  onSnapshot(windows: readonly HelperWindow[], tMs: number, loco: Locomotion | null): void {
    this.windows = windows
    if (!this.display || !this.petBox) return
    const world = buildWorld(this.display, this.petBox, windows, this.deps.params)
    this.current = world
    if (loco && loco.setWorld(world, tMs).ridingMoved) this.rideMovedAtMs = tMs
    this.updateRate(tMs, loco)
  }

  setHidden(hidden: boolean, tMs: number, loco: Locomotion | null): void {
    this.hidden = hidden
    this.updateRate(tMs, loco)
  }

  /** The pet wanders by itself (dev panel "wander", and nothing forced). */
  setWandering(on: boolean): void {
    this.wandering = on
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

  /** Every simulation wake: wandering, the snapshot rate, the debug view. */
  tick(nowMs: number, loco: Locomotion | null): void {
    const world = this.current
    if (loco && world) {
      const s = loco.state
      const idle = s.behavior === 'idle' && loco.goal === null && this.wandering && !this.hidden
      const target = this.wanderer.tick(nowMs / 1000, idle, world, { x: s.x, y: s.y })
      if (target) loco.goTo(target)
    }
    this.updateRate(nowMs, loco)
    this.sendDebug(loco)
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
      { hidden: this.hidden, riding: loco.state.windowId !== null, sinceRideMovedS: (nowMs - this.rideMovedAtMs) / 1000 },
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
