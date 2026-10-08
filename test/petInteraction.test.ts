import { describe, expect, it } from 'vitest'
import { cursorNearPet, type HitWindowPlacement } from '../src/main/windows/hitArea'
import {
  PetInteraction,
  type NativeMouseEvent,
  type PetInteractionDeps,
  type PetInteractionTuning,
} from '../src/main/windows/petInteraction'
import { boxAt, inflateRect, rectContainsRect, type Box, type Point } from '../src/shared/geometry'
import { tuning } from '../src/shared/tuning'

// PetInteraction (src/main/windows/petInteraction.ts) driven through fakes for every dependency: the grab area's
// placement and mouse state, epochs, presses, the menu, the on-screen check, cancel, the safety net, the cursor stream
// and dependency failures; then random event sequences against the safety invariants.

const T: PetInteractionTuning = {
  nearMarginPt: 32,
  farMarginPt: 56,
  slackPt: 48,
  innerMarginPt: 4,
  safetyMarginPt: 8,
  onScreenRecheckMs: 500,
  onScreenAnswerTimeoutMs: 3000,
  cursorStreamMinMovePt: 0.5,
  clickMaxMovePt: 4,
}
// The production values satisfy the same interface (compile-time check).
const production: PetInteractionTuning = tuning.hitArea

// The pet's box at GROUND spans x 440..560, y 670..804.
const BOX: Box = { left: -60, top: -130, right: 60, bottom: 4 }
const GROUND: Point = { x: 500, y: 800 }
const ON_PET: Point = { x: 500, y: 740 }
/** 20 pt right of the box: near (32) but outside the safety margin (8). */
const NEAR: Point = { x: 580, y: 740 }
/** 6 pt right of the box: inside the safety margin. */
const EDGE: Point = { x: 566, y: 740 }
/** 40 pt right of the box: between the near (32) and far (56) margins. */
const BETWEEN: Point = { x: 600, y: 740 }
const FAR: Point = { x: 900, y: 740 }

interface Deferred<V> {
  promise: Promise<V>
  resolve(value: V): void
  reject(err: unknown): void
}

