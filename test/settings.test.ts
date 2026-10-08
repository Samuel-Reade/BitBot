import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGES } from '../src/main/pages'
import {
  SettingsWindow,
  settingsWindowOptions,
  type SettingsBrowserWindow,
  type SettingsIpcEvent,
  type SettingsWindowDeps,
  type SettingsWindowPlatform,
} from '../src/main/windows/settingsWindow'
import { dayLabel, hotkeyRows, moreAppsText, permissionLine, recorderStep, spotRows, defaultHomeName } from '../src/renderer/settings/model'
import { acceleratorFromKey, formatAccelerator, isAccelerator, normalizeAccelerator, sameAccelerator, type KeyLike } from '../src/shared/accelerator'
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS } from '../src/shared/hotkeys'
import { IPC, isAllowedChannel } from '../src/shared/ipc'
import { DEFAULT_MODE_SETTINGS } from '../src/shared/modes'
import { DEFAULT_IDENTITY, DEFAULT_SETTINGS } from '../src/shared/settings'
import {
  cleanSpotName,
  isSettingsChange,
  isSettingsView,
  knownAppsView,
  localDay,
  modesView,
  type SettingsAppView,
  type SettingsChange,
  type SettingsView,
} from '../src/shared/settingsProtocol'
import { tuning } from '../src/shared/tuning'

// The settings window (BITBOT_SPEC.md §15.4): hotkey recording (src/shared/accelerator.ts), its messages
// (src/shared/settingsProtocol.ts), the window's IPC (src/main/windows/settingsWindow.ts) and the page's pure parts
// (src/renderer/settings/model.ts). Hotkey rebinding is in shellParts.test.ts, spot renaming / the default home in
// modes.test.ts.

const ROOT = join(__dirname, '..')

const key = (code: string, mods: Partial<KeyLike> = {}, k = 'x'): KeyLike => ({
  key: k,
  code,
  metaKey: false,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...mods,
})

describe('acceleratorFromKey (the recorder)', () => {
  it('⌥⌘S records as S from the physical key, not the ß that ⌥S types', () => {
    expect(acceleratorFromKey(key('KeyS', { altKey: true, metaKey: true }, 'ß'))).toEqual({ kind: 'ok', accelerator: 'Alt+Command+S' })
  })

  it('writes modifiers in the order ⌃⌥⇧⌘ (Control, Alt, Shift, Command)', () => {
    expect(acceleratorFromKey(key('F5', { metaKey: true, shiftKey: true, ctrlKey: true, altKey: true }))).toEqual({
      kind: 'ok',
      accelerator: 'Control+Alt+Shift+Command+F5',
    })
    expect(acceleratorFromKey(key('Digit1', { ctrlKey: true }))).toEqual({ kind: 'ok', accelerator: 'Control+1' })
    expect(acceleratorFromKey(key('ArrowUp', { altKey: true }))).toEqual({ kind: 'ok', accelerator: 'Alt+Up' })
    expect(acceleratorFromKey(key('Space', { metaKey: true }))).toEqual({ kind: 'ok', accelerator: 'Command+Space' })
    expect(acceleratorFromKey(key('Slash', { metaKey: true, shiftKey: true }, '?'))).toEqual({ kind: 'ok', accelerator: 'Shift+Command+/' })
  })

  it('only modifiers so far: keep listening', () => {
    expect(acceleratorFromKey(key('MetaLeft', { metaKey: true }, 'Meta'))).toEqual({ kind: 'incomplete' })
    expect(acceleratorFromKey(key('AltRight', { altKey: true }, 'Alt'))).toEqual({ kind: 'incomplete' })
    expect(acceleratorFromKey(key('ShiftLeft', { shiftKey: true }, 'Shift'))).toEqual({ kind: 'incomplete' })
  })

  it('rejects a bare key and a Shift-only combination (that is typing), and keys a hotkey can’t use', () => {
    expect(acceleratorFromKey(key('KeyA'))).toMatchObject({ kind: 'rejected' })
    expect(acceleratorFromKey(key('KeyA', { shiftKey: true }))).toMatchObject({ kind: 'rejected' })
    expect(acceleratorFromKey(key('F3'))).toMatchObject({ kind: 'rejected' })
    expect(acceleratorFromKey(key('Escape', { metaKey: true }))).toMatchObject({ kind: 'rejected' })
    expect(acceleratorFromKey(key('MediaPlayPause', { metaKey: true }))).toMatchObject({ kind: 'rejected' })
  })
})

