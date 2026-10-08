import { describe, expect, it } from 'vitest'
import { ModeState, screenSpotName, type SpotLookup } from '../src/main/sim/modes'
import type { PetArea } from '../src/shared/geometry'
import { tuning } from '../src/shared/tuning'

// The pet's mode and hangout spots (src/main/sim/modes.ts): §10.3 modes, spots, ⌥⌘S, Go home.

const AREA: PetArea = { minX: 50, maxX: 1660, minY: 147, groundY: 1022 }
const HOME = { x: 855, y: 1022 }

function lookup(appWindows: Record<string, { x: number; y: number; width: number } | undefined> = {}): SpotLookup {
  return {
    appSpot: (bundleId, relativeX) => {
      const w = appWindows[bundleId]
      return w ? { x: w.x + relativeX * w.width, y: w.y } : null
    },
    defaultHome: HOME,
  }
}

describe('ModeState', () => {
  it('starts in Roam with no spots', () => {
    const m = new ModeState()
    expect(m.mode).toBe('roam')
    expect(m.spots).toEqual([])
    expect(m.home(lookup())).toEqual(HOME)
  })

  it('⌥⌘S toggles Stay and back to the mode before it (§10.5)', () => {
    const m = new ModeState()
    m.toggleStay({ x: 300, y: 1022 })
    expect(m.mode).toBe('stay')
    expect(m.settings.stayPoint).toEqual({ x: 300, y: 1022 })
    m.toggleStay()
    expect(m.mode).toBe('roam')
    m.hangOutHere({ x: 200, y: 1022 }, 1, AREA)
    m.toggleStay()
    m.toggleStay()
    expect(m.mode).toBe('hangout')
  })

  it('Stay remembers the drop point (§10.4); outside Stay, drops change nothing', () => {
    const m = new ModeState()
    m.stayAt({ x: 1, y: 2 })
    expect(m.settings.stayPoint).toBeNull()
    m.setMode('stay')
    m.stayAt({ x: 400, y: 700 })
    expect(m.settings.stayPoint).toEqual({ x: 400, y: 700 })
  })

  it('"Hang out here" makes a named screen spot, active, in Hangout; the same place twice is one spot', () => {
    const m = new ModeState()
    const a = m.hangOutHere({ x: 200, y: 1022 }, 1, AREA)
    expect(a).toMatchObject({ kind: 'screen', name: 'Dock, left side', x: 200, y: 1022 })
    expect(m.mode).toBe('hangout')
    expect(m.active?.id).toBe(a.id)
    const again = m.hangOutHere({ x: 210, y: 1022 }, 1, AREA)
    expect(again.id).toBe(a.id)
    const b = m.hangOutHere({ x: 260, y: 1022 }, 1, AREA)
    expect(b.name).toBe('Dock, left side 2')
    expect(m.spots).toHaveLength(2)
  })

  it('"Hang out on <App>": one spot per app, following its window; away, the fallback or the default home', () => {
    const m = new ModeState()
    const spot = m.hangOutOnApp('com.apple.Notes', 'Notes', 0.25)
    expect(spot).toMatchObject({ kind: 'app', name: 'On Notes', relativeX: 0.25 })
    expect(m.spotPoint(spot, lookup({ 'com.apple.Notes': { x: 400, y: 300, width: 800 } }))).toEqual({ point: { x: 600, y: 300 }, fallback: false })
    // The window moved: the spot follows.
    expect(m.spotPoint(spot, lookup({ 'com.apple.Notes': { x: 500, y: 200, width: 800 } })).point).toEqual({ x: 700, y: 200 })
    // No window: the default home.
    expect(m.spotPoint(spot, lookup())).toEqual({ point: HOME, fallback: true })
    // Choosing it again moves it along the top.
    expect(m.hangOutOnApp('com.apple.Notes', 'Notes', 0.75).id).toBe(spot.id)
    expect(m.spots).toHaveLength(1)
    expect(m.home(lookup({ 'com.apple.Notes': { x: 400, y: 300, width: 800 } }))).toEqual({ x: 1000, y: 300 })
  })

  it('selecting and forgetting spots; forgetting the active one goes back to Roam', () => {
    const m = new ModeState()
    const a = m.hangOutHere({ x: 200, y: 1022 }, 1, AREA)
    const b = m.hangOutOnApp('com.apple.Notes', 'Notes', 0.5)
    expect(m.selectSpot(a.id)).toBe(true)
    expect(m.active?.id).toBe(a.id)
    expect(m.selectSpot('nope')).toBe(false)
    m.forgetSpot(a.id)
    expect(m.mode).toBe('roam')
    expect(m.spots.map((s) => s.id)).toEqual([b.id])
  })

  it('round-trips its settings (M8 saves them); a saved Hangout without its spot starts in Roam', () => {
    const m = new ModeState()
    m.hangOutHere({ x: 200, y: 1022 }, 1, AREA)
    const copy = new ModeState(m.settings)
    expect(copy.settings).toEqual(m.settings)
    const next = copy.hangOutHere({ x: 1500, y: 1022 }, 1, AREA)
    expect(next.id).not.toBe(m.spots[0]?.id) // ids keep counting up
    const broken = new ModeState({ ...m.settings, activeHangoutId: 'gone' })
    expect(broken.mode).toBe('roam')
  })
})

