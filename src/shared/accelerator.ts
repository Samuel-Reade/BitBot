// Global hotkey combinations (BITBOT_SPEC.md §10.5, rebound in the settings window §15.4) as Electron accelerator
// strings ("Alt+Command+S"). Pure; shared by the settings page (recording) and main (validating what the page sends).
// - acceleratorFromKey: the settings page's recorder turns one keydown into an accelerator, only while the user is
//   recording a hotkey (§2: no key is logged or kept; the page holds the result only to send it as the new binding).
//   The key comes from KeyboardEvent.code (the physical key: 'KeyS'), not .key, so ⌥S records as S rather than 'ß'.
//   A combination needs ⌘, ⌥ or ⌃ (⇧ alone is not enough: ⇧S is typing) plus one ordinary key; bare modifiers mean
//   "keep holding" (incomplete).
// - normalizeAccelerator / isAccelerator: one canonical spelling (modifiers ⌃⌥⇧⌘ order as Control, Alt, Shift,
//   Command; aliases such as Cmd, Option, CommandOrControl folded in), so two spellings of one combination compare
//   equal (sameAccelerator) and main accepts only combinations the recorder could have made.
// - formatAccelerator: the macOS way to show it ("⌥⌘S").

/** What acceleratorFromKey needs from a KeyboardEvent. */
export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

export type KeyResult =
  | { kind: 'ok'; accelerator: string }
  /** Only modifiers so far: keep listening. */
  | { kind: 'incomplete' }
  /** Not usable as a hotkey; `reason` is for the user. */
  | { kind: 'rejected'; reason: string }

/** Canonical modifier names, in the order they are written (and shown: ⌃⌥⇧⌘). */
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Command'] as const
type Modifier = (typeof MODIFIERS)[number]

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  command: 'Command',
  cmd: 'Command',
  // macOS: CommandOrControl is Command.
  commandorcontrol: 'Command',
  cmdorctrl: 'Command',
}

const MODIFIER_SYMBOLS: Readonly<Record<Modifier, string>> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' }

/** KeyboardEvent.code → the accelerator's key, for the keys a hotkey may use. */
const CODE_KEYS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {}
  for (let c = 65; c <= 90; c++) out[`Key${String.fromCharCode(c)}`] = String.fromCharCode(c)
  for (let d = 0; d <= 9; d++) {
    out[`Digit${d}`] = String(d)
    out[`Numpad${d}`] = `num${d}`
  }
  for (let f = 1; f <= 20; f++) out[`F${f}`] = `F${f}`
  Object.assign(out, {
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Return',
    NumpadEnter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
  })
  return out
})()

/** Every accelerator key this accepts, lower-cased → canonical. */
const KEYS: ReadonlyMap<string, string> = new Map(Object.values(CODE_KEYS).map((k) => [k.toLowerCase(), k]))
/** Electron's alternative spellings of some keys. */
const KEY_ALIASES: Readonly<Record<string, string>> = { enter: 'Return', esc: 'Escape', up: 'Up', down: 'Down', left: 'Left', right: 'Right' }

const KEY_SYMBOLS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Tab: '⇥',
  Return: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Home: '↖',
  End: '↘',
  PageUp: '⇞',
  PageDown: '⇟',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  numadd: 'Keypad +',
  numsub: 'Keypad −',
  nummult: 'Keypad ×',
  numdiv: 'Keypad ÷',
  numdec: 'Keypad .',
}

const MODIFIER_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'CapsLock',
  'Fn',
  'FnLock',
])

const NEEDS_MODIFIER = 'Add ⌘, ⌥ or ⌃ to the key: on its own (or with only ⇧) it is typing.'

function join(mods: ReadonlySet<Modifier>, key: string): string {
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+')
}

/** The settings page's recorder: one keydown → an accelerator (see the header). */
export function acceleratorFromKey(e: KeyLike): KeyResult {
  if (MODIFIER_CODES.has(e.code) || ['Meta', 'Alt', 'Control', 'Shift', 'CapsLock', 'Fn'].includes(e.key)) return { kind: 'incomplete' }
  const key = CODE_KEYS[e.code]
  if (key === undefined) return { kind: 'rejected', reason: 'That key can’t be used for a hotkey. Try a letter, number or function key.' }
  const mods = new Set<Modifier>()
  if (e.ctrlKey) mods.add('Control')
  if (e.altKey) mods.add('Alt')
  if (e.shiftKey) mods.add('Shift')
  if (e.metaKey) mods.add('Command')
  if (!mods.has('Control') && !mods.has('Alt') && !mods.has('Command')) return { kind: 'rejected', reason: NEEDS_MODIFIER }
  return { kind: 'ok', accelerator: join(mods, key) }
}

/** The canonical spelling of an accelerator this app accepts (see the header); null when it isn't one. */
export function normalizeAccelerator(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null
  const parts = value.split('+')
  const keyPart = parts.pop()
  if (keyPart === undefined) return null
  const lower = keyPart.toLowerCase()
  const key = KEYS.get(lower) ?? KEY_ALIASES[lower]
  if (key === undefined || key === 'Escape') return null
  const mods = new Set<Modifier>()
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    if (mod === undefined || mods.has(mod)) return null
    mods.add(mod)
  }
  if (!mods.has('Control') && !mods.has('Alt') && !mods.has('Command')) return null
  return join(mods, key)
}

export function isAccelerator(value: unknown): value is string {
  return normalizeAccelerator(value) !== null
}

/** Whether two accelerators are the same combination (spelling and order aside); false if either isn't one. */
export function sameAccelerator(a: unknown, b: unknown): boolean {
  const na = normalizeAccelerator(a)
  return na !== null && na === normalizeAccelerator(b)
}

/** The macOS way to show an accelerator: "Alt+Command+S" → "⌥⌘S". Anything unrecognised is shown as it is. */
export function formatAccelerator(accelerator: string): string {
  const normal = normalizeAccelerator(accelerator)
  if (normal === null) return accelerator
  const parts = normal.split('+')
  const key = parts.pop() ?? ''
  const mods = parts.map((p) => MODIFIER_SYMBOLS[p as Modifier]).join('')
  const shown = KEY_SYMBOLS[key] ?? (/^num\d$/.test(key) ? `Keypad ${key.slice(3)}` : key)
  return `${mods}${shown}`
}