function deferred<V>(): Deferred<V> {
  let resolve: (value: V) => void = () => undefined
  let reject: (err: unknown) => void = () => undefined
  const promise = new Promise<V>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets settled promises run their handlers. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type Dep =
  | 'place'
  | 'setMouseEnabled'
  | 'setMouseEnabled:true'
  | 'grab'
  | 'release'
  | 'now'
  | 'cursor'
  | 'displayedPoint'
  | 'petBox'
  | 'overlayShown'
  | 'petDrawn'
  | 'frontmostFullscreen'
  | 'checkOverlayOnScreen'
  | 'popupMenu'
  | 'closeMenu'
  | 'onSnap'
  | 'sendHoverReset'
  | 'sendCursor'
  | 'log'

const ALL_DEPS: Dep[] = [
  'place',
  'setMouseEnabled',
  'grab',
  'release',
  'now',
  'cursor',
  'displayedPoint',
  'petBox',
  'overlayShown',
  'petDrawn',
  'frontmostFullscreen',
  'checkOverlayOnScreen',
  'popupMenu',
  'closeMenu',
  'onSnap',
  'sendHoverReset',
  'sendCursor',
  'log',
]

class Harness {
  /** What the fakes report. */
  readonly world = {
    now: 1000,
    cursor: { ...FAR } as Point,
    drawn: { ...GROUND } as Point,
    petBox: BOX as Box | null,
    overlayShown: true,
    petDrawn: true,
    fullscreen: false,
    /** Dependencies that throw when called. */
    fail: new Set<Dep>(),
  }
  /** What the fakes were asked to do (failed calls aren't recorded, except in placeCalls). */
  readonly rec = {
    placeCalls: 0,
    placements: [] as HitWindowPlacement[],
    mouse: [] as boolean[],
    grabs: 0,
    releases: [] as Point[],
    snaps: 0,
    resets: [] as number[],
    cursors: [] as Point[],
    menus: [] as (() => void)[],
    closeMenus: 0,
    logs: [] as string[],
    questions: [] as Deferred<boolean | null>[],
  }
  readonly pi: PetInteraction

  constructor() {
    const { world, rec } = this
    const boom = (dep: Dep): void => {
      if (world.fail.has(dep)) throw new Error(`${dep} exploded`)
    }
    const deps: PetInteractionDeps = {
      hitWindow: {
        place: (placement) => {
          rec.placeCalls++
          boom('place')
          rec.placements.push(placement)
        },
        setMouseEnabled: (on) => {
          boom('setMouseEnabled')
          if (on) boom('setMouseEnabled:true')
          rec.mouse.push(on)
        },
      },
      locomotion: {
        grab: () => {
          boom('grab')
          rec.grabs++
        },
        release: (at) => {
          boom('release')
          rec.releases.push({ ...at })
        },
      },
      tuning: T,
      now: () => {
        boom('now')
        return world.now
      },
      cursor: () => {
        boom('cursor')
        return { ...world.cursor }
      },
      displayedPoint: () => {
        boom('displayedPoint')
        return { ...world.drawn }
      },
      petBox: () => {
        boom('petBox')
        return world.petBox
      },
      overlayShown: () => {
        boom('overlayShown')
        return world.overlayShown
      },
      petDrawn: () => {
        boom('petDrawn')
        return world.petDrawn
      },
      frontmostFullscreen: () => {
        boom('frontmostFullscreen')
        return world.fullscreen
      },
      checkOverlayOnScreen: () => {
        boom('checkOverlayOnScreen')
        const d = deferred<boolean | null>()
        rec.questions.push(d)
        return d.promise
      },
      popupMenu: (onClose) => {
        boom('popupMenu')
        rec.menus.push(onClose)
      },
      closeMenu: () => {
        boom('closeMenu')
        rec.closeMenus++
      },
      onSnap: () => {
        boom('onSnap')
        rec.snaps++
      },
      sendHoverReset: (epoch) => {
        boom('sendHoverReset')
        rec.resets.push(epoch)
      },
      sendCursor: (p) => {
        boom('sendCursor')
        rec.cursors.push({ ...p })
      },
      log: (line) => {
        boom('log')
        rec.logs.push(line)
      },
    }
    this.pi = new PetInteraction(deps)
  }

  tick(dt = 33): void {
    this.world.now += dt
    this.pi.tick(this.world.now)
  }

  /** Answers the newest (or the index-th) on-screen question and lets the reply land. */
  async answer(value: boolean | null, index = this.rec.questions.length - 1): Promise<void> {
    const question = this.rec.questions[index]
    if (!question) throw new Error(`no on-screen question #${index}`)
    question.resolve(value)
    await flush()
  }

  async reject(index = this.rec.questions.length - 1): Promise<void> {
    const question = this.rec.questions[index]
    if (!question) throw new Error(`no on-screen question #${index}`)
    question.reject(new Error('helper went away'))
    await flush()
  }

  /** Cursor onto the pet, helper says on screen → the grab area is shown (epoch 1). */
  async showOnPet(): Promise<void> {
    this.world.cursor = { ...ON_PET }
    this.tick()
    await this.answer(true)
    this.tick()
    expect(this.pi.placement.shown).toBe(true)
  }

  hover(over: boolean, epoch = this.pi.epoch): void {
    this.pi.handleHover({ over, epoch })
  }

  down(at: Point = ON_PET, epoch = this.pi.epoch, button = 0): void {
    const ground = this.world.drawn
    this.pi.handlePointer({ kind: 'down', button, screenX: at.x, screenY: at.y, groundX: ground.x, groundY: ground.y, epoch })
  }

  up(at: Point, epoch = this.pi.epoch, button = 0): void {
    this.pi.handlePointer({ kind: 'up', button, screenX: at.x, screenY: at.y, epoch })
  }

  contextMenu(at: Point = ON_PET, epoch = this.pi.epoch): void {
    this.pi.handlePointer({ kind: 'contextmenu', screenX: at.x, screenY: at.y, epoch })
  }

  native(e: Partial<NativeMouseEvent> & Pick<NativeMouseEvent, 'type'>): void {
    this.pi.handleNativeMouse({ button: null, leftButtonDown: false, screen: null, ...e })
  }

  /** The newest menu's onClose. */
  closeMenu(index = this.rec.menus.length - 1): void {
    const onClose = this.rec.menus[index]
    if (!onClose) throw new Error(`no menu #${index}`)
    onClose()
  }

  /** The mouse state the port was last asked for (click-through until asked otherwise). */
  get portMouse(): boolean {
    return this.rec.mouse.at(-1) ?? false
  }

  logged(text: string): boolean {
    return this.rec.logs.some((line) => line.includes(text))
  }
}

describe('PetInteraction: placement, gating and epochs', () => {
  it('starts at epoch 0: hidden, click-through, nothing engaged', () => {
    const h = new Harness()
    expect(production.clickMaxMovePt).toBeGreaterThan(0)
    expect(h.pi.epoch).toBe(0)
    expect(h.pi.placement).toEqual({ shown: false })
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.engaged).toBe(false)
    expect(h.pi.held).toBe(false)
    expect(h.pi.overlayOnScreen).toBeNull()
    expect(h.pi.label).toBe('none')
    expect(h.pi.sampleHeld(h.world.now)).toBeNull()
  })

  it('places the grab area on every tick, hidden while the cursor is far', () => {
    const h = new Harness()
    h.tick()
    h.tick()
    h.tick()
    expect(h.rec.placements).toEqual([{ shown: false }, { shown: false }, { shown: false }])
    expect(h.rec.questions).toHaveLength(0)
  })

  it('shows the grab area only once the helper confirms the overlay is on screen', async () => {
    const h = new Harness()
    h.world.cursor = { ...ON_PET }
    h.tick()
    expect(h.rec.questions).toHaveLength(1)
    expect(h.pi.placement.shown).toBe(false) // unknown → hidden
    await h.answer(true)
    expect(h.pi.placement.shown).toBe(false) // applied on the next wake
    h.tick()
    expect(h.pi.placement).toEqual({ shown: true, bounds: { x: 392, y: 622, width: 216, height: 230 } })
    expect(h.rec.placements.at(-1)).toEqual(h.pi.placement)
    expect(h.pi.overlayOnScreen).toBe(true)
    expect(h.pi.label).toBe('near')
    expect(h.pi.mouseEnabled).toBe(false) // shown, but click-through until the overlay reports a hover
  })

  it('bumps the epoch when the grab area shows and sends the cursor at once', async () => {
    const h = new Harness()
    await h.showOnPet()
    expect(h.pi.epoch).toBe(1)
    expect(h.rec.resets).toEqual([1])
    expect(h.rec.cursors).toEqual([ON_PET])
  })

  it('hides when the cursor goes far: mouse off, epoch bumped', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    expect(h.portMouse).toBe(true)
    h.world.cursor = { ...FAR }
    h.tick()
    expect(h.pi.placement).toEqual({ shown: false })
    expect(h.portMouse).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.epoch).toBe(2)
    expect(h.rec.resets).toEqual([1, 2])
    expect(h.pi.label).toBe('none')
  })

  it('appears near the pet and stays until the cursor is past the far margin', async () => {
    const h = new Harness()
    h.world.cursor = { ...BETWEEN }
    h.tick()
    expect(h.rec.questions).toHaveLength(0) // not near yet: nothing to ask
    h.world.cursor = { ...NEAR }
    h.tick()
    await h.answer(true)
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
    h.world.cursor = { ...BETWEEN }
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
    h.world.cursor = { x: 560 + 57, y: 740 }
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
  })

  it('drops hover and pointer messages from another epoch', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true, 0)
    h.hover(true, 2)
    expect(h.pi.mouseEnabled).toBe(false)
    h.down(ON_PET, 0)
    h.contextMenu(ON_PET, 0)
    expect(h.rec.grabs).toBe(0)
    expect(h.rec.menus).toHaveLength(0)
    h.hover(true, 1)
    expect(h.pi.mouseEnabled).toBe(true)
  })

  it('ignores hover and pointer messages unless the grab area is shown, the overlay shown and the pet drawn', async () => {
    const h = new Harness()
    h.hover(true, 0) // grab area hidden
    h.down(ON_PET, 0)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.rec.grabs).toBe(0)

    await h.showOnPet()
    h.world.overlayShown = false
    h.hover(true)
    h.down()
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.rec.grabs).toBe(0)

    h.world.overlayShown = true
    h.world.petDrawn = false
    h.hover(true)
    h.contextMenu()
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.rec.menus).toHaveLength(0)

    h.world.petDrawn = true
    h.hover(true)
    expect(h.pi.mouseEnabled).toBe(true)
    expect(h.pi.label).toBe('hover')
  })

  it('hover over takes the mouse; hover off gives it back', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    expect(h.portMouse).toBe(true)
    h.hover(false)
    expect(h.portMouse).toBe(false)
    expect(h.pi.epoch).toBe(1) // the overlay's own hover off is no reset
  })

  it('hover off keeps the mouse while a press or the menu is in progress', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down()
    h.hover(false)
    expect(h.portMouse).toBe(true)
    h.up(ON_PET)
    h.contextMenu()
    h.hover(false)
    expect(h.portMouse).toBe(true)
  })

  it('race: a stale hover:true arriving after the grab area hid is dropped; the mouse stays off', async () => {
    const h = new Harness()
    await h.showOnPet()
    const stale = h.pi.epoch
    h.world.cursor = { ...FAR }
    h.tick()
    h.hover(true, stale)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.rec.mouse).not.toContain(true)
    // Even with the current epoch: no hover counts while the grab area is hidden.
    h.hover(true)
    expect(h.pi.mouseEnabled).toBe(false)
  })

  it('race: a hover dropped while hidden is re-reported once the grab area shows (epoch bump + cursor sent)', async () => {
    const h = new Harness()
    h.world.cursor = { ...ON_PET }
    h.tick()
    h.hover(true, 0) // dropped: the grab area isn't shown yet
    expect(h.pi.mouseEnabled).toBe(false)
    await h.answer(true)
    h.tick()
    expect(h.pi.epoch).toBe(1)
    expect(h.rec.resets).toEqual([1])
    expect(h.rec.cursors.at(-1)).toEqual(ON_PET)
    h.hover(true, 1) // the overlay hit-tests that sample and reports again
    expect(h.pi.mouseEnabled).toBe(true)
  })
})

