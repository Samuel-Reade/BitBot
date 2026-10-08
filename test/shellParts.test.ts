import { describe, expect, it } from 'vitest'
import type { HelperClient } from '../src/main/helper/helperClient'
import { Hotkeys, rebindNotice, type ShortcutRegistry } from '../src/main/hotkeys'
import { petContextMenuTemplate } from '../src/main/menus/petContextMenu'
import { alphaToBgra, TRAY_ICON_PT, trayIconAlpha } from '../src/main/menus/trayIcon'
import { formatToday, formatWhole, trayMenuTemplate } from '../src/main/menus/trayMenu'
import { windowNumber, windowOnScreen, type SnapshotSource } from '../src/main/windows/onScreen'
import { DEFAULT_HOTKEYS, type HotkeyAction } from '../src/shared/hotkeys'

// The small pure pieces of the M1 shell: the overlay's on-screen check, the tray icon and menus, global hotkeys.

// HelperClient is a SnapshotSource (compile-time check).
const helperIsASource = (client: HelperClient): SnapshotSource => client

describe('windowNumber', () => {
  it("reads the CGWindowID from getMediaSourceId()'s 'window:<id>:<n>'", () => {
    expect(windowNumber('window:6600:0')).toBe(6600)
    expect(windowNumber('window:12:1')).toBe(12)
  })

  it('rejects anything else', () => {
    for (const id of ['', 'screen:1:0', 'window::0', 'window:0:0', 'window:abc:0', 'window:12', 'window:-3:0', 'window:99999999999999999999:0']) {
      expect(windowNumber(id), id).toBeNull()
    }
    expect(windowNumber(undefined as unknown as string)).toBeNull()
  })
})

describe('windowOnScreen', () => {
  const source = (windows: { wid: number; onScreen: boolean }[], running = true): SnapshotSource & { asked: number } => {
    const s = {
      asked: 0,
      isRunning: running,
      snapshot: async () => {
        s.asked++
        return { windows }
      },
    }
    return s
  }

  it('takes the HelperClient as its source', () => {
    expect(helperIsASource).toBeTypeOf('function') // the check is the compile-time assignment above
  })

  it('true when the helper lists the window as on screen', async () => {
    await expect(windowOnScreen(source([{ wid: 3, onScreen: true }, { wid: 7, onScreen: true }]), 7)).resolves.toBe(true)
  })

  it('false when the window is missing from the list or listed off screen', async () => {
    await expect(windowOnScreen(source([{ wid: 3, onScreen: true }]), 7)).resolves.toBe(false)
    await expect(windowOnScreen(source([{ wid: 7, onScreen: false }]), 7)).resolves.toBe(false)
    await expect(windowOnScreen(source([]), 7)).resolves.toBe(false)
  })

  it('null without a source, while the helper is not running, or without a window id (no request then)', async () => {
    await expect(windowOnScreen(null, 7)).resolves.toBeNull()
    const stopped = source([{ wid: 7, onScreen: true }], false)
    await expect(windowOnScreen(stopped, 7)).resolves.toBeNull()
    const running = source([{ wid: 7, onScreen: true }])
    await expect(windowOnScreen(running, null)).resolves.toBeNull()
    await expect(windowOnScreen(running, 0)).resolves.toBeNull()
    expect(stopped.asked + running.asked).toBe(0)
  })

  it('null when the request fails, throws or returns garbage; never rejects', async () => {
    const rejecting: SnapshotSource = { isRunning: true, snapshot: () => Promise.reject(new Error('timed out')) }
    const throwing: SnapshotSource = {
      isRunning: true,
      snapshot: () => {
        throw new Error('not running')
      },
    }
    const garbage = { isRunning: true, snapshot: async () => ({ windows: 'nope' }) } as unknown as SnapshotSource
    const empty = { isRunning: true, snapshot: async () => null } as unknown as SnapshotSource
    const brokenGetter = {
      get isRunning(): boolean {
        throw new Error('gone')
      },
      snapshot: async () => ({ windows: [] }),
    } as SnapshotSource
    for (const s of [rejecting, throwing, garbage, empty, brokenGetter]) await expect(windowOnScreen(s, 7)).resolves.toBeNull()
  })

  it('skips malformed entries', async () => {
    const s = { isRunning: true, snapshot: async () => ({ windows: [null, 7, { wid: 7, onScreen: 'yes' }, { wid: 7, onScreen: true }] }) }
    await expect(windowOnScreen(s as unknown as SnapshotSource, 7)).resolves.toBe(true)
    const t = { isRunning: true, snapshot: async () => ({ windows: [null, { wid: 7, onScreen: 1 }] }) }
    await expect(windowOnScreen(t as unknown as SnapshotSource, 7)).resolves.toBe(false)
  })
})

