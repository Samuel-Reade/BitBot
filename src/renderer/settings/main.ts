// The settings page (BITBOT_SPEC.md §15.4; main side src/main/windows/settingsWindow.ts, messages in
// src/shared/settingsProtocol.ts, the pure parts in ./model.ts). A sidebar of sections: Pet (name, color, size, reset
// position), Behavior (default mode, restlessness, hangout spots, hiding), Controls (hotkeys, ⌥⌘-click), Privacy (what
// is and isn't counted, Input Monitoring, the known apps, erase everything), General (open at login, sound) and About.
// Vanilla TS over the sandboxed bridge:
// - Every control sends one SettingsChange; every settings:view (validated) re-renders the page, so it always shows
//   main's settings, never its own idea of them. A field the user is typing in, or a slider being dragged, is left
//   alone until they finish.
// - The hotkey recorder listens to keydown only while the user is recording a hotkey (Record → press the combination;
//   Esc cancels, so does leaving the window), turns it into an accelerator (../../shared/accelerator.ts) and sends it.
//   No key is logged or kept (§2).
// - "Erase all Bitbot data" asks first inside the page (a sheet over the page, never a dialog of its own).
// - ?section=<id> opens a section (pet, behavior, controls, privacy, general, about); settings:section switches to one.

import type { KeyLike } from '../../shared/accelerator'
import { IPC } from '../../shared/ipc'
import { PALETTES } from '../../shared/palettes'
import { PET_NAME_MAX, cleanPetName } from '../../shared/settings'
import {
  cleanSpotName,
  isSettingsSection,
  isSettingsView,
  SETTINGS_SECTIONS,
  type SettingsChange,
  type SettingsSection,
  type SettingsView,
} from '../../shared/settingsProtocol'
import { tuning } from '../../shared/tuning'
import type { HotkeyAction } from '../../shared/hotkeys'
import type { PaletteId, PetSize } from '../../shared/types'
import {
  dayLabel,
  defaultHomeName,
  DOCK_HOME,
  hotkeyRows,
  moreAppsText,
  permissionLine,
  PRIVACY_COUNTED,
  PRIVACY_NETWORK,
  PRIVACY_NEVER,
  recorderStep,
  SECTION_LABELS,
  spotRows,
} from './model'

const bridge = window.bitbot

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id)
  if (!(el instanceof type)) throw new Error(`settings: #${id} missing`)
  return el
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props)
  el.append(...children)
  return el
}

const errorBox = element('error', HTMLParagraphElement)
function showError(message: string | null): void {
  errorBox.hidden = message === null
  errorBox.textContent = message ?? ''
}