describe('PetInteraction: presses', () => {
  it('down grabs at the overlay grab offset; sampleHeld follows the cursor minus that offset', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 }) // ground (500, 800): offset (10, −50)
    expect(h.rec.grabs).toBe(1)
    expect(h.pi.held).toBe(true)
    expect(h.pi.engaged).toBe(true)
    expect(h.pi.mouseEnabled).toBe(true)
    expect(h.pi.label).toBe('press')
    h.world.cursor = { x: 610, y: 650 }
    expect(h.pi.sampleHeld(h.world.now)).toEqual({ x: 600, y: 700 })
    expect(h.pi.label).toBe('drag')
  })

  it('a click (moved < clickMaxMovePt) puts the pet back exactly where it was; mouse stays on, epoch unchanged', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.world.drawn = { x: 500.25, y: 799.5 }
    h.down({ x: 510, y: 750 })
    h.world.cursor = { x: 512, y: 751 }
    h.pi.sampleHeld(h.world.now)
    const epoch = h.pi.epoch
    h.up({ x: 513, y: 752 }) // 3.6 pt from the press
    expect(h.rec.releases).toEqual([{ x: 500.25, y: 799.5 }])
    expect(h.rec.snaps).toBe(1)
    expect(h.pi.held).toBe(false)
    expect(h.pi.epoch).toBe(epoch)
    expect(h.pi.mouseEnabled).toBe(true)
    expect(h.pi.label).toBe('hover')
  })

  it('a drag lets go at the release point minus the grab offset; mouse off, epoch bumped', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    h.world.cursor = { x: 700, y: 600 }
    h.pi.sampleHeld(h.world.now)
    const epoch = h.pi.epoch
    h.up({ x: 705, y: 602 })
    expect(h.rec.releases).toEqual([{ x: 695, y: 652 }])
    expect(h.rec.snaps).toBe(1)
    expect(h.pi.held).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.epoch).toBe(epoch + 1)
    expect(h.rec.resets.at(-1)).toBe(epoch + 1)
  })

  it('a press that ends far from where it started is a drag even if no sample saw it move', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    h.up({ x: 530, y: 750 })
    expect(h.rec.releases).toEqual([{ x: 520, y: 800 }])
  })

  it('a press that moved away and came back is still a drag (largest movement counts)', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    h.world.cursor = { x: 540, y: 750 }
    h.pi.sampleHeld(h.world.now)
    h.up({ x: 511, y: 750 })
    expect(h.rec.releases).toEqual([{ x: 501, y: 800 }]) // the release point, not the press-start point
    expect(h.pi.mouseEnabled).toBe(false)
  })

  it('ignores other buttons, a second down while held, and a down while the menu is open', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down(ON_PET, h.pi.epoch, 2)
    expect(h.rec.grabs).toBe(0)
    h.down({ x: 510, y: 750 })
    h.up({ x: 600, y: 600 }, h.pi.epoch, 2)
    expect(h.pi.held).toBe(true)
    h.down({ x: 400, y: 700 }) // keeps the first press and its offset
    expect(h.rec.grabs).toBe(1)
    h.world.cursor = { x: 520, y: 760 }
    expect(h.pi.sampleHeld(h.world.now)).toEqual({ x: 510, y: 810 })
    h.up({ x: 520, y: 760 })
    h.tick()
    h.hover(true)
    h.contextMenu()
    h.down()
    expect(h.rec.grabs).toBe(1)
    expect(h.pi.held).toBe(false)
  })

  it('race: a native mouseUp before the renderer up releases once', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    const epoch = h.pi.epoch
    h.world.cursor = { x: 700, y: 600 }
    h.pi.sampleHeld(h.world.now)
    h.native({ type: 'mouseUp', button: 'left', screen: { x: 700, y: 600 } })
    expect(h.rec.releases).toEqual([{ x: 690, y: 650 }])
    expect(h.pi.epoch).toBe(epoch + 1)
    h.up({ x: 700, y: 600 }, epoch) // the renderer's up, stamped before the bump
    h.up({ x: 700, y: 600 }) // and even one with the current epoch
    expect(h.rec.releases).toHaveLength(1)
    expect(h.rec.snaps).toBe(1)
  })

  it('race: a native mouseUp ending a click, then the renderer up (same epoch), releases once', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    h.native({ type: 'mouseUp', button: 'left', screen: { x: 511, y: 750 } })
    h.up({ x: 511, y: 750 })
    expect(h.rec.releases).toEqual([GROUND])
    expect(h.pi.mouseEnabled).toBe(true)
  })

  it('a native mouseUp without a screen point releases at the cursor', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    h.world.cursor = { x: 710, y: 610 }
    h.native({ type: 'mouseUp', button: 'left' })
    expect(h.rec.releases).toEqual([{ x: 700, y: 660 }])
  })

  it('race: a lost mouseup — a native move without the left button releases', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    h.native({ type: 'mouseMove', leftButtonDown: true, screen: { x: 600, y: 700 } })
    expect(h.pi.held).toBe(true)
    h.native({ type: 'mouseMove', leftButtonDown: false, screen: { x: 620, y: 690 } })
    expect(h.pi.held).toBe(false)
    expect(h.rec.releases).toEqual([{ x: 610, y: 740 }])
    h.up({ x: 620, y: 690 })
    expect(h.rec.releases).toHaveLength(1)
  })

  it('ignores a native right or middle mouseUp and other events during a left press', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down()
    h.native({ type: 'mouseUp', button: 'right', screen: ON_PET })
    h.native({ type: 'mouseUp', button: 'middle', screen: ON_PET })
    h.native({ type: 'mouseLeave', screen: FAR })
    h.native({ type: 'mouseDown', button: 'left', leftButtonDown: true, screen: ON_PET })
    h.native({ type: 'mouseWheel', leftButtonDown: true })
    expect(h.pi.held).toBe(true)
    expect(h.rec.releases).toHaveLength(0)
  })

  it('native events never grab, and do nothing when nothing is held', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.native({ type: 'mouseDown', button: 'left', leftButtonDown: true, screen: ON_PET })
    h.native({ type: 'mouseUp', button: 'left', screen: ON_PET })
    h.native({ type: 'mouseMove', screen: ON_PET })
    h.native({ type: 'contextMenu', button: 'right', screen: ON_PET })
    expect(h.rec.grabs).toBe(0)
    expect(h.rec.releases).toHaveLength(0)
    expect(h.rec.menus).toHaveLength(0)
    expect(h.pi.mouseEnabled).toBe(true)
    expect(h.pi.epoch).toBe(1)
  })

  it('race: a pointer down arriving after cancel is dropped', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    const stale = h.pi.epoch
    h.pi.cancel('Space changed')
    h.down(ON_PET, stale)
    expect(h.rec.grabs).toBe(0)
    expect(h.pi.held).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
  })

  it('a failing locomotion.grab leaves nothing held and fails closed', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.world.fail.add('grab')
    const epoch = h.pi.epoch
    h.down()
    expect(h.pi.held).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.epoch).toBe(epoch + 1)
    expect(h.logged('locomotion.grab failed')).toBe(true)
  })
})

