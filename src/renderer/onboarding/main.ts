// The onboarding page (BITBOT_SPEC.md §15.1; main side src/main/windows/onboardingWindow.ts, messages in
// src/shared/onboarding.ts, pure parts in ./onboardingModel.ts). Five steps: welcome (the egg wobbling), privacy, the
// Input Monitoring permission, name & color (a live, turning 3D preview of the pet), hatch (the egg cracks, the pet pops
// out, the page says hello, then onboarding:finish and main takes over).
//
// Main owns the flow: the page shows the OnboardingView it pushes (validated) and sends requests; the only state the
// page keeps is the name and palette being chosen (until onboarding:hatch). Keyboard: Enter does the step's main
// button, Esc does nothing (it never closes the window).
//
// Performance: a 3D stage (three.js, the pet's own scene and lighting) exists only while its step is shown; it is
// disposed (renderer, geometries, its WebGL context) when the step changes or the page goes away. Frames are capped at
// tuning.onboarding.fps (the hatch at hatchFps), nothing is drawn while a stage holds still (the welcome egg between
// wobbles), and no frame runs while the window is hidden. prefers-reduced-motion: the egg does not wobble, the preview
// does not turn, the hatch is shorter, and the steps don't slide.

import { IPC } from '../../shared/ipc'
import { isOnboardingView, type OnboardingHatch, type OnboardingStep, type OnboardingView } from '../../shared/onboarding'
import { DEFAULT_PALETTE_ID, PALETTES, isPaletteId } from '../../shared/palettes'
import { DEFAULT_PET_NAME, PET_NAME_MAX } from '../../shared/settings'
import { tuning } from '../../shared/tuning'
import type { PaletteId } from '../../shared/types'
import { Animator, type AnimInput } from '../pet/character/animator'
import { createEgg } from '../pet/character/egg'
import { createPetScene, type PetScene } from '../pet/scene'
import { hatchFrame, hatchSchedule, nameStatus } from './onboardingModel'

const bridge = window.bitbot
const T = tuning.onboarding
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
const reducedMotion = (): boolean => reducedMotionQuery.matches

function element<E extends HTMLElement>(selector: string, type: new () => E): E {
  const found = document.querySelector(selector)
  if (!(found instanceof type)) throw new Error(`onboarding page: ${selector} missing`)
  return found
}

const sections = new Map<OnboardingStep, HTMLElement>()
for (const section of document.querySelectorAll<HTMLElement>('section.step')) {
  const step = section.dataset['step']
  if (step === 'welcome' || step === 'privacy' || step === 'permission' || step === 'identity' || step === 'hatch') sections.set(step, section)
}
const dots = element('#dots', HTMLOListElement)
const permStatus = element('#perm-status', HTMLParagraphElement)
const permRelaunch = element('#perm-relaunch', HTMLDivElement)
const permSkipNote = element('#perm-skip-note', HTMLParagraphElement)
const allowButton = element('#allow', HTMLButtonElement)
const skipButton = element('#skip', HTMLButtonElement)
const relaunchButton = element('#relaunch', HTMLButtonElement)
const nameInput = element('#name', HTMLInputElement)
const nameCount = element('#name-count', HTMLSpanElement)
const nameError = element('#name-error', HTMLParagraphElement)
const swatches = element('#swatches', HTMLFieldSetElement)
const hatchButton = element('#hatch', HTMLButtonElement)
const hatchTitle = element('#hatch-title', HTMLHeadingElement)
const hatchText = element('#hatch-text', HTMLParagraphElement)

for (const stage of document.querySelectorAll<HTMLElement>('.stage')) {
  const kind = stage.dataset['stage']
  const heights: Record<string, number> = T.stageHeight
  stage.style.height = `${heights[kind ?? 'egg'] ?? T.stageHeight.egg}px`
}
document.documentElement.style.setProperty('--fade-ms', reducedMotion() ? '0ms' : `${T.stepFadeMs}ms`)
document.documentElement.style.setProperty('--leave-ms', reducedMotion() ? '0ms' : `${T.leaveFadeMs}ms`)

// ---- The choice being made (name & color) ----------------------------------------------------------------

let paletteId: PaletteId = DEFAULT_PALETTE_ID
nameInput.value = DEFAULT_PET_NAME