describe('normalizeAccelerator / sameAccelerator / formatAccelerator', () => {
  it('the defaults are canonical', () => {
    for (const action of HOTKEY_ACTIONS) expect(normalizeAccelerator(DEFAULT_HOTKEYS[action])).toBe(DEFAULT_HOTKEYS[action])
  })

  it('folds aliases and order into one spelling', () => {
    expect(normalizeAccelerator('Cmd+Option+s')).toBe('Alt+Command+S')
    expect(normalizeAccelerator('CommandOrControl+Shift+k')).toBe('Shift+Command+K')
    expect(normalizeAccelerator('Ctrl+Alt+enter')).toBe('Control+Alt+Return')
    expect(sameAccelerator('Command+Alt+B', 'Alt+Command+B')).toBe(true)
    expect(sameAccelerator('Alt+Command+B', 'Alt+Command+C')).toBe(false)
    expect(sameAccelerator('B', 'B')).toBe(false)
  })

  it('accepts only combinations the recorder could make', () => {
    for (const bad of ['', 'B', 'Shift+B', 'Command', 'Command+Command+B', 'Command+Escape', 'Hyper+B', 'Command+Plus', 'Command+', 42, null, 'Alt+Command+B'.repeat(10)]) {
      expect(isAccelerator(bad), String(bad)).toBe(false)
    }
  })

  it('shows macOS symbols', () => {
    expect(formatAccelerator('Alt+Command+S')).toBe('⌥⌘S')
    expect(formatAccelerator('Control+Alt+Shift+Command+Up')).toBe('⌃⌥⇧⌘↑')
    expect(formatAccelerator('Command+Space')).toBe('⌘Space')
    expect(formatAccelerator('Control+num5')).toBe('⌃Keypad 5')
    expect(formatAccelerator('nonsense')).toBe('nonsense')
  })
})

