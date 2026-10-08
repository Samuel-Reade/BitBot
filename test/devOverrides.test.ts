import { describe, expect, it } from 'vitest'
import {
  copyDevOverrides,
  defaultDevOverrides,
  devPetMsg,
  DevOverrideState,
  overriddenFields,
  sameDevOverrides,
} from '../src/main/dev/devOverrides'
import { isDevOverrides, isDevPanelSet, type DevOverrides } from '../src/shared/devPanel'
import { isDevPetMsg } from '../src/shared/petProtocol'
import { tuning } from '../src/shared/tuning'
import { BEHAVIOR_STATES, type BehaviorState } from '../src/shared/types'

// The developer panel's overrides (BITBOT_SPEC.md §14.1) and their validation (src/shared/devPanel.ts).

describe('defaultDevOverrides', () => {
  it('forces nothing: the simulation state, facing, mood and dust, no face, the tuned idle style, real time', () => {
    const d = defaultDevOverrides()
    expect(d).toEqual({ state: null, mood: null, dust: null, facing: null, face: null, idleMode: tuning.anim.idleMode, showWorld: false, wander: true, timeScale: 1 })
    expect(isDevOverrides(d)).toBe(true)
    expect(defaultDevOverrides('continuous').idleMode).toBe('continuous')
  })

  it('with defaults, pet:state is exactly the simulation (what a packaged build sends)', () => {
    for (const behavior of BEHAVIOR_STATES) {
      for (const facing of [1, -1] as const) {
        expect(overriddenFields(defaultDevOverrides(), { behavior, facing })).toEqual({ state: behavior, facing, mood: 'content', dust: 0 })
      }
    }
  })
})

describe('overriddenFields', () => {
  const forced = (state: BehaviorState | null): DevOverrides => ({ ...defaultDevOverrides(), state })

  it('a forced state replaces the simulation idle', () => {
    expect(overriddenFields(forced('sleep'), { behavior: 'idle', facing: 1 }).state).toBe('sleep')
    expect(overriddenFields(forced('celebrate'), { behavior: 'idle', facing: 1 }).state).toBe('celebrate')
    expect(overriddenFields(forced(null), { behavior: 'idle', facing: 1 }).state).toBe('idle')
  })

  it('a forced state replaces only standing still: whatever the simulation does wins', () => {
    for (const behavior of ['held', 'fall', 'land', 'walk', 'run', 'climb', 'jump'] as const) {
      expect(overriddenFields(forced('sleep'), { behavior, facing: 1 }).state).toBe(behavior)
    }
  })

  it('a forced facing replaces the simulation one; mood and dust come from the overrides', () => {
    const o: DevOverrides = { ...defaultDevOverrides(), facing: -1, mood: 'hungry', dust: 0.6 }
    expect(overriddenFields(o, { behavior: 'held', facing: 1 })).toEqual({ state: 'held', facing: -1, mood: 'hungry', dust: 0.6 })
    expect(overriddenFields({ ...o, facing: null }, { behavior: 'idle', facing: -1 }).facing).toBe(-1)
  })
})

