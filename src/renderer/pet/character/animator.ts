import * as THREE from 'three'
import {
  ANIMATED_FACE_OVERLAYS,
  type EyesState,
  type FaceOverlay,
  type FaceOverride,
  type FaceState,
  type MouthState,
} from '../../../shared/faceStates'
import { tuning } from '../../../shared/tuning'
import type { BehaviorState, IdleMode, LookDirection, Mood } from '../../../shared/types'
import type { BitbotRig } from './buildBitbot'
import { armShoulder, SPEC_ORIGIN_HEIGHT } from './construction'

// Procedural animation (§6.4): turns what main says about the pet (behavior state, mood, dust, facing, where the cursor
// is) into a pose of the rig and a face, every frame the overlay asks for one. Pure apart from the rig it writes to
// (three.js objects, no DOM), with an injectable random source, so Vitest drives it in Node.
//
// - One pose function per state (§6.4 table; Jump and Greet, which the table leaves out, get simple ones). A change of
//   state blends from the pose shown at that moment over tuning.anim.blendS.
// - Mood cues are layered on top (§6.4): hungry droops the antenna and blinks the amber light, sleepy slows the idle
//   and yawns, stuffed burps and shows the digest spinner, happy hops now and then, dust shows specks.
// - Idle, Sit and Sleep follow the idle style (IdleMode, docs/decisions/overlay.md decided (c)): 'continuous' bobs
//   and sways all the time; 'event' holds still between short events (a blink, a glance, a breath, an antenna wiggle),
//   so nothing is rendered in between; 'still' only blinks and looks (its outline never changes). Every other state
//   moves all the time while it lasts.
// - Held: the pet swings about the grab point like a damped pendulum driven by the drag.
// - update() reports whether anything visible changed (render only then) and when the pose next changes on its own,
//   so the overlay can sleep until then (§11 render on demand).

/** What the animator needs each frame. */
export interface AnimInput {
  state: BehaviorState
  mood: Mood
  /** 0..1 */
  dust: number
  facing: 1 | -1
  look: LookDirection | null
  /**
   * While the user holds the pet: where it is held, relative to its ground-contact point (pt, y down), and the
   * cursor's x (global pt) to swing with. Null otherwise (also for a held state forced by the dev panel).
   */
  held: { grabX: number; grabY: number; mouseX: number } | null
  /** The dev panel's forced face fields. */
  faceOverride: FaceOverride | null
  idleMode: IdleMode
}

export interface AnimResult {
  /** The pose, face, yaw or dust differ from the last update: render. */
  changed: boolean
  /**
   * When the pose next changes by itself, on the update clock (ms): at or before `now` = every frame (capped at
   * `fps`); null = never, until the input changes.
   */
  wakeAt: number | null
  /** Most renders per second this state needs (§11: moving 60, idle 30, asleep 10). */
  fps: number
  /** Multiplies the contact shadow's strength: < 1 while a jump or hop lifts the pet off its surface. */
  shadowScale: number
}

type AnimTuning = typeof tuning.anim

/** A pose as offsets from the rest pose (scene units, radians; squash 1 = none; glows multiply the rest intensity). */
interface Pose {
  /** Figure offset, root space. */
  figX: number
  figY: number
  /** Roll in the screen plane (rad, + = counterclockwise as seen), about the point pivotY above the ground point. */
  roll: number
  /** Forward lean (rad, + = top toward the pet's front). */
  lean: number
  /** Extra turn about the vertical axis (rad). */
  spin: number
  pivotY: number
  bodyY: number
  squash: number
  /** Arm raise (rad, + = up and outward) and swing (rad, + = hand forward). L = the pet's left (+x). */
  armLRaise: number
  armRRaise: number
  armLSwing: number
  armRSwing: number
  /** Antenna (rad): z + = tip up/back toward −x, − = droops; x + = tip toward the front. */
  antZ: number
  antX: number
  footLY: number
  footLZ: number
  footRY: number
  footRZ: number
  glowTip: number
  glowPower: number
  glowAmber: number
  /** Height of a hop or jump, units (for the contact shadow). */
  lift: number
}

const REST: Readonly<Pose> = {
  figX: 0,
  figY: 0,
  roll: 0,
  lean: 0,
  spin: 0,
  pivotY: 0,
  bodyY: 0,
  squash: 1,
  armLRaise: 0,
  armRRaise: 0,
  armLSwing: 0,
  armRSwing: 0,
  antZ: 0,
  antX: 0,
  footLY: 0,
  footLZ: 0,
  footRY: 0,
  footRZ: 0,
  glowTip: 1,
  glowPower: 1,
  glowAmber: 1,
  lift: 0,
}
const POSE_KEYS = Object.keys(REST) as (keyof Pose)[]

