// The developer panel's page (BITBOT_SPEC.md §14.1, dev builds only; main side src/main/dev/devPanel.ts, messages in
// src/shared/devPanel.ts). Milestone 2: force the pet's state, mood, dust, facing, face and idle style, and watch what
// it does. Vanilla TS over the sandboxed bridge: every control sends a debug:panel-set with the one field it changes,
// and every debug:panel-status (validated) sets the controls and the status block, so the page always shows main's
// overrides, never its own idea of them.

import { isDevOverrides, type DevOverrides, type DevPanelSet, type DevPanelStatus } from '../../shared/devPanel'
import {
  EYES_STATES,
  FACE_OVERLAYS,
  isEyesState,
  isMouthState,
  MOUTH_STATES,
  type FaceOverlay,
  type FaceOverride,
} from '../../shared/faceStates'
import { IPC } from '../../shared/ipc'
import { tuning } from '../../shared/tuning'
import {
  BEHAVIOR_STATES,
  IDLE_MODES,
  isBehaviorState,
  isIdleMode,
  isLookDirection,
  isMood,
  MOODS,
} from '../../shared/types'

/** The value of every "the pet's own" choice. */
const AUTO = 'auto'

const bridge = window.bitbot

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id)
  if (!(el instanceof type)) throw new Error(`dev panel: #${id} missing`)
  return el
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRate(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isDevPanelStatus(value: unknown): value is DevPanelStatus {
  return (
    isRecord(value) &&
    isDevOverrides(value['overrides']) &&
    isBehaviorState(value['state']) &&
    isBehaviorState(value['simState']) &&
    (value['look'] === null || isLookDirection(value['look'])) &&
    typeof value['visible'] === 'boolean' &&
    isRate(value['rendersPerS']) &&
    isRate(value['framesPerS'])
  )
}

const errorBox = element('error', HTMLParagraphElement)
function showError(message: string | null): void {
  errorBox.hidden = message === null
  errorBox.textContent = message ?? ''
}

function send(set: DevPanelSet): void {
  try {
    bridge.send(IPC.debugPanelSet, set)
  } catch (err) {
    showError(`Could not send to Bitbot: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ───────────────────────────── controls ─────────────────────────────

/** A group of radio buttons; returns a setter for the checked value. */
function radios(container: HTMLElement, name: string, options: readonly (readonly [string, string])[], onPick: (value: string) => void) {
  const inputs = new Map<string, HTMLInputElement>()
  for (const [value, label] of options) {
    const wrap = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = name
    input.value = value
    input.addEventListener('change', () => {
      if (input.checked) onPick(value)
    })
    wrap.append(input, ` ${label}`)
    container.append(wrap)
    inputs.set(value, input)
  }
  return (value: string): void => {
    for (const [v, input] of inputs) input.checked = v === value
  }
}

/** Fills a select with "auto" (when given) and the options; returns a setter for the selected value. */
function fillSelect(select: HTMLSelectElement, options: readonly string[], autoLabel: string | null): (value: string) => void {
  if (autoLabel !== null) select.append(new Option(autoLabel, AUTO))
  for (const value of options) select.append(new Option(value, value))
  return (value: string): void => {
    select.value = value
  }
}

const setState = radios(
  element('state', HTMLDivElement),
  'state',
  [[AUTO, 'Auto (simulation)'], ...BEHAVIOR_STATES.map((s) => [s, s] as const)],
  (value) => send({ state: isBehaviorState(value) ? value : null }),
)

const moodSelect = element('mood', HTMLSelectElement)
const setMood = fillSelect(moodSelect, MOODS, null)
moodSelect.addEventListener('change', () => {
  if (isMood(moodSelect.value)) send({ mood: moodSelect.value })
})

const dust = element('dust', HTMLInputElement)
const dustValue = element('dust-value', HTMLOutputElement)
dust.addEventListener('input', () => {
  const value = Number(dust.value)
  dustValue.textContent = value.toFixed(2)
  if (Number.isFinite(value) && value >= 0 && value <= 1) send({ dust: value })
})

const setFacing = radios(
  element('facing', HTMLDivElement),
  'facing',
  [
    [AUTO, 'auto'],
    ['right', 'right'],
    ['left', 'left'],
  ],
  (value) => send({ facing: value === 'right' ? 1 : value === 'left' ? -1 : null }),
)

const eyesSelect = element('eyes', HTMLSelectElement)
const setEyes = fillSelect(eyesSelect, EYES_STATES, AUTO)
const mouthSelect = element('mouth', HTMLSelectElement)
const setMouth = fillSelect(mouthSelect, MOUTH_STATES, AUTO)

const overlaysBox = element('overlays', HTMLDivElement)
const overlaysAuto = checkbox(overlaysBox, AUTO)
const overlayBoxes = new Map<FaceOverlay, HTMLInputElement>(FACE_OVERLAYS.map((o) => [o, checkbox(overlaysBox, o)]))

function checkbox(container: HTMLElement, label: string): HTMLInputElement {
  const wrap = document.createElement('label')
  const input = document.createElement('input')
  input.type = 'checkbox'
  wrap.append(input, ` ${label}`)
  container.append(wrap)
  return input
}

/** The face the face controls describe: only the fields not on "auto"; null when all are. */
function faceFromControls(): FaceOverride | null {
  const face: FaceOverride = {}
  if (isEyesState(eyesSelect.value)) face.eyes = eyesSelect.value
  if (isMouthState(mouthSelect.value)) face.mouth = mouthSelect.value
  if (!overlaysAuto.checked) face.overlays = FACE_OVERLAYS.filter((o) => overlayBoxes.get(o)?.checked === true)
  return face.eyes === undefined && face.mouth === undefined && face.overlays === undefined ? null : face
}

function setOverlaysEnabled(): void {
  for (const input of overlayBoxes.values()) input.disabled = overlaysAuto.checked
}

const sendFace = (): void => {
  setOverlaysEnabled()
  send({ face: faceFromControls() })
}
eyesSelect.addEventListener('change', sendFace)
mouthSelect.addEventListener('change', sendFace)
overlaysAuto.addEventListener('change', sendFace)
for (const input of overlayBoxes.values()) input.addEventListener('change', sendFace)

const setIdle = radios(
  element('idle', HTMLDivElement),
  'idle',
  IDLE_MODES.map((m) => [m, m] as const),
  (value) => {
    if (isIdleMode(value)) send({ idleMode: value })
  },
)

element('reset', HTMLButtonElement).addEventListener('click', () => {
  const defaults: DevOverrides = { state: null, mood: 'content', dust: 0, facing: null, face: null, idleMode: tuning.anim.idleMode, showWorld: false, wander: true }
  send(defaults)
})

/** Sets every control from main's overrides. */
function showOverrides(o: DevOverrides): void {
  setState(o.state ?? AUTO)
  setMood(o.mood)
  // Not under the user's pointer: a status sent before their newest move would make the slider jump back.
  if (document.activeElement !== dust) dust.value = String(o.dust)
  dustValue.textContent = o.dust.toFixed(2)
  setFacing(o.facing === 1 ? 'right' : o.facing === -1 ? 'left' : AUTO)
  setEyes(o.face?.eyes ?? AUTO)
  setMouth(o.face?.mouth ?? AUTO)
  const overlays = o.face?.overlays
  overlaysAuto.checked = overlays === undefined
  for (const [name, input] of overlayBoxes) input.checked = overlays?.includes(name) ?? false
  setOverlaysEnabled()
  setIdle(o.idleMode)
}

// ───────────────────────────── status ─────────────────────────────

const stState = element('st-state', HTMLElement)
const stSim = element('st-sim', HTMLElement)
const stLook = element('st-look', HTMLElement)
const stVisible = element('st-visible', HTMLElement)
const stRates = element('st-rates', HTMLElement)

const rate = (value: number | null): string => (value === null ? '–' : value.toFixed(1))

function showStatus(status: DevPanelStatus): void {
  const forced = status.state !== status.simState
  stState.textContent = forced ? `${status.state} (forced)` : status.state
  stState.classList.toggle('forced', forced)
  stSim.textContent = status.simState
  stLook.textContent = status.look ?? 'ahead (or not looking)'
  stVisible.textContent = status.visible ? 'shown' : 'hidden'
  stRates.textContent = `${rate(status.rendersPerS)} renders/s · ${rate(status.framesPerS)} frames/s`
  showOverrides(status.overrides)
}

function onStatus(payload: unknown): void {
  if (!isDevPanelStatus(payload)) {
    showError('Bitbot sent a status this page does not understand.')
    return
  }
  showError(null)
  showStatus(payload)
}

// Subscribe before asking, so a push sent meanwhile is not lost.
bridge.on(IPC.debugPanelStatus, onStatus)
bridge.invoke(IPC.debugPanelGet).then(onStatus, (err: unknown) => {
  showError(`Bitbot did not answer: ${err instanceof Error ? err.message : String(err)}`)
})
