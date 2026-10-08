import type { BrowserWindowConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { createOverlayWindow, overlayWindowOptions, type OverlayWindowSetup } from '../src/main/windows/overlayWindow'

// The overlay window factory (src/main/windows/overlayWindow.ts): its options and the order of the calls after
// construction (design §3.1). Regressions here would put the pet on fullscreen Spaces, give Bitbot a Dock icon or let
// the display-sized window take clicks.

class FakeOverlay implements OverlayWindowSetup {
  readonly calls: string[] = []
  setAlwaysOnTop(flag: boolean, level: 'floating'): void {
    this.calls.push(`alwaysOnTop ${flag} ${level}`)
  }
  setVisibleOnAllWorkspaces(visible: boolean, o: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean }): void {
    this.calls.push(`allSpaces ${visible} fullscreen=${o.visibleOnFullScreen} skipTransform=${o.skipTransformProcessType}`)
  }
  setIgnoreMouseEvents(ignore: boolean, ...rest: unknown[]): void {
    this.calls.push(`ignore ${ignore}${rest.length > 0 ? ` ${JSON.stringify(rest)}` : ''}`)
  }
}

const BOUNDS = { x: 0, y: 0, width: 1710, height: 1107 }

describe('overlayWindowOptions', () => {
  const o = overlayWindowOptions(BOUNDS, '/app/out/preload/index.js')

  it('is NOT a panel (a panel joins fullscreen Spaces whatever it is told)', () => {
    expect('type' in o).toBe(false)
  })

  it('covers the given bounds, hidden, transparent, never focusable, movable, resizable or fullscreenable', () => {
    expect(o).toMatchObject({
      x: 0,
      y: 0,
      width: 1710,
      height: 1107,
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      fullscreenable: false,
      hiddenInMissionControl: true,
      roundedCorners: false,
      enableLargerThanScreen: true,
    } satisfies BrowserWindowConstructorOptions)
    // It never takes clicks, so no acceptFirstMouse.
    expect('acceptFirstMouse' in o).toBe(false)
  })

  it('sandboxed and isolated with the preload bridge; never throttled (it draws on demand)', () => {
    expect(o.webPreferences).toEqual({
      preload: '/app/out/preload/index.js',
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    })
  })
})

describe('createOverlayWindow', () => {
  it('constructs with the options, then: floating level, every Space but fullscreen ones, click-through without forwarding', () => {
    let given: BrowserWindowConstructorOptions | null = null
    const fake = new FakeOverlay()
    const win = createOverlayWindow(BOUNDS, '/p.js', (options) => {
      given = options
      return fake
    })
    expect(win).toBe(fake)
    expect(given).toEqual(overlayWindowOptions(BOUNDS, '/p.js'))
    expect(fake.calls).toEqual(['alwaysOnTop true floating', 'allSpaces true fullscreen=false skipTransform=true', 'ignore true'])
  })
})
