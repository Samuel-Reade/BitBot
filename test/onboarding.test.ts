import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGES } from '../src/main/pages'
import { IPC, isAllowedChannel } from '../src/shared/ipc'
import {
  isOnboardingView,
  parseOnboardingHatch,
  parseOnboardingNav,
  sameOnboardingView,
  type OnboardingView,
} from '../src/shared/onboarding'
import { OnboardingFlow } from '../src/shared/onboardingFlow'
import { PALETTES } from '../src/shared/palettes'
import type { PetIdentity } from '../src/shared/settings'
import { tuning } from '../src/shared/tuning'
import { createEgg, seamAngle, wobbleAngle } from '../src/renderer/pet/character/egg'
import { hatchFrame, hatchSchedule, nameStatus } from '../src/renderer/onboarding/onboardingModel'

// §15.1 onboarding: the messages and their validators (src/shared/onboarding.ts), the step machine
// (src/shared/onboardingFlow.ts), the page's pure parts (src/renderer/onboarding/onboardingModel.ts), the egg
// (src/renderer/pet/character/egg.ts) and the window class with a faked Electron (src/main/windows/onboardingWindow.ts).

const ROOT = join(__dirname, '..')

// ---- A fake Electron for OnboardingWindow ----------------------------------------------------------------------

const fake = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>()
    on(event: string, fn: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
      return this
    }
    once(event: string, fn: Listener): this {
      const wrapped: Listener = (...args) => {
        this.removeListener(event, wrapped)
        fn(...args)
      }
      return this.on(event, wrapped)
    }
    removeListener(event: string, fn: Listener): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== fn),
      )
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args)
    }
    count(event: string): number {
      return this.listeners.get(event)?.length ?? 0
    }
  }
  let nextId = 1
  class FakeWebContents extends Emitter {
    readonly id = nextId++
    readonly sent: [string, unknown][] = []
    send(channel: string, payload: unknown): void {
      this.sent.push([channel, payload])
    }
    isDestroyed(): boolean {
      return false
    }
    isCrashed(): boolean {
      return false
    }
  }
  class FakeWindow extends Emitter {
    static instances: FakeWindow[] = []
    readonly webContents = new FakeWebContents()
    shown = 0
    focused = 0
    private destroyed = false
    constructor(readonly options: Record<string, unknown>) {
      super()
      FakeWindow.instances.push(this)
    }
    show(): void {
      this.shown++
    }
    focus(): void {
      this.focused++
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    close(): void {
      this.destroy()
    }
    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
  }
  class FakeIpcMain extends Emitter {
    readonly handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
    handle(channel: string, fn: (event: unknown, payload?: unknown) => unknown): void {
      if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      this.handlers.set(channel, fn)
    }
    removeHandler(channel: string): void {
      this.handlers.delete(channel)
    }
  }
  return { FakeWindow, FakeWebContents, ipcMain: new FakeIpcMain() }
})

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeWindow,
  ipcMain: fake.ipcMain,
  app: { isPackaged: false, getAppPath: () => '/app' },
}))

const { OnboardingWindow, onboardingWindowOptions } = await import('../src/main/windows/onboardingWindow')

// ---- Validators ---------------------------------------------------------------------------------------------

