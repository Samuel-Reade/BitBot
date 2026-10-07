// Shared types used by main, preload and renderers.
// Phase 2+ fields exist here so later phases are additive (see BITBOT_SPEC.md §6.5, §16).

export type PaletteId = 'mint' | 'peach' | 'lilac' | 'lemon' | 'graphite' | 'beige'

export interface Palette {
  id: PaletteId
  name: string
  primary: string
  secondary: string
  outline: string
  accent: string
  screenGlow: string
}

export type PetSize = 'S' | 'M' | 'L'

export type FormId = 'base' | 'typist' | 'navigator' | 'hopper' | 'keeper'

export const ATTACH_POINTS = [
  'head_top',
  'head_side_L',
  'head_side_R',
  'face_screen',
  'back_casing',
  'antenna_tip',
  'hand_L',
  'hand_R',
  'belly',
  'foot_L',
  'foot_R',
] as const
export type AttachPoint = (typeof ATTACH_POINTS)[number]

/** Parts of the base rig (§6.1). Phase 2 forms swap or add parts (e.g. 'keycapFingers', 'cableTail'). */
export type PartId =
  | 'body'
  | 'rearCasing'
  | 'sideVents'
  | 'bezel'
  | 'screen'
  | 'bellyLights'
  | 'bellyKeys'
  | 'antenna'
  | 'arms'
  | 'feet'
  | 'contactShadow'

export interface CharacterSpec {
  formId: FormId
  palette: Palette
  /** Parts to build, in order. The base form uses BASE_PARTS. */
  parts: readonly PartId[]
}

export const BASE_PARTS: readonly PartId[] = [
  'body',
  'rearCasing',
  'sideVents',
  'bezel',
  'screen',
  'bellyLights',
  'bellyKeys',
  'antenna',
  'arms',
  'feet',
  'contactShadow',
]

export type Currency = 'crumbs' | 'pellets' | 'treats' | 'mileage' | 'sparks'
export type Price = Partial<Record<Currency, number>>