/** States that follow the idle style. */
const IDLE_LIKE: ReadonlySet<BehaviorState> = new Set(['idle', 'sit', 'sleep'])
/** States that move all the time while they last (rendered every frame, at tuning.render.fps.moving). */
const MOVING: ReadonlySet<BehaviorState> = new Set(['walk', 'run', 'jump', 'climb', 'eat', 'fall', 'land', 'held', 'celebrate'])
/** States whose pose moves all the time (MOVING, and Greet's wave); Peek holds its pose. */
const CONTINUOUS: ReadonlySet<BehaviorState> = new Set([...MOVING, 'greet'])

const TAU = Math.PI * 2
const smoothstep = (u: number): number => {
  const x = Math.min(1, Math.max(0, u))
  return x * x * (3 - 2 * x)
}
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u
/** 0 → 1 → 0 over u in [0, 1] (half a sine). */
const bump = (u: number): number => (u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u))

interface Timed {
  kind: string
  start: number
  end: number
  /** A per-event choice (glance side, hop vs wiggle). */
  pick: number
}

export interface AnimatorOptions {
  /** Scene units → pt at the pet's depth (PetScene.ptPerUnit): converts the grab point. */
  ptPerUnit: number
  /** Random source in [0, 1) (seed it in tests). Default Math.random: the choices are cosmetic. */
  random?: () => number
  tuning?: AnimTuning
}

export class Animator {
  private readonly rig: BitbotRig
  private readonly T: AnimTuning
  private readonly random: () => number
  private readonly ptPerUnit: number

  // Rest values of what the animator writes.
  private readonly armRest: { L: number; R: number }
  private readonly bodyRestY: number
  private readonly footRest: { L: THREE.Vector3 | null; R: THREE.Vector3 | null }
  private readonly glowRest: { tip: number; power: number; amber: number }

  private state: BehaviorState | null = null
  private stateStart = 0
  private from: Pose = { ...REST }
  private last: Pose = { ...REST }
  private yaw: number
  private lastT: number | null = null

  // Blinks and idle events.
  private nextBlink = 0
  private blinkUntil = -1
  private event: Timed | null = null
  private nextEvent = 0
  private moodEvent: Timed | null = null
  private nextMoodEvent = 0
  private moodFor: Mood | null = null
  private blinkSleepy = false
  /** The current face blinks (faceFor): blinks then count as scheduled changes. */
  private blinking = true

  // Held.
  private theta = 0
  private omega = 0
  private lastMouseX: number | null = null
  private lastVx = 0
  private shake = 0
  private dizzyUntil = -1
  private heldFace: 'o' | 'happy' = 'o'

  private signature: number[] = []
  private faceKey = ''
  private dustShown = -1

  // Scratch objects (no per-frame allocation).
  private readonly m = new THREE.Matrix4()
  private readonly m2 = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly qRoll = new THREE.Quaternion()
  private readonly v = new THREE.Vector3()
  private readonly s = new THREE.Vector3()
  private readonly axis = new THREE.Vector3()
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ')

  constructor(rig: BitbotRig, options: AnimatorOptions) {
    this.rig = rig
    this.T = options.tuning ?? tuning.anim
    this.random = options.random ?? Math.random
    this.ptPerUnit = options.ptPerUnit > 0 ? options.ptPerUnit : 1
    this.armRest = { L: armShoulder(1).rotationZ, R: armShoulder(-1).rotationZ }
    this.bodyRestY = rig.body.position.y
    this.footRest = {
      L: rig.joints.footL ? rig.joints.footL.position.clone() : null,
      R: rig.joints.footR ? rig.joints.footR.position.clone() : null,
    }
    this.glowRest = {
      tip: rig.glow.antennaTip?.emissiveIntensity ?? 0,
      power: rig.glow.powerLight?.emissiveIntensity ?? 0,
      amber: rig.glow.amberLight?.emissiveIntensity ?? 0,
    }
    this.yaw = rig.root.rotation.y
  }

  /** The face the last update showed. */
  get face(): FaceState | null {
    return this.rig.face?.state ?? null
  }