describe('onboarding messages', () => {
  it('nav: only {dir: next|back}', () => {
    expect(parseOnboardingNav({ dir: 'next' })).toEqual({ dir: 'next' })
    expect(parseOnboardingNav({ dir: 'back', extra: 1 })).toEqual({ dir: 'back' })
    for (const bad of [null, undefined, 'next', 1, [], {}, { dir: 'forward' }, { dir: 1 }, ['next']]) {
      expect(parseOnboardingNav(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('hatch: a name cleanPetName accepts (returned cleaned) and a known palette', () => {
    expect(parseOnboardingHatch({ name: 'Nibs', paletteId: 'mint' })).toEqual({ name: 'Nibs', paletteId: 'mint' })
    expect(parseOnboardingHatch({ name: '  Pixel \n', paletteId: 'lilac' })).toEqual({ name: 'Pixel', paletteId: 'lilac' })
    expect(parseOnboardingHatch({ name: 'a'.repeat(20), paletteId: 'beige' })?.name).toHaveLength(20)
    expect(parseOnboardingHatch({ name: '🥚'.repeat(20), paletteId: 'beige' })).not.toBeNull() // 20 characters (code points)
    for (const bad of [
      null,
      'Nibs',
      [],
      {},
      { name: '', paletteId: 'mint' },
      { name: '   ', paletteId: 'mint' },
      { name: '\u0000\u0007', paletteId: 'mint' },
      { name: 'a'.repeat(21), paletteId: 'mint' },
      { name: 42, paletteId: 'mint' },
      { name: ['Nibs'], paletteId: 'mint' },
      { name: 'Nibs' },
      { name: 'Nibs', paletteId: 'teal' },
      { name: 'Nibs', paletteId: 'toString' },
      { name: 'Nibs', paletteId: 3 },
    ]) {
      expect(parseOnboardingHatch(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  const view: OnboardingView = {
    step: 'permission',
    granted: false,
    requested: true,
    showRelaunch: false,
    canBack: true,
    canSkip: true,
    hatching: null,
  }

  it('the page accepts only well-formed views', () => {
    expect(isOnboardingView(view)).toBe(true)
    expect(isOnboardingView({ ...view, step: 'hatch', hatching: { name: 'Nibs', paletteId: 'mint' } })).toBe(true)
    for (const bad of [
      null,
      [],
      { ...view, step: 'done' },
      { ...view, granted: 'yes' },
      { ...view, requested: undefined },
      { ...view, showRelaunch: 1 },
      { ...view, canBack: null },
      { ...view, canSkip: 'no' },
      { ...view, hatching: undefined },
      { ...view, hatching: { name: ' Nibs ', paletteId: 'mint' } }, // not as cleaned
      { ...view, hatching: { name: 'Nibs', paletteId: 'teal' } },
    ]) {
      expect(isOnboardingView(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('sameOnboardingView compares every field', () => {
    expect(sameOnboardingView(view, { ...view })).toBe(true)
    for (const changed of [
      { step: 'identity' },
      { granted: true },
      { requested: false },
      { showRelaunch: true },
      { canBack: false },
      { canSkip: false },
      { hatching: { name: 'Nibs', paletteId: 'mint' } },
    ] as const) {
      expect(sameOnboardingView(view, { ...view, ...changed }), JSON.stringify(changed)).toBe(false)
    }
  })

  it('every onboarding channel passes the preload allowlist and is unique', () => {
    const channels = Object.entries(IPC)
      .filter(([key]) => key.startsWith('onboarding'))
      .map(([, channel]) => channel)
    expect(channels).toHaveLength(8)
    expect(new Set(channels).size).toBe(channels.length)
    for (const channel of channels) {
      expect(channel.startsWith('onboarding:')).toBe(true)
      expect(isAllowedChannel(channel)).toBe(true)
    }
  })
})

// ---- The step machine ---------------------------------------------------------------------------------------

describe('OnboardingFlow', () => {
  const params = { relaunchHintMs: 15_000, grantedAdvanceMs: 1_000 }

  it('goes welcome → privacy → permission; Back on steps 2–4 only', () => {
    const f = new OnboardingFlow(params, false)
    expect(f.view).toMatchObject({ step: 'welcome', canBack: false, canSkip: false })
    expect(f.back()).toBe(false)
    expect(f.next()).toBe(true)
    expect(f.view).toMatchObject({ step: 'privacy', canBack: true })
    expect(f.back()).toBe(true)
    expect(f.step).toBe('welcome')
    f.next()
    f.next()
    expect(f.view).toMatchObject({ step: 'permission', canBack: true, canSkip: true, requested: false, showRelaunch: false })
  })

  it('does not move on from the permission step until granted; Skip for now does', () => {
    const f = new OnboardingFlow(params, false, 'permission')
    expect(f.next()).toBe(false)
    expect(f.step).toBe('permission')
    expect(f.skip()).toBe(true)
    expect(f.view).toMatchObject({ step: 'identity', canBack: true, canSkip: false })
    expect(f.skip()).toBe(false)
    expect(f.back()).toBe(true)
    expect(f.step).toBe('permission')
  })

  it('auto-advances grantedAdvanceMs after the grant comes in on the permission step', () => {
    const f = new OnboardingFlow(params, false, 'permission')
    expect(f.tick(100)).toBe(false)
    expect(f.grant(true, 1_000)).toBe(true)
    expect(f.view).toMatchObject({ step: 'permission', granted: true, canSkip: false })
    expect(f.tick(1_999)).toBe(false)
    expect(f.tick(2_000)).toBe(true)
    expect(f.step).toBe('identity')
    expect(f.grant(true, 3_000)).toBe(false) // unchanged
  })

  it('arriving at the permission step already granted shows Continue instead of bouncing on', () => {
    const f = new OnboardingFlow(params, false, 'permission')
    f.grant(true, 0)
    f.next()
    expect(f.step).toBe('identity')
    f.back()
    f.setGranted(true)
    expect(f.tick(1e9)).toBe(false)
    expect(f.view).toMatchObject({ step: 'permission', granted: true, canSkip: false })
    expect(f.next()).toBe(true)
    // Granted on another step (setGranted on arrival): no auto-advance either.
    const g = new OnboardingFlow(params, false, 'welcome')
    g.next()
    g.next()
    expect(g.setGranted(true)).toBe(true)
    expect(g.tick(1e9)).toBe(false)
    expect(g.step).toBe('permission')
    expect(new OnboardingFlow(params, true, 'permission').tick(1e9)).toBe(false)
  })

  it('leaving the permission step cancels a pending auto-advance; losing the grant does too', () => {
    const f = new OnboardingFlow(params, false, 'permission')
    f.grant(true, 0)
    f.back()
    f.next()
    expect(f.tick(5_000)).toBe(false)
    expect(f.step).toBe('permission')
    const g = new OnboardingFlow(params, false, 'permission')
    g.grant(true, 0)
    g.grant(false, 500)
    expect(g.tick(5_000)).toBe(false)
    expect(g.view).toMatchObject({ step: 'permission', granted: false, canSkip: true })
  })

  it('offers Relaunch once Allow was pressed and relaunchHintMs passed without the grant, and keeps offering it', () => {
    const f = new OnboardingFlow(params, false, 'permission')
    expect(f.tick(60_000)).toBe(false) // never pressed: never offered
    expect(f.requestAccess(10_000)).toBe(true)
    expect(f.view).toMatchObject({ requested: true, showRelaunch: false })
    expect(f.requestAccess(20_000)).toBe(true) // pressed again: still timed from the first press
    expect(f.tick(24_999)).toBe(false)
    expect(f.relaunchShown).toBe(false)
    expect(f.tick(25_000)).toBe(true)
    expect(f.view.showRelaunch).toBe(true)
    expect(f.tick(26_000)).toBe(false)
    // Away and back: still offered; never on another step.
    f.skip()
    expect(f.view.showRelaunch).toBe(false)
    f.back()
    expect(f.view.showRelaunch).toBe(true)
    // The grant shows: no longer offered.
    f.grant(true, 30_000)
    expect(f.view.showRelaunch).toBe(false)
    expect(f.relaunchShown).toBe(false)
  })

  it('Allow is not accepted off the permission step or once granted', () => {
    expect(new OnboardingFlow(params, false, 'welcome').requestAccess(0)).toBe(false)
    expect(new OnboardingFlow(params, true, 'permission').requestAccess(0)).toBe(false)
  })

  it('hatches only from Name & color, then finishes exactly once', () => {
    const f = new OnboardingFlow(params, false, 'permission')
    expect(f.hatch({ name: 'Nibs', paletteId: 'mint' })).toBe(false)
    expect(f.finish()).toBeNull()
    f.skip()
    expect(f.finish()).toBeNull()
    expect(f.hatch({ name: 'Pixel', paletteId: 'lemon' })).toBe(true)
    expect(f.view).toMatchObject({ step: 'hatch', canBack: false, canSkip: false, hatching: { name: 'Pixel', paletteId: 'lemon' } })
    expect(f.back()).toBe(false)
    expect(f.next()).toBe(false)
    expect(f.isFinished).toBe(false)
    expect(f.finish()).toEqual({ name: 'Pixel', paletteId: 'lemon' })
    expect(f.isFinished).toBe(true)
    expect(f.finish()).toBeNull()
  })
})

// ---- The page's pure parts --------------------------------------------------------------------------------

describe('the onboarding page model', () => {
  it('nameStatus: live validation of the name field', () => {
    expect(nameStatus('Nibs')).toEqual({ name: 'Nibs', length: 4, error: null })
    expect(nameStatus('  Nibs  ')).toEqual({ name: 'Nibs', length: 4, error: null })
    expect(nameStatus('')).toMatchObject({ name: null, length: 0, error: 'Your Bitbot needs a name.' })
    expect(nameStatus('   ')).toMatchObject({ name: null, length: 0 })
    expect(nameStatus('a'.repeat(21))).toMatchObject({ name: null, length: 21, error: 'Up to 20 characters, please.' })
    expect(nameStatus('🥚'.repeat(20))).toMatchObject({ length: 20, error: null })
  })

  it('the hatch: wobble, crack, pop, hello, done (in that order)', () => {
    const h = tuning.onboarding.hatch
    const s = hatchSchedule(false)
    expect(s.wobbleEnd).toBe(h.wobbleS)
    expect(s.end).toBeCloseTo(h.wobbleS + h.crackS + h.popS + h.holdS)
    const start = hatchFrame(0, false)
    expect(start).toMatchObject({ crack: 0, eggOpacity: 1, petVisible: false, hello: false, done: false })
    expect(hatchFrame(s.wobbleEnd * 0.9, false).wobble).toBeGreaterThan(0)
    const midCrack = hatchFrame((s.wobbleEnd + s.crackEnd) / 2, false)
    expect(midCrack.crack).toBeGreaterThan(0)
    expect(midCrack.crack).toBeLessThan(tuning.onboarding.egg.crack.drawUntil)
    expect(midCrack.petVisible).toBe(false)
    const popped = hatchFrame(s.popEnd, false)
    expect(popped).toMatchObject({ crack: 1, eggOpacity: 0, petVisible: true, hello: true, done: false })
    expect(popped.petScale).toBeCloseTo(1)
    expect(popped.petHop).toBeCloseTo(0)
    expect(hatchFrame(s.end, false).done).toBe(true)
    // The crack never goes back; the shell only fades.
    let crack = 0
    let opacity = 1
    for (let t = 0; t <= s.end; t += 0.01) {
      const f = hatchFrame(t, false)
      expect(f.crack).toBeGreaterThanOrEqual(crack - 1e-12)
      expect(f.eggOpacity).toBeLessThanOrEqual(opacity + 1e-12)
      crack = f.crack
      opacity = f.eggOpacity
    }
  })

  it('reduced motion: no wobble or hop, and shorter', () => {
    const s = hatchSchedule(true)
    expect(s.end).toBeLessThan(hatchSchedule(false).end)
    for (let t = 0; t <= s.end; t += 0.01) {
      const f = hatchFrame(t, true)
      expect(f.wobble).toBe(0)
      expect(f.petHop).toBe(0)
    }
    expect(hatchFrame(s.crackEnd, true)).toMatchObject({ crack: 1, eggOpacity: 0, petVisible: true, hello: true })
    expect(hatchFrame(s.end, true).done).toBe(true)
  })
})

// ---- The egg --------------------------------------------------------------------------------------------------

describe('the egg', () => {
  it('wobbles in bursts on the welcome step (still in between), steadily when told how hard', () => {
    const w = tuning.onboarding.wobble
    expect(wobbleAngle(0, null)).toBe(0)
    let peak = 0
    for (let t = 0; t < w.burstS; t += 0.01) peak = Math.max(peak, Math.abs(wobbleAngle(t, null)))
    expect(peak).toBeGreaterThan(w.amplitude * 0.5)
    expect(peak).toBeLessThanOrEqual(w.amplitude)
    for (let t = w.burstS; t < w.periodS; t += 0.05) expect(wobbleAngle(t, null)).toBe(0)
    expect(wobbleAngle(w.periodS + 0.1, null)).toBeCloseTo(wobbleAngle(0.1, null))
    expect(Math.abs(wobbleAngle(0.25 / w.hz, 2))).toBeCloseTo(2 * w.amplitude)
    expect(wobbleAngle(0.3, 0)).toBe(0)
    expect(wobbleAngle(Number.NaN, null)).toBe(0)
  })

  it('its seam zigzags round it, a tooth tip at the front', () => {
    const e = tuning.onboarding.egg
    expect(seamAngle(0)).toBeCloseTo(e.seam.angle + e.seam.amplitude)
    expect(seamAngle(Math.PI / e.seam.teeth)).toBeCloseTo(e.seam.angle - e.seam.amplitude)
    expect(seamAngle(2 * Math.PI)).toBeCloseTo(seamAngle(0))
    expect(e.segments.around % (2 * e.seam.teeth)).toBe(0)
  })

  it('stands on its bottom, cracks, parts, fades, and frees everything it made', () => {
    const egg = createEgg(PALETTES.lilac)
    const scene = new THREE.Scene()
    scene.add(egg.root)
    egg.root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(egg.root)
    const e = tuning.onboarding.egg
    expect(box.min.y).toBeCloseTo(0, 1) // the shadow disc sits on the ground; the shell's bottom too
    expect(box.max.y).toBeCloseTo(e.height, 2)
    const named = (name: string): THREE.Object3D => {
      const o = egg.root.getObjectByName(name)
      if (!o) throw new Error(name)
      return o
    }
    const cracks = [named('egg-crack-right'), named('egg-crack-left')] as THREE.Mesh[]
    const upper = named('egg-upper')
    const restY = upper.position.y
    egg.crack(0)
    expect(cracks.every((c) => !c.visible)).toBe(true)
    egg.crack(e.crack.drawUntil / 2)
    for (const c of cracks) {
      expect(c.visible).toBe(true)
      expect(c.geometry.drawRange.count).toBeGreaterThan(0)
      expect(c.geometry.drawRange.count).toBeLessThan(c.geometry.index?.count ?? 0)
      expect(c.geometry.drawRange.count % 3).toBe(0)
    }
    expect(upper.position.y).toBe(restY)
    egg.crack(e.crack.drawUntil)
    for (const c of cracks) expect(c.geometry.drawRange.count).toBe(c.geometry.index?.count)
    egg.crack(1)
    expect(upper.position.y).toBeCloseTo(restY + e.part.lift)
    expect(upper.position.x).toBeCloseTo(e.part.side)

    egg.wobble(0.1, 1)
    expect(named('egg-rocker').rotation.z).not.toBe(0)
    expect(named('egg-shadow').rotation.z).toBe(0) // the shadow stays on the ground

    egg.setOpacity(0.5)
    const lower = (named('egg-lower').children[0] as THREE.Mesh).material as THREE.Material
    expect(lower.transparent).toBe(true)
    expect(lower.opacity).toBe(0.5)
    egg.setOpacity(0)
    expect(egg.root.visible).toBe(false)

    const disposed: string[] = []
    egg.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.addEventListener('dispose', () => disposed.push('geometry'))
        ;(o.material as THREE.Material).addEventListener('dispose', () => disposed.push('material'))
      }
    })
    egg.dispose()
    expect(egg.root.parent).toBeNull()
    // 2 shells, 2 pixel meshes, 2 cracks (sharing one material), 1 shadow.
    expect(disposed.filter((d) => d === 'geometry')).toHaveLength(7)
    expect(new Set(disposed.filter((d) => d === 'material')).size).toBe(1)
    expect(disposed.filter((d) => d === 'material').length).toBeGreaterThanOrEqual(6)
  })
})

// ---- The window ---------------------------------------------------------------------------------------------

describe('OnboardingWindow', () => {
  type Win = InstanceType<typeof fake.FakeWindow>
  let granted = false
  const makeDeps = () => ({
    requestInputAccess: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    inputGranted: vi.fn<() => boolean>(() => granted),
    openInputPane: vi.fn<() => void>(),
    relaunch: vi.fn<() => void>(),
    onFinish: vi.fn<(identity: PetIdentity) => void>(),
    onClosedEarly: vi.fn<() => void>(),
    log: vi.fn<(line: string) => void>(),
    warn: vi.fn<(key: string, line: string) => void>(),
    now: () => Date.now(),
  })
  let deps: ReturnType<typeof makeDeps>
  let ow: InstanceType<typeof OnboardingWindow>

  beforeEach(() => {
    vi.useFakeTimers()
    fake.FakeWindow.instances.length = 0
    granted = false
    deps = makeDeps()
    ow = new OnboardingWindow(deps)
  })

  afterEach(() => {
    ow.destroy()
    vi.useRealTimers()
  })

  const win = (): Win => {
    const w = fake.FakeWindow.instances.at(-1)
    if (!w) throw new Error('no window')
    return w
  }
  const send = (channel: string, payload?: unknown, sender: unknown = win().webContents): void => {
    fake.ipcMain.emit(channel, { sender }, payload)
  }
  const state = (sender: unknown = win().webContents): unknown => fake.ipcMain.handlers.get(IPC.onboardingState)?.({ sender })
  const lastView = (): OnboardingView => {
    const sent = win().webContents.sent.filter(([c]) => c === IPC.onboardingView)
    const v = sent.at(-1)?.[1]
    if (!isOnboardingView(v)) throw new Error('no view pushed')
    return v
  }
  const toPermission = (): void => {
    send(IPC.onboardingNav, { dir: 'next' })
    send(IPC.onboardingNav, { dir: 'next' })
  }

  it('its window: tuning.onboarding.window content size, not resizable, hidden until ready, sandboxed', () => {
    const o = onboardingWindowOptions('/x/preload.js')
    expect(o).toMatchObject({
      width: tuning.onboarding.window.width,
      height: tuning.onboarding.window.height,
      useContentSize: true,
      center: true,
      resizable: false,
      fullscreenable: false,
      show: false,
      title: 'Welcome to Bitbot',
    })
    expect(o.focusable).toBeUndefined()
    expect(o.webPreferences).toEqual({ preload: '/x/preload.js', sandbox: true, contextIsolation: true })
  })

  it('opens once, shows and focuses when ready (first launch), raises when opened again', () => {
    expect(ow.isOpen).toBe(false)
    ow.open()
    expect(fake.FakeWindow.instances).toHaveLength(1)
    expect(win().shown).toBe(0)
    win().emit('ready-to-show')
    expect(win().shown).toBe(1)
    expect(win().focused).toBe(1)
    ow.open()
    expect(fake.FakeWindow.instances).toHaveLength(1)
    expect(win().shown).toBe(2)
    expect(ow.step).toBe('welcome')
  })

  it('answers and accepts messages only from its own page, and validates them', () => {
    ow.open()
    const stranger = new fake.FakeWebContents()
    expect(() => state(stranger)).toThrow()
    send(IPC.onboardingNav, { dir: 'next' }, stranger)
    expect(ow.step).toBe('welcome')
    expect(deps.warn).toHaveBeenCalledWith(`${IPC.onboardingNav} sender`, expect.any(String))
    // A different webContents with the same id is still not the page.
    send(IPC.onboardingNav, { dir: 'next' }, { id: win().webContents.id })
    expect(ow.step).toBe('welcome')
    send(IPC.onboardingNav, { dir: 'sideways' })
    expect(ow.step).toBe('welcome')
    expect(deps.warn).toHaveBeenCalledWith(`malformed ${IPC.onboardingNav}`, expect.any(String))
    expect(state()).toMatchObject({ step: 'welcome' })
    send(IPC.onboardingNav, { dir: 'next' })
    expect(ow.step).toBe('privacy')
    expect(lastView().step).toBe('privacy')
  })

  it('ignores messages while closed', () => {
    const page = new fake.FakeWebContents()
    send(IPC.onboardingNav, { dir: 'next' }, page)
    expect(deps.warn).toHaveBeenCalled()
  })

  it('Allow asks macOS, then opens System Settings', async () => {
    ow.open()
    toPermission()
    send(IPC.onboardingRequestAccess)
    expect(deps.requestInputAccess).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openInputPane).toHaveBeenCalledTimes(1)
    expect(lastView()).toMatchObject({ requested: true })
    // Failing to ask still opens the pane.
    deps.requestInputAccess.mockImplementationOnce(() => Promise.reject(new Error('no helper')))
    send(IPC.onboardingRequestAccess)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openInputPane).toHaveBeenCalledTimes(2)
  })

  it('polls the grant only on the permission step; the grant auto-advances', async () => {
    ow.open()
    await vi.advanceTimersByTimeAsync(tuning.onboarding.permissionPollMs * 4)
    expect(deps.inputGranted).toHaveBeenCalledTimes(1) // once, at open
    toPermission()
    const before = deps.inputGranted.mock.calls.length
    await vi.advanceTimersByTimeAsync(tuning.onboarding.permissionPollMs * 3)
    expect(deps.inputGranted.mock.calls.length - before).toBe(3)
    granted = true
    await vi.advanceTimersByTimeAsync(tuning.onboarding.permissionPollMs)
    expect(lastView()).toMatchObject({ step: 'permission', granted: true })
    await vi.advanceTimersByTimeAsync(tuning.onboarding.grantedAdvanceMs + tuning.onboarding.permissionPollMs)
    expect(lastView().step).toBe('identity')
    const after = deps.inputGranted.mock.calls.length
    await vi.advanceTimersByTimeAsync(tuning.onboarding.permissionPollMs * 5)
    expect(deps.inputGranted.mock.calls.length).toBe(after)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('offers Relaunch after relaunchHintMs without the grant; relaunching is not closing early', async () => {
    ow.open()
    toPermission()
    send(IPC.onboardingRelaunch)
    expect(deps.relaunch).not.toHaveBeenCalled()
    send(IPC.onboardingRequestAccess)
    await vi.advanceTimersByTimeAsync(tuning.onboarding.relaunchHintMs + tuning.onboarding.permissionPollMs)
    expect(lastView().showRelaunch).toBe(true)
    send(IPC.onboardingRelaunch)
    expect(deps.relaunch).toHaveBeenCalledTimes(1)
    win().close()
    expect(deps.onClosedEarly).not.toHaveBeenCalled()
    expect(deps.onFinish).not.toHaveBeenCalled()
  })

  it('can start at the permission step (after a relaunch)', () => {
    ow.open({ startAt: 'permission' })
    expect(ow.step).toBe('permission')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('hatch then finish: onFinish once with the identity (size M), then it closes itself', () => {
    ow.open()
    toPermission()
    send(IPC.onboardingFinish) // too early: ignored
    send(IPC.onboardingSkipPermission)
    send(IPC.onboardingHatch, { name: '', paletteId: 'mint' })
    expect(ow.step).toBe('identity')
    send(IPC.onboardingHatch, { name: ' Pixel ', paletteId: 'graphite' })
    expect(lastView()).toMatchObject({ step: 'hatch', hatching: { name: 'Pixel', paletteId: 'graphite' } })
    send(IPC.onboardingFinish)
    expect(deps.onFinish).toHaveBeenCalledTimes(1)
    expect(deps.onFinish).toHaveBeenCalledWith({ name: 'Pixel', paletteId: 'graphite', size: 'M' })
    expect(ow.isOpen).toBe(false)
    expect(deps.onClosedEarly).not.toHaveBeenCalled()
  })

  it('closing before the hatch is closing early; closing during it counts as finishing', () => {
    ow.open()
    send(IPC.onboardingNav, { dir: 'next' })
    ow.close()
    expect(deps.onClosedEarly).toHaveBeenCalledTimes(1)
    expect(deps.onFinish).not.toHaveBeenCalled()

    ow.open()
    expect(ow.step).toBe('welcome') // a new window starts over
    toPermission()
    send(IPC.onboardingSkipPermission)
    send(IPC.onboardingHatch, { name: 'Nibs', paletteId: 'mint' })
    win().close()
    expect(deps.onFinish).toHaveBeenCalledWith({ name: 'Nibs', paletteId: 'mint', size: 'M' })
    expect(deps.onClosedEarly).toHaveBeenCalledTimes(1)
  })

  it('a reload pushes again from scratch', () => {
    ow.open()
    expect(state()).toMatchObject({ step: 'welcome' })
    const pushes = (): number => win().webContents.sent.length
    send(IPC.onboardingSkipPermission) // no change: nothing pushed
    expect(pushes()).toBe(0)
    win().webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    send(IPC.onboardingSkipPermission)
    expect(pushes()).toBe(1)
  })

  it('destroy(): closes without callbacks, removes its IPC, can be built again', () => {
    ow.open()
    toPermission()
    ow.destroy()
    expect(ow.isOpen).toBe(false)
    expect(deps.onClosedEarly).not.toHaveBeenCalled()
    expect(fake.ipcMain.handlers.has(IPC.onboardingState)).toBe(false)
    for (const channel of [IPC.onboardingNav, IPC.onboardingRequestAccess, IPC.onboardingSkipPermission, IPC.onboardingRelaunch, IPC.onboardingHatch, IPC.onboardingFinish]) {
      expect(fake.ipcMain.count(channel), channel).toBe(0)
    }
    expect(vi.getTimerCount()).toBe(0)
    ow.open()
    expect(fake.FakeWindow.instances).toHaveLength(1)
    ow = new OnboardingWindow(deps) // registering again does not throw
  })
})

// ---- The page -------------------------------------------------------------------------------------------------

describe('the onboarding page', () => {
  const html = readFileSync(join(ROOT, 'src/renderer/onboarding/index.html'), 'utf8')
  const text = html.replace(/\s+/g, ' ')

  it('is built (electron.vite.config.ts) and loaded (pages.ts) under the same name', () => {
    expect(PAGES.onboarding).toBe('onboarding/index.html')
    expect(readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8')).toContain("onboarding: r('src/renderer/onboarding/index.html')")
  })

  it('has the pet page Content-Security-Policy (nothing remote)', () => {
    const csp = (source: string): string | undefined => /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(source)?.[1]
    const pet = csp(readFileSync(join(ROOT, 'src/renderer/pet/index.html'), 'utf8'))
    expect(pet).toBeDefined()
    expect(csp(html)).toBe(pet)
  })

  it("says the spec's welcome and privacy texts word for word", () => {
    expect(text).toContain('Bitbot is a little creature that lives on your screen and gets fed when you use your computer.')
    expect(text).toContain(
      'Bitbot counts how many keys you press and clicks you make. It never sees what you type, never reads your windows, and never connects to the internet. Everything stays on this Mac.',
    )
    expect(text).toContain('Skip for now')
    expect(text).toContain('Relaunch Bitbot')
  })
})