describe('trayIconAlpha', () => {
  const masks = new Map([1, 2].map((scale) => [scale, trayIconAlpha(scale)]))
  const mask = (scale: number): Uint8Array => masks.get(scale) ?? trayIconAlpha(scale)
  /** Alpha of the pixel containing the point (pt). */
  const at = (scale: number, x: number, y: number): number => {
    const size = TRAY_ICON_PT * scale
    return mask(scale)[Math.floor(y * scale) * size + Math.floor(x * scale)] ?? -1
  }
  /** Pixels (as pt rect cells) inside a pt rect. */
  const cells = (scale: number, x0: number, y0: number, x1: number, y1: number): number[] => {
    const out: number[] = []
    for (let py = Math.round(y0 * scale); py < Math.round(y1 * scale); py++) {
      for (let px = Math.round(x0 * scale); px < Math.round(x1 * scale); px++) out.push(at(scale, (px + 0.5) / scale, (py + 0.5) / scale))
    }
    return out
  }
  const coverage = (m: Uint8Array): number => m.reduce((sum, a) => sum + a, 0) / (255 * m.length)

  it('is (18 · scale)² bytes', () => {
    expect(TRAY_ICON_PT).toBe(18)
    expect(mask(1)).toHaveLength(18 * 18)
    expect(mask(2)).toHaveLength(36 * 36)
  })

  it('rejects scales other than whole numbers ≥ 1', () => {
    for (const scale of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => trayIconAlpha(scale)).toThrow(RangeError)
  })

  it('uses the full alpha range, with anti-aliased edges', () => {
    for (const scale of [1, 2]) {
      const m = mask(scale)
      expect(Math.min(...m)).toBe(0)
      expect(Math.max(...m)).toBe(255)
      expect(m.some((a) => a > 0 && a < 255)).toBe(true)
    }
  })

  it('has transparent corners', () => {
    for (const scale of [1, 2]) {
      for (const [x, y] of [
        [0.2, 0.2],
        [17.8, 0.2],
        [0.2, 17.8],
        [17.8, 17.8],
      ] as const) {
        expect(at(scale, x, y)).toBe(0)
      }
    }
  })

  it('has an opaque body: frame, chin, antenna and feet', () => {
    for (const scale of [1, 2]) {
      expect(at(scale, 3, 10)).toBe(255) // left frame
      expect(at(scale, 15, 10)).toBe(255) // right frame
      expect(at(scale, 9, 6)).toBe(255) // top frame
      expect(at(scale, 9, 14.5)).toBe(255) // chin
      expect(at(scale, 10.5, 4.5)).toBe(255) // antenna stem
      expect(at(scale, 10.5, 2)).toBe(255) // antenna ball
      expect(at(scale, 6, 16.5)).toBe(255) // left foot
      expect(at(scale, 12, 16.5)).toBe(255) // right foot
    }
  })

  it('has a screen hole that is mostly transparent, with two opaque eyes in it', () => {
    for (const scale of [1, 2]) {
      const leftEye = cells(scale, 6, 9, 8, 11)
      const rightEye = cells(scale, 10, 9, 12, 11)
      expect(leftEye.every((a) => a === 255)).toBe(true)
      expect(rightEye.every((a) => a === 255)).toBe(true)
      // The screen (4..14 × 7..13) without the eyes: only its rounded inner corners carry some alpha.
      const hole = cells(scale, 4, 7, 14, 13)
      const holeWithoutEyes = hole.length - leftEye.length - rightEye.length
      const alphaInHole = hole.reduce((sum, a) => sum + a, 0) - 255 * (leftEye.length + rightEye.length)
      expect(alphaInHole / (255 * holeWithoutEyes)).toBeLessThan(0.08)
      expect(hole.filter((a) => a === 0).length / holeWithoutEyes).toBeGreaterThan(0.7)
      expect(at(scale, 9, 10)).toBe(0) // between the eyes
      expect(at(scale, 9, 8)).toBe(0) // above them
    }
  })

  it('has gaps where the silhouette has none: beside the antenna, between the feet', () => {
    for (const scale of [1, 2]) {
      expect(at(scale, 8.5, 4.5)).toBe(0)
      expect(at(scale, 9, 17)).toBe(0)
    }
  })

  it('covers about the same fraction at both scales', () => {
    const c1 = coverage(mask(1))
    const c2 = coverage(mask(2))
    expect(c1).toBeGreaterThan(0.25)
    expect(c1).toBeLessThan(0.5)
    expect(Math.abs(c1 - c2)).toBeLessThan(0.01)
  })
})