  /** Poses the rig for time `nowMs` (any monotonic clock, ms). */
  update(nowMs: number, input: AnimInput): AnimResult {
    const T = this.T
    const t = nowMs / 1000
    const dt = this.lastT === null ? 0 : Math.min(Math.max(t - this.lastT, 0), 0.1)
    this.lastT = t

    if (input.state !== this.state) this.enterState(input.state, t)
    const tau = t - this.stateStart
    const idleLike = IDLE_LIKE.has(input.state)
    // The idle style applies to the idle-like states; every other state moves all the time.
    const style: IdleMode = idleLike ? input.idleMode : 'continuous'
    this.updateSchedules(t, input, style)

    // The pose: the state's own, blended in from the pose shown when the state changed, then the mood layers.
    let pose = this.statePose(input, tau, t, dt, style)
    const blendS = blendFor(input.state, T)
    if (tau < blendS) pose = mix(this.from, pose, smoothstep(tau / blendS))
    pose = this.moodLayers(pose, input, t, style)
    this.last = pose

    // Facing (§6.1): ease toward the walking direction (the first update starts there); a climbing pet faces the viewer.
    const yawTarget = yawFor(input)
    if (this.signature.length === 0) this.yaw = yawTarget
    else if (dt > 0) this.yaw = lerp(this.yaw, yawTarget, 1 - Math.exp(-T.yawEaseRate * dt))
    if (Math.abs(yawTarget - this.yaw) < 1e-4) this.yaw = yawTarget

    const face = this.faceFor(input, tau, t, style)
    const dustCount = input.dust >= T.dust.visibleFrom ? Math.round(Math.min(1, input.dust) * T.dust.maxSpecks) : 0

    const changed = this.apply(pose, face, dustCount, input)
    const wakeAt = this.wakeAt(nowMs, t, input, style, face)
    return {
      changed,
      wakeAt,
      fps: this.fpsFor(input.state),
      shadowScale: Math.max(0, 1 - pose.lift / Math.max(T.celebrate.jump, 1e-6)),
    }
  }

  // ───────────────────────────── states ─────────────────────────────

  private enterState(state: BehaviorState, t: number): void {
    this.from = { ...this.last }
    this.state = state
    this.stateStart = t
    if (state === 'held') {
      this.theta = 0
      this.omega = 0
      this.lastMouseX = null
      this.lastVx = 0
      this.shake = 0
      this.heldFace = this.random() < 0.5 ? 'o' : 'happy'
    }
  }

