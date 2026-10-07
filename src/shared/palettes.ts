import type { Palette, PaletteId } from './types'

// §6.2 — the six palettes offered at hatch. Mint is the default and matches the concept render.
export const PALETTES: Readonly<Record<PaletteId, Palette>> = {
  mint: {
    id: 'mint',
    name: 'Mint',
    primary: '#7FD1C7',
    secondary: '#5FB8AD',
    outline: '#2C5F5A',
    accent: '#F2A65A',
    screenGlow: '#9BF2D8',
  },
  peach: {
    id: 'peach',
    name: 'Peach',
    primary: '#F4B49A',
    secondary: '#E2957A',
    outline: '#6B3A2C',
    accent: '#7FD1C7',
    screenGlow: '#FFE2B8',
  },
  lilac: {
    id: 'lilac',
    name: 'Lilac',
    primary: '#B9A8EC',
    secondary: '#9C88DC',
    outline: '#3F3474',
    accent: '#F2D25A',
    screenGlow: '#E3DBFF',
  },
  lemon: {
    id: 'lemon',
    name: 'Lemon',
    primary: '#F2D76B',
    secondary: '#DDBE4A',
    outline: '#5E4A12',
    accent: '#6BB6F2',
    screenGlow: '#FFF4B0',
  },
  graphite: {
    id: 'graphite',
    name: 'Graphite',
    primary: '#8A8F98',
    secondary: '#6D727B',
    outline: '#25282D',
    accent: '#F25A7A',
    screenGlow: '#B8F2C8',
  },
  beige: {
    id: 'beige',
    name: 'Beige Classic',
    primary: '#E4DCC8',
    secondary: '#CFC5AD',
    outline: '#5C5446',
    accent: '#5AA0F2',
    screenGlow: '#A8F0A0',
  },
}

export const DEFAULT_PALETTE_ID: PaletteId = 'mint'

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && Object.hasOwn(PALETTES, value)
}
