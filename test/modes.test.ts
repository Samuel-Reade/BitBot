import { describe, expect, it } from 'vitest'
import { ModeState, screenSpotName, type SpotLookup } from '../src/main/sim/modes'
import type { PetArea } from '../src/shared/geometry'

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