  private statePose(input: AnimInput, tau: number, t: number, dt: number, style: IdleMode): Pose {
    const T = this.T
    const p: Pose = { ...REST }
    const f = input.facing
    switch (input.state) {
      case 'idle': {
        if (style !== 'continuous') return this.eventIdle(p, t)
        const rate = input.mood === 'sleepy' ? T.mood.sleepyRate : 1
        const i = T.idle
        const bob = Math.sin(i.bobRate * rate * t)
        p.bodyY = bob * i.bobAmp
        p.squash = 1 + bob * i.squash
        const swing = Math.sin(i.armRate * rate * t)
        p.armLRaise = swing * i.armSwing
        p.armRRaise = -swing * i.armSwing
        p.antZ = Math.sin(i.antennaRate * rate * t) * i.antennaSway + Math.sin(2.7 * i.antennaRate * rate * t) * i.antennaSway * 0.25
        return p
      }
      case 'walk':
      case 'run': {
        const w = input.state === 'walk' ? T.walk : T.run
        const phase = TAU * w.stepHz * tau
        p.bodyY = Math.abs(Math.sin(phase)) * w.bobAmp + (input.state === 'run' ? Math.abs(Math.sin(phase)) * T.run.hop : 0)
        p.lift = input.state === 'run' ? Math.abs(Math.sin(phase)) * T.run.hop : 0
        p.lean = w.lean
        p.footLY = Math.max(0, Math.sin(phase)) * w.footLift
        p.footRY = Math.max(0, -Math.sin(phase)) * w.footLift
        p.footLZ = Math.cos(phase) * w.stride
        p.footRZ = -Math.cos(phase) * w.stride
        p.armLSwing = -Math.cos(phase) * w.armSwing
        p.armRSwing = Math.cos(phase) * w.armSwing
        p.antX = w.antennaBack + Math.sin(2 * phase) * 0.05
        return p
      }
      case 'climb': {
        const c = T.climb
        const phase = TAU * c.reachHz * tau
        // M2 previews climbing in place: rolled a quarter turn about the body's centre, feet toward the wall on the
        // facing side. M3 places it on real walls.
        p.roll = f * (Math.PI / 2)
        p.pivotY = SPEC_ORIGIN_HEIGHT
        p.armLRaise = Math.max(0, Math.sin(phase)) * c.armReach
        p.armRRaise = Math.max(0, -Math.sin(phase)) * c.armReach
        p.footLY = Math.max(0, -Math.sin(phase)) * c.footStep
        p.footRY = Math.max(0, Math.sin(phase)) * c.footStep
        p.bodyY = Math.abs(Math.sin(phase)) * c.bob
        p.antZ = -f * 0.6 // hangs with gravity
        return p
      }
      case 'sit': {
        const s = T.sit
        p.bodyY = -s.lower
        p.footLZ = s.feetForward
        p.footRZ = s.feetForward
        p.armLRaise = s.armsIn
        p.armRRaise = s.armsIn
        p.antZ = s.antenna
        const swingOn = style === 'continuous' || this.event !== null
        const swing = swingOn ? Math.sin(TAU * s.feetSwingHz * t) * s.feetSwing : 0
        p.footLY = swing
        p.footRY = -swing
        return style !== 'continuous' ? this.eventIdle(p, t) : p
      }
      case 'sleep': {
        const s = T.sleep
        const bob = style === 'continuous' || this.event !== null ? Math.sin(s.bobRate * t) * s.bobAmp : 0
        p.bodyY = -s.lower + bob
        p.lean = s.slump
        p.armLRaise = -s.armsLimp
        p.armRRaise = -s.armsLimp
        p.antZ = s.antennaDroop
        p.glowPower = s.powerGlow / Math.max(this.glowRest.power, 1e-6)
        return p
      }
      case 'eat': {
        const e = T.eat
        p.bodyY = Math.abs(Math.sin(Math.PI * e.bounceHz * tau)) * e.bounceAmp
        const pump = Math.sin(TAU * e.pumpHz * tau)
        p.armLRaise = -Math.abs(pump) * e.pump
        p.armRRaise = -Math.abs(pump) * e.pump
        p.armLSwing = pump * e.pump
        p.armRSwing = pump * e.pump
        p.antZ = e.antennaPerk
        p.glowTip = 1 + Math.max(0, Math.sin(TAU * e.tipFlashHz * tau)) * (e.tipFlash - 1)
        return p
      }
      case 'fall': {
        const fl = T.fall
        p.roll = -f * fl.tumbleRate * tau
        p.pivotY = SPEC_ORIGIN_HEIGHT
        p.armLRaise = 0.6 + Math.sin(TAU * fl.flailHz * tau) * fl.flail
        p.armRRaise = 0.6 - Math.sin(TAU * fl.flailHz * tau) * fl.flail
        p.antZ = Math.sin(TAU * fl.whipHz * tau) * fl.whip
        return p
      }
      case 'land': {
        const l = T.land
        const u = Math.min(1, tau / Math.max(tuning.move.landS, 1e-3))
        // Squash at touchdown, overshoot, settle: a damped spring around 1.
        const spring = Math.exp(-5 * u) * Math.cos(TAU * 1.25 * u)
        p.squash = 1 - (1 - l.squash) * spring + (l.stretch - 1) * Math.max(0, -spring)
        p.armLRaise = l.armsOut * (1 - u)
        p.armRRaise = l.armsOut * (1 - u)
        p.antZ = Math.sin(TAU * 2 * u) * l.boing * (1 - u)
        return p
      }
      case 'held':
        return this.heldPose(p, input, dt)
      case 'celebrate': {
        const c = T.celebrate
        const u = (tau % c.periodS) / c.periodS
        const jump = bump(u)
        p.figY = jump * c.jump
        p.lift = p.figY
        p.spin = TAU * smoothstep(u)
        p.armLRaise = c.armsUp
        p.armRRaise = c.armsUp
        p.antZ = Math.sin(TAU * c.antennaWiggleHz * tau) * c.antennaWiggle
        return p
      }
      case 'peek': {
        const k = T.peek
        p.roll = -f * k.lean
        // The arm on the side turned toward the viewer (the 3/4 view hides the other one behind the body).
        if (f === 1) p.armRRaise = k.armUp
        else p.armLRaise = k.armUp
        return p
      }
      case 'greet': {
        const g = T.greet
        const wave = Math.sin(TAU * g.waveHz * tau) * g.wave
        // The arm on the side turned toward the viewer: facing right (+1) shows the pet's own right arm (−x).
        if (f === 1) p.armRRaise = g.armUp + wave
        else p.armLRaise = g.armUp + wave
        p.bodyY = Math.abs(Math.sin(TAU * g.waveHz * 0.5 * tau)) * g.bounceAmp
        return p
      }
      case 'jump': {
        const j = T.jump
        const u = (tau % j.periodS) / j.periodS
        // Crouch over the first third, then stretch up and come back down.
        const crouch = u < 1 / 3 ? bump(u * 1.5) : 0
        const up = u >= 1 / 3 ? bump((u - 1 / 3) * 1.5) : 0
        p.squash = 1 - crouch * (1 - j.crouch) + up * (j.stretch - 1)
        p.figY = up * j.lift
        p.lift = p.figY
        p.armLRaise = up * j.armsUp
        p.armRRaise = up * j.armsUp
        p.antZ = -crouch * 0.3 + up * 0.2
        return p
      }
    }
  }

  /** Event-driven idle on top of `base`: still, apart from the current event. */
  private eventIdle(base: Pose, t: number): Pose {
    const e = this.event
    if (!e || t < e.start || t >= e.end) return base
    const u = (t - e.start) / (e.end - e.start)
    const i = this.T.idle
    if (e.kind === 'breath') {
      const b = bump(u)
      base.bodyY += b * i.bobAmp
      base.squash *= 1 + b * i.squash
      base.armLRaise += b * i.armSwing
      base.armRRaise -= b * i.armSwing
    } else if (e.kind === 'wiggle') {
      base.antZ += Math.sin(TAU * 2 * u) * i.antennaSway * 1.5 * (1 - u)
    }
    return base
  }