describe('isSettingsChange', () => {
  const valid: SettingsChange[] = [
    { kind: 'name', name: 'Pixel' },
    { kind: 'palette', paletteId: 'lilac' },
    { kind: 'size', size: 'L' },
    { kind: 'resetPosition' },
    { kind: 'defaultMode', mode: 'roam' },
    { kind: 'defaultMode', mode: 'stay' },
    { kind: 'defaultMode', mode: 'hangout', spotId: 'spot-2' },
    { kind: 'restlessness', value: 0 },
    { kind: 'restlessness', value: 1 },
    { kind: 'renameSpot', id: 'spot-1', name: 'Desk corner' },
    { kind: 'deleteSpot', id: 'spot-1' },
    { kind: 'setDefaultHome', id: 'spot-1' },
    { kind: 'setDefaultHome', id: null },
    { kind: 'hideInFullscreen', on: false },
    { kind: 'hotkey', action: 'goHome', accelerator: 'Control+Alt+H' },
    { kind: 'resetHotkey', action: 'toggleStay' },
    { kind: 'altCmdClickSend', on: true },
    { kind: 'recordingHotkey', on: true },
    { kind: 'recordingHotkey', on: false },
    { kind: 'launchAtLogin', on: true },
    { kind: 'requestInputAccess' },
    { kind: 'eraseAllData', confirmed: true },
  ]

  it('accepts every kind of change', () => {
    for (const change of valid) expect(isSettingsChange(change), JSON.stringify(change)).toBe(true)
    const kinds = new Set(valid.map((c) => c.kind))
    expect(kinds.size).toBe(17)
  })

  it('rejects malformed changes', () => {
    const bad: unknown[] = [
      null,
      'name',
      [],
      {},
      { kind: 'nope' },
      { kind: 'name', name: '  Pixel ' }, // not cleaned
      { kind: 'name', name: '' },
      { kind: 'name', name: 'x'.repeat(21) },
      { kind: 'name', name: 'Pi\nxel' },
      { kind: 'name', name: 7 },
      { kind: 'name', name: 'Pixel', extra: 1 },
      { kind: 'palette', paletteId: 'teal' },
      { kind: 'size', size: 'XL' },
      { kind: 'resetPosition', now: true },
      { kind: 'defaultMode', mode: 'hangout' },
      { kind: 'defaultMode', mode: 'roam', spotId: 'spot-1' },
      { kind: 'defaultMode', mode: 'fly' },
      { kind: 'defaultMode', mode: 'hangout', spotId: '' },
      { kind: 'defaultMode', mode: 'hangout', spotId: 'x'.repeat(65) },
      { kind: 'restlessness', value: -0.1 },
      { kind: 'restlessness', value: 1.1 },
      { kind: 'restlessness', value: Number.NaN },
      { kind: 'restlessness', value: '0.5' },
      { kind: 'renameSpot', id: 'spot-1', name: ' ' },
      { kind: 'renameSpot', id: 'spot-1', name: 'x'.repeat(tuning.settingsWindow.spotNameMax + 1) },
      { kind: 'renameSpot', id: 'spot-1' },
      { kind: 'deleteSpot', id: 3 },
      { kind: 'setDefaultHome' },
      { kind: 'hideInFullscreen', on: 'yes' },
      { kind: 'hotkey', action: 'goHome', accelerator: 'H' },
      { kind: 'hotkey', action: 'goHome', accelerator: 'Command+Alt+H' }, // not canonical
      { kind: 'hotkey', action: 'dance', accelerator: 'Control+Alt+H' },
      { kind: 'resetHotkey', action: 'dance' },
      { kind: 'altCmdClickSend', on: 1 },
      { kind: 'recordingHotkey', on: 'yes' },
      { kind: 'recordingHotkey' },
      { kind: 'launchAtLogin' },
      { kind: 'eraseAllData' },
      { kind: 'eraseAllData', confirmed: 'true' },
      { kind: 'eraseAllData', confirmed: false },
    ]
    for (const change of bad) expect(isSettingsChange(change), JSON.stringify(change)).toBe(false)
  })

  it('cleanSpotName trims and limits like the pet’s name', () => {
    expect(cleanSpotName('  Desk  ')).toBe('Desk')
    expect(cleanSpotName('a\u0007b')).toBe('ab')
    expect(cleanSpotName('')).toBeNull()
    expect(cleanSpotName(5)).toBeNull()
    expect(cleanSpotName('x'.repeat(tuning.settingsWindow.spotNameMax))).not.toBeNull()
  })
})

// ───────────────────────────── the view ─────────────────────────────

function appView(over: Partial<SettingsAppView> = {}): SettingsAppView {
  return {
    identity: { ...DEFAULT_IDENTITY },
    settings: structuredClone(DEFAULT_SETTINGS),
    modes: modesView({
      ...DEFAULT_MODE_SETTINGS,
      mode: 'hangout',
      activeHangoutId: 'spot-2',
      defaultHomeId: 'spot-1',
      hangouts: [
        { id: 'spot-1', name: 'Dock, left side', kind: 'screen', displayId: 1, x: 100, y: 1022 },
        { id: 'spot-2', name: 'On Notes', kind: 'app', bundleId: 'com.apple.Notes', appName: 'Notes', relativeX: 0.5, fallbackId: null },
      ],
    }),
    hotkeys: {
      toggleVisible: { accelerator: 'Alt+Command+B', registered: true },
      comeHere: { accelerator: 'Alt+Command+C', registered: false },
      goHome: { accelerator: 'Control+Alt+H', registered: true },
      toggleStay: { accelerator: 'Alt+Command+S', registered: true },
    },
    inputMonitoring: 'off',
    launchAtLoginAvailable: false,
    knownApps: [{ bundleId: 'com.apple.Notes', name: 'Notes', lastOpenedDay: '2026-10-08' }],
    knownAppsTotal: 3,
    version: '0.1.0',
    ...over,
  }
}

