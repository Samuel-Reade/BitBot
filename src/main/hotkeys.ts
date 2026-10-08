// Global hotkeys (BITBOT_SPEC.md §10.5; default bindings in src/shared/hotkeys.ts). Registers the actions it is given
// with Electron's globalShortcut (injected as a ShortcutRegistry, so this is unit-tested), remembers exactly what it
// registered, and reports what failed (another app owns the shortcut, or the accelerator is invalid) so the caller can
// log it now and show it in settings (M8). M1 registers only toggleVisible.
// M8 (the settings window, §15.4): rebind() moves one action to a new combination at runtime: another Bitbot action's
// combination is refused; otherwise the old one is unregistered and the new one registered, and if the new one fails
// (another app owns it) the old one is registered again and kept. bindings() is what to save (settings.hotkeys, §16);
// statuses() what settings shows (each binding and whether it is registered).

import { formatAccelerator, normalizeAccelerator, sameAccelerator } from '../shared/accelerator'
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, type HotkeyAction } from '../shared/hotkeys'
import { HOTKEY_LABELS } from '../shared/settingsProtocol'

/** The part of Electron's globalShortcut this uses. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface HotkeyRegistration {
  registered: HotkeyAction[]
  failed: HotkeyAction[]
}

/**
 * What rebind() did. Not ok: 'invalid' (not a combination Bitbot accepts), 'conflict' (another Bitbot action has it:
 * conflictsWith), 'taken' (the registry refused it, e.g. another app owns it; the old binding stays), 'noHandler' (the
 * action was never registered, so there is nothing to bind).
 */
export type RebindResult =
  | { ok: true; accelerator: string }
  | { ok: false; reason: 'invalid' | 'taken' | 'noHandler'; accelerator: string }
  | { ok: false; reason: 'conflict'; accelerator: string; conflictsWith: HotkeyAction }

/** One action's binding and whether it is registered now. */
export interface HotkeyStatus {
  accelerator: string
  registered: boolean
}

export class Hotkeys {
  /** What this instance registered: action → accelerator. */
  private readonly active = new Map<HotkeyAction, string>()
  /** Each action's binding, registered or not (starts as the constructor's; rebind() changes it). */
  private readonly wanted: Record<HotkeyAction, string>
  /** The handlers given to register(), for rebind(). */
  private readonly handlers = new Map<HotkeyAction, () => void>()

  constructor(
    private readonly registry: ShortcutRegistry,
    accelerators: Readonly<Record<HotkeyAction, string>> = DEFAULT_HOTKEYS,
  ) {
    this.wanted = { ...accelerators }
  }

  /**
   * Registers each action that has a handler (others are left alone). A registry that returns false or throws counts as
   * failed. Registering an action again replaces this instance's own binding of it.
   */
  register(handlers: Partial<Record<HotkeyAction, () => void>>): HotkeyRegistration {
    const result: HotkeyRegistration = { registered: [], failed: [] }
    for (const action of HOTKEY_ACTIONS) {
      const handler = handlers[action]
      if (!handler) continue
      this.handlers.set(action, handler)
      this.release(action)
      if (this.bind(action, this.wanted[action])) result.registered.push(action)
      else result.failed.push(action)
    }
    return result
  }

  /** Moves `action` to `accelerator` (see the header). */
  rebind(action: HotkeyAction, accelerator: string): RebindResult {
    const next = normalizeAccelerator(accelerator)
    if (next === null) return { ok: false, reason: 'invalid', accelerator }
    const other = HOTKEY_ACTIONS.find((a) => a !== action && sameAccelerator(this.wanted[a], next))
    if (other !== undefined) return { ok: false, reason: 'conflict', accelerator: next, conflictsWith: other }
    if (!this.handlers.has(action)) return { ok: false, reason: 'noHandler', accelerator: next }
    const current = this.active.get(action)
    if (current !== undefined && sameAccelerator(current, next)) {
      this.wanted[action] = current
      return { ok: true, accelerator: current }
    }
    this.release(action)
    if (this.bind(action, next)) {
      this.wanted[action] = next
      return { ok: true, accelerator: next }
    }
    if (current !== undefined) this.bind(action, current)
    return { ok: false, reason: 'taken', accelerator: next }
  }

  /** Each action's binding, registered or not (what to save as settings.hotkeys). */
  bindings(): Record<HotkeyAction, string> {
    return { ...this.wanted }
  }

  /** Each action's binding and whether it is registered now (what settings shows, §10.5 "surface that in settings"). */
  statuses(): Record<HotkeyAction, HotkeyStatus> {
    const out = {} as Record<HotkeyAction, HotkeyStatus>
    for (const action of HOTKEY_ACTIONS) out[action] = { accelerator: this.wanted[action], registered: this.active.has(action) }
    return out
  }

  /** Unregisters only what this instance registered. */
  unregisterAll(): void {
    for (const action of [...this.active.keys()]) this.release(action)
  }

  /** The accelerator of a registered action (for menus); null when it isn't registered. */
  accelerator(action: HotkeyAction): string | null {
    return this.active.get(action) ?? null
  }

  /** Registers `action`'s handler at `accelerator`; false (nothing registered) if the registry refuses or throws. */
  private bind(action: HotkeyAction, accelerator: string): boolean {
    const handler = this.handlers.get(action)
    if (!handler || typeof accelerator !== 'string' || accelerator === '') return false
    let ok = false
    try {
      ok = this.registry.register(accelerator, () => handler()) === true
    } catch {
      ok = false
    }
    if (ok) this.active.set(action, accelerator)
    return ok
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

/**
 * What the settings page says after a rebind that didn't go as asked (null: it did). `after`: the action's status after
 * the rebind (statuses()[action]).
 */
export function rebindNotice(action: HotkeyAction, result: RebindResult, after: HotkeyStatus): string | null {
  if (result.ok) return null
  const keys = formatAccelerator(result.accelerator)
  const label = HOTKEY_LABELS[action]
  switch (result.reason) {
    case 'conflict':
      return `${keys} is already Bitbot’s “${HOTKEY_LABELS[result.conflictsWith]}” hotkey. Pick another, or change that one first.`
    case 'taken':
      return after.registered
        ? `${keys} is in use by another app or by macOS, so “${label}” stays on ${formatAccelerator(after.accelerator)}.`
        : `${keys} is in use by another app or by macOS. “${label}” has no working hotkey yet: try another combination.`
    case 'invalid':
      return `${keys} can’t be used as a hotkey.`
    case 'noHandler':
      return `“${label}” can’t be changed right now.`
  }
}