describe('alphaToBgra', () => {
  it('makes black pixels carrying the alpha', () => {
    expect([...alphaToBgra(new Uint8Array([0, 128, 255]))]).toEqual([0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255])
  })

  it('converts the icon pixel for pixel without touching the mask', () => {
    const alpha = trayIconAlpha(1)
    const copy = alpha.slice()
    const bgra = alphaToBgra(alpha)
    expect(bgra).toHaveLength(alpha.length * 4)
    for (let i = 0; i < alpha.length; i++) {
      expect([bgra[i * 4], bgra[i * 4 + 1], bgra[i * 4 + 2], bgra[i * 4 + 3]]).toEqual([0, 0, 0, alpha[i]])
    }
    expect(alpha).toEqual(copy)
  })
})

describe('trayMenuTemplate', () => {
  const actions = (): { toggleVisible(): void; quit(): void; calls: string[] } => {
    const calls: string[] = []
    return { calls, toggleVisible: () => calls.push('toggle'), quit: () => calls.push('quit') }
  }
  // Electron calls click(menuItem, window, event); the actions take nothing.
  const click = (item: { click?: unknown } | undefined): void => {
    if (typeof item?.click !== 'function') throw new Error('item has no click handler')
    const handler = item.click as (...args: unknown[]) => void
    handler({}, undefined, {})
  }
  const labels = (items: { type?: string; label?: string }[]): (string | undefined)[] => items.map((item) => item.type ?? item.label)

  it('lists the header, Hide Bitbot with its shortcut, and Quit (§15.2 order)', () => {
    const items = trayMenuTemplate({ visible: true, toggleAccelerator: 'Alt+Command+B' }, actions())
    expect(labels(items)).toEqual(['Bitbot', 'separator', 'Hide Bitbot', 'separator', 'Quit Bitbot'])
    expect(items[0]).toEqual({ label: 'Bitbot', enabled: false })
    expect(items[2]?.accelerator).toBe('Alt+Command+B')
    expect(items[4]?.accelerator).toBeUndefined()
  })

  it('offers Show Bitbot while hidden, and shows no shortcut when it did not register', () => {
    const items = trayMenuTemplate({ visible: false, toggleAccelerator: null }, actions())
    expect(items[2]?.label).toBe('Show Bitbot')
    expect(items[2] && 'accelerator' in items[2]).toBe(false)
  })

  it('Come here and Go home come before Hide, with their shortcuts when registered (§15.2, M4)', () => {
    const a = actions()
    const calls: string[] = []
    const items = trayMenuTemplate(
      { visible: true, toggleAccelerator: null, comeHereAccelerator: 'Alt+Command+C', goHomeAccelerator: null },
      { ...a, comeHere: () => calls.push('come'), goHome: () => calls.push('home') },
    )
    expect(labels(items)).toEqual(['Bitbot', 'separator', 'Come here', 'Go home', 'Hide Bitbot', 'separator', 'Quit Bitbot'])
    expect(items[2]?.accelerator).toBe('Alt+Command+C')
    expect(items[3] && 'accelerator' in items[3]).toBe(false)
    click(items[2])
    click(items[3])
    expect(calls).toEqual(['come', 'home'])
  })

  it('calls the actions on click', () => {
    const a = actions()
    const items = trayMenuTemplate({ visible: true, toggleAccelerator: null }, a)
    click(items[2])
    click(items[4])
    expect(a.calls).toEqual(['toggle', 'quit'])
    expect(items[0]?.click).toBeUndefined()
  })

  it('has no Developer… without the developer action (packaged builds)', () => {
    const items = trayMenuTemplate({ visible: true, toggleAccelerator: null }, actions())
    expect(items.some((item) => item.label?.startsWith('Developer'))).toBe(false)
  })

  it('lists Developer… before Quit when given the developer action (dev builds, §15.2), and calls it', () => {
    const a = actions()
    let opened = 0
    const items = trayMenuTemplate({ visible: true, toggleAccelerator: null }, { ...a, developer: () => opened++ })
    expect(labels(items)).toEqual(['Bitbot', 'separator', 'Hide Bitbot', 'separator', 'Developer…', 'Quit Bitbot'])
    click(items[4])
    expect(opened).toBe(1)
    click(items[5])
    expect(a.calls).toEqual(['quit'])
  })

  const TODAY = { crumbs: 1240.7, pellets: 310, treats: 6.25, mileage: 22.999, sparks: 3 }

  it("shows today's earned totals after the header, before the first separator, disabled (§15.2)", () => {
    const items = trayMenuTemplate({ visible: true, toggleAccelerator: null, today: TODAY }, actions())
    expect(labels(items)).toEqual(['Bitbot', 'Today: 🍞 1,240  ⚪ 310  🎁 6  🧭 22  ✨ 3', 'separator', 'Hide Bitbot', 'separator', 'Quit Bitbot'])
    expect(items[1]?.enabled).toBe(false)
    expect(items[1]?.click).toBeUndefined()
  })

  it('has no Today line while the economy has nothing to show (null or absent)', () => {
    for (const today of [null, undefined]) {
      const items = trayMenuTemplate({ visible: true, toggleAccelerator: null, today }, actions())
      expect(items.some((item) => item.label?.startsWith('Today'))).toBe(false)
    }
  })

  it('shows the Input Monitoring reminder while it is off, with Developer… and Quit (§7.1, §15.2), and calls it', () => {
    const a = actions()
    let turnedOn = 0
    const items = trayMenuTemplate(
      { visible: true, toggleAccelerator: null, inputMonitoringOff: true },
      { ...a, developer: () => {}, turnOnInputMonitoring: () => turnedOn++ },
    )
    expect(labels(items)).toEqual(['Bitbot', 'separator', 'Hide Bitbot', 'separator', 'Input Monitoring is off — Turn on…', 'Developer…', 'Quit Bitbot'])
    expect(items[4]?.enabled).toBeUndefined()
    click(items[4])
    expect(turnedOn).toBe(1)
    expect(a.calls).toEqual([])
  })

  it('has no reminder when Input Monitoring is granted, or without the action', () => {
    const reminder = (items: { label?: string }[]): boolean => items.some((item) => item.label?.startsWith('Input Monitoring'))
    const on = { turnOnInputMonitoring: () => {} }
    expect(reminder(trayMenuTemplate({ visible: true, toggleAccelerator: null, inputMonitoringOff: false }, { ...actions(), ...on }))).toBe(false)
    expect(reminder(trayMenuTemplate({ visible: true, toggleAccelerator: null }, { ...actions(), ...on }))).toBe(false)
    expect(reminder(trayMenuTemplate({ visible: true, toggleAccelerator: null, inputMonitoringOff: true }, actions()))).toBe(false)
  })

  it('Settings… comes after the Input Monitoring reminder and before Developer… when given (§15.2, M8), and calls it', () => {
    const a = actions()
    let opened = 0
    const items = trayMenuTemplate(
      { visible: true, toggleAccelerator: null, inputMonitoringOff: true },
      { ...a, developer: () => {}, turnOnInputMonitoring: () => {}, settings: () => opened++ },
    )
    expect(labels(items)).toEqual(['Bitbot', 'separator', 'Hide Bitbot', 'separator', 'Input Monitoring is off — Turn on…', 'Settings…', 'Developer…', 'Quit Bitbot'])
    click(items[5])
    expect(opened).toBe(1)
    expect(trayMenuTemplate({ visible: true, toggleAccelerator: null }, actions()).some((item) => item.label === 'Settings…')).toBe(false)
  })
})