  private heldPose(p: Pose, input: AnimInput, dt: number): Pose {
    const h = this.T.held
    const held = input.held
    if (held && dt > 0) {
      const x = held.mouseX
      const vx = this.lastMouseX === null ? 0 : (x - this.lastMouseX) / dt
      const ax = this.lastMouseX === null ? 0 : (vx - this.lastVx) / dt
      this.lastMouseX = x
      this.lastVx = vx
      // Damped pendulum about the grab point, driven by the cursor's acceleration; fixed substeps keep it stable.
      const steps = Math.max(1, Math.ceil(dt * 240))
      const step = dt / steps
      for (let k = 0; k < steps; k++) {
        const alpha = -(h.gravityPt / h.lengthPt) * Math.sin(this.theta) - h.damping * this.omega - (ax / h.lengthPt) * Math.cos(this.theta)
        this.omega += alpha * step
        this.theta = Math.min(h.maxAngle, Math.max(-h.maxAngle, this.theta + this.omega * step))
      }
      // Shaking: the speed changes summed over about shakeWindowS.
      this.shake = this.shake * Math.exp(-dt / h.shakeWindowS) + Math.abs(ax) * dt
      if (this.shake > h.dizzyShakePt) this.dizzyUntil = (this.lastT ?? 0) + h.dizzyS
    } else if (!held) {
      // Nothing to follow (the dev panel forced Held): a gentle sway.
      this.theta = Math.sin(TAU * 0.6 * ((this.lastT ?? 0) - this.stateStart)) * h.idleSway
      this.omega = 0
    }
    p.armLRaise = h.armsOut
    p.armRRaise = h.armsOut
    p.footLY = -h.feetDrop
    p.footRY = -h.feetDrop
    p.antZ = -this.theta * 0.8
    return p
  }

  private moodLayers(pose: Pose, input: AnimInput, t: number, style: IdleMode): Pose {
    const T = this.T
    const p = pose
    if (input.mood === 'hungry' && input.state !== 'eat' && input.state !== 'sleep') {
      p.antZ = lerp(p.antZ, T.mood.hungryAntenna, 0.85)
      const on = this.cueOn(style, t)
      p.glowAmber = on && Math.sin(TAU * T.mood.amberBlinkHz * t) < 0 ? 0.15 : 1
    }
    const m = this.moodEvent
    if (m && t >= m.start && t < m.end && IDLE_LIKE.has(input.state) && input.state !== 'sleep') {
      const u = (t - m.start) / (m.end - m.start)
      if (m.kind === 'hop') {
        const b = bump(u) * T.mood.hop
        p.figY += b
        p.lift = Math.max(p.lift, b)
      } else if (m.kind === 'wiggle') {
        p.roll += Math.sin(TAU * 2 * u) * T.mood.wiggle * (1 - u)
      }
    }
    return p
  }

  // ───────────────────────────── face ─────────────────────────────