describe('DevOverrideState', () => {
  it('applies the fields present, leaving the others', () => {
    const s = new DevOverrideState()
    expect(s.apply({ state: 'walk', dust: 0.25 })).toEqual({ changed: true, petChanged: false })
    expect(s.overrides).toEqual({ ...defaultDevOverrides(), state: 'walk', dust: 0.25 })
    expect(s.apply({ mood: 'sleepy', facing: -1 })).toEqual({ changed: true, petChanged: false })
    expect(s.overrides).toMatchObject({ state: 'walk', dust: 0.25, mood: 'sleepy', facing: -1 })
    expect(s.apply({ state: null, facing: null })).toEqual({ changed: true, petChanged: false })
    expect(s.overrides).toMatchObject({ state: null, facing: null, mood: 'sleepy' })
  })

  it('reports a change of the face or idle style as a debug:pet change', () => {
    const s = new DevOverrideState(defaultDevOverrides('event'))
    expect(s.apply({ idleMode: 'continuous' })).toEqual({ changed: true, petChanged: true })
    expect(s.apply({ face: { eyes: 'heart', overlays: ['blush'] } })).toEqual({ changed: true, petChanged: true })
    expect(devPetMsg(s.overrides)).toEqual({ face: { eyes: 'heart', overlays: ['blush'] }, idleMode: 'continuous' })
    expect(isDevPetMsg(devPetMsg(s.overrides))).toBe(true)
    expect(s.apply({ face: { eyes: 'heart', overlays: ['blush'] } })).toEqual({ changed: false, petChanged: false })
    expect(s.apply({ face: { eyes: 'heart', overlays: ['blush', 'zzz'] } }).petChanged).toBe(true)
    expect(s.apply({ face: { eyes: 'heart', overlays: ['zzz', 'blush'] } }).petChanged).toBe(true)
    expect(s.apply({ face: { eyes: 'heart' } }).petChanged).toBe(true)
    expect(s.apply({ face: null })).toEqual({ changed: true, petChanged: true })
    expect(s.apply({})).toEqual({ changed: false, petChanged: false })
  })

  it('keeps its own copies: nothing passed in or handed out changes it', () => {
    const overlays: ('blush' | 'zzz')[] = ['blush']
    const s = new DevOverrideState()
    s.apply({ face: { overlays } })
    overlays.push('zzz')
    expect(s.overrides.face).toEqual({ overlays: ['blush'] })
    const out = s.overrides
    out.mood = 'bored'
    ;(out.face?.overlays as string[] | undefined)?.push('static')
    expect(s.overrides).toEqual({ ...defaultDevOverrides(), face: { overlays: ['blush'] } })
    expect(s.current).toEqual(s.overrides)
  })

  it('copyDevOverrides and sameDevOverrides', () => {
    const o: DevOverrides = { ...defaultDevOverrides(), face: { mouth: 'o', overlays: ['dust'] } }
    const c = copyDevOverrides(o)
    expect(c).toEqual(o)
    expect(c.face).not.toBe(o.face)
    expect(sameDevOverrides(o, c)).toBe(true)
    expect(sameDevOverrides(o, { ...c, dust: 0.1 })).toBe(false)
    expect(sameDevOverrides(o, { ...c, face: { mouth: 'o' } })).toBe(false)
    expect(sameDevOverrides(o, { ...c, face: null })).toBe(false)
  })
})

describe('isDevPanelSet (debug:panel-set validation)', () => {
  it('accepts any subset of valid fields, including "auto" nulls', () => {
    expect(isDevPanelSet({})).toBe(true)
    expect(isDevPanelSet({ state: 'sleep' })).toBe(true)
    expect(isDevPanelSet({ state: null, facing: null, face: null })).toBe(true)
    expect(isDevPanelSet({ mood: 'happy', dust: 0, idleMode: 'event', facing: -1 })).toBe(true)
    expect(isDevPanelSet({ dust: 1, face: { eyes: 'dizzy', mouth: 'yawn', overlays: [] } })).toBe(true)
    expect(isDevPanelSet(defaultDevOverrides())).toBe(true)
  })

  it('rejects anything else', () => {
    for (const bad of [
      null,
      undefined,
      'state',
      [],
      { state: 'dance' },
      { mood: 'grumpy' },
      { timeScale: 2 },
      { timeScale: null },
      { dust: -0.01 },
      { dust: 1.5 },
      { dust: Number.NaN },
      { dust: '0.5' },
      { facing: 0 },
      { facing: 2 },
      { face: { eyes: 'x' } },
      { face: { overlays: ['blush', 'glitter'] } },
      { face: { nose: 'big' } },
      { face: 'happy' },
      { idleMode: 'busy' },
      { idleMode: null },
      { extra: 1 },
      { state: 'idle', look: 'left' },
    ]) {
      expect(isDevPanelSet(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('isDevOverrides needs every field', () => {
    const { dust: _dust, ...partial } = defaultDevOverrides()
    expect(isDevOverrides(partial)).toBe(false)
  })
})
