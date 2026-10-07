// Spike B input harness (BITBOT_SPEC.md §12 Spike B, §7.1, §15.1 step 3): can global input be counted
// in a packaged app, and which permission does each approach need?
//   --source=helper   bitbot-helper's listen-only CGEventTap (needs Input Monitoring; never prompts unless
//                     --request asks for the system prompt via CGRequestListenEventAccess).
//   --source=uiohook  uiohook-napi (the §3 default). Its start() can show the Accessibility prompt.
//
// THIS HARNESS CAN SHOW macOS PERMISSION PROMPTS. It is for the user's manual permission tests only
// (spikes/README-input-helper.md); automated agents never run it.
//
// Privacy (§2, §7.3): counts only. Key codes reach this process (helper `input` messages, uiohook
// events) and are used transiently for a held-key set; they are never printed, logged or written. No
// characters, no titles, no URLs. The log goes to app.getPath('logs')/spike-input.log because a
// packaged app started with `open` has no visible stdout.

import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app, systemPreferences } from 'electron'
import { tuning } from '../../../shared/tuning'
import type { HelperClient, HelperExitInfo } from '../../helper/helperClient'
import type { DiagMsg, HelloMsg, InputAccessMsg, InputTapMsg } from '../../helper/protocol'
import type { CheckResult, CheckStatus } from '../windows/checks'
import {
  appIdentity,
  createHelperClient,
  defaultResultsDir,
  helperBinaryPath,
  installSignalHandlers,
  processAlive,
  SpikeLog,
  waitForHello,
  withTimeout,
  type AppIdentity,
} from '../windows/common'
import { errorText, localStamp } from '../windows/format'
import { formatSummary, round, roundSummary, summarize } from '../windows/measure'
import { formatCounts, HelperInputCounter, totalEvents, UiohookInputCounter, type InputCounts } from './counters'
import type { InputSpikeOptions } from './options'
import { followUpAfterRetry, RestartAfterGrantProbe } from './restartAfterGrant'

const T = tuning.spikeInput
const TAG = '[spike:input]'
const RESULTS_SCHEMA = 'bitbot-spike-input/2'
const now = (): number => performance.now()

type UiohookModule = typeof import('uiohook-napi')
type UiohookHook = UiohookModule['uIOhook']

interface TapAttempt {
  tRunS: number
  why: string
  active: boolean
  reason: InputTapMsg['reason']
  error: string | null
}

interface IntervalReport {
  tRunS: number
  counts: InputCounts
}

export class InputHarness {
  private readonly log = new SpikeLog(TAG)
  private readonly startedAt = new Date()
  private readonly t0 = now()
  private readonly checks: CheckResult[] = []
  private readonly errors: string[] = []
  private readonly detachers: (() => void)[] = []
  private readonly intervals: ReturnType<typeof setInterval>[] = []
  private durationTimer: ReturnType<typeof setTimeout> | null = null
  private finishing = false
  private identity: AppIdentity | null = null