describe('trayMenuTemplate header (§15.2)', () => {
  it('shows the pet’s name and mood word when given, else "Bitbot"', () => {
    const a = { toggleVisible: () => {}, quit: () => {} }
    expect(trayMenuTemplate({ visible: true, toggleAccelerator: null, header: 'Nibs — happy' }, a)[0]).toEqual({ label: 'Nibs — happy', enabled: false })
    expect(trayMenuTemplate({ visible: true, toggleAccelerator: null }, a)[0]).toEqual({ label: 'Bitbot', enabled: false })
  })
})

describe('trayMenuTemplate Mode ▸ (§15.2, M7)', () => {
  type Item = { label?: string; type?: string; checked?: boolean; enabled?: boolean; accelerator?: string; submenu?: unknown; click?: unknown }
  const press = (item: Item | undefined): void => (item?.click as (...args: unknown[]) => void)({}, undefined, {})
  const setup = (mode: { current: 'roam' | 'stay' | 'hangout'; spots: { id: string; name: string }[]; activeSpotId: string | null }) => {
    const calls: string[] = []
    const items = trayMenuTemplate(
      { visible: true, toggleAccelerator: null, toggleStayAccelerator: 'Alt+Command+S', mode },
      {
        toggleVisible: () => calls.push('toggle'),
        quit: () => calls.push('quit'),
        setMode: (m) => calls.push(`mode:${m}`),
        selectSpot: (id) => calls.push(`spot:${id}`),
        forgetSpot: (id) => calls.push(`forget:${id}`),
      },
    ) as Item[]
    const modeItem = items.find((i) => i.label === 'Mode')
    return { calls, items, sub: (modeItem?.submenu ?? []) as Item[] }
  }

  it('comes after the header, before Hide Bitbot; Roam and Stay are radio items with ⌥⌘S on Stay', () => {
    const { items, sub, calls } = setup({ current: 'roam', spots: [], activeSpotId: null })
    expect(items.map((i) => i.type ?? i.label)).toEqual(['Bitbot', 'separator', 'Mode', 'Hide Bitbot', 'separator', 'Quit Bitbot'])
    expect(sub.map((i) => [i.label, i.checked])).toEqual([
      ['Roam', true],
      ['Stay', false],
      ['Hang out', undefined],
    ])
    expect(sub[1]?.accelerator).toBe('Alt+Command+S')
    press(sub[1])
    press(sub[0])
    expect(calls).toEqual(['mode:stay', 'mode:roam'])
    // No spots yet: a hint.
    expect((sub[2]?.submenu as Item[])[0]).toMatchObject({ enabled: false })
  })

  it('Hang out ▸ lists the spots with the active one checked, and forgets it', () => {
    const spots = [
      { id: 'spot-1', name: 'Dock, left side' },
      { id: 'spot-2', name: 'On Notes' },
    ]
    const { sub, calls } = setup({ current: 'hangout', spots, activeSpotId: 'spot-2' })
    expect(sub[0]?.checked).toBe(false)
    expect(sub[2]?.label).toBe('Hang out: On Notes')
    const list = sub[2]?.submenu as Item[]
    expect(list.map((i) => [i.type === 'separator' ? '-' : i.label, i.checked])).toEqual([
      ['Dock, left side', false],
      ['On Notes', true],
      ['-', undefined],
      ['Forget “On Notes”', undefined],
    ])
    press(list[0])
    press(list[3])
    expect(calls).toEqual(['spot:spot-1', 'forget:spot-2'])
  })

  it('ends with Manage spots… when given (§15.2, M8: opens settings), and calls it', () => {
    let managed = 0
    const items = trayMenuTemplate(
      { visible: true, toggleAccelerator: null, mode: { current: 'roam', spots: [], activeSpotId: null } },
      { toggleVisible: () => {}, quit: () => {}, setMode: () => {}, manageSpots: () => managed++ },
    ) as Item[]
    const sub = (items.find((i) => i.label === 'Mode')?.submenu ?? []) as Item[]
    expect(sub.map((i) => i.type ?? i.label)).toEqual(['radio', 'radio', 'Hang out', 'separator', 'Manage spots…'])
    press(sub[4])
    expect(managed).toBe(1)
    expect(setup({ current: 'roam', spots: [], activeSpotId: null }).sub.some((i) => i.label === 'Manage spots…')).toBe(false)
  })

  it('in Roam no spot is checked even if one was active before', () => {
    const { sub } = setup({ current: 'roam', spots: [{ id: 'spot-1', name: 'Middle' }], activeSpotId: 'spot-1' })
    expect(sub[2]?.label).toBe('Hang out')
    expect((sub[2]?.submenu as Item[]).map((i) => i.checked)).toEqual([false])
  })
})