describe('PetInteraction: context menu', () => {
  it('contextmenu opens the menu: engaged, mouse on', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.contextMenu()
    expect(h.rec.menus).toHaveLength(1)
    expect(h.pi.engaged).toBe(true)
    expect(h.pi.held).toBe(false)
    expect(h.pi.mouseEnabled).toBe(true)
    expect(h.pi.label).toBe('menu')
  })

  it('race: onClose called twice resets once — mouse off, one epoch bump, one cursor sample', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.contextMenu()
    const epoch = h.pi.epoch
    const cursors = h.rec.cursors.length
    h.world.cursor = { x: 505, y: 745 }
    h.closeMenu()
    h.closeMenu()
    expect(h.pi.engaged).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.epoch).toBe(epoch + 1)
    expect(h.rec.resets.filter((e) => e > epoch)).toEqual([epoch + 1])
    expect(h.rec.cursors.slice(cursors)).toEqual([{ x: 505, y: 745 }])
    expect(h.pi.label).toBe('near')
  })

  it('race: cancel while the menu is open closes it; its later onClose changes nothing', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.contextMenu()
    h.pi.cancel('Space changed')
    expect(h.rec.closeMenus).toBe(1)
    expect(h.pi.engaged).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
    const epoch = h.pi.epoch
    const cursors = h.rec.cursors.length
    h.closeMenu() // AppKit reports the close afterwards
    expect(h.pi.epoch).toBe(epoch)
    expect(h.rec.cursors).toHaveLength(cursors)
    expect(h.logged('Space changed')).toBe(true)
  })

  it('ignores contextmenu while held or while the menu is open', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down()
    h.contextMenu()
    expect(h.rec.menus).toHaveLength(0)
    h.up(ON_PET)
    h.contextMenu()
    h.contextMenu()
    expect(h.rec.menus).toHaveLength(1)
  })

  it('a menu that fails to pop up counts as closed', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.world.fail.add('popupMenu')
    const epoch = h.pi.epoch
    h.contextMenu()
    expect(h.pi.engaged).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.epoch).toBe(epoch + 1)
  })

  it('keeps the grab area and the mouse while the menu is open, wherever the cursor goes', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.contextMenu()
    h.world.cursor = { ...FAR }
    h.tick()
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
    expect(h.pi.mouseEnabled).toBe(true) // no safety net while engaged
    h.closeMenu()
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
  })
})