  private helper: HelperClient | null = null
  private helperPath = ''
  private hello: HelloMsg | null = null
  private diag: DiagMsg | null = null
  private accessAtStart: InputAccessMsg | null = null
  private accessLatest: InputAccessMsg | null = null
  private requestReply: InputAccessMsg | null = null
  private readonly helperExits: HelperExitInfo[] = []
  private readonly helperStderr: string[] = []
  private readonly tapAttempts: TapAttempt[] = []
  private readonly reapplied: TapAttempt[] = []
  private tapActive = false
  private grantPollBusy = false
  private grantedAtS: number | null = null
  /** §15.1: after a refused same-process retry, does a fresh helper process get the tap? */
  private readonly restartProbe = new RestartAfterGrantProbe(
    {
      kill: (pid, signal) => process.kill(pid, signal),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer),
      nowMs: now,
      currentPid: () => this.helper?.pid ?? null,
      record: (name, status, detail) => this.record(name, status, detail),
      log: (line) => this.log.line(line),
    },
    T.restartAfterGrantTimeoutMs,
  )

  private readonly helperCounter = new HelperInputCounter(T.maxPlausibleAgeS, T.ageSampleCap)
  private readonly uiohookCounter = new UiohookInputCounter()
  private hook: UiohookHook | null = null
  private hookImportedVia: 'import()' | 'require' | null = null
  private hookRunning = false
  private hookStartError: { code: string | null; message: string } | null = null
  private axTrusted: { atStart: boolean | null; afterStart: boolean | null } = { atStart: null, afterStart: null }
  private readonly reports: IntervalReport[] = []

  constructor(private readonly options: InputSpikeOptions) {}

  private get counter(): HelperInputCounter | UiohookInputCounter {
    return this.options.source === 'helper' ? this.helperCounter : this.uiohookCounter
  }

  async run(): Promise<void> {
    const o = this.options
    this.log.mirrorTo(join(app.getPath('logs'), 'spike-input.log'))
    this.installHandlers()
    try {
      const id = appIdentity()
      this.identity = id
      this.log.line('──────── run start ────────')
      this.log.line(
        `options source=${o.source} keys=${o.keys} mouse=${o.mouse} request=${o.request} ` +
          `duration=${o.durationS > 0 ? `${o.durationS}s` : 'until quit'} retryOnGrant=${o.retryOnGrant}`,
      )
      this.log.line(`app isPackaged=${id.isPackaged} pid=${id.pid} ppid=${id.ppid} bundleId=${id.bundleId ?? '-'} bundle=${id.bundlePath ?? '-'}`)
      this.log.line(`app execPath=${id.execPath} electron=${id.versions.electron ?? '-'} arch=${id.arch}`)
      this.log.line(`app appPath=${id.appPath} resourcesPath=${id.resourcesPath} logs=${id.logsPath}`)
      if (!id.isPackaged) {
        this.log.line(
          'NOTE dev run: macOS attributes permissions to the app that launched Electron (Terminal / VS Code), not to Bitbot',
        )
      } else if (id.ppid !== 1) {
        this.log.line(
          'NOTE packaged app started from a terminal: macOS charges that terminal app, not Bitbot. For the packaged ' +
            'attribution test start it with `open` or from Finder (parent pid 1)',
        )
      }
      // Never prompts (prompt: false).
      this.axTrusted.atStart = systemPreferences.isTrustedAccessibilityClient(false)
      this.log.line(`Electron process Accessibility trusted (no prompt): ${this.axTrusted.atStart}`)

      await this.startHelper()
      if (this.finishing) return
      if (o.durationS > 0) this.durationTimer = setTimeout(() => void this.finish('duration'), o.durationS * 1000)
      this.every(() => this.report(), T.reportIntervalS * 1000)
      if (o.source === 'helper') await this.runHelperSource()
      else await this.runUiohookSource()
      this.log.line(`counting${o.durationS > 0 ? ` for ${o.durationS} s` : ' until Ctrl+C / SIGTERM / quit'}; counts every ${T.reportIntervalS} s`)
    } catch (err) {
      if (this.finishing) return
      this.error(`run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      await this.finish('error')
    }
  }

  // ───────────────────────────── helper ─────────────────────────────

  private async startHelper(): Promise<void> {
    this.helperPath = helperBinaryPath()
    const helper = createHelperClient(this.helperPath, (err) => this.error(`helper listener failed: ${errorText(err)}`))
    this.helper = helper
    this.detachers.push(
      helper.on('exit', (info) => {
        this.helperExits.push(info)
        this.tapActive = false
        this.helperCounter.clearHeld()
        this.log.line(
          `helper exit code=${info.code} signal=${info.signal ?? '-'} error=${info.error ?? '-'} willRestart=${info.willRestart}`,
        )
      }),
      helper.on('restart', (info) => this.log.line(`helper restart attempt=${info.attempt} pid=${info.pid ?? '-'}`)),
      helper.on('stderr', (line) => {
        if (this.helperStderr.length < 200) this.helperStderr.push(line)
        this.log.line(`helper stderr: ${line}`)
      }),
      helper.on('protocolError', (info) => this.log.line(`helper protocolError ${JSON.stringify(info)}`)),
      // Re-applied after a helper restart (id null).
      helper.on('inputTap', (message) => {
        const attempt = this.tapAttempt('re-applied after a helper restart', message)
        this.reapplied.push(attempt)
        this.tapActive = message.active
        this.restartProbe.onReapplied(message)
      }),
      // Counts only: the message (with its key code) goes nowhere else.
      helper.on('input', (message) => {
        if (this.options.source === 'helper') this.helperCounter.record(message, Date.now() / 1000)
      }),
    )
    const hello = waitForHello(helper, T.helloTimeoutMs)
    helper.start()
    this.hello = await hello
    this.log.line(`helper hello version=${this.hello.version} pid=${this.hello.pid} path=${this.helperPath}`)
    const diag = await helper.diag()
    this.diag = diag
    this.log.line(
      `helper diag pid=${diag.pid} ppid=${diag.ppid} responsiblePid=${diag.responsiblePid ?? '-'} ` +
        `responsiblePath=${diag.responsiblePath ?? '-'} executablePath=${diag.executablePath ?? '-'}`,
    )
    this.log.line(
      `TCC attributes the helper's input permission to: ${diag.responsiblePath ?? '(unknown)'} (pid ${diag.responsiblePid ?? '-'})`,
    )
    this.accessAtStart = await helper.inputAccess()
    this.accessLatest = this.accessAtStart
    this.log.line(
      `inputAccess preflight (never prompts): listen(Input Monitoring)=${this.accessAtStart.listen} ` +
        `post=${this.accessAtStart.post} accessibility=${this.accessAtStart.accessibility}`,
    )
  }

  private async runHelperSource(): Promise<void> {
    const helper = this.requireHelper()
    if (this.options.request) {
      this.log.line(
        'requestInputAccess: macOS shows the Input Monitoring prompt now if the user has not decided yet ' +
          '(it should name the responsible app above); the reply is the state right after the call',
      )
      const start = now()
      this.requestReply = await helper.requestInputAccess()
      this.log.line(
        `requestInputAccess replied after ${Math.round(now() - start)} ms: listen=${this.requestReply.listen} ` +
          `post=${this.requestReply.post} accessibility=${this.requestReply.accessibility}`,
      )
    }
    await this.startTap('initial')
    if (this.options.retryOnGrant) this.every(() => void this.pollGrant(), T.grantPollMs)
  }

  private async startTap(why: string): Promise<InputTapMsg> {
    const helper = this.requireHelper()
    const start = now()
    const reply = await helper.startInputTap({ keys: this.options.keys, mouse: this.options.mouse })
    const attempt = this.tapAttempt(`${why}, ${Math.round(now() - start)} ms`, reply)
    this.tapAttempts.push(attempt)
    this.tapActive = reply.active
    const status: CheckStatus = reply.active ? 'PASS' : 'FAIL'
    const hint =
      reply.reason === 'notGranted'
        ? ' — Input Monitoring is not granted (no tap was attempted, nothing prompted)'
        : reply.reason === 'tapCreateFailed'
          ? ' — granted, but macOS refused the tap in this helper process'
          : ''
    this.record(`helper tap (${why})`, status, `active=${reply.active} reason=${reply.reason ?? '-'} error=${reply.error ?? '-'}${hint}`)
    return reply
  }

  private tapAttempt(why: string, message: InputTapMsg): TapAttempt {
    const attempt: TapAttempt = {
      tRunS: round(this.runSeconds(), 3),
      why,
      active: message.active,
      reason: message.reason,
      error: message.error,
    }
    if (message.id === null) {
      this.log.line(`inputTap (${why}): active=${message.active} reason=${message.reason ?? '-'} error=${message.error ?? '-'}`)
    }
    return attempt
  }

  /** While the tap is not running: watch the grant (preflight) and retry the tap once it flips to granted. */
  private async pollGrant(): Promise<void> {
    const helper = this.helper
    if (!helper || this.finishing || this.tapActive || this.grantPollBusy || !helper.isRunning) return
    this.grantPollBusy = true
    try {
      const access = await helper.inputAccess()
      const before = this.accessLatest
      this.accessLatest = access
      if (before && before.listen !== access.listen) {
        this.log.line(`Input Monitoring preflight changed: listen ${before.listen} → ${access.listen} at +${this.runSeconds().toFixed(1)} s`)
      }
      if (access.listen && !this.tapActive && !this.finishing) {
        if (this.grantedAtS === null) this.grantedAtS = round(this.runSeconds(), 3)
        // One retry per observed grant, in the helper process that saw the denial. If macOS refuses it
        // ('tapCreateFailed'), a fresh helper process is tried before concluding the app needs a relaunch.
        if (!before?.listen) {
          const reply = await this.startTap('retry after the grant was detected, same process')
          const followUp = followUpAfterRetry(reply)
          const pid = helper.pid
          if (followUp === 'notNeeded') this.restartProbe.notNeeded()
          else if (followUp === 'restartHelper' && pid !== undefined && !this.finishing) this.restartProbe.start(pid)
        }
      }
    } catch (err) {
      if (!this.finishing) this.log.line(`grant poll failed: ${errorText(err)}`)
    } finally {
      this.grantPollBusy = false
    }
  }

  // ───────────────────────────── uiohook ─────────────────────────────

  /**
   * uiohook-napi 1.5.5 bundles libuiohook. On macOS its start():
   *  - calls AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true}): shows the Accessibility
   *    prompt when undecided, and fails with UIOHOOK_ERROR_AXAPI_DISABLED while not trusted;
   *  - then creates an ACTIVE event tap (CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
   *    kCGEventTapOptionDefault, …)) that also receives every mouse move and translates each key press
   *    to text with UCKeyTranslate via dispatch_sync on the main queue (uiohook-napi drops the text).
   * So it needs Accessibility rather than Input Monitoring. Even loading the module opens an IOHIDSystem
   * connection (its library constructor, built with USE_IOKIT). Imported only here, never at startup.
   */
  private async runUiohookSource(): Promise<void> {
    const name = 'uiohook'
    this.log.line('uiohook: importing uiohook-napi')
    type Loaded = Partial<UiohookModule> & { default?: Partial<UiohookModule> }
    let hook: UiohookHook | undefined
    try {
      const mod = (await import('uiohook-napi')) as Loaded
      hook = mod.uIOhook ?? mod.default?.uIOhook
      this.hookImportedVia = 'import()'
    } catch (importErr) {
      // Fallback for the ESM loader not reading app.asar: the package is CommonJS, so require it from the
      // app root (Electron's CommonJS loader reads asar archives and app.asar.unpacked natives).
      this.log.line(`uiohook: import() failed (${errorText(importErr)}); trying require from the app root`)
      try {
        const mod = createRequire(join(app.getAppPath(), 'package.json'))('uiohook-napi') as Loaded
        hook = mod.uIOhook
        this.hookImportedVia = 'require'
      } catch (err) {
        this.record(`${name} import`, 'FAIL', `import(): ${errorText(importErr)}; require: ${errorText(err)}`)
        return
      }
    }
    if (!hook) {
      this.record(`${name} import`, 'FAIL', 'uiohook-napi has no uIOhook export')
      return
    }
    this.hook = hook
    this.record(`${name} import`, 'PASS', `native module loaded via ${this.hookImportedVia}`)
    const counter = this.uiohookCounter
    // Listeners only count; the event objects (key codes, positions) go nowhere else.
    if (this.options.keys) {
      hook.on('keydown', (event) => counter.keydown(event.keycode))
      hook.on('keyup', (event) => counter.keyup(event.keycode))
    }
    if (this.options.mouse) {
      hook.on('mousedown', (event) => counter.mousedown(event.button))
      // Counted only: libuiohook's wheel events are whole-line ones and carry no comparable breakdown.
      hook.on('wheel', () => counter.wheel())
    }
    this.log.line('uiohook: calling uIOhook.start() (libuiohook asks AXIsProcessTrustedWithOptions with prompt: true first)')
    const start = now()
    try {
      hook.start()
      this.hookRunning = true
      this.record(`${name} start()`, 'PASS', `hook running (${Math.round(now() - start)} ms)`)
    } catch (err) {
      const rawCode: unknown = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
      const code = typeof rawCode === 'string' ? rawCode : null
      this.hookStartError = { code, message: errorText(err) }
      this.record(`${name} start()`, 'FAIL', `threw ${code ?? '(no code)'}: ${errorText(err)} (${Math.round(now() - start)} ms)`)
    }
    this.axTrusted.afterStart = systemPreferences.isTrustedAccessibilityClient(false)
    this.log.line(`Electron process Accessibility trusted after start() (no prompt): ${this.axTrusted.afterStart}`)
  }

  // ───────────────────────────── reporting ─────────────────────────────

  private report(): void {
    const counts = this.counter.takeInterval()
    this.reports.push({ tRunS: round(this.runSeconds(), 3), counts })
    const tap =
      this.options.source === 'helper'
        ? ` · tap ${this.tapActive ? 'active' : 'inactive'} · listen=${this.accessLatest?.listen ?? '-'}`
        : ` · hook ${this.hookRunning ? 'running' : 'not running'}`
    this.log.line(`+${T.reportIntervalS}s ${formatCounts(counts)}${tap}`)
  }

  private installHandlers(): void {
    this.detachers.push(
      installSignalHandlers(
        T.signalRepeatGraceMs,
        (signal) => {
          if (this.finishing) this.log.line(`${signal}: already finishing; send it again to exit at once`)
          else void this.finish(`signal:${signal}`)
        },
        (signal) => {
          this.log.line(`${signal} again: exiting at once, results NOT written`)
          app.exit(130)
        },
      ),
    )
    // The user may also quit the packaged app from Activity Monitor or `osascript … quit`.
    const onBeforeQuit = (event: Electron.Event): void => {
      if (this.finishing) return
      event.preventDefault()
      void this.finish('quit')
    }
    app.on('before-quit', onBeforeQuit)
    const onException = (err: Error): void => {
      this.error(`uncaught exception: ${err.stack ?? err.message}`)
      void this.finish('fatal')
    }
    const onRejection = (reason: unknown): void => {
      this.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
    }
    process.on('uncaughtException', onException)
    process.on('unhandledRejection', onRejection)
    this.detachers.push(
      () => app.off('before-quit', onBeforeQuit),
      () => process.off('uncaughtException', onException),
      () => process.off('unhandledRejection', onRejection),
    )
  }

  private async finish(reason: string): Promise<void> {
    if (this.finishing) return
    this.finishing = true
    this.log.line(`finishing (${reason})`)
    if (this.durationTimer !== null) clearTimeout(this.durationTimer)
    this.restartProbe.abort('the run ended before the re-applied tap arrived')
    for (const interval of this.intervals.splice(0)) clearInterval(interval)
    this.report()

    if (this.hook && this.hookRunning) {
      try {
        this.hook.stop()
        this.hookRunning = false
      } catch (err) {
        this.error(`uIOhook.stop() threw: ${errorText(err)}`)
      }
    }
    const helper = this.helper
    const helperPid = helper?.pid ?? null
    if (helper) {
      if (this.tapActive) {
        await withTimeout(
          helper.stopInputTap().then(
            () => true,
            () => false,
          ),
          T.helperStopTimeoutMs,
          false,
        )
      }
      this.accessLatest = await withTimeout(
        helper.inputAccess().catch(() => this.accessLatest),
        T.helperStopTimeoutMs,
        this.accessLatest,
      )
      await withTimeout(
        helper.stop().then(() => true),
        T.helperStopTimeoutMs,
        false,
      )
    }
    if (helperPid !== null && processAlive(helperPid)) {
      try {
        process.kill(helperPid, 'SIGKILL')
      } catch {
        // Gone meanwhile.
      }
      this.error(`helper pid ${helperPid} was still alive after stop(); SIGKILLed`)
    }
    for (const detach of this.detachers.splice(0)) {
      try {
        detach()
      } catch {
        // Teardown is best effort.
      }
    }

    const total = this.counter.total
    this.log.line(`TOTAL ${formatCounts(total)} (${totalEvents(total)} events in ${this.runSeconds().toFixed(1)} s)`)
    const ages = summarize(this.helperCounter.ages.samplesMs)
    if (this.options.source === 'helper') {
      this.log.line(
        `event age at receipt (helper ts → main): ${formatSummary(ages, ' ms')}; implausible ${this.helperCounter.ages.implausible} ` +
          '(a wrong timestamp unit shows up as implausible or huge ages)',
      )
    }
    let code = 0
    try {
      const resultsDir = this.options.resultsDir ?? defaultResultsDir()
      const file = join(resultsDir, `input-${this.options.source}-${this.options.label ?? localStamp(this.startedAt)}.json`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(this.buildResults(reason, total, ages), null, 1)}\n`)
      this.log.line(`wrote ${file}`)
    } catch (err) {
      this.log.line(`ERROR could not write results: ${errorText(err)}`)
      code = 1
    }
    this.log.line('──────── run end ────────')
    if (code === 0) {
      setTimeout(() => app.exit(0), T.quitFallbackMs).unref()
      app.quit()
    } else {
      app.exit(code)
    }
  }

  private buildResults(reason: string, total: InputCounts, ages: ReturnType<typeof summarize>) {
    return {
      schema: RESULTS_SCHEMA,
      privacy: 'counts only: no key codes, characters, titles or positions',
      reason,
      startedAt: this.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      runSeconds: round(this.runSeconds(), 3),
      options: this.options,
      app: this.identity,
      logFile: this.log.filePath,
      accessibilityTrusted: this.axTrusted,
      helper: {
        path: this.helperPath,
        hello: this.hello,
        diag: this.diag,
        inputAccessAtStart: this.accessAtStart,
        inputAccessAtEnd: this.accessLatest,
        requestInputAccessReply: this.requestReply,
        tapAttempts: this.tapAttempts,
        tapReapplied: this.reapplied,
        grantDetectedAtS: this.grantedAtS,
        restartAfterGrant: this.restartProbe.state,
        exits: this.helperExits,
        stderr: this.helperStderr,
      },
      uiohook:
        this.options.source === 'uiohook'
          ? { importedVia: this.hookImportedVia, startError: this.hookStartError, started: this.hook !== null && this.hookStartError === null }
          : null,
      checks: this.checks,
      reportIntervalS: T.reportIntervalS,
      countsNote:
        'null = this source cannot observe it (not 0). uiohook only dispatches scrolls with a whole-line delta, labels ' +
        'diagonal scrolls vertical and has no continuous/momentum flag: compare keys, clicks and notched-wheel scrolls only.',
      reports: this.reports,
      total,
      totalEvents: totalEvents(total),
      eventAgeMs: this.options.source === 'helper' ? roundSummary(ages) : null,
      implausibleEventAges: this.options.source === 'helper' ? this.helperCounter.ages.implausible : null,
      errors: this.errors,
    }
  }

  // ───────────────────────────── utilities ─────────────────────────────

  private requireHelper(): HelperClient {
    if (!this.helper) throw new Error('helper not started')
    return this.helper
  }

  private record(name: string, status: CheckStatus, detail: string): void {
    this.checks.push({ name, status, detail })
    this.log.line(`${status} ${name}: ${detail}`)
  }

  private error(message: string): void {
    this.errors.push(message)
    this.log.line(`ERROR ${message}`)
  }

  private runSeconds(): number {
    return (now() - this.t0) / 1000
  }

  private every(fn: () => void, ms: number): void {
    this.intervals.push(
      setInterval(() => {
        try {
          fn()
        } catch (err) {
          this.error(`timer failed: ${errorText(err)}`)
        }
      }, ms),
    )
  }
}