const fullView = (over: Partial<SettingsView> = {}): SettingsView => ({ ...appView(), notice: null, ...over })

describe('the view', () => {
  it('modesView keeps what the page shows of the modes', () => {
    expect(appView().modes).toEqual({
      mode: 'hangout',
      activeSpotId: 'spot-2',
      defaultHomeId: 'spot-1',
      spots: [
        { id: 'spot-1', name: 'Dock, left side', kind: 'screen', appName: null },
        { id: 'spot-2', name: 'On Notes', kind: 'app', appName: 'Notes' },
      ],
    })
  })

  it('knownAppsView: the most recently opened first, local days, names when known, cut at knownAppsShown', () => {
    const known: Record<string, string> = {
      'com.a': new Date(2026, 9, 1, 10).toISOString(),
      'com.b': new Date(2026, 9, 8, 9).toISOString(),
      'com.c': 'not a time',
    }
    const out = knownAppsView(known, (id) => (id === 'com.b' ? 'Bee' : null))
    expect(out.knownApps).toEqual([
      { bundleId: 'com.b', name: 'Bee', lastOpenedDay: '2026-10-08' },
      { bundleId: 'com.a', name: null, lastOpenedDay: '2026-10-01' },
    ])
    expect(out.knownAppsTotal).toBe(3)
    const many = Object.fromEntries(Array.from({ length: tuning.settingsWindow.knownAppsShown + 5 }, (_, i) => [`com.app${i}`, new Date(2026, 0, 1, 0, i).toISOString()]))
    const cut = knownAppsView(many, () => null)
    expect(cut.knownApps).toHaveLength(tuning.settingsWindow.knownAppsShown)
    expect(cut.knownAppsTotal).toBe(tuning.settingsWindow.knownAppsShown + 5)
    expect(localDay('nope')).toBeNull()
  })

  it('isSettingsView accepts a good view and rejects broken ones', () => {
    expect(isSettingsView(fullView())).toBe(true)
    expect(isSettingsView(fullView({ notice: { action: 'goHome', text: 'x' } }))).toBe(true)
    expect(isSettingsView(fullView({ notice: { action: null, text: 'x' } }))).toBe(true)
    expect(isSettingsView({ ...fullView(), notice: undefined })).toBe(false)
    expect(isSettingsView({ ...fullView(), inputMonitoring: 'maybe' })).toBe(false)
    expect(isSettingsView({ ...fullView(), knownAppsTotal: -1 })).toBe(false)
    expect(isSettingsView({ ...fullView(), knownApps: [{ bundleId: 'x', name: null, lastOpenedDay: 'Tuesday' }] })).toBe(false)
    expect(isSettingsView({ ...fullView(), settings: { ...DEFAULT_SETTINGS, restlessness: 2 } })).toBe(false)
    expect(isSettingsView({ ...fullView(), hotkeys: { toggleVisible: { accelerator: 'x', registered: true } } })).toBe(false)
    expect(isSettingsView(null)).toBe(false)
  })
})

