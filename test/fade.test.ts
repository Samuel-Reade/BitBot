import { describe, expect, it } from 'vitest'
import { visibilityStyle } from '../src/renderer/pet/fade'
import { tuning } from '../src/shared/tuning'

// The overlay page's show / hide fade (src/renderer/pet/fade.ts, BITBOT_SPEC.md §8.6).

describe('visibilityStyle', () => {
  const transition = `opacity ${tuning.overlay.fadeMs}ms ${tuning.overlay.fadeEasing}`

  it('fades out and in over fadeMs (fullscreen, the locked screen)', () => {
    expect(tuning.overlay.fadeMs).toBe(300) // §8.6
    expect(visibilityStyle(false, true, false)).toEqual({ transition, opacity: '0' })
    expect(visibilityStyle(true, true, false)).toEqual({ transition, opacity: '1' })
  })

  it('no fade (the user’s hide, macOS): at once', () => {
    expect(visibilityStyle(false, false, false)).toEqual({ transition: 'none', opacity: '0' })
    expect(visibilityStyle(true, false, false)).toEqual({ transition: 'none', opacity: '1' })
  })

  it('reduced motion: never fades', () => {
    expect(visibilityStyle(false, true, true)).toEqual({ transition: 'none', opacity: '0' })
    expect(visibilityStyle(true, true, true)).toEqual({ transition: 'none', opacity: '1' })
  })
})