function send(change: SettingsChange): void {
  try {
    bridge.send(IPC.settingsChange, change)
  } catch (err) {
    showError(`Could not reach Bitbot: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The newest view from main (null until the first). */
let view: SettingsView | null = null
/** The hotkey being recorded (null: none) and what the recorder says meanwhile. */
let recording: HotkeyAction | null = null
let recordMessage: string | null = null

/** Rebuilds a list only when what it shows changed (keeps focus and hover otherwise). */
const listKeys = new WeakMap<HTMLElement, string>()
function renderList(container: HTMLElement, key: unknown, build: () => Node[]): void {
  const k = JSON.stringify(key)
  if (listKeys.get(container) === k) return
  listKeys.set(container, k)
  container.replaceChildren(...build())
}

// ───────────────────────────── sections ─────────────────────────────

/** Small white glyphs on coloured squares, like System Settings. */
const ICONS: Record<SettingsSection, { color: string; svg: string }> = {
  pet: {
    color: '#34c759',
    svg: '<svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.6"><rect x="2" y="3" width="12" height="9" rx="2.5"/><path d="M6 7v1M10 7v1" stroke-linecap="round"/><path d="M5 15h2M9 15h2" stroke-linecap="round"/></svg>',
  },
  behavior: {
    color: '#ff9500',
    svg: '<svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11c2-5 4-5 6 0s4 5 6 0"/></svg>',
  },
  controls: { color: '#8e8e93', svg: '<svg viewBox="0 0 16 16"><text x="8" y="12.5" text-anchor="middle" font-size="13" fill="#fff" font-family="-apple-system">⌘</text></svg>' },
  privacy: {
    color: '#007aff',
    svg: '<svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"><path d="M8 1.8 13 4v4c0 3-2.2 5.2-5 6.2C5.2 13.2 3 11 3 8V4z"/></svg>',
  },
  general: {
    color: '#8e8e93',
    svg: '<svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.6"><circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke-linecap="round"/></svg>',
  },
  about: { color: '#5856d6', svg: '<svg viewBox="0 0 16 16"><text x="8" y="12.5" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" font-family="Georgia, serif">i</text></svg>' },
}

const nav = element('nav', HTMLElement)
const navButtons = new Map<SettingsSection, HTMLButtonElement>()
for (const id of SETTINGS_SECTIONS) {
  const label = SECTION_LABELS[id]
  const icon = make('span', { className: 'icon' })
  icon.style.background = ICONS[id].color
  icon.innerHTML = ICONS[id].svg
  const button = make('button', { type: 'button' }, icon, label)
  button.addEventListener('click', () => showSection(id))
  nav.append(button)
  navButtons.set(id, button)
}

function showSection(id: SettingsSection): void {
  cancelRecording()
  for (const [sid, button] of navButtons) {
    if (sid === id) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  for (const section of document.querySelectorAll<HTMLElement>('section[data-section]')) section.hidden = section.dataset['section'] !== id
}

const requested = new URLSearchParams(location.search).get('section')
showSection(isSettingsSection(requested) ? requested : 'pet')

// ───────────────────────────── Pet ─────────────────────────────

const nameInput = element('name', HTMLInputElement)
const nameError = element('name-error', HTMLSpanElement)
nameInput.maxLength = PET_NAME_MAX
function commitName(): void {
  if (!view) return
  const name = cleanPetName(nameInput.value)
  if (name === null) {
    nameError.hidden = false
    nameError.textContent = `1 to ${PET_NAME_MAX} characters`
    return
  }
  nameError.hidden = true
  nameInput.value = name
  if (name !== view.identity.name) send({ kind: 'name', name })
}
nameInput.addEventListener('change', commitName)
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nameInput.blur()
  if (e.key === 'Escape' && view) {
    nameInput.value = view.identity.name
    nameError.hidden = true
    nameInput.blur()
  }
})
nameInput.addEventListener('blur', () => {
  // Left with a bad name: show the saved one again.
  if (view && cleanPetName(nameInput.value) === null) {
    nameInput.value = view.identity.name
    window.setTimeout(() => (nameError.hidden = true), 2500)
  }
})

const swatchBox = element('swatches', HTMLDivElement)
const swatches = new Map<PaletteId, HTMLButtonElement>()
for (const palette of Object.values(PALETTES)) {
  const dot = make('span', { className: 'dot' })
  dot.style.setProperty('--fill', palette.primary)
  dot.style.setProperty('--outline', palette.outline)
  const button = make('button', { type: 'button', className: 'swatch', title: palette.name }, dot, palette.name.replace(' Classic', ''))
  button.addEventListener('click', () => send({ kind: 'palette', paletteId: palette.id }))
  swatchBox.append(button)
  swatches.set(palette.id, button)
}

function segmented<T extends string>(container: HTMLElement, options: readonly (readonly [T, string])[], onPick: (value: T) => void): Map<T, HTMLButtonElement> {
  const buttons = new Map<T, HTMLButtonElement>()
  for (const [value, label] of options) {
    const button = make('button', { type: 'button' }, label)
    button.addEventListener('click', () => onPick(value))
    container.append(button)
    buttons.set(value, button)
  }
  return buttons
}

function press<T>(buttons: Map<T, HTMLButtonElement>, value: T): void {
  for (const [v, b] of buttons) b.setAttribute('aria-pressed', String(v === value))
}

const SIZES: readonly (readonly [PetSize, string])[] = [
  ['S', 'Small'],
  ['M', 'Medium'],
  ['L', 'Large'],
]
const sizeButtons = segmented(element('size', HTMLDivElement), SIZES, (size) => send({ kind: 'size', size }))

element('reset-position', HTMLButtonElement).addEventListener('click', () => send({ kind: 'resetPosition' }))
const resetHint = element('reset-hint', HTMLSpanElement)

function renderPet(v: SettingsView): void {
  if (document.activeElement !== nameInput) nameInput.value = v.identity.name
  for (const [id, b] of swatches) b.setAttribute('aria-pressed', String(id === v.identity.paletteId))
  press(sizeButtons, v.identity.size)
  resetHint.textContent = `Puts ${v.identity.name} back at its home (${defaultHomeName(v)}).`
}

// ───────────────────────────── Behavior ─────────────────────────────

type ModeChoice = 'roam' | 'stay' | 'hangout'
const MODES: readonly (readonly [ModeChoice, string])[] = [
  ['roam', 'Roam'],
  ['stay', 'Stay'],
  ['hangout', 'Hang out'],
]
const modeButtons = segmented(element('mode', HTMLDivElement), MODES, (mode) => {
  if (!view) return
  if (mode !== 'hangout') {
    send({ kind: 'defaultMode', mode })
    return
  }
  const m = view.modes
  const spotId = m.activeSpotId ?? m.spots.find((s) => s.id === m.defaultHomeId)?.id ?? m.spots[0]?.id
  if (spotId !== undefined) send({ kind: 'defaultMode', mode: 'hangout', spotId })
})
const modeSpotRow = element('mode-spot-row', HTMLDivElement)
const modeSpot = element('mode-spot', HTMLSelectElement)
const modeSpotHint = element('mode-spot-hint', HTMLSpanElement)
modeSpot.addEventListener('change', () => {
  if (modeSpot.value) send({ kind: 'defaultMode', mode: 'hangout', spotId: modeSpot.value })
})

const restlessness = element('restlessness', HTMLInputElement)
restlessness.step = String(tuning.settingsWindow.restlessnessStep)
let dragging = false
restlessness.addEventListener('pointerdown', () => (dragging = true))
restlessness.addEventListener('pointerup', () => (dragging = false))
restlessness.addEventListener('change', () => {
  dragging = false
  const value = Number(restlessness.value)
  if (Number.isFinite(value) && value >= 0 && value <= 1) send({ kind: 'restlessness', value })
})

const hideFullscreen = element('hide-fullscreen', HTMLInputElement)
hideFullscreen.addEventListener('change', () => send({ kind: 'hideInFullscreen', on: hideFullscreen.checked }))

const spotsBox = element('spots', HTMLDivElement)
/** The spot being renamed / asked about deleting (null: none). */
let renaming: string | null = null
let renameError: string | null = null
let confirmingDelete: string | null = null

function linkButton(label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const b = make('button', { type: 'button', className: danger ? 'link danger' : 'link' }, label)
  b.addEventListener('click', onClick)
  return b
}

function badge(text: string, gray = false): HTMLSpanElement {
  return make('span', { className: gray ? 'badge gray' : 'badge' }, text)
}

function rerenderSpots(): void {
  listKeys.delete(spotsBox)
  if (view) renderSpots(view)
}

function renderSpots(v: SettingsView): void {
  const rows = spotRows(v)
  renderList(spotsBox, { rows, renaming, renameError, confirmingDelete, home: v.modes.defaultHomeId }, () => {
    const dockIsHome = !rows.some((r) => r.isDefaultHome)
    const dock = make(
      'div',
      { className: 'row' },
      make('div', { className: 'text' }, make('span', {}, DOCK_HOME, ...(dockIsHome ? [badge('Default home')] : [])), make('span', { className: 'hint' }, 'Built in')),
      make('div', { className: 'controls' }, ...(dockIsHome ? [] : [linkButton('Make default home', () => send({ kind: 'setDefaultHome', id: null }))])),
    )
    const out: Node[] = [dock]
    for (const r of rows) {
      if (r.id === renaming) {
        const input = make('input', { type: 'text', value: r.name, spellcheck: false, maxLength: tuning.settingsWindow.spotNameMax })
        const save = (): void => {
          const name = cleanSpotName(input.value)
          if (name === null) {
            renameError = `1 to ${tuning.settingsWindow.spotNameMax} characters`
            rerenderSpots()
            return
          }
          renaming = null
          renameError = null
          if (name !== r.name) send({ kind: 'renameSpot', id: r.id, name })
          rerenderSpots()
        }
        const cancel = (): void => {
          renaming = null
          renameError = null
          rerenderSpots()
        }
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') cancel()
        })
        const saveButton = make('button', { type: 'button', className: 'btn primary' }, 'Save')
        saveButton.addEventListener('click', save)
        out.push(
          make(
            'div',
            { className: 'row' },
            make(
              'div',
              { className: 'text' },
              make('div', { className: 'spot-rename' }, input),
              ...(renameError ? [make('span', { className: 'field-error' }, renameError)] : []),
            ),
            make('div', { className: 'controls' }, linkButton('Cancel', cancel), saveButton),
          ),
        )
        window.setTimeout(() => {
          input.focus()
          input.select()
        }, 0)
        continue
      }
      if (r.id === confirmingDelete) {
        out.push(
          make(
            'div',
            { className: 'row' },
            make('div', { className: 'text' }, make('span', {}, `Delete “${r.name}”?`), make('span', { className: 'hint' }, r.active ? 'Bitbot goes back to roaming.' : 'This can’t be undone.')),
            make(
              'div',
              { className: 'controls' },
              linkButton('Cancel', () => {
                confirmingDelete = null
                rerenderSpots()
              }),
              (() => {
                const b = make('button', { type: 'button', className: 'btn danger filled' }, 'Delete')
                b.addEventListener('click', () => {
                  confirmingDelete = null
                  send({ kind: 'deleteSpot', id: r.id })
                  rerenderSpots()
                })
                return b
              })(),
            ),
          ),
        )
        continue
      }
      const badges = [...(r.active ? [badge('Hanging out here', true)] : []), ...(r.isDefaultHome ? [badge('Default home')] : [])]
      const actions: Node[] = [
        linkButton('Rename', () => {
          renaming = r.id
          renameError = null
          confirmingDelete = null
          rerenderSpots()
        }),
      ]
      if (r.canBeDefaultHome && !r.isDefaultHome) actions.push(linkButton('Make default home', () => send({ kind: 'setDefaultHome', id: r.id })))
      actions.push(
        linkButton(
          'Delete',
          () => {
            confirmingDelete = r.id
            renaming = null
            rerenderSpots()
          },
          true,
        ),
      )
      out.push(
        make(
          'div',
          { className: 'row' },
          make('div', { className: 'text' }, make('span', {}, r.name, ...badges), make('span', { className: 'hint' }, r.detail)),
          make('div', { className: 'controls' }, ...actions),
        ),
      )
    }
    return out
  })
}

function renderBehavior(v: SettingsView): void {
  const m = v.modes
  press(modeButtons, m.mode)
  const hangout = modeButtons.get('hangout')
  if (hangout) {
    hangout.disabled = m.spots.length === 0
    hangout.title = m.spots.length === 0 ? 'Make a hangout spot first (right-click Bitbot, Hang out here)' : ''
  }
  modeSpotRow.hidden = m.mode !== 'hangout'
  renderList(modeSpot, m.spots.map((s) => [s.id, s.name]), () => m.spots.map((s) => new Option(s.name, s.id)))
  if (m.activeSpotId !== null) modeSpot.value = m.activeSpotId
  modeSpotHint.textContent = 'Bitbot stays near it.'
  if (!dragging && document.activeElement !== restlessness) restlessness.value = String(v.settings.restlessness)
  hideFullscreen.checked = v.settings.hideInFullscreen
  renderSpots(v)
}

// ───────────────────────────── Controls ─────────────────────────────

const hotkeysBox = element('hotkeys', HTMLDivElement)
function startRecording(action: HotkeyAction): void {
  recording = action
  recordMessage = null
  rerenderHotkeys()
}

function cancelRecording(): void {
  if (recording === null) return
  recording = null
  recordMessage = null
  rerenderHotkeys()
}

function rerenderHotkeys(): void {
  listKeys.delete(hotkeysBox)
  if (view) renderHotkeys(view)
}

// Only while recording: one keydown → the new binding (or a reason it can't be one). Nothing is logged or kept.
window.addEventListener(
  'keydown',
  (e) => {
    if (recording === null) return
    e.preventDefault()
    e.stopPropagation()
    const key: KeyLike = { key: e.key, code: e.code, metaKey: e.metaKey, altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey }
    const step = recorderStep(key)
    if (step.kind === 'cancel') cancelRecording()
    else if (step.kind === 'rejected') {
      recordMessage = step.reason
      rerenderHotkeys()
    } else if (step.kind === 'ok') {
      const action = recording
      recording = null
      recordMessage = null
      send({ kind: 'hotkey', action, accelerator: step.accelerator })
      rerenderHotkeys()
    }
  },
  true,
)
window.addEventListener('blur', cancelRecording)

function renderHotkeys(v: SettingsView): void {
  const rows = hotkeyRows(v)
  const notice = v.notice?.action != null ? v.notice : null
  renderList(hotkeysBox, { rows, recording, recordMessage, notice }, () => {
    const out: Node[] = []
    for (const r of rows) {
      const isRecording = recording === r.action
      const keys = make('span', { className: 'keys' }, isRecording ? 'Press keys…' : r.keys)
      if (isRecording) keys.classList.add('recording')
      else if (!r.registered) keys.classList.add('broken')
      const record = make('button', { type: 'button', className: 'btn' }, isRecording ? 'Cancel' : 'Record')
      record.addEventListener('click', () => (isRecording ? cancelRecording() : startRecording(r.action)))
      const reset = make('button', { type: 'button', className: 'link', disabled: r.isDefault, title: `Back to ${r.defaultKeys}` }, 'Reset')
      reset.addEventListener('click', () => {
        cancelRecording()
        send({ kind: 'resetHotkey', action: r.action })
      })
      out.push(make('div', { className: 'row' }, make('div', { className: 'text' }, make('span', {}, r.label)), make('div', { className: 'controls' }, keys, record, reset)))
      const lines: string[] = []
      if (isRecording) lines.push(recordMessage ?? 'Press the new combination with ⌘, ⌥ or ⌃. Esc cancels.')
      else if (notice?.action === r.action) lines.push(notice.text)
      else if (r.problem) lines.push(r.problem)
      for (const line of lines) {
        const p = make('div', { className: isRecording && !recordMessage ? 'hint' : 'problem' }, line)
        out.push(make('div', { className: 'sub' }, p))
      }
    }
    return out
  })
}

const altCmd = element('alt-cmd-click', HTMLInputElement)
const altCmdHint = element('alt-cmd-hint', HTMLSpanElement)
altCmd.addEventListener('change', () => send({ kind: 'altCmdClickSend', on: altCmd.checked }))

function renderControls(v: SettingsView): void {
  renderHotkeys(v)
  altCmd.checked = v.settings.altCmdClickSend
  altCmdHint.textContent =
    v.inputMonitoring === 'off'
      ? 'Needs Input Monitoring, which is off (Privacy), so this does nothing yet.'
      : 'Needs Input Monitoring. The click itself still goes to the app underneath.'
}

// ───────────────────────────── Privacy ─────────────────────────────

element('counted', HTMLUListElement).append(...PRIVACY_COUNTED.map((t) => make('li', {}, t)))
element('never', HTMLUListElement).append(...PRIVACY_NEVER.map((t) => make('li', {}, t)))
element('network', HTMLParagraphElement).textContent = PRIVACY_NETWORK

const permLight = element('perm-light', HTMLSpanElement)
const permText = element('perm-text', HTMLSpanElement)
const permButton = element('perm-turn-on', HTMLButtonElement)
permButton.addEventListener('click', () => send({ kind: 'requestInputAccess' }))
const appsBox = element('apps', HTMLDivElement)

function localToday(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) return day
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function renderPrivacy(v: SettingsView): void {
  const line = permissionLine(v.inputMonitoring)
  permLight.className = `light ${line.tone}`
  permText.textContent = line.text
  permButton.hidden = !line.canTurnOn
  const today = localToday()
  renderList(appsBox, { apps: v.knownApps, total: v.knownAppsTotal, today }, () => {
    if (v.knownApps.length === 0) return [make('div', { className: 'empty' }, 'None yet.')]
    const rows: Node[] = v.knownApps.map((a) =>
      make(
        'div',
        { className: 'row' },
        make('div', { className: 'text' }, make('span', {}, a.name ?? a.bundleId), make('span', { className: 'bundle' }, a.bundleId)),
        make('span', { className: 'hint' }, dayLabel(a.lastOpenedDay, today, formatDay)),
      ),
    )
    const more = moreAppsText(v)
    if (more) rows.push(make('div', { className: 'empty' }, more))
    return rows
  })
}

const confirm = element('confirm', HTMLDivElement)
const confirmText = element('confirm-text', HTMLParagraphElement)
const confirmCancel = element('confirm-cancel', HTMLButtonElement)
function closeConfirm(): void {
  confirm.hidden = true
}
element('erase', HTMLButtonElement).addEventListener('click', () => {
  const name = view?.identity.name ?? 'Your pet'
  confirmText.textContent = `${name}, everything it has earned, your settings, hangout spots and the apps list will be deleted, and Bitbot starts over from the egg. This can’t be undone.`
  confirm.hidden = false
  confirmCancel.focus()
})
confirmCancel.addEventListener('click', closeConfirm)
element('confirm-erase', HTMLButtonElement).addEventListener('click', () => {
  closeConfirm()
  send({ kind: 'eraseAllData', confirmed: true })
})
confirm.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeConfirm()
})

// ───────────────────────────── General / About ─────────────────────────────

const login = element('login', HTMLInputElement)
const loginHint = element('login-hint', HTMLSpanElement)
login.addEventListener('change', () => send({ kind: 'launchAtLogin', on: login.checked }))
const version = element('version', HTMLDivElement)

function renderGeneral(v: SettingsView): void {
  login.checked = v.settings.launchAtLogin
  login.disabled = !v.launchAtLoginAvailable
  loginHint.hidden = v.launchAtLoginAvailable
  element('sound', HTMLInputElement).checked = false
  version.textContent = `Version ${v.version}`
}

// ───────────────────────────── the view ─────────────────────────────

const noticeBox = element('notice', HTMLParagraphElement)

function render(v: SettingsView): void {
  view = v
  document.title = 'Bitbot Settings'
  const general = v.notice && v.notice.action === null ? v.notice.text : null
  noticeBox.hidden = general === null
  noticeBox.textContent = general ?? ''
  renderPet(v)
  renderBehavior(v)
  renderControls(v)
  renderPrivacy(v)
  renderGeneral(v)
}

function onView(payload: unknown): void {
  if (!isSettingsView(payload)) {
    showError('Bitbot sent settings this page does not understand.')
    return
  }
  showError(null)
  render(payload)
}

// Subscribe before asking, so a push sent meanwhile is not lost.
bridge.on(IPC.settingsView, onView)
bridge.on(IPC.settingsSection, (payload) => {
  if (isSettingsSection(payload)) showSection(payload)
})
bridge.invoke(IPC.settingsGet).then(onView, (err: unknown) => {
  showError(`Bitbot did not answer: ${err instanceof Error ? err.message : String(err)}`)
})
