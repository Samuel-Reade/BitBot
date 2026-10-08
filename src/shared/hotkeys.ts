// Global hotkeys (BITBOT_SPEC.md §10.5): actions and their default bindings, in Electron accelerator syntax.
// Settings (M8) make them rebindable and save them in `settings.hotkeys` (§16). M1 registers only toggleVisible.

export const HOTKEY_ACTIONS = ['toggleVisible', 'comeHere', 'goHome', 'toggleStay'] as const
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]

export const DEFAULT_HOTKEYS: Readonly<Record<HotkeyAction, string>> = {
  /** Show / hide Bitbot: ⌥⌘B */
  toggleVisible: 'Alt+Command+B',
  /** Come here: ⌥⌘C (M4) */
  comeHere: 'Alt+Command+C',
  /** Go home: ⌥⌘H (M4) */
  goHome: 'Alt+Command+H',
  /** Toggle Stay / previous mode: ⌥⌘S (M7) */
  toggleStay: 'Alt+Command+S',
}
