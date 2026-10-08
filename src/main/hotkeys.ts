// Global hotkeys (BITBOT_SPEC.md §10.5; default bindings in src/shared/hotkeys.ts). Registers the actions it is given
// with Electron's globalShortcut (injected as a ShortcutRegistry, so this is unit-tested), remembers exactly what it
// registered, and reports what failed (another app owns the shortcut, or the accelerator is invalid) so the caller can
// log it now and show it in settings (M8). M1 registers only toggleVisible.

import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, type HotkeyAction } from '../shared/hotkeys'

/** The part of Electron's globalShortcut this uses. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface HotkeyRegistration {
  registered: HotkeyAction[]
  failed: HotkeyAction[]
}

export class Hotkeys {
  /** What this instance registered: action → accelerator. */
  private readonly active = new Map<HotkeyAction, string>()

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly accelerators: Readonly<Record<HotkeyAction, string>> = DEFAULT_HOTKEYS,
  ) {}

  /**
   * Registers each action that has a handler (others are left alone). A registry that returns false or throws counts as
   * failed. Registering an action again replaces this instance's own binding of it.
   */
  register(handlers: Partial<Record<HotkeyAction, () => void>>): HotkeyRegistration {
    const result: HotkeyRegistration = { registered: [], failed: [] }
    for (const action of HOTKEY_ACTIONS) {
      const handler = handlers[action]
      if (!handler) continue
      this.release(action)
      const accelerator = this.accelerators[action]
      let ok = false
      try {
        ok = typeof accelerator === 'string' && accelerator !== '' && this.registry.register(accelerator, () => handler()) === true
      } catch {
        ok = false
      }
      if (ok) {
        this.active.set(action, accelerator)
        result.registered.push(action)
      } else {
        result.failed.push(action)
      }
    }
    return result
  }

  /** Unregisters only what this instance registered. */
  unregisterAll(): void {
    for (const action of [...this.active.keys()]) this.release(action)
  }

  /** The accelerator of a registered action (for menus); null when it isn't registered. */
  accelerator(action: HotkeyAction): string | null {
    return this.active.get(action) ?? null
  }

  private release(action: HotkeyAction): void {
    const accelerator = this.active.get(action)
    if (accelerator === undefined) return
    this.active.delete(action)
    try {
      this.registry.unregister(accelerator)
    } catch {
      // Already gone (e.g. the app is quitting): nothing left to undo.
    }
  }
}