  private faceFor(input: AnimInput, tau: number, t: number, style: IdleMode): FaceState {
    const T = this.T
    let eyes: EyesState = 'open'
    let mouth: MouthState = 'smile'
    const overlays = new Set<FaceOverlay>()
    let blinks = true
    let looks = false

    switch (input.state) {
      case 'idle':
        looks = true
        break
      case 'walk':
        break
      case 'run':
        eyes = 'wide'
        break
      case 'climb':
        mouth = 'flat'
        break
      case 'sit':
        looks = true
        if (input.mood === 'happy') eyes = 'happy'
        break
      case 'sleep':
        eyes = 'closed'
        mouth = 'flat'
        blinks = false
        if (this.cueOn(style, t)) overlays.add('zzz')
        break
      case 'eat':
        eyes = 'happy'
        mouth = Math.floor(tau * T.eat.chewHz) % 2 === 0 ? 'open-chew-A' : 'open-chew-B'
        blinks = false
        break
      case 'fall':
        eyes = 'wide'
        mouth = 'o'
        blinks = false
        break
      case 'land':
        eyes = tau < tuning.move.landS * T.land.wideFraction ? 'wide' : 'open'
        mouth = tau < tuning.move.landS * T.land.wideFraction ? 'o' : 'smile'
        break
      case 'held':
        if (t < this.dizzyUntil) {
          eyes = 'dizzy'
          mouth = 'wavy'
          blinks = false
        } else if (this.heldFace === 'o') {
          eyes = 'wide'
          mouth = 'o'
        } else {
          eyes = 'happy'
          blinks = false
        }
        break
      case 'celebrate':
        eyes = 'happy'
        blinks = false
        overlays.add('heart-pop')
        break
      case 'peek':
        eyes = input.look ? lookEyes(input.look) : input.facing === 1 ? 'look-right' : 'look-left'
        break
      case 'greet':
        eyes = 'happy'
        blinks = false
        overlays.add('blush')
        break
      case 'jump':
        eyes = 'wide'
        break
    }

    // Mood (§6.4) where the state leaves the face to it.
    const idleLike = IDLE_LIKE.has(input.state) && input.state !== 'sleep'
    if (idleLike || input.state === 'walk') {
      if (input.mood === 'hungry') mouth = 'wavy'
      else if (input.mood === 'bored' || input.mood === 'stuffed') mouth = 'flat'
      else if (input.mood === 'lonely') {
        eyes = 'sad'
        mouth = 'flat'
      }
    }
    if (input.mood === 'happy') overlays.add('blush')
    if (input.mood === 'stuffed' && input.state !== 'sleep' && this.cueOn(style, t)) overlays.add('loading')
    if (input.dust >= T.dust.visibleFrom) overlays.add('dust')

    // Eyes follow the cursor (§6.3) or glance aside (event idle, bored).
    if (looks && eyes === 'open') {
      if (input.look) eyes = lookEyes(input.look)
      else {
        const e = this.event
        const m = this.moodEvent
        const glance = e?.kind === 'glance' && t >= e.start && t < e.end ? e : m?.kind === 'glance' && t >= m.start && t < m.end ? m : null
        if (glance) eyes = glance.pick < 0.5 ? 'look-left' : 'look-right'
      }
    }

    // Mood moments: yawn (sleepy), burp (stuffed).
    const m = this.moodEvent
    if (m && idleLike && t >= m.start && t < m.end) {
      if (m.kind === 'yawn') {
        eyes = 'closed'
        mouth = 'yawn'
        blinks = false
      } else if (m.kind === 'burp') {
        eyes = 'happy'
        mouth = 'o'
        blinks = false
      }
    }

    this.blinking = blinks
    if (blinks && t < this.blinkUntil && eyes !== 'closed') eyes = 'blink'

    const o = input.faceOverride
    if (o?.eyes) eyes = o.eyes
    if (o?.mouth) mouth = o.mouth
    const list = o?.overlays ? [...o.overlays] : [...overlays]
    const animated = list.some((x) => (ANIMATED_FACE_OVERLAYS as readonly string[]).includes(x))
    const frame = animated ? Math.floor(t * T.face.frameHz) : 0
    return { eyes, mouth, overlays: list, frame }
  }

  // ───────────────────────────── scheduling ─────────────────────────────

  private updateSchedules(t: number, input: AnimInput, style: IdleMode): void {
    const T = this.T
    // Blinks (§6.3), sleepier when sleepy.
    const sleepy = input.mood === 'sleepy'
    if (sleepy !== this.blinkSleepy) {
      this.blinkSleepy = sleepy
      this.nextBlink = t + this.between(sleepy ? T.blink.sleepyGapS : T.blink.gapS)
    }
    if (this.nextBlink === 0) this.nextBlink = t + this.between(T.blink.gapS)
    if (t >= this.nextBlink) {
      this.blinkUntil = this.nextBlink + (sleepy ? T.blink.sleepyDurationS : T.blink.durationS)
      this.nextBlink = this.blinkUntil + this.between(sleepy ? T.blink.sleepyGapS : T.blink.gapS)
    }

    // Idle events (event mode only).
    // Asleep, the event style only runs the zzz bursts: a sleeping pet holds still.
    if (style !== 'event' || input.state === 'sleep') {
      this.event = null
      this.nextEvent = 0
    } else {
      if (this.event && t >= this.event.end) this.event = null
      if (this.nextEvent === 0) this.nextEvent = t + this.between(T.event.gapS)
      if (!this.event && t >= this.nextEvent) {
        const r = this.random()
        const kind = r < 0.4 ? 'glance' : r < 0.75 ? 'breath' : 'wiggle'
        const length = kind === 'glance' ? this.between(T.event.glanceS) : kind === 'breath' ? T.event.breathS : T.event.wiggleS
        this.event = { kind, start: t, end: t + length, pick: this.random() }
        this.nextEvent = this.event.end + this.between(T.event.gapS)
      }
    }

    // Mood moments (none in the still style: nothing moves there but the eyes).
    if (style === 'still') {
      this.moodEvent = null
      this.nextMoodEvent = 0
      this.moodFor = null
      return
    }
    if (input.mood !== this.moodFor) {
      this.moodFor = input.mood
      this.moodEvent = null
      this.nextMoodEvent = 0
    }
    const gap = moodGap(input.mood, T)
    if (!gap) return
    if (this.moodEvent && t >= this.moodEvent.end) this.moodEvent = null
    if (this.nextMoodEvent === 0) this.nextMoodEvent = t + this.between(gap)
    if (!this.moodEvent && t >= this.nextMoodEvent) {
      const pick = this.random()
      const kind =
        input.mood === 'sleepy' ? 'yawn' : input.mood === 'stuffed' ? 'burp' : input.mood === 'bored' ? 'glance' : pick < 0.5 ? 'hop' : 'wiggle'
      const length =
        kind === 'yawn' ? T.mood.yawnS : kind === 'burp' ? T.mood.burpS : kind === 'glance' ? this.between(T.event.glanceS) : T.mood.happyS
      this.moodEvent = { kind, start: t, end: t + length, pick: this.random() }
      this.nextMoodEvent = this.moodEvent.end + this.between(gap)
    }
  }

