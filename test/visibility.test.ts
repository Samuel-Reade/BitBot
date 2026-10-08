import { describe, expect, it } from 'vitest'
import { PetVisibility } from '../src/main/visibility'

// Whether the pet is shown (src/main/visibility.ts, BITBOT_SPEC.md §8.6): the reasons, kept apart, and the fade.

describe('PetVisibility', () => {
  it('starts shown; the user’s hide and show are instant', () => {
    const v = new PetVisibility({ hideInFullscreen: true })
    expect(v.shown).toBe(true)
    expect(v.userShown).toBe(true)
    expect(v.reasons()).toEqual([])
    expect(v.set('user', true)).toEqual({ shown: false, fade: false })
    expect(v.userShown).toBe(false)
    expect(v.reasons()).toEqual(['user'])
    expect(v.set('user', true)).toBeNull()
    expect(v.set('user', false)).toEqual({ shown: true, fade: false })
  })

  it('a fullscreen app and the locked screen fade it out and back in', () => {
    const v = new PetVisibility({ hideInFullscreen: true })
    expect(v.set('fullscreen', true)).toEqual({ shown: false, fade: true })
    expect(v.userShown).toBe(true) // the tray still says "Hide Bitbot"
    expect(v.set('fullscreen', false)).toEqual({ shown: true, fade: true })
    expect(v.set('locked', true)).toEqual({ shown: false, fade: true })
    expect(v.set('locked', false)).toEqual({ shown: true, fade: true })
  })

  it('macOS hiding Bitbot is instant', () => {
    const v = new PetVisibility({ hideInFullscreen: true })
    expect(v.set('macHidden', true)).toEqual({ shown: false, fade: false })
    expect(v.userShown).toBe(false)
    expect(v.set('macHidden', false)).toEqual({ shown: true, fade: false })
  })

  it('unlocking while the user had hidden it keeps it hidden (no change at all)', () => {
    const v = new PetVisibility({ hideInFullscreen: true })
    v.set('user', true)
    expect(v.set('locked', true)).toBeNull()
    expect(v.reasons()).toEqual(['user', 'locked'])
    expect(v.set('locked', false)).toBeNull()
    expect(v.shown).toBe(false)
    expect(v.set('user', false)).toEqual({ shown: true, fade: false })
  })

  it('"Show Bitbot" while a fullscreen app is in front: not over it; it fades in when the app goes', () => {
    const v = new PetVisibility({ hideInFullscreen: true })
    v.set('user', true)
    expect(v.set('fullscreen', true)).toBeNull()
    expect(v.set('user', false)).toBeNull()
    expect(v.userShown).toBe(true)
    expect(v.shown).toBe(false)
    expect(v.set('fullscreen', false)).toEqual({ shown: true, fade: true })
  })

  it('the user’s hide while fullscreen hid it: nothing changes now, it stays hidden after', () => {
    const v = new PetVisibility({ hideInFullscreen: true })
    v.set('fullscreen', true)
    expect(v.set('user', true)).toBeNull()
    expect(v.set('fullscreen', false)).toBeNull()
    expect(v.shown).toBe(false)
    expect(v.reasons()).toEqual(['user'])
  })

  it('locked and fullscreen together: shown only once both have ended', () => {
    const v = new PetVisibility({ hideInFullscreen: true })
    v.set('fullscreen', true)
    expect(v.set('locked', true)).toBeNull()
    expect(v.set('fullscreen', false)).toBeNull()
    expect(v.set('locked', false)).toEqual({ shown: true, fade: true })
  })

  it('hide in fullscreen off: a fullscreen app doesn’t hide it; the toggle applies live, with the fade', () => {
    const v = new PetVisibility({ hideInFullscreen: false })
    expect(v.set('fullscreen', true)).toBeNull()
    expect(v.shown).toBe(true)
    expect(v.has('fullscreen')).toBe(false)
    expect(v.setHideInFullscreen(true)).toEqual({ shown: false, fade: true })
    expect(v.has('fullscreen')).toBe(true)
    expect(v.setHideInFullscreen(true)).toBeNull()
    expect(v.setHideInFullscreen(false)).toEqual({ shown: true, fade: true })
    // No fullscreen app: the toggle changes nothing visible.
    v.set('fullscreen', false)
    expect(v.setHideInFullscreen(true)).toBeNull()
    // Toggled while the user hides it: no change.
    v.set('user', true)
    v.set('fullscreen', true)
    expect(v.setHideInFullscreen(false)).toBeNull()
    expect(v.setHideInFullscreen(true)).toBeNull()
  })
})