for (const palette of Object.values(PALETTES)) {
  const label = document.createElement('label')
  label.className = 'swatch'
  label.title = palette.name
  const input = document.createElement('input')
  input.type = 'radio'
  input.name = 'palette'
  input.value = palette.id
  input.checked = palette.id === paletteId
  const chip = document.createElement('span')
  chip.className = 'chip'
  chip.style.setProperty('--c1', palette.primary)
  chip.style.setProperty('--c2', palette.secondary)
  chip.style.setProperty('--c3', palette.outline)
  const name = document.createElement('span')
  name.className = 'label'
  name.textContent = palette.name
  label.append(input, chip, name)
  swatches.append(label)
  input.addEventListener('change', () => {
    if (input.checked && isPaletteId(input.value)) choosePalette(input.value)
  })
}

function choosePalette(id: PaletteId): void {
  if (id === paletteId) return
  paletteId = id
  setGlow(id)
  if (stage?.kind === 'preview') stage.setPalette(id)
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
let glowId: PaletteId = DEFAULT_PALETTE_ID

/** The soft glow behind the stage in the palette's primary colour. */
function setGlow(id: PaletteId): void {
  glowId = id
  const hex = PALETTES[id].primary
  const channel = (i: number): number => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  const alpha = darkQuery.matches ? T.glowAlpha.dark : T.glowAlpha.light
  document.documentElement.style.setProperty('--glow', `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha})`)
}
darkQuery.addEventListener('change', () => setGlow(glowId))

function updateName(): OnboardingHatch | null {
  const status = nameStatus(nameInput.value)
  nameCount.textContent = `${status.length}/${PET_NAME_MAX}`
  nameError.textContent = status.error ?? ''
  nameInput.setAttribute('aria-invalid', status.error ? 'true' : 'false')
  hatchButton.disabled = status.name === null
  return status.name === null ? null : { name: status.name, paletteId }
}
nameInput.addEventListener('input', () => updateName())
updateName()

// ---- Showing the view -----------------------------------------------------------------------------------

let view: OnboardingView | null = null
let shownStep: OnboardingStep | null = null

function show(next: OnboardingView): void {
  const previous = view
  view = next
  for (const section of sections.values()) {
    for (const back of section.querySelectorAll<HTMLButtonElement>('[data-action="back"]')) back.hidden = !next.canBack
  }
  showPermission(next, previous)
  if (next.step !== shownStep) enterStep(next)
}

function showPermission(v: OnboardingView, previous: OnboardingView | null): void {
  skipButton.hidden = !v.canSkip
  permSkipNote.hidden = v.granted
  permRelaunch.hidden = !v.showRelaunch
  permStatus.classList.toggle('ok', v.granted)
  if (v.granted) {
    permStatus.textContent = '✓ Input Monitoring is on'
    allowButton.textContent = 'Continue'
  } else if (v.requested) {
    permStatus.replaceChildren(spinner(), document.createTextNode('In System Settings, turn on Bitbot under Input Monitoring.'))
    allowButton.textContent = 'Open System Settings'
  } else {
    permStatus.textContent = ''
    allowButton.textContent = 'Allow Input Monitoring'
  }
  // The grant just came in: keep the keyboard on the button that now says Continue.
  if (v.step === 'permission' && v.granted && previous?.granted === false && document.activeElement !== allowButton) allowButton.focus()
}

function spinner(): HTMLElement {
  const s = document.createElement('span')
  s.className = 'spinner'
  s.setAttribute('aria-hidden', 'true')
  return s
}

function enterStep(v: OnboardingView): void {
  const step = v.step
  shownStep = step
  stopStage()
  for (const [id, section] of sections) {
    const on = id === step
    section.classList.toggle('shown', on)
    section.inert = !on
    section.setAttribute('aria-hidden', on ? 'false' : 'true')
  }
  const index = [...sections.keys()].indexOf(step)
  dots.classList.toggle('hidden', step === 'hatch')
  dots.querySelectorAll('li').forEach((li, i) => li.classList.toggle('on', i === index))

  const section = sections.get(step)
  const stageElement = section?.querySelector<HTMLElement>('[data-stage]')
  if (step === 'welcome' && stageElement) {
    setGlow(DEFAULT_PALETTE_ID)
    stage = eggStage(stageElement)
  } else if (step === 'identity' && stageElement) {
    setGlow(paletteId)
    stage = previewStage(stageElement, paletteId)
    nameInput.focus()
    nameInput.select()
    updateName()
    return
  } else if (step === 'hatch' && stageElement) {
    const chosen = v.hatching ?? { name: nameStatus(nameInput.value).name ?? DEFAULT_PET_NAME, paletteId }
    setGlow(chosen.paletteId)
    stage = hatchStage(stageElement, chosen)
    return
  } else {
    setGlow(DEFAULT_PALETTE_ID)
  }
  section?.querySelector<HTMLButtonElement>('[data-primary]')?.focus()
}

// ---- Requests to main --------------------------------------------------------------------------------------

function primary(): void {
  const step = view?.step
  if (step === 'welcome' || step === 'privacy') bridge.send(IPC.onboardingNav, { dir: 'next' })
  else if (step === 'permission') {
    if (view?.granted) bridge.send(IPC.onboardingNav, { dir: 'next' })
    else bridge.send(IPC.onboardingRequestAccess)
  } else if (step === 'identity') {
    const chosen = updateName()
    if (chosen) bridge.send(IPC.onboardingHatch, chosen)
    else nameInput.focus()
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="next"], #allow, #hatch')) {
  button.addEventListener('click', primary)
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="back"]')) {
  button.addEventListener('click', () => bridge.send(IPC.onboardingNav, { dir: 'back' }))
}
skipButton.addEventListener('click', () => bridge.send(IPC.onboardingSkipPermission))
relaunchButton.addEventListener('click', () => bridge.send(IPC.onboardingRelaunch))

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    return
  }
  if (event.key !== 'Enter' || event.isComposing || event.repeat) return
  // A focused button does its own thing on Enter; anywhere else Enter is the step's main button.
  if (event.target instanceof HTMLButtonElement) return
  event.preventDefault()
  primary()
})