describe('formatToday / formatWhole', () => {
  it('lists all five currencies in order, icon and number, two spaces apart (§15.2)', () => {
    expect(formatToday({ crumbs: 0, pellets: 0, treats: 0, mileage: 0, sparks: 0 })).toBe('Today: 🍞 0  ⚪ 0  🎁 0  🧭 0  ✨ 0')
    expect(formatToday({ crumbs: 1, pellets: 2, treats: 3, mileage: 4, sparks: 5 })).toBe('Today: 🍞 1  ⚪ 2  🎁 3  🧭 4  ✨ 5')
  })

  it('rounds down so the number never runs ahead of what was earned', () => {
    expect(formatWhole(0.99)).toBe('0')
    expect(formatWhole(6.999)).toBe('6')
    expect(formatWhole(22)).toBe('22')
  })

  it('does not lose a unit to float error in a running sum', () => {
    let sum = 0
    for (let i = 0; i < 10; i++) sum += 0.1 // ten clicks
    expect(sum).toBeLessThan(1)
    expect(formatWhole(sum)).toBe('1')
  })

  it('separates thousands with commas', () => {
    expect(formatWhole(999)).toBe('999')
    expect(formatWhole(1000)).toBe('1,000')
    expect(formatWhole(1240.9)).toBe('1,240')
    expect(formatWhole(1_234_567)).toBe('1,234,567')
  })

  it('shows 0 for nothing, negatives and non-numbers', () => {
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatWhole(value)).toBe('0')
  })
})

