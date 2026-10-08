import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultDevOverrides } from '../src/main/dev/devOverrides'
import { devPanelWindowOptions, RateMeter, sameDevPanelStatus } from '../src/main/dev/devPanelModel'
import { PAGES } from '../src/main/pages'
import type { DevPanelStatus } from '../src/shared/devPanel'
import { IPC, isAllowedChannel } from '../src/shared/ipc'
import type { OverlayStatsMsg } from '../src/shared/petProtocol'
import { tuning } from '../src/shared/tuning'

// The developer panel's pure parts (BITBOT_SPEC.md §14.1; src/main/dev/devPanelModel.ts) and its page.

const ROOT = join(__dirname, '..')

function stats(at: number, frames: number, renders: number): OverlayStatsMsg {
  return {
    at,
    frames,
    renders,
    starvedFrames: 0,
    longFrames: 0,
    rafIntervalsMs: [],
    inputToFrameMs: [],
    cursorMsgs: 0,
    cursorMsgsIgnored: 0,
    hitTests: 0,
    hoverMsgs: 0,
    pointerMsgs: 0,
    contextLosses: 0,
    truncated: false,
  }
}

describe('RateMeter', () => {
  it('has no rates until two readings, then renders and frames per second between them', () => {
    const m = new RateMeter()
    expect(m.rates).toEqual({ rendersPerS: null, framesPerS: null })
    expect(m.update(stats(1000, 10, 4))).toEqual({ rendersPerS: null, framesPerS: null })
    expect(m.update(stats(3000, 130, 64))).toEqual({ rendersPerS: 30, framesPerS: 60 })
    expect(m.update(stats(4000, 130, 64))).toEqual({ rendersPerS: 0, framesPerS: 0 })
    expect(m.rates).toEqual({ rendersPerS: 0, framesPerS: 0 })
  })

  it('a missing reading, or counters that went backwards (a new page load), gives no rates until the next', () => {
    const m = new RateMeter()
    m.update(stats(1000, 100, 50))
    expect(m.update(null)).toEqual({ rendersPerS: null, framesPerS: null })
    expect(m.update(stats(2000, 160, 80))).toEqual({ rendersPerS: null, framesPerS: null })
    expect(m.update(stats(3000, 220, 110))).toEqual({ rendersPerS: 30, framesPerS: 60 })
    expect(m.update(stats(500, 3, 1))).toEqual({ rendersPerS: null, framesPerS: null })
    expect(m.update(stats(1500, 63, 31))).toEqual({ rendersPerS: 30, framesPerS: 60 })
    expect(m.update(stats(1500, 70, 40))).toEqual({ rendersPerS: null, framesPerS: null }) // no time passed
  })

  it('reset() forgets the previous reading', () => {
    const m = new RateMeter()
    m.update(stats(1000, 0, 0))
    m.update(stats(2000, 60, 30))
    m.reset()
    expect(m.rates).toEqual({ rendersPerS: null, framesPerS: null })
    expect(m.update(stats(3000, 120, 60))).toEqual({ rendersPerS: null, framesPerS: null })
  })
})

describe('sameDevPanelStatus', () => {
  const base: DevPanelStatus = {
    overrides: defaultDevOverrides(),
    state: 'idle',
    simState: 'idle',
    look: null,
    visible: true,
    rendersPerS: null,
    framesPerS: null,
    world: null,
    economy: null,
    life: null,
  }

  it('compares every field, the overrides by value', () => {
    expect(sameDevPanelStatus(base, { ...base, overrides: defaultDevOverrides() })).toBe(true)
    for (const changed of [
      { overrides: { ...defaultDevOverrides(), dust: 0.5 } },
      { overrides: { ...defaultDevOverrides(), face: { overlays: [] } } },
      { state: 'sleep' },
      { simState: 'fall' },
      { look: 'up' },
      { visible: false },
      { rendersPerS: 0 },
      { framesPerS: 12 },
    ] as const) {
      expect(sameDevPanelStatus(base, { ...base, ...changed }), JSON.stringify(changed)).toBe(false)
    }
  })
})

describe('the dev panel window and page', () => {
  it('is an ordinary focusable window of tuning.dev.panel size, created hidden, sandboxed with the preload', () => {
    const o = devPanelWindowOptions('/x/preload.js')
    expect(o).toMatchObject({ width: tuning.dev.panel.width, height: tuning.dev.panel.height, show: false })
    expect(o.focusable).toBeUndefined() // focusable: the user opened it on purpose (§2 covers the pet's windows)
    expect(o.type).toBeUndefined()
    expect(o.webPreferences).toEqual({ preload: '/x/preload.js', sandbox: true, contextIsolation: true })
    expect(o.webPreferences?.nodeIntegration).toBeUndefined()
  })

  it('its page is built (electron.vite.config.ts) and loaded (pages.ts) under the same name', () => {
    expect(PAGES.devPanel).toBe('devpanel/index.html')
    const config = readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8')
    expect(config).toContain("devPanel: r('src/renderer/devpanel/index.html')")
  })

  it('its page has the pet page Content-Security-Policy', () => {
    const csp = (file: string): string | undefined =>
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync(join(ROOT, file), 'utf8'))?.[1]
    const pet = csp('src/renderer/pet/index.html')
    expect(pet).toBeDefined()
    expect(csp('src/renderer/devpanel/index.html')).toBe(pet)
  })

  it('its channels pass the preload allowlist', () => {
    for (const channel of [IPC.debugPanelGet, IPC.debugPanelSet, IPC.debugPanelStatus, IPC.debugPet]) {
      expect(isAllowedChannel(channel)).toBe(true)
    }
  })
})
