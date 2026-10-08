// First-launch onboarding (BITBOT_SPEC.md §15.1): its window, its IPC (messages in src/shared/onboarding.ts) and the
// step machine it runs (src/shared/onboardingFlow.ts); the page is src/renderer/onboarding/.
// - open() creates the window (content tuning.onboarding.window, not resizable, centred, "Welcome to Bitbot") and shows
//   and focuses it once its page is ready. It is an ordinary window and the one time Bitbot takes focus on its own (§2):
//   the app shows it on first launch only, right after the user launched the app. Open again: raised.
// - Main owns the flow; the page renders the OnboardingView pushed on onboarding:view (and fetched with
//   onboarding:state) and sends requests. Every message is accepted only from this window's own page and validated;
//   anything else is ignored and logged (throttled).
// - The permission step: "Allow Input Monitoring" asks macOS (requestInputAccess: the system prompt, the first time)
//   and opens System Settings' Input Monitoring pane, as the tray's "Turn on…" does. While that step is shown (and only
//   then) the grant is read every tuning.onboarding.permissionPollMs (inputGranted: the app's input tap counts, which
//   is what "granted" has to mean), which also drives the flow's auto-advance and its "Relaunch Bitbot" offer.
// - The end: onboarding:hatch (validated name and palette) starts the hatch; onboarding:finish (after the page's egg
//   animation) calls onFinish(identity) once, then the window closes itself. Closing the window during the hatch
//   counts as finishing (everything was chosen). Closing it earlier calls onClosedEarly(): the app keeps running with
//   the default identity and does not mark onboarding complete, so it shows again on the next launch. "Relaunch Bitbot"
//   calls relaunch() (the app saves, relaunches and exits) and is not a close-early.
// - destroy() (quit) closes the window without calling either, removes the IPC handlers and stops the poll.
// The class takes its Electron-free parts as injected dependencies (unit-tested with fakes in test/onboarding.test.ts).