  /** Animated cues (zzz, the spinner, the hungry light) run: always in the continuous style, in bursts in the event style, never in the still one. */
  private cueOn(style: IdleMode, t: number): boolean {
    return style === 'continuous' || (style === 'event' && this.burstOn(t))
  }

  /** In event mode, the periodic bursts of animated cues (zzz, spinner, hungry light), counted from the state's start. */
  private burstOn(t: number): boolean {
    const e = this.T.event
    const period = e.burstS + e.burstGapS
    return (t - this.stateStart) % period < e.burstS
  }

  private nextBurstEdge(t: number): number {
    const e = this.T.event
    const period = e.burstS + e.burstGapS
    const into = (t - this.stateStart) % period
    return into < e.burstS ? t + (e.burstS - into) : t + (period - into)
  }

  private between([lo, hi]: readonly [number, number]): number {
    return lo + (hi - lo) * this.random()
  }

  /** When the pose next changes on its own: now (it moves every frame), the next scheduled change, or never (null). */
  private wakeAt(nowMs: number, t: number, input: AnimInput, style: IdleMode, face: FaceState): number | null {
    if (this.inMotion(input, t, style)) return nowMs
    const next: number[] = []
    if (this.blinking) next.push(t < this.blinkUntil ? this.blinkUntil : this.nextBlink)
    if (style === 'event') {
      next.push(this.event ? this.event.end : this.nextEvent)
      if (input.state === 'sleep' || input.mood === 'stuffed' || input.mood === 'hungry') next.push(this.nextBurstEdge(t))
    }
    if (moodGap(input.mood, this.T)) next.push(this.moodEvent ? this.moodEvent.end : this.nextMoodEvent)
    if (face.overlays.some((x) => (ANIMATED_FACE_OVERLAYS as readonly string[]).includes(x))) {
      next.push((Math.floor(t * this.T.face.frameHz) + 1) / this.T.face.frameHz)
    }
    const soonest = Math.min(...next.filter((x) => x > t))
    return Number.isFinite(soonest) ? soonest * 1000 : null
  }

  /** The pose changes every frame: a moving state, a continuous idle, a blend, a turn, or a moving event or cue. */
  private inMotion(input: AnimInput, t: number, style: IdleMode): boolean {
    const active = (e: Timed | null): boolean => e !== null && t >= e.start && t < e.end
    if (CONTINUOUS.has(input.state)) return true
    if (IDLE_LIKE.has(input.state) && style === 'continuous') return true
    if (t - this.stateStart < blendFor(input.state, this.T)) return true
    if (this.yaw !== yawFor(input)) return true
    if (active(this.event) && this.event?.kind !== 'glance') return true
    if (active(this.moodEvent) && (this.moodEvent?.kind === 'hop' || this.moodEvent?.kind === 'wiggle')) return true
    if (input.mood === 'hungry' && input.state !== 'sleep' && this.cueOn(style, t)) return true
    return false
  }

  private fpsFor(state: BehaviorState): number {
    const fps = tuning.render.fps
    if (state === 'sleep') return fps.asleep
    return MOVING.has(state) ? fps.moving : fps.idle
  }

  // ───────────────────────────── the rig ─────────────────────────────

  /** Writes the pose and face to the rig; true if anything visible changed. */
  private apply(p: Pose, face: FaceState, dustCount: number, input: AnimInput): boolean {
    const rig = this.rig
    rig.root.rotation.y = this.yaw
    this.figureMatrix(p, input)
    this.m.decompose(rig.figure.position, rig.figure.quaternion, this.s)
    rig.body.position.y = this.bodyRestY + p.bodyY
    const squash = Math.max(0.2, p.squash)
    const widen = 1 / Math.sqrt(squash)
    rig.body.scale.set(widen, squash, widen)
    const { armL, armR, antenna, footL, footR } = rig.joints
    if (armL) armL.rotation.set(p.armLSwing, 0, this.armRest.L + p.armLRaise)
    if (armR) armR.rotation.set(p.armRSwing, 0, this.armRest.R - p.armRRaise)
    if (antenna) antenna.rotation.set(p.antX, 0, p.antZ)
    if (footL && this.footRest.L) footL.position.set(this.footRest.L.x, this.footRest.L.y + p.footLY, this.footRest.L.z + p.footLZ)
    if (footR && this.footRest.R) footR.position.set(this.footRest.R.x, this.footRest.R.y + p.footRY, this.footRest.R.z + p.footRZ)
    const glow = rig.glow
    if (glow.antennaTip) glow.antennaTip.emissiveIntensity = this.glowRest.tip * p.glowTip
    if (glow.powerLight) glow.powerLight.emissiveIntensity = this.glowRest.power * p.glowPower
    if (glow.amberLight) glow.amberLight.emissiveIntensity = this.glowRest.amber * p.glowAmber
    if (rig.face) rig.face.setState(face)
    if (dustCount !== this.dustShown) {
      rig.dust?.setCount(dustCount)
    }

    const sig = [
      this.yaw,
      ...rig.figure.position.toArray(),
      ...rig.figure.quaternion.toArray(),
      rig.body.position.y,
      squash,
      p.armLRaise,
      p.armRRaise,
      p.armLSwing,
      p.armRSwing,
      p.antZ,
      p.antX,
      p.footLY,
      p.footLZ,
      p.footRY,
      p.footRZ,
      p.glowTip,
      p.glowPower,
      p.glowAmber,
      dustCount,
    ]
    const key = faceKey(face)
    const changed = key !== this.faceKey || sig.length !== this.signature.length || sig.some((x, i) => x !== this.signature[i])
    this.signature = sig
    this.faceKey = key
    this.dustShown = dustCount
    return changed
  }

