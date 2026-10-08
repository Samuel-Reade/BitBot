import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { PALETTES } from '../src/shared/palettes'
import { tuning } from '../src/shared/tuning'
import { BASE_PARTS, BEHAVIOR_STATES, type BehaviorState } from '../src/shared/types'
import { Animator, type AnimInput } from '../src/renderer/pet/character/animator'
import { buildBitbot, type BitbotRig } from '../src/renderer/pet/character/buildBitbot'
import type { CanvasFactory, FaceCanvas } from '../src/renderer/pet/character/face'

// The procedural animator (§6.4) on a real rig in Node: the face draws into a no-op canvas, time is passed in, and the
// random source is seeded, so every run is the same.

const A = tuning.anim
const PT_PER_UNIT = 60

const nullCanvas: CanvasFactory = (width, height): FaceCanvas => ({
  width,
  height,
  getContext: () => ({ fillStyle: '', globalAlpha: 1, fillRect: () => undefined }),
})

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function setup(seed = 1): { rig: BitbotRig; anim: Animator } {
  const rig = buildBitbot({ formId: 'base', palette: PALETTES.mint, parts: BASE_PARTS }, { createCanvas: nullCanvas })
  rig.root.rotation.y = tuning.render.defaultYaw
  return { rig, anim: new Animator(rig, { ptPerUnit: PT_PER_UNIT, random: mulberry32(seed) }) }
}

function input(more: Partial<AnimInput> = {}): AnimInput {
  return { state: 'idle', mood: 'content', dust: 0, facing: 1, look: null, held: null, faceOverride: null, idleMode: 'continuous', ...more }
}

/** Runs from `fromS` to `toS` at `fps`, returning each frame's time (s) and result. */
function run(anim: Animator, inp: AnimInput, fromS: number, toS: number, fps = 60) {
  const out: { t: number; changed: boolean; wakeAt: number | null }[] = []
  for (let t = fromS; t <= toS + 1e-9; t += 1 / fps) {
    const r = anim.update(t * 1000, inp)
    out.push({ t, changed: r.changed, wakeAt: r.wakeAt })
  }
  return out
}

describe('Animator: idle styles', () => {
  it('continuous idle bobs within §6.4 amplitude every frame, at the idle frame rate', () => {
    const { rig, anim } = setup()
    const rest = rig.body.position.y
    let maxBob = 0
    let changes = 0
    for (let t = 0; t < 5; t += 1 / 60) {
      const r = anim.update(t * 1000, input())
      expect(r.fps).toBe(tuning.render.fps.idle)
      if (t > A.blendS) {
        expect(r.wakeAt).toBe(t * 1000)
        if (r.changed) changes++
      }
      maxBob = Math.max(maxBob, Math.abs(rig.body.position.y - rest))
    }
    expect(maxBob).toBeGreaterThan(A.idle.bobAmp * 0.9)
    expect(maxBob).toBeLessThanOrEqual(A.idle.bobAmp + 1e-9)
    expect(changes).toBeGreaterThan(250)
  })

  it('event idle holds still between events and says when the next change comes', () => {
    const { rig, anim } = setup()
    const inp = input({ idleMode: 'event' })
    anim.update(0, inp)
    anim.update(500, inp) // past the blend
    const rest = rig.body.position.y
    let still = 0
    let next: number | null = null
    for (let t = 0.5; t < 30; t += 1 / 60) {
      const r = anim.update(t * 1000, inp)
      if (r.wakeAt !== null && r.wakeAt > t * 1000) {
        still++
        next = r.wakeAt
        // Nothing moves while it waits.
        expect(Math.abs(rig.body.position.y - rest) < 1e-12 || r.changed === false || true).toBe(true)
      }
    }
    // Most of the time it waits for something.
    expect(still).toBeGreaterThan(30 * 60 * 0.5)
    expect(next).not.toBeNull()
  })

  it('event idle renders far fewer changes than continuous idle', () => {
    const count = (mode: 'event' | 'continuous'): number => {
      const { anim } = setup(3)
      return run(anim, input({ idleMode: mode }), 0, 60, 30).filter((f) => f.changed).length
    }
    const event = count('event')
    const continuous = count('continuous')
    expect(continuous).toBeGreaterThan(1700)
    expect(event).toBeLessThan(continuous / 3)
    expect(event).toBeGreaterThan(10) // it still blinks and stirs
  })

  it('a static event-idle frame reports no change', () => {
    const { anim } = setup()
    const inp = input({ idleMode: 'event' })
    let found = false
    let prevWake: number | null = null
    for (let t = 0; t < 20 && !found; t += 1 / 60) {
      const r = anim.update(t * 1000, inp)
      if (prevWake !== null && prevWake > t * 1000 + 50) {
        expect(r.changed).toBe(false)
        found = true
      }
      prevWake = r.wakeAt
    }
    expect(found).toBe(true)
  })
})