describe('PetInteraction: on-screen check', () => {
  it('asks one question at a time and re-asks every onScreenRecheckMs while near, keeping the answer meanwhile', async () => {
    const h = new Harness()
    h.world.cursor = { ...ON_PET }
    h.tick() // 1033: asks #1
    h.tick()
    expect(h.rec.questions).toHaveLength(1) // one in flight
    await h.answer(true)
    h.tick() // 1099: shown
    h.tick(400) // 1499: 466 ms since #1 was asked
    expect(h.rec.questions).toHaveLength(1)
    h.tick(40) // 1539: 506 ms → asks #2
    expect(h.rec.questions).toHaveLength(2)
    expect(h.pi.placement.shown).toBe(true) // still the cached answer
    h.tick()
    expect(h.rec.questions).toHaveLength(2)
    await h.answer(false)
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
    expect(h.pi.overlayOnScreen).toBe(false)
    h.tick(500)
    expect(h.rec.questions).toHaveLength(3) // still near: re-asked on schedule
  })

  it('does not ask while the cursor is far and nothing is engaged', () => {
    const h = new Harness()
    for (let i = 0; i < 40; i++) h.tick(100)
    expect(h.rec.questions).toHaveLength(0)
  })

  it('discards the answer when the cursor comes near again (fails closed on entry)', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.world.cursor = { ...FAR }
    h.tick()
    h.world.cursor = { ...ON_PET }
    h.tick() // only 66 ms after a true answer, but not trusted
    expect(h.pi.placement.shown).toBe(false)
    expect(h.pi.overlayOnScreen).toBeNull()
    expect(h.rec.questions).toHaveLength(2)
    await h.answer(true)
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
  })

  it('race: an on-screen reply asked before an invalidate is ignored', async () => {
    const h = new Harness()
    h.world.cursor = { ...ON_PET }
    h.tick() // asks #1
    h.pi.invalidateOnScreen()
    await h.answer(true, 0)
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
    expect(h.rec.questions).toHaveLength(2) // asked again once #1 was out of the way
    await h.answer(true, 1)
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
  })

  it('invalidateOnScreen hides the grab area at once and asks again only after settleMs', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    const epoch = h.pi.epoch
    h.pi.invalidateOnScreen(700)
    expect(h.pi.placement.shown).toBe(false) // no tick needed
    expect(h.rec.placements.at(-1)).toEqual({ shown: false })
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.epoch).toBe(epoch + 1)
    h.tick(300)
    h.tick(300)
    expect(h.rec.questions).toHaveLength(1)
    h.tick(200)
    expect(h.rec.questions).toHaveLength(2)
    await h.answer(true)
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
  })

  it('a later invalidate never shortens an earlier settle delay', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.pi.invalidateOnScreen(700)
    h.pi.invalidateOnScreen(0)
    h.tick(600)
    expect(h.rec.questions).toHaveLength(1)
    h.tick(200)
    expect(h.rec.questions).toHaveLength(2)
  })

  it('a rejecting checkOverlayOnScreen counts as unknown (hidden) and is asked again on schedule', async () => {
    const h = new Harness()
    h.world.cursor = { ...ON_PET }
    h.tick()
    await h.reject()
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
    expect(h.pi.overlayOnScreen).toBeNull()
    expect(h.rec.questions).toHaveLength(1) // not hammered on every wake
    expect(h.logged('checkOverlayOnScreen failed')).toBe(true)
    h.tick(500)
    expect(h.rec.questions).toHaveLength(2)
    await h.answer(true)
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
  })

  it('a checkOverlayOnScreen that throws synchronously counts as unknown', async () => {
    const h = new Harness()
    h.world.fail.add('checkOverlayOnScreen')
    h.world.cursor = { ...ON_PET }
    expect(() => h.tick()).not.toThrow()
    await flush()
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
    h.world.fail.delete('checkOverlayOnScreen')
    h.tick(500)
    await h.answer(true)
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
  })

  it('a null answer (helper down, unknown window) keeps the grab area hidden', async () => {
    const h = new Harness()
    h.world.cursor = { ...ON_PET }
    h.tick()
    await h.answer(null)
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
  })

  it('abandons a question unanswered for onScreenAnswerTimeoutMs: hidden, asked again, the late reply ignored', async () => {
    const h = new Harness()
    await h.showOnPet() // #1 asked at 1033
    h.tick(500) // 1566: asks #2, which never gets an answer
    expect(h.rec.questions).toHaveLength(2)
    h.tick(2900)
    expect(h.pi.placement.shown).toBe(true) // the cached answer, while #2 may still come
    expect(h.rec.questions).toHaveLength(2)
    h.tick(100) // 3000 ms after #2
    expect(h.pi.placement.shown).toBe(false)
    expect(h.rec.questions).toHaveLength(3)
    expect(h.logged('no answer after 3000 ms')).toBe(true)
    await h.answer(true, 1) // #2, too late
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
    await h.answer(true, 2)
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
  })

  it('frontmostFullscreen counts as off screen', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.world.fullscreen = true
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
    expect(h.pi.overlayOnScreen).toBe(false)
  })

  it('engaging discards the answer and asks again; the grab area stays meanwhile', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down()
    h.tick()
    expect(h.rec.questions).toHaveLength(2)
    expect(h.pi.overlayOnScreen).toBeNull()
    expect(h.pi.placement.shown).toBe(true)
    expect(h.pi.held).toBe(true)
    await h.answer(false)
    h.tick()
    expect(h.pi.held).toBe(false)
    expect(h.rec.releases).toHaveLength(1)
    expect(h.pi.placement.shown).toBe(false)
    expect(h.logged('not on screen')).toBe(true)
  })

  it('keeps asking while engaged, even with the cursor far from the pet', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down()
    h.world.cursor = { ...FAR }
    h.tick()
    await h.answer(true)
    h.tick(500)
    expect(h.rec.questions).toHaveLength(3)
  })
})