describe('petContextMenuTemplate', () => {
  const press = (item: { click?: unknown } | undefined): void => (item?.click as (...args: unknown[]) => void)({}, undefined, {})
  const setup = (mode: 'roam' | 'stay' | 'hangout', onApp: string | null) => {
    const calls: string[] = []
    const a = (name: string) => () => void calls.push(name)
    const items = petContextMenuTemplate(
      { mode, onApp },
      { pet: a('pet'), stayHere: a('stay'), roam: a('roam'), hangOutHere: a('here'), hangOutOnApp: a('app'), goHome: a('home'), hide: a('hide') },
    )
    return { items, calls, labels: items.map((item) => item.type ?? item.label) }
  }

  it('Pet, Stay here, Hang out here, Go home, a separator and Hide (§15.3 order), each calling its action', () => {
    const { items, calls, labels } = setup('roam', null)
    expect(labels).toEqual(['Pet', 'Stay here', 'Hang out here', 'Go home', 'separator', 'Hide'])
    for (const i of [0, 1, 2, 3, 5]) press(items[i])
    expect(calls).toEqual(['pet', 'stay', 'here', 'home', 'hide'])
  })

  it('in Stay it offers Roam instead', () => {
    const { items, calls, labels } = setup('stay', null)
    expect(labels[1]).toBe('Roam')
    press(items[1])
    expect(calls).toEqual(['roam'])
  })

  it('on an app’s window: both "Hang out here (this spot)" and "Hang out on <App>" (§10.3)', () => {
    const { items, calls, labels } = setup('hangout', 'Notes')
    expect(labels).toEqual(['Pet', 'Stay here', 'Hang out here (this spot)', 'Hang out on Notes', 'Go home', 'separator', 'Hide'])
    press(items[2])
    press(items[3])
    expect(calls).toEqual(['here', 'app'])
  })

  it('Settings… comes last, after Hide, when given (§15.3, M8)', () => {
    let opened = 0
    const noop = (): void => undefined
    const items = petContextMenuTemplate(
      { mode: 'roam', onApp: null },
      { pet: noop, stayHere: noop, roam: noop, hangOutHere: noop, hangOutOnApp: noop, goHome: noop, hide: noop, settings: () => opened++ },
    )
    expect(items.map((item) => item.type ?? item.label)).toEqual(['Pet', 'Stay here', 'Hang out here', 'Go home', 'separator', 'Hide', 'Settings…'])
    press(items[6])
    expect(opened).toBe(1)
  })
})