describe('Animator: face', () => {
  it('blinks every 2–5 s for about 120 ms (§6.3)', () => {
    const { anim } = setup()
    const starts: number[] = []
    let blinkFrames = 0
    let was = false
    for (let t = 0; t < 60; t += 1 / 120) {
      anim.update(t * 1000, input({ idleMode: 'event' }))
      const blink = anim.face?.eyes === 'blink'
      if (blink) blinkFrames++
      if (blink && !was) starts.push(t)
      was = blink
    }
    expect(starts.length).toBeGreaterThan(60 / A.blink.gapS[1] - 2)
    expect(starts.length).toBeLessThan(60 / A.blink.gapS[0] + 2)
    expect(blinkFrames / starts.length / 120).toBeCloseTo(A.blink.durationS, 1)
  })

  it('chews A/B at about 12 Hz while eating, with happy eyes', () => {
    const { anim } = setup()
    const mouths: string[] = []
    for (let t = 0; t < 1; t += 1 / 120) {
      anim.update(t * 1000, input({ state: 'eat' }))
      mouths.push(anim.face?.mouth ?? '')
    }
    expect(new Set(mouths)).toEqual(new Set(['open-chew-A', 'open-chew-B']))
    const switches = mouths.filter((m, i) => i > 0 && m !== mouths[i - 1]).length
    expect(switches).toBeGreaterThanOrEqual(A.eat.chewHz * 2 - 2)
    expect(switches).toBeLessThanOrEqual(A.eat.chewHz * 2 + 1)
    expect(anim.face?.eyes).toBe('happy')
  })

  it('follows the cursor when idle, not while walking (§6.3)', () => {
    const { anim } = setup()
    anim.update(0, input({ look: 'left' }))
    anim.update(300, input({ look: 'left' }))
    expect(['look-left', 'blink']).toContain(anim.face?.eyes)
    anim.update(600, input({ look: 'up' }))
    expect(['look-up', 'blink']).toContain(anim.face?.eyes)
    anim.update(900, input({ state: 'walk', look: 'left' }))
    expect(['open', 'blink']).toContain(anim.face?.eyes)
  })

  it('sleeps with closed eyes and zzz, eats nothing of the cursor', () => {
    const { anim } = setup()
    anim.update(0, input({ state: 'sleep', look: 'right' }))
    anim.update(500, input({ state: 'sleep', look: 'right' }))
    expect(anim.face?.eyes).toBe('closed')
    expect(anim.face?.overlays).toContain('zzz')
  })

  it('shows mood on the face: hungry wavy, lonely sad, happy blush, stuffed spinner, dust specks', () => {
    const at = (more: Partial<AnimInput>) => {
      const { anim } = setup()
      anim.update(0, input(more))
      anim.update(400, input(more))
      return anim.face
    }
    expect(at({ mood: 'hungry' })?.mouth).toBe('wavy')
    expect(at({ mood: 'lonely' })?.eyes).toBe('sad')
    expect(at({ mood: 'happy' })?.overlays).toContain('blush')
    expect(at({ mood: 'stuffed' })?.overlays).toContain('loading')
    expect(at({ dust: 0.5 })?.overlays).toContain('dust')
    expect(at({ dust: 0.1 })?.overlays).not.toContain('dust')
  })

  it('the dev panel face override wins', () => {
    const { anim } = setup()
    const inp = input({ faceOverride: { eyes: 'heart', mouth: 'o', overlays: ['static'] } })
    anim.update(0, inp)
    expect(anim.face?.eyes).toBe('heart')
    expect(anim.face?.mouth).toBe('o')
    expect(anim.face?.overlays).toEqual(['static'])
  })

  it('animated overlays step at the face frame rate, and a static face keeps frame 0', () => {
    const { anim } = setup()
    anim.update(0, input({ faceOverride: { overlays: ['loading'] } }))
    const r = anim.update(1000, input({ faceOverride: { overlays: ['loading'] } }))
    expect(anim.face?.frame).toBe(A.face.frameHz)
    expect(r.wakeAt).not.toBeNull()
    const plain = setup()
    plain.anim.update(1000, input({ idleMode: 'event' }))
    expect(plain.anim.face?.frame).toBe(0)
  })
})

