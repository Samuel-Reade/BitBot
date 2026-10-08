// What the developer panel forces (BITBOT_SPEC.md §14.1 "Force state / face / mood pickers"; messages in
// src/shared/devPanel.ts), and how it changes what the overlay is told. Pure (unit-tested in test/devOverrides.test.ts).
// - DevOverrideState holds the overrides (defaults: nothing forced, mood 'content', no dust, the tuned idle style) and
//   applies a validated DevPanelSet.
// - overriddenFields: pet:state's state, facing, mood and dust. A forced state replaces only standing still: anything
//   the simulation is doing wins (held, falling, landing, and since M3 walking, running, climbing, jumping: the pet's
//   drawing must match its movement). Mood and dust come from the overrides until the needs model computes them (M6).
// - devPetMsg: debug:pet, the overrides the overlay applies itself (face, idle style).
//
// Packaged builds have no panel, so the defaults always apply: the simulation's own state and facing, mood 'content',
// no dust, the tuned idle style.

import type { DevOverrides, DevPanelSet } from '../../shared/devPanel'
import type { FaceOverride } from '../../shared/faceStates'
import type { DevPetMsg } from '../../shared/petProtocol'
import { tuning } from '../../shared/tuning'
import type { BehaviorState, IdleMode, Mood } from '../../shared/types'


export function defaultDevOverrides(idleMode: IdleMode = tuning.anim.idleMode): DevOverrides {
  return { state: null, mood: 'content', dust: 0, facing: null, face: null, idleMode, showWorld: false, wander: true }
}

function copyFace(face: FaceOverride | null): FaceOverride | null {
  if (face === null) return null
  const copy: FaceOverride = {}
  if (face.eyes !== undefined) copy.eyes = face.eyes
  if (face.mouth !== undefined) copy.mouth = face.mouth
  if (face.overlays !== undefined) copy.overlays = [...face.overlays]
  return copy
}

function sameFace(a: FaceOverride | null, b: FaceOverride | null): boolean {
  if (a === null || b === null) return a === b
  const ao = a.overlays
  const bo = b.overlays
  const sameOverlays = ao === undefined || bo === undefined ? ao === bo : ao.length === bo.length && ao.every((o, i) => o === bo[i])
  return a.eyes === b.eyes && a.mouth === b.mouth && sameOverlays
}

export function copyDevOverrides(o: DevOverrides): DevOverrides {
  return { ...o, face: copyFace(o.face) }
}

export function sameDevOverrides(a: DevOverrides, b: DevOverrides): boolean {
  return (
    a.state === b.state &&
    a.mood === b.mood &&
    a.dust === b.dust &&
    a.facing === b.facing &&
    a.idleMode === b.idleMode &&
    a.showWorld === b.showWorld &&
    a.wander === b.wander &&
    sameFace(a.face, b.face)
  )
}

/** debug:pet for the overrides: the parts the overlay applies itself. */
export function devPetMsg(o: DevOverrides): DevPetMsg {
  return { face: copyFace(o.face), idleMode: o.idleMode }
}

export function sameDevPetMsg(a: DevPetMsg, b: DevPetMsg): boolean {
  return a.idleMode === b.idleMode && sameFace(a.face, b.face)
}

/** The simulation's part of pet:state that the overrides may replace. */
export interface SimulationFields {
  behavior: BehaviorState
  facing: 1 | -1
}

/** pet:state's fields that the overrides decide. */
export interface OverriddenFields {
  state: BehaviorState
  facing: 1 | -1
  mood: Mood
  dust: number
}

export function overriddenFields(o: DevOverrides, sim: SimulationFields): OverriddenFields {
  const state = sim.behavior === 'idle' ? (o.state ?? 'idle') : sim.behavior
  return { state, facing: o.facing ?? sim.facing, mood: o.mood, dust: o.dust }
}

/** What applying a DevPanelSet changed. */
export interface DevOverrideChange {
  /** Anything at all. */
  changed: boolean
  /** The debug:pet part (face, idle style). */
  petChanged: boolean
}

export class DevOverrideState {
  private o: DevOverrides

  constructor(initial: DevOverrides = defaultDevOverrides()) {
    this.o = copyDevOverrides(initial)
  }

  /** A copy of the current overrides. */
  get overrides(): DevOverrides {
    return copyDevOverrides(this.o)
  }

  /** The live overrides, read-only (no copy: for the simulation's every step). */
  get current(): Readonly<DevOverrides> {
    return this.o
  }

  /** Applies the fields present in `set` (validate it with isDevPanelSet first); absent fields stay. */
  apply(set: DevPanelSet): DevOverrideChange {
    const before = this.o
    const next = copyDevOverrides(before)
    if (set.state !== undefined) next.state = set.state
    if (set.mood !== undefined) next.mood = set.mood
    if (set.dust !== undefined) next.dust = set.dust
    if (set.facing !== undefined) next.facing = set.facing
    if (set.face !== undefined) next.face = copyFace(set.face)
    if (set.idleMode !== undefined) next.idleMode = set.idleMode
    if (set.showWorld !== undefined) next.showWorld = set.showWorld
    if (set.wander !== undefined) next.wander = set.wander
    this.o = next
    return {
      changed: !sameDevOverrides(before, next),
      petChanged: !sameDevPetMsg(devPetMsg(before), devPetMsg(next)),
    }
  }
}