describe('PetInteraction: cancel, safety net, cursor stream', () => {
  it('frontmostFullscreen while engaged cancels: the held pet is let go where it is drawn', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    h.world.cursor = { x: 700, y: 600 }
    h.pi.sampleHeld(h.world.now)
    h.world.drawn = { x: 650, y: 700 }
    h.world.fullscreen = true
    h.tick()
    expect(h.rec.releases).toEqual([{ x: 650, y: 700 }])
    expect(h.rec.snaps).toBe(1)
    expect(h.pi.held).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.placement.shown).toBe(false)
    expect(h.logged('fullscreen')).toBe(true)
  })

  it('engaged when the overlay is hidden cancels', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down()
    h.world.overlayShown = false
    h.tick()
    expect(h.pi.held).toBe(false)
    expect(h.rec.releases).toHaveLength(1)
    expect(h.pi.placement.shown).toBe(false)
    expect(h.portMouse).toBe(false)
    expect(h.logged('the overlay is hidden')).toBe(true)
  })

  it('engaged when the pet is no longer drawn cancels, closing an open menu', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.contextMenu()
    h.world.petDrawn = false
    h.tick()
    expect(h.rec.closeMenus).toBe(1)
    expect(h.pi.engaged).toBe(false)
    expect(h.pi.placement.shown).toBe(false)
  })

  it('engaged without a pet box cancels', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down()
    h.world.petBox = null
    h.tick()
    expect(h.pi.held).toBe(false)
    expect(h.pi.placement.shown).toBe(false)
  })

  it('an engaged interaction survives an unknown on-screen answer, not a false one', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down()
    h.tick() // asks again (engaging)
    await h.answer(null)
    h.tick()
    expect(h.pi.held).toBe(true)
    expect(h.pi.placement.shown).toBe(true)
    h.tick(500)
    await h.answer(false)
    h.tick()
    expect(h.pi.held).toBe(false)
  })

  it('cancel lets a held pet go where it is drawn (no click rule): onSnap, mouse off, epoch bump, logged', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 }) // hasn't moved: as a release this would be a click
    h.world.drawn = { x: 505, y: 790 }
    const epoch = h.pi.epoch
    h.pi.cancel('lock screen')
    expect(h.rec.releases).toEqual([{ x: 505, y: 790 }])
    expect(h.rec.snaps).toBe(1)
    expect(h.pi.held).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.epoch).toBe(epoch + 1)
    expect(h.rec.resets.at(-1)).toBe(epoch + 1)
    expect(h.logged('lock screen')).toBe(true)
    // The press's own ends arrive afterwards and change nothing.
    h.up({ x: 510, y: 750 }, epoch)
    h.native({ type: 'mouseUp', button: 'left', screen: { x: 510, y: 750 } })
    expect(h.rec.releases).toHaveLength(1)
  })

  it('cancel with nothing in progress still turns the mouse off and bumps the epoch', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    const epoch = h.pi.epoch
    h.pi.cancel('hidden by the user')
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.epoch).toBe(epoch + 1)
    expect(h.rec.releases).toHaveLength(0)
    expect(h.rec.closeMenus).toBe(0)
  })

  it('safety net: mouse on, nothing engaged, cursor outside the pet box + safetyMarginPt → click-through, epoch bump', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    const epoch = h.pi.epoch
    h.world.cursor = { ...NEAR }
    h.tick()
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.portMouse).toBe(false)
    expect(h.pi.epoch).toBe(epoch + 1)
    expect(h.pi.placement.shown).toBe(true) // still near: only the mouse goes
    expect(h.logged('safety net')).toBe(true)
  })

  it('safety net: also when the pet moves away from a still cursor', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.world.drawn = { x: 420, y: 800 } // the box now ends at x 480; the cursor (500) is 20 pt outside
    h.tick()
    expect(h.pi.mouseEnabled).toBe(false)
  })

  it('safety net: not inside the margin, and never while engaged', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.world.cursor = { ...EDGE }
    h.tick()
    expect(h.pi.mouseEnabled).toBe(true)
    h.down(EDGE)
    h.world.cursor = { ...NEAR }
    h.tick()
    expect(h.portMouse).toBe(true)
    expect(h.pi.held).toBe(true)
  })

  it('safety net logs at 1, 2, 4, 8… firings only', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.world.cursor = { ...NEAR }
    for (let i = 0; i < 9; i++) {
      h.hover(true) // a renderer that keeps disagreeing
      h.tick()
    }
    expect(h.rec.logs.filter((line) => line.includes('safety net'))).toHaveLength(4)
  })

  it('cursor stream: sends when the cursor or the drawn pet moved more than cursorStreamMinMovePt', async () => {
    const h = new Harness()
    await h.showOnPet()
    expect(h.rec.cursors).toEqual([ON_PET])
    h.tick()
    expect(h.rec.cursors).toHaveLength(1)
    h.world.cursor = { x: 500.4, y: 740 }
    h.tick()
    expect(h.rec.cursors).toHaveLength(1)
    h.world.cursor = { x: 500.6, y: 740 }
    h.tick()
    expect(h.rec.cursors).toEqual([ON_PET, { x: 500.6, y: 740 }])
    h.world.drawn = { x: 501, y: 800 }
    h.tick()
    expect(h.rec.cursors).toHaveLength(3) // the pet moved under a still cursor
  })

  it('cursor stream: pauses while held, sends a fresh sample after a drag release', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    const sent = h.rec.cursors.length
    h.world.cursor = { x: 700, y: 600 }
    h.world.drawn = h.pi.sampleHeld(h.world.now) ?? h.world.drawn
    h.tick() // engaging re-asks the helper
    await h.answer(true)
    h.tick()
    expect(h.rec.cursors).toHaveLength(sent)
    h.up({ x: 700, y: 600 })
    h.tick()
    expect(h.rec.cursors.slice(sent)).toEqual([{ x: 700, y: 600 }])
  })

  it('cursor stream: after any reset the overlay gets a fresh sample, even if nothing moved', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.tick()
    expect(h.rec.cursors).toEqual([ON_PET])
    h.pi.cancel('display changed') // the overlay forgets its hover with the bump…
    h.tick()
    expect(h.rec.cursors).toEqual([ON_PET, ON_PET]) // …and can report it again from this sample
    h.hover(true)
    expect(h.pi.mouseEnabled).toBe(true)
    // A drag that ends back where it started: the cursor and the pet are where they were last sent.
    h.down(ON_PET)
    h.world.cursor = { x: 540, y: 740 }
    h.pi.sampleHeld(h.world.now)
    h.world.cursor = { ...ON_PET }
    h.up(ON_PET)
    expect(h.rec.releases).toEqual([GROUND])
    expect(h.pi.mouseEnabled).toBe(false)
    h.tick()
    expect(h.rec.cursors).toEqual([ON_PET, ON_PET, ON_PET])
  })

  it('cursor stream: sends nothing while hidden', () => {
    const h = new Harness()
    for (let i = 0; i < 10; i++) {
      h.world.cursor = { x: 900 + i * 10, y: 740 }
      h.tick()
    }
    expect(h.rec.cursors).toHaveLength(0)
  })
})