describe('the page’s pure parts', () => {
  it('hotkey rows: symbols, whether it is the default, and a problem while it isn’t registered (§10.5)', () => {
    const rows = hotkeyRows(fullView())
    expect(rows.map((r) => [r.action, r.label, r.keys, r.isDefault, r.registered])).toEqual([
      ['toggleVisible', 'Show / hide Bitbot', '⌥⌘B', true, true],
      ['comeHere', 'Come here', '⌥⌘C', true, false],
      ['goHome', 'Go home', '⌃⌥H', false, true],
      ['toggleStay', 'Toggle Stay', '⌥⌘S', true, true],
    ])
    expect(rows[1]?.problem).toContain('another app')
    expect(rows[0]?.problem).toBeNull()
    expect(rows[2]?.defaultKeys).toBe('⌥⌘H')
  })

  it('the recorder: Esc cancels, anything else is acceleratorFromKey', () => {
    expect(recorderStep(key('Escape', {}, 'Escape'))).toEqual({ kind: 'cancel' })
    expect(recorderStep(key('Escape', { metaKey: true }, 'Escape'))).toEqual({ kind: 'cancel' })
    expect(recorderStep(key('KeyK', { metaKey: true, altKey: true }, '˚'))).toEqual({ kind: 'ok', accelerator: 'Alt+Command+K' })
  })

  it('spot rows: what each is, the active one, the default home (screen spots only)', () => {
    expect(spotRows(fullView())).toEqual([
      { id: 'spot-1', name: 'Dock, left side', detail: 'Screen spot', active: false, isDefaultHome: true, canBeDefaultHome: true },
      { id: 'spot-2', name: 'On Notes', detail: 'Follows the Notes window', active: true, isDefaultHome: false, canBeDefaultHome: false },
    ])
    expect(defaultHomeName(fullView())).toBe('Dock, left side')
    expect(defaultHomeName(fullView({ modes: { ...fullView().modes, defaultHomeId: null } }))).toBe('Middle of the Dock')
  })

  it('the permission line offers "Turn on…" only while Input Monitoring is off', () => {
    expect(permissionLine('off')).toMatchObject({ tone: 'off', canTurnOn: true })
    expect(permissionLine('granted')).toMatchObject({ tone: 'ok', canTurnOn: false })
    expect(permissionLine('unknown')).toMatchObject({ tone: 'unknown', canTurnOn: false })
  })

  it('known apps: Today / Yesterday / a date, and how many more there are', () => {
    const fmt = (d: string): string => `on ${d}`
    expect(dayLabel('2026-10-08', '2026-10-08', fmt)).toBe('Today')
    expect(dayLabel('2026-10-07', '2026-10-08', fmt)).toBe('Yesterday')
    expect(dayLabel('2026-09-30', '2026-10-01', fmt)).toBe('Yesterday')
    expect(dayLabel('2026-10-01', '2026-10-08', fmt)).toBe('on 2026-10-01')
    expect(moreAppsText(fullView())).toBe('and 2 more')
    expect(moreAppsText(fullView({ knownAppsTotal: 1 }))).toBeNull()
  })
})

// ───────────────────────────── the window ─────────────────────────────