import { BrowserWindow, ipcMain, type BrowserWindowConstructorOptions, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc'
import { parseOnboardingHatch, parseOnboardingNav, sameOnboardingView, type OnboardingView } from '../../shared/onboarding'
import { OnboardingFlow, type OnboardingStart } from '../../shared/onboardingFlow'
import { DEFAULT_IDENTITY, type PetIdentity } from '../../shared/settings'
import { tuning } from '../../shared/tuning'
import { loadPage, preloadPath } from '../pages'

export interface OnboardingDeps {
  /** Asks macOS for Input Monitoring (the system prompt shows once, the first time): helper.requestInputAccess(). */
  requestInputAccess(): Promise<void>
  /** Is Input Monitoring granted and counting now (inputTap.isCounting)? Cheap: read every poll. */
  inputGranted(): boolean
  /** Opens System Settings at Input Monitoring (shell.openExternal of INPUT_MONITORING_PANE). */
  openInputPane(): void
  /** Save, app.relaunch(), app.exit(0). */
  relaunch(): void
  /** Onboarding is done: set the identity, mark onboarding complete, place the pet near the bottom centre, celebrate. */
  onFinish(identity: PetIdentity): void
  /** The user closed the window before the hatch: keep the defaults, leave onboarding incomplete (shows next launch). */
  onClosedEarly(): void
  log(line: string): void
  /** Throttled: for problems that may repeat (messages from the wrong sender, malformed payloads). */
  warn(key: string, line: string): void
  /** Monotonic ms (default Date.now). */
  now?(): number
}

export interface OnboardingOpenOptions {
  /** 'permission': back at the permission step (after "Relaunch Bitbot"). Default 'welcome'. */
  startAt?: OnboardingStart
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The onboarding window: ordinary and focusable (the user just launched the app, §15.1), sized to its content, not
 * resizable, minimizable, maximizable or fullscreenable (one step at a time, nothing to grow), created hidden and shown
 * once its page is ready. Sandboxed with the shared preload like every Bitbot page.
 */
export function onboardingWindowOptions(preload: string): BrowserWindowConstructorOptions {
  const { width, height } = tuning.onboarding.window
  return {
    width,
    height,
    useContentSize: true,
    center: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Welcome to Bitbot',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
    },
  }
}

export class OnboardingWindow {
  private win: BrowserWindow | null = null
  private flow: OnboardingFlow | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** The view last pushed to the current page (null: none yet). */
  private pushed: OnboardingView | null = null
  /** Closing for a reason that is neither finishing nor closing early (relaunch, quit). */
  private quietClose = false
  private destroyed = false
  private readonly now: () => number
  /** The ipcMain listeners installed (removed by destroy()). */
  private readonly listeners: [string, (event: IpcMainEvent, payload: unknown) => void][] = []

  constructor(private readonly deps: OnboardingDeps) {
    this.now = deps.now ?? Date.now
    this.installIpc()
  }

  get isOpen(): boolean {
    return this.window !== null
  }

  /** The step shown (null while closed). */
  get step(): OnboardingView['step'] | null {
    return this.window ? (this.flow?.step ?? null) : null
  }

  /** First launch: creates the window (shown and focused once its page is ready), or raises the open one. */
  open(options: OnboardingOpenOptions = {}): void {
    if (this.destroyed) return
    const existing = this.window
    if (existing) {
      existing.show()
      existing.focus()
      return
    }
    const flow = new OnboardingFlow(
      { relaunchHintMs: tuning.onboarding.relaunchHintMs, grantedAdvanceMs: tuning.onboarding.grantedAdvanceMs },
      this.readGranted(),
      options.startAt ?? 'welcome',
    )
    const win = new BrowserWindow(onboardingWindowOptions(preloadPath()))
    this.win = win
    this.flow = flow
    this.pushed = null
    this.quietClose = false
    win.once('ready-to-show', () => {
      if (win !== this.win || win.isDestroyed()) return
      win.show()
      win.focus()
    })
    win.webContents.on('did-start-navigation', (details) => {
      // A reload: the new page asks for the view itself; push again from scratch.
      if (details.isMainFrame && !details.isSameDocument) this.pushed = null
    })
    win.on('closed', () => {
      if (win !== this.win) return
      this.win = null
      this.stopTimer()
      this.pushed = null
      const quiet = this.quietClose || this.destroyed
      this.flow = null
      if (quiet) return
      // Closed during the hatch: everything was chosen, so it counts as finishing.
      const chosen = flow.finish()
      if (chosen) this.finishWith(chosen)
      else if (!flow.isFinished) this.deps.onClosedEarly()
    })
    this.syncTimer()
    loadPage(win, 'onboarding').catch((err: unknown) => {
      if (win === this.win) this.deps.log(`[bitbot] onboarding: its page did not load (${errorText(err)})`)
    })
    this.deps.log(`[bitbot] onboarding opened (${flow.step})`)
  }

  /** Closes the window as the user would (an unfinished onboarding then counts as closed early). */
  close(): void {
    const win = this.window
    if (win) win.close()
  }

  /** Quit: closes the window without calling onFinish or onClosedEarly, removes the IPC handlers; it can't open again. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopTimer()
    const win = this.win
    this.win = null
    this.flow = null
    if (win && !win.isDestroyed()) win.destroy()
    for (const [channel, listener] of this.listeners) ipcMain.removeListener(channel, listener)
    this.listeners.length = 0
    ipcMain.removeHandler(IPC.onboardingState)
  }

  private get window(): BrowserWindow | null {
    const win = this.win
    return win && !win.isDestroyed() ? win : null
  }

  private readGranted(): boolean {
    try {
      return this.deps.inputGranted()
    } catch {
      return false
    }
  }

  /** The flow changed (or may have): push the view if it differs, and run the poll only on the permission step. */
  private changed(): void {
    this.syncTimer()
    const win = this.window
    const flow = this.flow
    if (!win || !flow) return
    const view = flow.view
    if (this.pushed !== null && sameOnboardingView(this.pushed, view)) return
    try {
      const wc = win.webContents
      if (wc.isDestroyed() || wc.isCrashed()) return
      wc.send(IPC.onboardingView, view)
      this.pushed = view
    } catch {
      // Closing.
    }
  }

  private syncTimer(): void {
    const wanted = this.window !== null && this.flow?.step === 'permission'
    if (wanted && this.timer === null) {
      this.timer = setInterval(() => this.poll(), tuning.onboarding.permissionPollMs)
    } else if (!wanted) {
      this.stopTimer()
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private poll(): void {
    const flow = this.flow
    if (!flow || !this.window) {
      this.stopTimer()
      return
    }
    const now = this.now()
    const granted = flow.grant(this.readGranted(), now)
    const ticked = flow.tick(now)
    if (granted || ticked) this.changed()
  }

  private finishWith(chosen: { name: string; paletteId: PetIdentity['paletteId'] }): void {
    const identity: PetIdentity = { name: chosen.name, paletteId: chosen.paletteId, size: DEFAULT_IDENTITY.size }
    this.deps.log(`[bitbot] onboarding finished (${identity.paletteId})`)
    try {
      this.deps.onFinish(identity)
    } catch (err) {
      this.deps.log(`[bitbot] ERROR finishing onboarding: ${errorText(err)}`)
    }
  }

  private installIpc(): void {
    ipcMain.handle(IPC.onboardingState, (event) => {
      const flow = this.flow
      if (!this.fromPage(event) || !flow) {
        this.deps.warn(`${IPC.onboardingState} sender`, `[bitbot] onboarding: ignored ${IPC.onboardingState} from another page`)
        throw new Error(`${IPC.onboardingState} from an unknown sender`)
      }
      // A fresh page on the permission step: the grant as it is now (a reload never starts an auto-advance).
      if (flow.step === 'permission') flow.setGranted(this.readGranted())
      const view = flow.view
      this.pushed = view
      return view
    })
    this.on(IPC.onboardingNav, (flow, payload) => {
      const nav = parseOnboardingNav(payload)
      if (!nav) return 'malformed'
      const moved = nav.dir === 'next' ? flow.next() : flow.back()
      // Arriving at the permission step: the grant as it is now (without starting an auto-advance).
      if (moved && flow.step === 'permission') flow.setGranted(this.readGranted())
      return true
    })
    this.on(IPC.onboardingRequestAccess, (flow) => {
      if (!flow.requestAccess(this.now())) return true
      this.deps
        .requestInputAccess()
        .catch((err: unknown) => this.deps.warn('onboarding request access', `[bitbot] onboarding: asking for Input Monitoring failed: ${errorText(err)}`))
        .finally(() => {
          try {
            this.deps.openInputPane()
          } catch (err) {
            this.deps.log(`[bitbot] onboarding: could not open System Settings: ${errorText(err)}`)
          }
        })
      return true
    })
    this.on(IPC.onboardingSkipPermission, (flow) => {
      flow.skip()
      return true
    })
    this.on(IPC.onboardingRelaunch, (flow) => {
      if (!flow.relaunchShown) return true
      this.deps.log('[bitbot] onboarding: relaunching for Input Monitoring')
      this.quietClose = true
      this.stopTimer()
      this.deps.relaunch()
      return true
    })
    this.on(IPC.onboardingHatch, (flow, payload) => {
      const chosen = parseOnboardingHatch(payload)
      if (!chosen) return 'malformed'
      flow.hatch(chosen)
      return true
    })
    this.on(IPC.onboardingFinish, (flow) => {
      const chosen = flow.finish()
      if (!chosen) return true
      this.finishWith(chosen)
      this.close()
      return true
    })
  }

  /** Listens on `channel` for messages from this window's page; `handle` returns 'malformed' to have it logged. */
  private on(channel: string, handle: (flow: OnboardingFlow, payload: unknown) => true | 'malformed'): void {
    const listener = (event: IpcMainEvent, payload: unknown): void => {
      const flow = this.flow
      if (!this.fromPage(event) || !flow) {
        this.deps.warn(`${channel} sender`, `[bitbot] onboarding: ignored ${channel} from another page`)
        return
      }
      try {
        if (handle(flow, payload) === 'malformed') {
          this.deps.warn(`malformed ${channel}`, `[bitbot] onboarding: ignored a malformed ${channel}`)
          return
        }
      } catch (err) {
        this.deps.warn(`${channel} handler`, `[bitbot] ERROR handling ${channel}: ${errorText(err)}`)
      }
      this.changed()
    }
    ipcMain.on(channel, listener)
    this.listeners.push([channel, listener])
  }

  private fromPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const win = this.window
    return win !== null && event.sender === win.webContents
  }
}