describe('PetInteraction: dependency failures', () => {
  it('a throwing dependency never escapes a tick; it fails closed, logs once, and recovers', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.world.fail.add('cursor')
    expect(() => h.tick()).not.toThrow()
    expect(h.pi.placement.shown).toBe(false)
    expect(h.portMouse).toBe(false)
    h.tick()
    h.tick()
    expect(h.rec.logs.filter((line) => line.includes('cursor failed'))).toHaveLength(1)
    expect(h.rec.logs.filter((line) => line.includes('grab area hidden'))).toHaveLength(1)
    h.world.fail.delete('cursor')
    h.tick() // the cursor "comes near" again: a fresh question
    await h.answer(true)
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
  })

  it('a dependency failure while held cancels the press', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down()
    h.world.fail.add('petBox')
    h.tick()
    expect(h.pi.held).toBe(false)
    expect(h.rec.releases).toHaveLength(1)
    expect(h.pi.placement.shown).toBe(false)
    expect(h.portMouse).toBe(false)
  })

  it('a misbehaving dependency (non-finite cursor, malformed box) counts as a failure', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.world.cursor = { x: Number.NaN, y: 740 }
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
    const g = new Harness()
    await g.showOnPet()
    g.world.petBox = { left: 10, top: 0, right: -10, bottom: 4 }
    g.tick()
    expect(g.pi.placement.shown).toBe(false)
  })

  it('a hit window that throws on place counts as hidden, and is retried on every tick', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.world.fail.add('place')
    const calls = h.rec.placeCalls
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
    expect(h.portMouse).toBe(false)
    h.tick()
    expect(h.rec.placeCalls).toBeGreaterThanOrEqual(calls + 2)
    h.world.fail.delete('place')
    // After failing closed it re-checks from scratch: questions asked before the recovery don't count.
    const asked = h.rec.questions.length
    h.tick()
    await h.answer(true)
    h.tick()
    expect(h.pi.placement.shown).toBe(false)
    expect(h.rec.questions.length).toBeGreaterThan(asked)
    await h.answer(true)
    h.tick()
    expect(h.pi.placement.shown).toBe(true)
    expect(h.rec.placements.at(-1)).toEqual(h.pi.placement)
  })

  it('a hit window that cannot take the mouse stays click-through', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.world.fail.add('setMouseEnabled:true')
    h.hover(true)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.portMouse).toBe(false)
  })

  it('a setMouseEnabled(false) that throws is retried on the next tick', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.world.fail.add('setMouseEnabled')
    h.hover(false)
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.portMouse).toBe(true) // the port never got it
    h.world.fail.delete('setMouseEnabled')
    h.tick()
    expect(h.portMouse).toBe(false)
  })

  it('every public method survives every dependency throwing, and ends fail-closed', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.down({ x: 510, y: 750 })
    for (const dep of ALL_DEPS) h.world.fail.add(dep)
    expect(() => {
      h.tick()
      h.hover(true)
      h.down()
      h.up(ON_PET)
      h.contextMenu()
      h.native({ type: 'mouseUp', button: 'left' })
      h.native({ type: 'mouseMove' })
      h.pi.sampleHeld(h.world.now)
      h.pi.invalidateOnScreen(100)
      h.pi.cancel('test')
      h.tick()
    }).not.toThrow()
    expect(h.pi.mouseEnabled).toBe(false)
    expect(h.pi.placement.shown).toBe(false)
    expect(h.pi.engaged).toBe(false)
  })

  it('a non-finite clock fails closed', async () => {
    const h = new Harness()
    await h.showOnPet()
    h.hover(true)
    h.pi.tick(Number.NaN)
    expect(h.pi.placement.shown).toBe(false)
    expect(h.pi.mouseEnabled).toBe(false)
  })
})

