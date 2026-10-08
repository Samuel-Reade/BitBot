import { describe, expect, it } from 'vitest'
import { subtractRanges, visibleSidePieces, visibleTopPieces } from '../src/main/sim/world/geometry'
import type { Rect } from '../src/shared/geometry'

// Visible pieces of window edges under occlusion (BITBOT_SPEC.md §8.3, §14.2 geometry).

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })
const TOL = 2

describe('subtractRanges', () => {
  it('leaves the base whole without cuts', () => {
    expect(subtractRanges({ lo: 0, hi: 100 }, [])).toEqual([{ lo: 0, hi: 100 }])
  })

  it('splits around a cut inside it', () => {
    expect(subtractRanges({ lo: 0, hi: 100 }, [{ lo: 40, hi: 60 }])).toEqual([
      { lo: 0, hi: 40 },
      { lo: 60, hi: 100 },
    ])
  })

  it('trims cuts that overlap an end', () => {
    expect(subtractRanges({ lo: 0, hi: 100 }, [{ lo: -10, hi: 20 }, { lo: 90, hi: 150 }])).toEqual([{ lo: 20, hi: 90 }])
  })

  it('a cover leaves nothing; overlapping cuts act as their union', () => {
    expect(subtractRanges({ lo: 0, hi: 100 }, [{ lo: -1, hi: 101 }])).toEqual([])
    expect(subtractRanges({ lo: 0, hi: 100 }, [{ lo: 10, hi: 50 }, { lo: 30, hi: 70 }])).toEqual([
      { lo: 0, hi: 10 },
      { lo: 70, hi: 100 },
    ])
  })

  it('cuts that only touch an end, or are empty, remove nothing', () => {
    expect(subtractRanges({ lo: 0, hi: 100 }, [{ lo: -50, hi: 0 }, { lo: 100, hi: 120 }, { lo: 50, hi: 50 }])).toEqual([
      { lo: 0, hi: 100 },
    ])
  })

  it('an empty base stays empty', () => {
    expect(subtractRanges({ lo: 10, hi: 5 }, [])).toEqual([])
  })
})

describe('visibleTopPieces', () => {
  const W = r(100, 300, 600, 400) // top edge y 300, x 100..700

  it('no window in front: the whole top', () => {
    expect(visibleTopPieces(W, [], TOL, 50)).toEqual([{ lo: 100, hi: 700 }])
  })

  it('a window in front over the middle of the top splits it', () => {
    expect(visibleTopPieces(W, [r(300, 200, 200, 300)], TOL, 50)).toEqual([
      { lo: 100, hi: 300 },
      { lo: 500, hi: 700 },
    ])
  })

  it('overlapping windows in front remove their union', () => {
    expect(visibleTopPieces(W, [r(200, 250, 200, 100), r(350, 280, 200, 100)], TOL, 50)).toEqual([
      { lo: 100, hi: 200 },
      { lo: 550, hi: 700 },
    ])
  })

  it('fully covered: nothing', () => {
    expect(visibleTopPieces(W, [r(50, 100, 800, 800)], TOL, 50)).toEqual([])
  })

  it('a window nested inside it (in front, below its top) hides nothing of the top', () => {
    expect(visibleTopPieces(W, [r(200, 400, 200, 100)], TOL, 50)).toEqual([{ lo: 100, hi: 700 }])
  })

  it('a window in front entirely above the top hides nothing; one whose bottom reaches the top within tolerance does', () => {
    expect(visibleTopPieces(W, [r(200, 100, 200, 197)], TOL, 50)).toEqual([{ lo: 100, hi: 700 }]) // bottom 297: 3 pt clear
    expect(visibleTopPieces(W, [r(200, 100, 200, 198)], TOL, 50)).toEqual([
      { lo: 100, hi: 200 },
      { lo: 400, hi: 700 },
    ]) // bottom 298: within 2 pt
  })

  it('a window in front whose top lies just below the edge (within tolerance) covers it; further below does not', () => {
    expect(visibleTopPieces(W, [r(200, 302, 200, 100)], TOL, 50)).toEqual([
      { lo: 100, hi: 200 },
      { lo: 400, hi: 700 },
    ])
    expect(visibleTopPieces(W, [r(200, 303, 200, 100)], TOL, 50)).toEqual([{ lo: 100, hi: 700 }])
  })

  it('windows touching the top at its ends (sharing an x) leave it whole', () => {
    expect(visibleTopPieces(W, [r(0, 200, 100, 300), r(700, 200, 100, 300)], TOL, 50)).toEqual([{ lo: 100, hi: 700 }])
  })

  it('drops pieces shorter than the minimum, keeps those exactly as long', () => {
    // Pieces 100..140 (40) and 660..700 (40), and the middle 300..400 (100).
    const inFront = [r(140, 200, 160, 200), r(400, 200, 260, 200)]
    expect(visibleTopPieces(W, inFront, TOL, 50)).toEqual([{ lo: 300, hi: 400 }])
    expect(visibleTopPieces(W, inFront, TOL, 40)).toEqual([
      { lo: 100, hi: 140 },
      { lo: 300, hi: 400 },
      { lo: 660, hi: 700 },
    ])
  })
})

describe('visibleSidePieces', () => {
  const W = r(100, 300, 600, 400) // left side x 100, right side x 700, y 300..700

  it('no window in front: both sides whole', () => {
    expect(visibleSidePieces(W, 'left', [], TOL, 50)).toEqual([{ lo: 300, hi: 700 }])
    expect(visibleSidePieces(W, 'right', [], TOL, 50)).toEqual([{ lo: 300, hi: 700 }])
  })

  it('a window in front over the left side splits it; the right side is untouched', () => {
    const inFront = [r(50, 400, 200, 100)]
    expect(visibleSidePieces(W, 'left', inFront, TOL, 50)).toEqual([
      { lo: 300, hi: 400 },
      { lo: 500, hi: 700 },
    ])
    expect(visibleSidePieces(W, 'right', inFront, TOL, 50)).toEqual([{ lo: 300, hi: 700 }])
  })

  it('tolerance: a window in front ending within 2 pt of the side covers it, 3 pt short does not', () => {
    expect(visibleSidePieces(W, 'right', [r(702, 400, 100, 100)], TOL, 50)).toEqual([
      { lo: 300, hi: 400 },
      { lo: 500, hi: 700 },
    ])
    expect(visibleSidePieces(W, 'right', [r(703, 400, 100, 100)], TOL, 50)).toEqual([{ lo: 300, hi: 700 }])
  })

  it('fully covered, nested and touching windows', () => {
    expect(visibleSidePieces(W, 'left', [r(0, 0, 300, 1000)], TOL, 50)).toEqual([])
    expect(visibleSidePieces(W, 'left', [r(200, 350, 100, 100)], TOL, 50)).toEqual([{ lo: 300, hi: 700 }])
    expect(visibleSidePieces(W, 'left', [r(0, 200, 300, 100), r(0, 700, 300, 50)], TOL, 50)).toEqual([
      { lo: 300, hi: 700 },
    ])
  })

  it('drops short pieces', () => {
    expect(visibleSidePieces(W, 'left', [r(0, 330, 300, 340)], TOL, 50)).toEqual([])
    expect(visibleSidePieces(W, 'left', [r(0, 330, 300, 340)], TOL, 30)).toEqual([
      { lo: 300, hi: 330 },
      { lo: 670, hi: 700 },
    ])
  })
})
