// The developer panel's page (BITBOT_SPEC.md §14.1, dev builds only; main side src/main/dev/devPanel.ts, messages in
// src/shared/devPanel.ts). Milestone 2: force the pet's state, mood, dust, facing, face and idle style, and watch what
// it does. Milestone 3: the world section (show the world's debug view, wander, send the pet somewhere, and what the
// simulation sees). Milestone 5: the economy section (the currency table, diet, sparks, whether input is counted, and
// buttons that inject activity; the pure part in ./economyView.ts). Milestone 6: mood and dust can be left to the needs
// ("auto", showing what is in effect), the time scale of the pet's life, and the Life section (need bars, the needs'
// mood, stuffed, asleep, what the brain does, the goal scores; the pure part in ./lifeView.ts). Vanilla TS over the
// sandboxed bridge: every control
// sends a debug:panel-set with the one field it changes (the world buttons a debug:panel-action, the economy buttons a
// debug:panel-inject), and every debug:panel-status (validated) sets the controls and the status blocks, so the page
// always shows main's overrides, never its own idea of them.

import {
  isDevOverrides,
  type DevOverrides,
  type DevPanelAction,
  type DevPanelSet,
  type DevPanelStatus,
  type DevWorldStatus,
} from '../../shared/devPanel'
import type { DevInject, EconomySnapshot } from '../../shared/economy'
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
import type { LifeSnapshot } from '../../shared/life'
import { breakInject, ECONOMY_INJECTS, economyDetails, economyRows, isEconomySnapshot } from './economyView'
import {
  dustInEffect,
  isLifeSnapshot,
  lifeDetails,
  moodInEffect,
  needBars,
  scoreRows,
  TIME_SCALE_CHOICES,
  timeScaleFrom,
} from './lifeView'

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

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isDevWorldStatus(value: unknown): value is DevWorldStatus {
  if (!isRecord(value)) return false
  const goal = value['goal']
  return (
    isCount(value['windows']) &&
    isCount(value['segments']) &&
    isCount(value['walls']) &&
    isRate(value['snapshotHz']) &&
    value['snapshotHz'] !== null &&
    (value['surface'] === null || typeof value['surface'] === 'string') &&
    (goal === null || (isRecord(goal) && Number.isFinite(goal['x']) && Number.isFinite(goal['y'])))
  )
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
    isRate(value['framesPerS']) &&
    (value['world'] === null || isDevWorldStatus(value['world'])) &&
    (value['economy'] === null || isEconomySnapshot(value['economy'])) &&
    (value['life'] === null || isLifeSnapshot(value['life']))
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
const setMood = fillSelect(moodSelect, MOODS, 'auto (needs)')
moodSelect.addEventListener('change', () => send({ mood: isMood(moodSelect.value) ? moodSelect.value : null }))
const moodEffect = element('mood-effect', HTMLOutputElement)

const dust = element('dust', HTMLInputElement)
const dustAuto = element('dust-auto', HTMLInputElement)
const dustEffect = element('dust-effect', HTMLOutputElement)
/** The slider's level when it is one main accepts; null otherwise. */
function sliderDust(): number | null {
  const value = Number(dust.value)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}
dust.addEventListener('input', () => {
  const value = sliderDust()
  if (value !== null) send({ dust: value })
})
dustAuto.addEventListener('change', () => {
  dust.disabled = dustAuto.checked
  // Forcing starts from where the slider is.
  send({ dust: dustAuto.checked ? null : (sliderDust() ?? 0) })
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

const setTimeScale = radios(element('time-scale', HTMLDivElement), 'time-scale', TIME_SCALE_CHOICES, (value) => {
  const timeScale = timeScaleFrom(value)
  if (timeScale !== null) send({ timeScale })
})

const showWorld = element('show-world', HTMLInputElement)
showWorld.addEventListener('change', () => send({ showWorld: showWorld.checked }))
const wander = element('wander', HTMLInputElement)
wander.addEventListener('change', () => send({ wander: wander.checked }))

function sendAction(action: DevPanelAction): void {
  try {
    bridge.send(IPC.debugPanelAction, action)
  } catch (err) {
    showError(`Could not send to Bitbot: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const ACTION_BUTTONS: readonly (readonly [string, DevPanelAction])[] = [
  ['go-random', 'goRandom'],
  ['go-window', 'goWindow'],
  ['climb-wall', 'climbWall'],
  ['stop', 'stop'],
  ['reset-save', 'resetSave'],
  ['fixture-fresh', 'loadFixtureFresh'],
  ['fixture-day3', 'loadFixtureDay3'],
  ['show-summary', 'showSummary'],
]
for (const [id, action] of ACTION_BUTTONS) element(id, HTMLButtonElement).addEventListener('click', () => sendAction(action))

function sendInject(inject: DevInject): void {
  try {
    bridge.send(IPC.debugPanelInject, inject)
  } catch (err) {
    showError(`Could not send to Bitbot: ${err instanceof Error ? err.message : String(err)}`)
  }
}

for (const [id, inject] of ECONOMY_INJECTS) element(id, HTMLButtonElement).addEventListener('click', () => sendInject(inject))

const breakMinutes = element('ec-break-min', HTMLInputElement)
breakMinutes.value = String(tuning.dev.panel.economy.breakDefaultMin)
element('ec-break', HTMLButtonElement).addEventListener('click', () => {
  const inject = breakInject(Number(breakMinutes.value))
  if (inject) sendInject(inject)
  else showError('A break is a number of minutes (more than 0).')
})

element('reset', HTMLButtonElement).addEventListener('click', () => {
  const defaults: DevOverrides = { state: null, mood: null, dust: null, facing: null, face: null, idleMode: tuning.anim.idleMode, showWorld: false, wander: true, timeScale: 1 }
  send(defaults)
})

/** Sets every control from main's overrides (and what mood and dust are in effect, from the life). */
function showOverrides(o: DevOverrides, life: LifeSnapshot | null): void {
  setState(o.state ?? AUTO)
  setMood(o.mood ?? AUTO)
  moodEffect.textContent = moodInEffect(o, life)
  dustAuto.checked = o.dust === null
  dust.disabled = o.dust === null
  // Not under the user's pointer: a status sent before their newest move would make the slider jump back. On auto it
  // follows the needs' dust, so forcing starts from there.
  const shown = o.dust ?? (life ? life.needs.dust / 100 : null)
  if (shown !== null && document.activeElement !== dust) dust.value = String(shown)
  dustEffect.textContent = dustInEffect(o, life)
  setFacing(o.facing === 1 ? 'right' : o.facing === -1 ? 'left' : AUTO)
  setEyes(o.face?.eyes ?? AUTO)
  setMouth(o.face?.mouth ?? AUTO)
  const overlays = o.face?.overlays
  overlaysAuto.checked = overlays === undefined
  for (const [name, input] of overlayBoxes) input.checked = overlays?.includes(name) ?? false
  setOverlaysEnabled()
  setIdle(o.idleMode)
  showWorld.checked = o.showWorld
  wander.checked = o.wander
  setTimeScale(String(o.timeScale))
}

// ───────────────────────────── status ─────────────────────────────

const stState = element('st-state', HTMLElement)
const stSim = element('st-sim', HTMLElement)
const stLook = element('st-look', HTMLElement)
const stVisible = element('st-visible', HTMLElement)
const stRates = element('st-rates', HTMLElement)

const rate = (value: number | null): string => (value === null ? '–' : value.toFixed(1))

const wdWindows = element('wd-windows', HTMLElement)
const wdSegments = element('wd-segments', HTMLElement)
const wdWalls = element('wd-walls', HTMLElement)
const wdHz = element('wd-hz', HTMLElement)
const wdSurface = element('wd-surface', HTMLElement)
const wdGoal = element('wd-goal', HTMLElement)

/** The world status block; "—" for whatever the simulation doesn't know (no snapshot yet, in the air, no goal). */
function showWorldStatus(world: DevWorldStatus | null): void {
  const none = '—'
  wdWindows.textContent = world ? String(world.windows) : none
  wdSegments.textContent = world ? String(world.segments) : none
  wdWalls.textContent = world ? String(world.walls) : none
  wdHz.textContent = world ? `${world.snapshotHz.toFixed(1)} Hz` : none
  wdSurface.textContent = world?.surface ?? none
  wdGoal.textContent = world?.goal ? `${Math.round(world.goal.x)}, ${Math.round(world.goal.y)}` : none
}

/** The currency table's cells, one row per currency (CURRENCIES order), made once. */
const ecRows = element('ec-rows', HTMLTableSectionElement)
const ecCells = economyRows(null).map((row) => {
  const tr = document.createElement('tr')
  const name = document.createElement('td')
  name.textContent = row.currency
  const cells = row.cells.map((text) => {
    const td = document.createElement('td')
    td.textContent = text
    return td
  })
  tr.append(name, ...cells)
  ecRows.append(tr)
  return cells
})

const ecDay = element('ec-day', HTMLElement)
const ecDiet = element('ec-diet', HTMLElement)
const ecRhythm = element('ec-rhythm', HTMLElement)
const ecNutrition = element('ec-nutrition', HTMLElement)
const ecSparks = element('ec-sparks', HTMLElement)
const ecInput = element('ec-input', HTMLElement)

/** The economy block; "—" everywhere before the economy starts. */
function showEconomy(economy: EconomySnapshot | null): void {
  economyRows(economy).forEach((row, i) => {
    row.cells.forEach((text, j) => {
      const td = ecCells[i]?.[j]
      if (td) td.textContent = text
    })
  })
  const details = economyDetails(economy)
  ecDay.textContent = details.day
  ecDiet.textContent = details.diet
  ecRhythm.textContent = details.rhythm
  ecNutrition.textContent = details.nutrition
  ecSparks.textContent = details.sparks
  ecInput.textContent = details.input
  ecInput.classList.toggle('warn', details.inputOff)
}

/** The need bars (NEEDS order), made once. */
const lfNeeds = element('lf-needs', HTMLDivElement)
const needCells = needBars(null).map((bar) => {
  const name = document.createElement('span')
  name.className = 'need'
  name.textContent = bar.need
  const meter = document.createElement('meter')
  meter.min = 0
  meter.max = 100
  const value = document.createElement('output')
  lfNeeds.append(name, meter, value)
  return { meter, value }
})

const lfMood = element('lf-mood', HTMLElement)
const lfStuffed = element('lf-stuffed', HTMLElement)
const lfAsleep = element('lf-asleep', HTMLElement)
const lfActivity = element('lf-activity', HTMLElement)
const lfGoal = element('lf-goal', HTMLElement)
const lfContinuous = element('lf-continuous', HTMLElement)

/** The goal-score table's rows (GOAL_KINDS order), made once. */
const lfScores = element('lf-scores', HTMLTableSectionElement)
const scoreCells = scoreRows(null).map((row) => {
  const tr = document.createElement('tr')
  const name = document.createElement('td')
  name.textContent = row.goal
  const score = document.createElement('td')
  tr.append(name, score)
  lfScores.append(tr)
  return { tr, score }
})

/** The Life block; "—" everywhere before the pet exists. */
function showLife(life: LifeSnapshot | null): void {
  needBars(life).forEach((bar, i) => {
    const cells = needCells[i]
    if (!cells) return
    cells.meter.value = bar.value
    cells.value.textContent = bar.text
  })
  const details = lifeDetails(life)
  lfMood.textContent = details.mood
  lfStuffed.textContent = details.stuffed
  lfAsleep.textContent = details.asleep
  lfActivity.textContent = details.activity
  lfGoal.textContent = details.goal
  lfContinuous.textContent = details.continuous
  scoreRows(life).forEach((row, i) => {
    const cells = scoreCells[i]
    if (!cells) return
    cells.score.textContent = row.score
    cells.tr.classList.toggle('chosen', row.chosen)
  })
}

function showStatus(status: DevPanelStatus): void {
  const forced = status.state !== status.simState
  stState.textContent = forced ? `${status.state} (forced)` : status.state
  stState.classList.toggle('forced', forced)
  stSim.textContent = status.simState
  stLook.textContent = status.look ?? 'ahead (or not looking)'
  stVisible.textContent = status.visible ? 'shown' : 'hidden'
  stRates.textContent = `${rate(status.rendersPerS)} renders/s · ${rate(status.framesPerS)} frames/s`
  showWorldStatus(status.world)
  showEconomy(status.economy)
  showLife(status.life)
  showOverrides(status.overrides, status.life)
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