// ───────────────────────────── random sequences ─────────────────────────────

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('PetInteraction: invariants under random event sequences', () => {
  /** Rare paths, counted over all seeds (the tests in a file run in order). */
  const rare = { menuCancels: 0, heldCancels: 0, seeds: 0 }

  for (const seed of [1, 2, 3, 0xb17b07]) {
    it(`holds the safety invariants (seed ${seed})`, async () => {
      const rand = mulberry32(seed)
      const pick = <V>(items: readonly V[]): V => items[Math.floor(rand() * items.length)] as V
      const h = new Harness()
      const spots = [ON_PET, NEAR, EDGE, BETWEEN, FAR, { x: 445, y: 675 }, { x: 1400, y: 100 }]
      const settled = new Set<Deferred<boolean | null>>()
      const pending = (): Deferred<boolean | null>[] => h.rec.questions.filter((q) => !settled.has(q))
      const settle = async (q: Deferred<boolean | null>, how: 'true' | 'false' | 'null' | 'reject'): Promise<void> => {
        settled.add(q)
        if (how === 'reject') q.reject(new Error('gone'))
        else q.resolve(how === 'true' ? true : how === 'false' ? false : null)
        await flush()
      }

      // Cumulative action weights (%), biased toward a user playing with the pet on a healthy system.
      const weights = { tick: 25, cursor: 37, drawn: 41, hover: 53, down: 62, up: 69, menu: 72, native: 78, close: 81, cancel: 82.5, invalidate: 85, answer: 97 }
      for (let step = 0; step < 3000; step++) {
        const epochBefore = h.pi.epoch
        const resetsBefore = h.rec.resets.length
        const placeBefore = h.rec.placements.length
        let ticked = false
        const r = rand() * 100
        const epochFor = (): number => (rand() < 0.8 ? h.pi.epoch : h.pi.epoch - 1 - Math.floor(rand() * 3))
        if (r < weights.tick) {
          h.tick(rand() < 0.05 ? 1000 + Math.floor(rand() * 3000) : 1 + Math.floor(rand() * 120))
          ticked = true
        } else if (r < weights.cursor) {
          const spot = rand() < 0.4 ? ON_PET : pick(spots)
          h.world.cursor = { x: spot.x + (rand() - 0.5) * 6, y: spot.y + (rand() - 0.5) * 6 }
          if (h.pi.held) h.world.drawn = h.pi.sampleHeld(h.world.now) ?? h.world.drawn
        } else if (r < weights.drawn) {
          h.world.drawn = rand() < 0.5 ? { ...GROUND } : { x: GROUND.x + (rand() - 0.5) * 80, y: GROUND.y - rand() * 60 }
        } else if (r < weights.hover) {
          h.hover(rand() < 0.7, epochFor())
        } else if (r < weights.down) {
          h.down(h.world.cursor, epochFor(), rand() < 0.9 ? 0 : 2)
        } else if (r < weights.up) {
          h.up(h.world.cursor, epochFor(), rand() < 0.9 ? 0 : 2)
        } else if (r < weights.menu) {
          h.contextMenu(h.world.cursor, epochFor())
        } else if (r < weights.native) {
          h.native({
            type: pick(['mouseDown', 'mouseUp', 'mouseMove', 'mouseLeave', 'contextMenu'] as const),
            button: pick(['left', 'right', null] as const),
            leftButtonDown: rand() < 0.5,
            screen: rand() < 0.7 ? { ...h.world.cursor } : null,
          })
        } else if (r < weights.close) {
          if (h.rec.menus.length > 0) h.closeMenu(rand() < 0.7 ? h.rec.menus.length - 1 : Math.floor(rand() * h.rec.menus.length))
        } else if (r < weights.cancel) {
          h.pi.cancel('random')
        } else if (r < weights.invalidate) {
          h.pi.invalidateOnScreen(rand() < 0.5 ? 0 : 700)
          ticked = true
        } else if (r < weights.answer) {
          const open = pending()
          if (open.length > 0) await settle(pick(open), pick(['true', 'true', 'true', 'false', 'null', 'reject'] as const))
        } else {
          // Mostly healthy: each condition goes bad only now and then.
          h.world.overlayShown = rand() < 0.9
          h.world.petDrawn = rand() < 0.9
          h.world.fullscreen = rand() < 0.08
          h.world.petBox = rand() < 0.92 ? BOX : null
        }

        const pi = h.pi
        const where = `seed ${seed}, step ${step}`
        // Hidden means click-through, always; and the port agrees with what PetInteraction believes.
        if (!pi.placement.shown) expect(pi.mouseEnabled, where).toBe(false)
        expect(h.portMouse, where).toBe(pi.mouseEnabled)
        // An interaction never outlives its grab area.
        if (pi.engaged) expect(pi.placement.shown, where).toBe(true)
        // Every grab is released exactly once.
        expect(h.rec.grabs - h.rec.releases.length, where).toBe(pi.held ? 1 : 0)
        for (const at of h.rec.releases) expect(Number.isFinite(at.x) && Number.isFinite(at.y), where).toBe(true)
        // Epochs only grow, every bump is announced, and the mouse is off after a bump.
        expect(pi.epoch, where).toBeGreaterThanOrEqual(epochBefore)
        expect(h.rec.resets.slice(resetsBefore), where).toEqual(
          Array.from({ length: pi.epoch - epochBefore }, (_, i) => epochBefore + i + 1),
        )
        if (pi.epoch > epochBefore) expect(pi.mouseEnabled, where).toBe(false)
        if (ticked) {
          // One placement per wake, and it is what PetInteraction reports.
          expect(h.rec.placements.length, where).toBe(placeBefore + 1)
          expect(h.rec.placements.at(-1), where).toEqual(pi.placement)
          const w = h.world
          if (pi.placement.shown) {
            expect(w.overlayShown && w.petDrawn && w.petBox !== null, where).toBe(true)
            if (pi.engaged) expect(pi.overlayOnScreen, where).not.toBe(false)
            else expect(pi.overlayOnScreen, where).toBe(true)
            if (!pi.engaged && w.petBox) expect(cursorNearPet(w.cursor, w.drawn, w.petBox, T.farMarginPt), where).toBe(true)
            if (w.petBox) {
              const covered = inflateRect(boxAt(w.drawn, w.petBox), T.innerMarginPt)
              expect(rectContainsRect(pi.placement.bounds, covered), where).toBe(true)
            }
          }
          // The safety net holds after every wake.
          if (pi.mouseEnabled && !pi.engaged && w.petBox) {
            expect(cursorNearPet(w.cursor, w.drawn, w.petBox, T.safetyMarginPt), where).toBe(true)
          }
        }
      }
      // The sequence exercised the interesting states: hover, presses, drags, the menu.
      expect(h.rec.mouse).toContain(true)
      expect(h.rec.grabs).toBeGreaterThan(3)
      expect(h.rec.releases.some((at) => at.x !== GROUND.x || at.y !== GROUND.y)).toBe(true)
      expect(h.rec.menus.length).toBeGreaterThan(1)
      expect(h.pi.epoch).toBeGreaterThan(20)
      rare.menuCancels += h.rec.closeMenus
      rare.heldCancels += h.rec.logs.filter((line) => line.includes('let the pet go where it is drawn')).length
      rare.seeds++
    })
  }

  it('reached a cancel of an open menu and of a held pet across the seeds', () => {
    expect(rare.seeds).toBe(4)
    expect(rare.menuCancels).toBeGreaterThan(0)
    expect(rare.heldCancels).toBeGreaterThan(0)
  })
})