// ---- 3D stages ----------------------------------------------------------------------------------------------

interface Stage {
  readonly kind: 'egg' | 'preview' | 'hatch'
  setPalette(id: PaletteId): void
  stop(): void
}

let stage: Stage | null = null

function stopStage(): void {
  stage?.stop()
  stage = null
}

/** A fresh canvas filling `container`, and the pet's scene on it (size tuning.onboarding.stageSize). */
function sceneIn(container: HTMLElement, id: PaletteId): { pet: PetScene; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas')
  container.append(canvas) // on top of an old one until that is disposed (a palette change)
  const width = container.clientWidth || T.window.width
  const height = container.clientHeight || T.stageHeight.egg
  const pet = createPetScene({ canvas, width, height, size: T.stageSize, palette: PALETTES[id] })
  return { pet, canvas }
}

function disposeScene(pet: PetScene, canvas: HTMLCanvasElement): void {
  pet.dispose()
  pet.renderer.forceContextLoss()
  canvas.remove()
}

/**
 * Calls `frame(nowMs)` at most `fps` times a second while the page is visible; frame returns the ms until it next
 * needs a frame (0 = as soon as allowed) or null to stop.
 */
function runLoop(fps: number, frame: (nowMs: number) => number | null): { stop(): void } {
  const minGap = 1000 / fps
  let raf = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = -Infinity
  let stopped = false
  const schedule = (delayMs: number): void => {
    if (stopped || document.hidden) return
    if (delayMs > minGap) timer = setTimeout(() => ((timer = null), (raf = requestAnimationFrame(tick))), delayMs - minGap)
    else raf = requestAnimationFrame(tick)
  }
  const tick = (now: number): void => {
    raf = 0
    if (stopped) return
    if (now - last < minGap - T.frameSlackMs) return schedule(0)
    last = now
    const next = frame(now)
    if (next === null) stopped = true
    else schedule(next)
  }
  const onVisibility = (): void => {
    if (!document.hidden && !stopped && raf === 0 && timer === null) schedule(0)
  }
  document.addEventListener('visibilitychange', onVisibility)
  schedule(0)
  return {
    stop() {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}

/** Welcome: the egg (default palette) wobbling now and then, drawn only while it moves. */
function eggStage(container: HTMLElement): Stage {
  const { pet, canvas } = sceneIn(container, DEFAULT_PALETTE_ID)
  pet.rig.figure.visible = false
  pet.setContactShadow(0, 0) // the egg brings its own
  const egg = createEgg(PALETTES[DEFAULT_PALETTE_ID])
  pet.scene.add(egg.root)
  pet.render()
  let loop: { stop(): void } | null = null
  if (!reducedMotion()) {
    const w = T.wobble
    const start = performance.now()
    let lastAngle = 0
    loop = runLoop(T.fps, (now) => {
      const t = (now - start) / 1000
      const angle = egg.wobble(t)
      if (angle !== lastAngle) pet.render()
      lastAngle = angle
      if (angle !== 0) return 0
      // Between bursts: sleep until the next one.
      const phase = t % w.periodS
      return phase < w.burstS ? 0 : (w.periodS - phase) * 1000
    })
  }
  return {
    kind: 'egg',
    setPalette() {},
    stop() {
      loop?.stop()
      egg.dispose()
      disposeScene(pet, canvas)
    },
  }
}

function animInput(state: AnimInput['state'], idleMode: AnimInput['idleMode']): AnimInput {
  return { state, mood: 'happy', dust: 0, facing: 1, look: null, attach: 'floor', held: null, faceOverride: null, idleMode }
}

/** Name & color: the pet in the chosen palette, idling on a slow turntable (still with reduced motion). */
function previewStage(container: HTMLElement, id: PaletteId): Stage {
  const reduced = reducedMotion()
  const input = animInput('idle', reduced ? 'still' : 'continuous')
  let scene = sceneIn(container, id)
  let animator = new Animator(scene.pet.rig, { ptPerUnit: scene.pet.ptPerUnit })
  const start = performance.now()
  const loop = runLoop(T.fps, (now) => {
    const result = animator.update(now, input)
    if (!reduced) scene.pet.rig.root.rotation.y = tuning.render.defaultYaw + ((now - start) / 1000) * T.previewSpinRadPerS
    if (result.changed || !reduced) scene.pet.render()
    if (reduced && result.wakeAt !== null) return Math.max(0, result.wakeAt - now)
    return reduced ? null : 0
  })
  return {
    kind: 'preview',
    setPalette(next) {
      const fresh = sceneIn(container, next)
      disposeScene(scene.pet, scene.canvas)
      scene = fresh
      animator = new Animator(scene.pet.rig, { ptPerUnit: scene.pet.ptPerUnit })
      animator.update(performance.now(), input)
      scene.pet.render()
    },
    stop() {
      loop.stop()
      disposeScene(scene.pet, scene.canvas)
    },
  }
}

/** Hatch: the egg in the chosen palette wobbles, cracks and parts, the pet pops out, celebrates and waves; then goodbye. */
function hatchStage(container: HTMLElement, chosen: OnboardingHatch): Stage {
  const reduced = reducedMotion()
  const { pet, canvas } = sceneIn(container, chosen.paletteId)
  const egg = createEgg(PALETTES[chosen.paletteId])
  pet.scene.add(egg.root)
  pet.rig.figure.visible = false
  pet.setContactShadow(0, 0) // the egg has its own until the pet is out
  const animator = new Animator(pet.rig, { ptPerUnit: pet.ptPerUnit })
  // Out of the egg it celebrates (§15.1) for one jump and turn, then waves at the user while the page says hello.
  const input = animInput(reduced ? 'greet' : 'celebrate', 'continuous')
  let outAt: number | null = null
  hatchTitle.textContent = `Say hi to ${chosen.name}!`
  hatchText.textContent = `${chosen.name} is off to explore your desktop. You'll find Bitbot in the menu bar.`
  hatchTitle.classList.remove('shown')
  hatchText.classList.remove('shown')

  const schedule = hatchSchedule(reduced)
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    document.body.classList.add('leaving')
    setTimeout(() => bridge.send(IPC.onboardingFinish), reduced ? 0 : T.leaveFadeMs)
  }
  // If frames stop (the window hidden), still finish on time.
  const fallback = setTimeout(finish, schedule.end * 1000 + T.hatchFinishSlackMs)

  const start = performance.now()
  const loop = runLoop(T.hatchFps, (now) => {
    const t = (now - start) / 1000
    const f = hatchFrame(t, reduced)
    egg.wobble(t, f.wobble)
    egg.crack(f.crack)
    egg.setOpacity(f.eggOpacity)
    pet.rig.figure.visible = f.petVisible
    pet.setContactShadow(0, f.petVisible ? 1 : 0)
    if (f.petVisible) {
      outAt ??= now
      if (!reduced) input.state = now - outAt < tuning.anim.celebrate.periodS * 1000 ? 'celebrate' : 'greet'
      animator.update(now, input)
      pet.rig.figure.scale.setScalar(f.petScale)
      pet.rig.root.position.y = f.petHop
    }
    pet.render()
    if (f.hello) {
      hatchTitle.classList.add('shown')
      hatchText.classList.add('shown')
    }
    if (f.done) {
      finish()
      return null
    }
    return 0
  })
  return {
    kind: 'hatch',
    setPalette() {},
    stop() {
      loop.stop()
      clearTimeout(fallback)
      egg.dispose()
      disposeScene(pet, canvas)
    },
  }
}

// ---- Start -------------------------------------------------------------------------------------------------

bridge.on(IPC.onboardingView, (payload) => {
  if (isOnboardingView(payload)) show(payload)
})
bridge
  .invoke(IPC.onboardingState)
  .then((payload) => {
    if (isOnboardingView(payload)) show(payload)
  })
  .catch(() => {
    // Not from the onboarding window (or main is going away): nothing to show.
  })
window.addEventListener('pagehide', stopStage)