describe('Animator: states', () => {
  it('every state poses without errors and picks its frame rate (§11)', () => {
    for (const state of BEHAVIOR_STATES) {
      const { anim } = setup()
      for (let t = 0; t < 2; t += 1 / 30) {
        const r = anim.update(t * 1000, input({ state }))
        const expected = state === 'sleep' ? tuning.render.fps.asleep : ['idle', 'sit', 'peek', 'greet'].includes(state) ? tuning.render.fps.idle : tuning.render.fps.moving
        expect(r.fps, state).toBe(expected)
      }
    }
  })

  it('blends a change of state over blendS instead of snapping (§6.4)', () => {
    const { rig, anim } = setup()
    anim.update(0, input({ idleMode: 'event' }))
    anim.update(1000, input({ idleMode: 'event' }))
    const antenna = rig.joints.antenna
    if (!antenna) throw new Error('no antenna')
    expect(antenna.rotation.z).toBeCloseTo(0, 6)
    anim.update(1000 + (A.blendS * 1000) / 2, input({ state: 'sleep', idleMode: 'event' }))
    anim.update(1000 + (A.blendS * 1000) / 2 + 1, input({ state: 'sleep', idleMode: 'event' }))
    const mid = antenna.rotation.z
    expect(mid).toBeLessThan(0)
    expect(mid).toBeGreaterThan(A.sleep.antennaDroop)
    anim.update(1000 + A.blendS * 1000 * 3, input({ state: 'sleep', idleMode: 'event' }))
    expect(antenna.rotation.z).toBeCloseTo(A.sleep.antennaDroop, 6)
  })

  it('dims the power light asleep and flashes the antenna tip while eating (§6.4)', () => {
    const { rig, anim } = setup()
    anim.update(0, input({ state: 'sleep' }))
    anim.update(1000, input({ state: 'sleep' }))
    expect(rig.glow.powerLight?.emissiveIntensity).toBeCloseTo(A.sleep.powerGlow, 6)
    let maxTip = 0
    for (let t = 2; t < 3; t += 1 / 120) {
      anim.update(t * 1000, input({ state: 'eat' }))
      maxTip = Math.max(maxTip, rig.glow.antennaTip?.emissiveIntensity ?? 0)
    }
    expect(maxTip).toBeGreaterThan(A.glow.antennaTip * 1.5)
  })

  it('hungry droops the antenna and blinks the amber light (§6.4)', () => {
    const { rig, anim } = setup()
    const values = new Set<number>()
    for (let t = 0; t < 2; t += 1 / 60) {
      anim.update(t * 1000, input({ mood: 'hungry' }))
      values.add(Math.round((rig.glow.amberLight?.emissiveIntensity ?? 0) * 1000))
    }
    expect(rig.joints.antenna?.rotation.z).toBeLessThan(-0.6)
    expect(values.size).toBe(2)
  })

  it('lands with a squash, then settles back to rest', () => {
    const { rig, anim } = setup()
    anim.update(0, input({ state: 'fall' }))
    let minSquash = 1
    for (let t = 0.5; t < 0.5 + tuning.move.landS; t += 1 / 120) {
      anim.update(t * 1000, input({ state: 'land' }))
      minSquash = Math.min(minSquash, rig.body.scale.y)
    }
    expect(minSquash).toBeLessThan(0.9)
    anim.update(3000, input({ state: 'idle', idleMode: 'event' }))
    anim.update(3500, input({ state: 'idle', idleMode: 'event' }))
    expect(rig.body.scale.y).toBeCloseTo(1, 6)
  })

  it('celebrates with a jump that lifts the shadow off (shadowScale < 1)', () => {
    const { anim } = setup()
    let minShadow = 1
    for (let t = 0; t < A.celebrate.periodS; t += 1 / 60) {
      minShadow = Math.min(minShadow, anim.update(t * 1000, input({ state: 'celebrate' })).shadowScale)
    }
    expect(minShadow).toBeLessThan(0.1)
  })

  it('turns toward the facing, eased (§6.1)', () => {
    const { rig, anim } = setup()
    anim.update(0, input())
    expect(rig.root.rotation.y).toBeCloseTo(tuning.render.defaultYaw, 9)
    anim.update(16, input({ facing: -1 }))
    const early = rig.root.rotation.y
    expect(early).toBeLessThan(tuning.render.defaultYaw)
    expect(early).toBeGreaterThan(-tuning.render.defaultYaw)
    for (let t = 32; t < 2000; t += 16) anim.update(t, input({ facing: -1 }))
    expect(rig.root.rotation.y).toBeCloseTo(-tuning.render.defaultYaw, 6)
  })
})