class FakeWindow implements SettingsBrowserWindow {
  static nextId = 100
  readonly sent: { channel: string; payload: unknown }[] = []
  readonly calls: string[] = []
  destroyed = false
  minimized = false
  private readonly listeners = new Map<string, (() => void)[]>()
  private navListener: ((d: { isMainFrame: boolean; isSameDocument: boolean }) => void) | null = null
  readonly webContents = {
    id: FakeWindow.nextId++,
    send: (channel: string, payload: unknown): void => void this.sent.push({ channel, payload }),
    isDestroyed: (): boolean => this.destroyed,
    isCrashed: (): boolean => false,
    on: (_event: 'did-start-navigation', listener: (d: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown => {
      this.navListener = listener
      return this
    },
  }
  constructor(readonly options: unknown) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore(): void {
    this.calls.push('restore')
  }
  show(): void {
    this.calls.push('show')
  }
  focus(): void {
    this.calls.push('focus')
  }
  destroy(): void {
    this.destroyed = true
  }
  once(event: string, listener: () => void): unknown {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  on(event: string, listener: () => void): unknown {
    return this.once(event, listener)
  }
  emit(event: string): void {
    for (const l of this.listeners.get(event) ?? []) l()
  }
  navigate(): void {
    this.navListener?.({ isMainFrame: true, isSameDocument: false })
  }
  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

class FakePlatform implements SettingsWindowPlatform {
  readonly handlers = new Map<string, (event: SettingsIpcEvent, payload: unknown) => unknown>()
  readonly windows: FakeWindow[] = []
  readonly loads: (string | undefined)[] = []
  handle(channel: string, listener: (event: SettingsIpcEvent, payload: unknown) => unknown): void {
    this.handlers.set(channel, listener)
  }
  on(channel: string, listener: (event: SettingsIpcEvent, payload: unknown) => void): void {
    this.handlers.set(channel, listener)
  }
  createWindow(options: unknown): FakeWindow {
    const win = new FakeWindow(options)
    this.windows.push(win)
    return win
  }
  load(_win: SettingsBrowserWindow, section?: string): Promise<void> {
    this.loads.push(section)
    return Promise.resolve()
  }
  preloadPath(): string {
    return '/preload.js'
  }
  call(channel: string, senderId: number, payload?: unknown): unknown {
    const h = this.handlers.get(channel)
    if (!h) throw new Error(`no handler for ${channel}`)
    return h({ sender: { id: senderId } }, payload)
  }
}

function setupWindow(apply: SettingsWindowDeps['apply'] = () => null) {
  const platform = new FakePlatform()
  let current = appView()
  const applied: SettingsChange[] = []
  const warnings: string[] = []
  const settings = new SettingsWindow(
    {
      view: () => current,
      apply: (change) => {
        applied.push(change)
        return apply(change)
      },
      log: () => undefined,
      warn: (key) => void warnings.push(key),
    },
    platform,
  )
  return {
    platform,
    settings,
    applied,
    warnings,
    setView: (v: SettingsAppView) => (current = v),
  }
}

describe('SettingsWindow', () => {
  it('is an ordinary focusable window of tuning.settingsWindow size, created hidden, sandboxed with the preload', () => {
    const o = settingsWindowOptions('/p.js')
    expect(o).toMatchObject({
      width: tuning.settingsWindow.width,
      height: tuning.settingsWindow.height,
      minWidth: tuning.settingsWindow.width,
      minHeight: tuning.settingsWindow.height,
      show: false,
      title: 'Bitbot Settings',
      webPreferences: { preload: '/p.js', sandbox: true, contextIsolation: true },
    })
    expect(o.focusable).not.toBe(false)
  })

  it('opens hidden and shows itself once its page is ready; opening again restores, shows and focuses', () => {
    const { platform, settings } = setupWindow()
    expect(settings.isOpen).toBe(false)
    settings.open()
    const win = platform.windows[0] as FakeWindow
    expect(win.calls).toEqual([])
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['show', 'focus'])
    win.minimized = true
    settings.open()
    expect(platform.windows).toHaveLength(1)
    expect(win.calls).toEqual(['show', 'focus', 'restore', 'show', 'focus'])
    win.close()
    expect(settings.isOpen).toBe(false)
    settings.open()
    expect(platform.windows).toHaveLength(2)
  })

  it('opens at a section: a new window loads with it, an open one is told to show it', () => {
    const { platform, settings } = setupWindow()
    settings.open('behavior')
    expect(platform.loads).toEqual(['behavior'])
    const win = platform.windows[0] as FakeWindow
    settings.open('privacy')
    settings.open()
    expect(win.sent).toEqual([{ channel: IPC.settingsSection, payload: 'privacy' }])
    win.close()
    settings.open()
    expect(platform.loads).toEqual(['behavior', undefined])
  })

  it('answers settings:get and takes changes only from its own page', () => {
    const { platform, settings, applied, warnings } = setupWindow()
    expect(() => platform.call(IPC.settingsGet, 1)).toThrow() // not open
    settings.open()
    const win = platform.windows[0] as FakeWindow
    expect(() => platform.call(IPC.settingsGet, win.webContents.id + 1)).toThrow()
    platform.call(IPC.settingsChange, win.webContents.id + 1, { kind: 'resetPosition' })
    expect(applied).toEqual([])
    expect(warnings).toEqual([`${IPC.settingsGet} sender`, `${IPC.settingsGet} sender`, `${IPC.settingsChange} sender`])
    expect(platform.call(IPC.settingsGet, win.webContents.id)).toEqual(fullView())
    platform.call(IPC.settingsChange, win.webContents.id, { kind: 'resetPosition' })
    expect(applied).toEqual([{ kind: 'resetPosition' }])
  })

  it('ignores malformed changes', () => {
    const { platform, settings, applied, warnings } = setupWindow()
    settings.open()
    const id = (platform.windows[0] as FakeWindow).webContents.id
    platform.call(IPC.settingsChange, id, { kind: 'name', name: '   ' })
    platform.call(IPC.settingsChange, id, { kind: 'eraseAllData' })
    expect(applied).toEqual([])
    expect(warnings).toEqual([`malformed ${IPC.settingsChange}`, `malformed ${IPC.settingsChange}`])
  })

  it('pushes the view after a change and on refresh() only when it changed', () => {
    const t = setupWindow()
    t.settings.open()
    const win = t.platform.windows[0] as FakeWindow
    t.platform.call(IPC.settingsGet, win.webContents.id)
    t.settings.refresh()
    expect(win.sent).toEqual([])
    t.setView(appView({ inputMonitoring: 'granted' }))
    t.settings.refresh()
    t.settings.refresh()
    expect(win.sent).toEqual([{ channel: IPC.settingsView, payload: fullView({ inputMonitoring: 'granted' }) }])
    t.setView(appView({ inputMonitoring: 'granted', identity: { ...DEFAULT_IDENTITY, size: 'L' } }))
    t.platform.call(IPC.settingsChange, win.webContents.id, { kind: 'size', size: 'L' })
    expect(win.sent).toHaveLength(2)
    // A reload pushes from scratch.
    win.navigate()
    t.settings.refresh()
    expect(win.sent).toHaveLength(3)
  })

  it('keeps the notice apply() returns until the next change or until it closes', () => {
    let notice: { action: 'toggleStay'; text: string } | null = { action: 'toggleStay', text: '⌘Space is taken' }
    const t = setupWindow(() => notice)
    t.settings.open()
    const win = t.platform.windows[0] as FakeWindow
    t.platform.call(IPC.settingsChange, win.webContents.id, { kind: 'hotkey', action: 'toggleStay', accelerator: 'Command+Space' })
    expect((win.sent.at(-1)?.payload as SettingsView).notice).toEqual({ action: 'toggleStay', text: '⌘Space is taken' })
    t.settings.refresh()
    expect((t.platform.call(IPC.settingsGet, win.webContents.id) as SettingsView).notice).not.toBeNull()
    notice = null
    t.platform.call(IPC.settingsChange, win.webContents.id, { kind: 'resetHotkey', action: 'toggleStay' })
    expect((win.sent.at(-1)?.payload as SettingsView).notice).toBeNull()
  })

  it('an apply() that throws is reported and the page still gets the view', () => {
    const t = setupWindow(() => {
      throw new Error('boom')
    })
    t.settings.open()
    const win = t.platform.windows[0] as FakeWindow
    t.platform.call(IPC.settingsChange, win.webContents.id, { kind: 'resetPosition' })
    expect(t.warnings).toEqual([`${IPC.settingsChange} handler`])
    expect(win.sent).toHaveLength(1)
  })

  it('destroy() closes it for good', () => {
    const { platform, settings } = setupWindow()
    settings.open()
    settings.destroy()
    expect((platform.windows[0] as FakeWindow).destroyed).toBe(true)
    settings.open()
    expect(platform.windows).toHaveLength(1)
  })
})

describe('the settings page', () => {
  it('is built (electron.vite.config.ts) and loaded (pages.ts) under the same name', () => {
    expect(PAGES.settings).toBe('settings/index.html')
    const config = readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8')
    expect(config).toContain("settings: r('src/renderer/settings/index.html')")
  })

  it('has the pet page’s Content-Security-Policy (nothing remote)', () => {
    const csp = (file: string): string | undefined =>
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync(join(ROOT, file), 'utf8'))?.[1]
    expect(csp('src/renderer/settings/index.html')).toBe(csp('src/renderer/devpanel/index.html'))
    expect(csp('src/renderer/settings/index.html')).toContain("default-src 'self'")
  })

  it('its channels pass the preload allowlist', () => {
    for (const channel of [IPC.settingsGet, IPC.settingsChange, IPC.settingsView, IPC.settingsSection]) expect(isAllowedChannel(channel)).toBe(true)
  })
})