describe('Hotkeys', () => {
  /** A globalShortcut stand-in. `owners` holds accelerators taken by "other apps". */
  class FakeRegistry implements ShortcutRegistry {
    readonly callbacks = new Map<string, () => void>()
    readonly owners = new Set<string>()
    readonly fails = new Map<string, 'false' | 'throw'>()
    readonly calls: string[] = []
    register(accelerator: string, callback: () => void): boolean {
      this.calls.push(`register ${accelerator}`)
      const fail = this.fails.get(accelerator)
      if (fail === 'throw') throw new TypeError(`bad accelerator ${accelerator}`)
      if (fail === 'false' || this.owners.has(accelerator) || this.callbacks.has(accelerator)) return false
      this.callbacks.set(accelerator, callback)
      return true
    }
    unregister(accelerator: string): void {
      this.calls.push(`unregister ${accelerator}`)
      this.callbacks.delete(accelerator)
    }
    press(accelerator: string): void {
      this.callbacks.get(accelerator)?.()
    }
  }

  it('registers only the actions it is given, at the default bindings', () => {
    const registry = new FakeRegistry()
    const hotkeys = new Hotkeys(registry)
    let toggles = 0
    const result = hotkeys.register({ toggleVisible: () => toggles++ })
    expect(result).toEqual({ registered: ['toggleVisible'], failed: [] })
    expect(registry.calls).toEqual([`register ${DEFAULT_HOTKEYS.toggleVisible}`])
    registry.press('Alt+Command+B')
    expect(toggles).toBe(1)
    expect(hotkeys.accelerator('toggleVisible')).toBe('Alt+Command+B')
    expect(hotkeys.accelerator('comeHere')).toBeNull()
  })

  it('a registry that returns false or throws, or a shortcut owned by another app, counts as failed', () => {
    const registry = new FakeRegistry()
    registry.fails.set(DEFAULT_HOTKEYS.comeHere, 'false')
    registry.fails.set(DEFAULT_HOTKEYS.goHome, 'throw')
    registry.owners.add(DEFAULT_HOTKEYS.toggleStay)
    const hotkeys = new Hotkeys(registry)
    const noop = (): void => undefined
    const result = hotkeys.register({ toggleVisible: noop, comeHere: noop, goHome: noop, toggleStay: noop })
    expect(result).toEqual({ registered: ['toggleVisible'], failed: ['comeHere', 'goHome', 'toggleStay'] })
    for (const action of ['comeHere', 'goHome', 'toggleStay'] as HotkeyAction[]) expect(hotkeys.accelerator(action)).toBeNull()
    expect(hotkeys.accelerator('toggleVisible')).toBe(DEFAULT_HOTKEYS.toggleVisible)
  })

  it('an empty accelerator fails without reaching the registry', () => {
    const registry = new FakeRegistry()
    const hotkeys = new Hotkeys(registry, { ...DEFAULT_HOTKEYS, toggleVisible: '' })
    expect(hotkeys.register({ toggleVisible: () => undefined }).failed).toEqual(['toggleVisible'])
    expect(registry.calls).toEqual([])
  })

  it('uses the accelerators it was given', () => {
    const registry = new FakeRegistry()
    const hotkeys = new Hotkeys(registry, { ...DEFAULT_HOTKEYS, toggleVisible: 'Control+Alt+P' })
    hotkeys.register({ toggleVisible: () => undefined })
    expect(registry.calls).toEqual(['register Control+Alt+P'])
    expect(hotkeys.accelerator('toggleVisible')).toBe('Control+Alt+P')
  })

  it('unregisterAll unregisters only what this instance registered', () => {
    const registry = new FakeRegistry()
    registry.owners.add(DEFAULT_HOTKEYS.comeHere)
    const other = new Hotkeys(registry)
    other.register({ goHome: () => undefined }) // someone else's registration in the same registry
    const hotkeys = new Hotkeys(registry)
    hotkeys.register({ toggleVisible: () => undefined, comeHere: () => undefined })
    registry.calls.length = 0
    hotkeys.unregisterAll()
    expect(registry.calls).toEqual([`unregister ${DEFAULT_HOTKEYS.toggleVisible}`])
    expect(hotkeys.accelerator('toggleVisible')).toBeNull()
    expect(registry.callbacks.has(DEFAULT_HOTKEYS.goHome)).toBe(true)
    hotkeys.unregisterAll()
    expect(registry.calls).toHaveLength(1)
  })

  it('registering an action again replaces its own binding', () => {
    const registry = new FakeRegistry()
    const hotkeys = new Hotkeys(registry)
    const pressed: string[] = []
    hotkeys.register({ toggleVisible: () => pressed.push('first') })
    expect(hotkeys.register({ toggleVisible: () => pressed.push('second') })).toEqual({ registered: ['toggleVisible'], failed: [] })
    registry.press(DEFAULT_HOTKEYS.toggleVisible)
    expect(pressed).toEqual(['second'])
  })

  it('an unregister that throws still forgets the binding', () => {
    const registry = new FakeRegistry()
    const hotkeys = new Hotkeys(registry)
    hotkeys.register({ toggleVisible: () => undefined })
    registry.unregister = () => {
      throw new Error('quitting')
    }
    expect(() => hotkeys.unregisterAll()).not.toThrow()
    expect(hotkeys.accelerator('toggleVisible')).toBeNull()
  })

  describe('rebind (the settings window, §15.4)', () => {
    const setup = () => {
      const registry = new FakeRegistry()
      const hotkeys = new Hotkeys(registry)
      const pressed: string[] = []
      hotkeys.register({
        toggleVisible: () => pressed.push('toggle'),
        comeHere: () => pressed.push('come'),
        goHome: () => pressed.push('home'),
        toggleStay: () => pressed.push('stay'),
      })
      registry.calls.length = 0
      return { registry, hotkeys, pressed }
    }

    it('moves an action to a new combination: the old one is unregistered, the new one calls the same handler', () => {
      const { registry, hotkeys, pressed } = setup()
      expect(hotkeys.rebind('toggleVisible', 'Control+Alt+P')).toEqual({ ok: true, accelerator: 'Control+Alt+P' })
      expect(registry.calls).toEqual(['unregister Alt+Command+B', 'register Control+Alt+P'])
      registry.press('Alt+Command+B')
      registry.press('Control+Alt+P')
      expect(pressed).toEqual(['toggle'])
      expect(hotkeys.accelerator('toggleVisible')).toBe('Control+Alt+P')
      expect(hotkeys.bindings().toggleVisible).toBe('Control+Alt+P')
      expect(hotkeys.statuses().toggleVisible).toEqual({ accelerator: 'Control+Alt+P', registered: true })
    })

    it('stores the canonical spelling', () => {
      const { hotkeys } = setup()
      expect(hotkeys.rebind('goHome', 'Cmd+Option+j')).toEqual({ ok: true, accelerator: 'Alt+Command+J' })
      expect(hotkeys.bindings().goHome).toBe('Alt+Command+J')
    })

    it('refuses another Bitbot action’s combination (in any spelling) without touching the registry', () => {
      const { registry, hotkeys } = setup()
      expect(hotkeys.rebind('toggleVisible', 'Command+Alt+H')).toEqual({ ok: false, reason: 'conflict', accelerator: 'Alt+Command+H', conflictsWith: 'goHome' })
      expect(registry.calls).toEqual([])
      expect(hotkeys.bindings().toggleVisible).toBe(DEFAULT_HOTKEYS.toggleVisible)
    })

    it('a combination another app owns: the old binding is registered again and kept', () => {
      const { registry, hotkeys, pressed } = setup()
      registry.owners.add('Command+Space')
      expect(hotkeys.rebind('toggleStay', 'Command+Space')).toEqual({ ok: false, reason: 'taken', accelerator: 'Command+Space' })
      expect(registry.calls).toEqual(['unregister Alt+Command+S', 'register Command+Space', 'register Alt+Command+S'])
      expect(hotkeys.statuses().toggleStay).toEqual({ accelerator: 'Alt+Command+S', registered: true })
      registry.press('Alt+Command+S')
      expect(pressed).toEqual(['stay'])
    })

    it('a registry that throws counts as taken', () => {
      const { registry, hotkeys } = setup()
      registry.fails.set('Control+Alt+X', 'throw')
      expect(hotkeys.rebind('comeHere', 'Control+Alt+X')).toMatchObject({ ok: false, reason: 'taken' })
      expect(hotkeys.accelerator('comeHere')).toBe(DEFAULT_HOTKEYS.comeHere)
    })

    it('an action that failed to register can be moved to a free combination, and then works', () => {
      const registry = new FakeRegistry()
      registry.owners.add(DEFAULT_HOTKEYS.comeHere)
      const hotkeys = new Hotkeys(registry)
      let comes = 0
      hotkeys.register({ comeHere: () => comes++ })
      expect(hotkeys.statuses().comeHere).toEqual({ accelerator: DEFAULT_HOTKEYS.comeHere, registered: false })
      registry.owners.add('Control+Alt+Y')
      expect(hotkeys.rebind('comeHere', 'Control+Alt+Y')).toMatchObject({ ok: false, reason: 'taken' })
      expect(hotkeys.statuses().comeHere).toEqual({ accelerator: DEFAULT_HOTKEYS.comeHere, registered: false })
      expect(hotkeys.rebind('comeHere', 'Control+Alt+Z')).toEqual({ ok: true, accelerator: 'Control+Alt+Z' })
      registry.press('Control+Alt+Z')
      expect(comes).toBe(1)
      expect(hotkeys.statuses().comeHere).toEqual({ accelerator: 'Control+Alt+Z', registered: true })
    })

    it('the same combination again changes nothing', () => {
      const { registry, hotkeys } = setup()
      expect(hotkeys.rebind('toggleVisible', 'Command+Alt+B')).toEqual({ ok: true, accelerator: 'Alt+Command+B' })
      expect(registry.calls).toEqual([])
    })

    it('refuses what isn’t a combination, and an action that was never registered', () => {
      const { hotkeys } = setup()
      expect(hotkeys.rebind('toggleVisible', 'B')).toEqual({ ok: false, reason: 'invalid', accelerator: 'B' })
      expect(hotkeys.rebind('toggleVisible', 'Shift+B')).toMatchObject({ ok: false, reason: 'invalid' })
      const bare = new Hotkeys(new FakeRegistry())
      expect(bare.rebind('goHome', 'Control+Alt+G')).toMatchObject({ ok: false, reason: 'noHandler' })
    })

    it('statuses() covers every action; bindings() are what to save', () => {
      const registry = new FakeRegistry()
      const hotkeys = new Hotkeys(registry, { ...DEFAULT_HOTKEYS, goHome: 'Control+Alt+H' })
      hotkeys.register({ toggleVisible: () => undefined })
      expect(hotkeys.statuses()).toEqual({
        toggleVisible: { accelerator: 'Alt+Command+B', registered: true },
        comeHere: { accelerator: 'Alt+Command+C', registered: false },
        goHome: { accelerator: 'Control+Alt+H', registered: false },
        toggleStay: { accelerator: 'Alt+Command+S', registered: false },
      })
      expect(hotkeys.bindings()).toEqual({ ...DEFAULT_HOTKEYS, goHome: 'Control+Alt+H' })
    })

    it('rebindNotice says what happened in words (null when it worked)', () => {
      const { registry, hotkeys } = setup()
      expect(rebindNotice('toggleVisible', { ok: true, accelerator: 'Control+Alt+P' }, hotkeys.statuses().toggleVisible)).toBeNull()
      const conflict = hotkeys.rebind('toggleVisible', 'Alt+Command+H')
      expect(rebindNotice('toggleVisible', conflict, hotkeys.statuses().toggleVisible)).toBe(
        '⌥⌘H is already Bitbot’s “Go home” hotkey. Pick another, or change that one first.',
      )
      registry.owners.add('Command+Space')
      const taken = hotkeys.rebind('toggleStay', 'Command+Space')
      expect(rebindNotice('toggleStay', taken, hotkeys.statuses().toggleStay)).toBe(
        '⌘Space is in use by another app or by macOS, so “Toggle Stay” stays on ⌥⌘S.',
      )
      expect(rebindNotice('toggleStay', taken, { accelerator: 'Alt+Command+S', registered: false })).toContain('has no working hotkey yet')
    })
  })
})