describe('ModeState settings (§15.4, M8)', () => {
  it('renames a spot: trimmed, 1–tuning.settingsWindow.spotNameMax characters; false for a bad name or no such spot', () => {
    const m = new ModeState()
    const a = m.hangOutHere({ x: 200, y: 1022 }, 1, AREA)
    expect(m.renameSpot(a.id, '  Desk corner  ')).toBe(true)
    expect(m.spots[0]?.name).toBe('Desk corner')
    expect(m.settings.hangouts[0]?.name).toBe('Desk corner')
    expect(m.renameSpot(a.id, '   ')).toBe(false)
    expect(m.renameSpot(a.id, 'x'.repeat(tuning.settingsWindow.spotNameMax + 1))).toBe(false)
    expect(m.renameSpot(a.id, 'x'.repeat(tuning.settingsWindow.spotNameMax))).toBe(true)
    expect(m.renameSpot('nope', 'Fine')).toBe(false)
  })

  it('the default home is a screen spot or none; Go home and Reset position use it', () => {
    const m = new ModeState()
    const screen = m.hangOutHere({ x: 200, y: 1022 }, 1, AREA)
    const app = m.hangOutOnApp('com.apple.Notes', 'Notes', 0.5)
    m.setMode('roam')
    expect(m.setDefaultHome(app.id)).toBe(false) // an app spot falls back to the default home (§10.3)
    expect(m.setDefaultHome('nope')).toBe(false)
    expect(m.settings.defaultHomeId).toBeNull()
    expect(m.defaultHomePoint(lookup())).toEqual(HOME)
    expect(m.setDefaultHome(screen.id)).toBe(true)
    expect(m.defaultHomeSpot?.id).toBe(screen.id)
    expect(m.defaultHomePoint(lookup())).toEqual({ x: 200, y: 1022 })
    expect(m.home(lookup())).toEqual({ x: 200, y: 1022 })
    expect(m.setDefaultHome(null)).toBe(true)
    expect(m.home(lookup())).toEqual(HOME)
  })

  it('an app spot without its window and without a fallback goes to the default home spot (§10.3)', () => {
    const m = new ModeState()
    const screen = m.hangOutHere({ x: 300, y: 1022 }, 1, AREA)
    const app = m.hangOutOnApp('com.apple.Notes', 'Notes', 0.5)
    expect(m.spotPoint(app, lookup())).toEqual({ point: HOME, fallback: true })
    m.setDefaultHome(screen.id)
    expect(m.spotPoint(app, lookup())).toEqual({ point: { x: 300, y: 1022 }, fallback: true })
    expect(m.home(lookup())).toEqual({ x: 300, y: 1022 }) // Hangout on Notes, its window away
    expect(m.spotPoint(app, lookup({ 'com.apple.Notes': { x: 100, y: 400, width: 600 } }))).toEqual({ point: { x: 400, y: 400 }, fallback: false })
  })

  it('forgetting the default home spot goes back to the middle of the Dock', () => {
    const m = new ModeState()
    const screen = m.hangOutHere({ x: 300, y: 1022 }, 1, AREA)
    m.setDefaultHome(screen.id)
    m.forgetSpot(screen.id)
    expect(m.settings.defaultHomeId).toBeNull()
    expect(m.defaultHomePoint(lookup())).toEqual(HOME)
  })
})

describe('screenSpotName', () => {
  it('names the Dock by thirds and elsewhere by the area’s thirds', () => {
    expect(screenSpotName({ x: 100, y: 1022 }, AREA)).toBe('Dock, left side')
    expect(screenSpotName({ x: 855, y: 1022 }, AREA)).toBe('Dock, middle')
    expect(screenSpotName({ x: 1600, y: 1022 }, AREA)).toBe('Dock, right side')
    expect(screenSpotName({ x: 1600, y: 200 }, AREA)).toBe('Top-right')
    expect(screenSpotName({ x: 855, y: 580 }, AREA)).toBe('Middle')
    expect(screenSpotName({ x: 100, y: 900 }, AREA)).toBe('Bottom-left')
  })
})