  /**
   * The figure's transform in root space: the pose's lean and spin (about the body's vertical axis) and roll (in the
   * screen plane) about its pivot, then the held pendulum about the grab point, both rolls about the world z axis
   * expressed in the yawed root's space.
   */
  private figureMatrix(p: Pose, input: AnimInput): void {
    const yaw = this.yaw
    // World z in root space: R_y(−yaw)·(0, 0, 1).
    this.axis.set(-Math.sin(yaw), 0, Math.cos(yaw))
    // Pose: T(offset) · T(pivot) · R_roll · R_spin,lean · T(−pivot)
    this.euler.set(p.lean, p.spin, 0, 'YXZ')
    this.q.setFromEuler(this.euler)
    this.qRoll.setFromAxisAngle(this.axis, p.roll)
    this.q.premultiply(this.qRoll)
    this.m.makeTranslation(0, -p.pivotY, 0)
    this.m2.makeRotationFromQuaternion(this.q)
    this.m.premultiply(this.m2)
    this.m2.makeTranslation(p.figX, p.pivotY + p.figY, 0)
    this.m.premultiply(this.m2)
    if (input.state !== 'held' || this.theta === 0) return
    // Pendulum about the grab point (pt, y down, relative to the ground point) → root space.
    const g = input.held
    const px = g ? g.grabX / this.ptPerUnit : 0
    const py = g ? -g.grabY / this.ptPerUnit : SPEC_ORIGIN_HEIGHT
    this.v.set(px * Math.cos(yaw), py, px * Math.sin(yaw))
    this.m2.makeTranslation(-this.v.x, -this.v.y, -this.v.z)
    this.m.premultiply(this.m2)
    this.m2.makeRotationAxis(this.axis, this.theta)
    this.m.premultiply(this.m2)
    this.m2.makeTranslation(this.v.x, this.v.y, this.v.z)
    this.m.premultiply(this.m2)
  }
}

function mix(a: Pose, b: Pose, u: number): Pose {
  const out = { ...b }
  for (const key of POSE_KEYS) out[key] = lerp(a[key], b[key], u)
  return out
}

/** How long a change into `state` blends (§6.4: 150–250 ms; a landing hits at once). */
// SPEC-DEVIATION: §6.4 blends every state over 150–250 ms. Land blends over tuning.anim.land.blendS (40 ms): a 200 ms
// blend from the fall pose swallowed the landing squash (measured: 0.99 of full height instead of 0.75).
function blendFor(state: BehaviorState, T: AnimTuning): number {
  return state === 'land' ? T.land.blendS : T.blendS
}

/** The yaw the pet turns toward: its facing's 3/4 view (§6.1); a climbing pet faces the viewer. */
function yawFor(input: AnimInput): number {
  return input.state === 'climb' ? 0 : input.facing * tuning.render.defaultYaw
}

function lookEyes(look: LookDirection): EyesState {
  return look === 'left' ? 'look-left' : look === 'right' ? 'look-right' : 'look-up'
}

function moodGap(mood: Mood, T: AnimTuning): readonly [number, number] | null {
  switch (mood) {
    case 'sleepy':
      return T.mood.yawnGapS
    case 'stuffed':
      return T.mood.burpGapS
    case 'happy':
      return T.mood.happyGapS
    case 'bored':
      return T.mood.boredGlanceGapS
    default:
      return null
  }
}

function faceKey(f: FaceState): string {
  const animated = f.overlays.some((x) => (ANIMATED_FACE_OVERLAYS as readonly string[]).includes(x))
  return `${f.eyes}|${f.mouth}|${f.overlays.join(',')}|${animated ? f.frame : 0}`
}