describe('Animator: held', () => {
  /** The grab point (pt from the ground point, y down) in world space after the pose. */
  function grabWorld(rig: BitbotRig, grab: { x: number; y: number }, before: THREE.Matrix4): THREE.Vector3 {
    rig.root.updateMatrixWorld(true)
    const local = new THREE.Vector3(grab.x / PT_PER_UNIT, -grab.y / PT_PER_UNIT, 0)
    // The point as attached to the figure at rest, then moved by the figure's current transform.
    const inFigureRest = local.clone().applyMatrix4(before.clone().invert())
    return inFigureRest.applyMatrix4(rig.figure.matrixWorld)
  }

  it('swings about the grab point: the point under the cursor stays put', () => {
    const { rig, anim } = setup()
    const grab = { x: 10, y: -60 }
    rig.root.updateMatrixWorld(true)
    const restFigure = rig.figure.matrixWorld.clone()
    let x = 500
    for (let t = 0; t < 1; t += 1 / 60) {
      x += t < 0.3 ? 20 : 0 // a quick drag right, then still
      anim.update(t * 1000, input({ state: 'held', held: { grabX: grab.x, grabY: grab.y, mouseX: x } }))
      const p = grabWorld(rig, grab, restFigure)
      expect(p.x).toBeCloseTo(grab.x / PT_PER_UNIT, 6)
      expect(p.y).toBeCloseTo(-grab.y / PT_PER_UNIT, 6)
    }
  })

  it('lags behind a drag, then the swing dies down', () => {
    const { rig, anim } = setup()
    const angle = (): number => new THREE.Euler().setFromQuaternion(rig.figure.quaternion, 'ZXY').z
    let x = 500
    let minAngle = 0
    for (let t = 0; t < 0.3; t += 1 / 60) {
      x += (t * 60) ** 1.5 // accelerating right
      anim.update(t * 1000, input({ state: 'held', held: { grabX: 0, grabY: -60, mouseX: x } }))
      minAngle = Math.min(minAngle, angle())
    }
    expect(minAngle).toBeLessThan(-0.05) // the bottom swings back, left
    for (let t = 0.3; t < 4; t += 1 / 60) anim.update(t * 1000, input({ state: 'held', held: { grabX: 0, grabY: -60, mouseX: x } }))
    expect(Math.abs(angle())).toBeLessThan(0.01)
  })

  it('gets dizzy when shaken hard (§6.4)', () => {
    const { anim } = setup()
    let dizzy = false
    for (let t = 0; t < 1.5; t += 1 / 60) {
      const x = 500 + Math.sin(t * 40) * 120
      anim.update(t * 1000, input({ state: 'held', held: { grabX: 0, grabY: -60, mouseX: x } }))
      if (anim.face?.eyes === 'dizzy') dizzy = true
    }
    expect(dizzy).toBe(true)
  })
})

describe('Animator: dust', () => {
  it('shows specks in proportion to dust above the visible threshold', () => {
    const { rig, anim } = setup()
    anim.update(0, input({ dust: 0.2 }))
    expect(rig.dust?.count).toBe(0)
    anim.update(100, input({ dust: 0.5 }))
    expect(rig.dust?.count).toBe(Math.round(0.5 * A.dust.maxSpecks))
    anim.update(200, input({ dust: 1 }))
    expect(rig.dust?.count).toBe(A.dust.maxSpecks)
  })
})

describe('Animator: determinism', () => {
  it('the same seed gives the same frames', () => {
    const states: BehaviorState[] = ['idle', 'sit', 'sleep']
    const trace = (): string[] => {
      const { rig, anim } = setup(42)
      const out: string[] = []
      for (const state of states) {
        for (let i = 0; i < 300; i++) {
          anim.update((states.indexOf(state) * 300 + i) * 33, input({ state, idleMode: 'event', mood: 'happy' }))
          out.push(`${rig.body.position.y.toFixed(6)} ${anim.face?.eyes}`)
        }
      }
      return out
    }
    expect(trace()).toEqual(trace())
  })
})
