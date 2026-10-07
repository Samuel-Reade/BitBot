// Electron-side plumbing shared by the two Spike B harnesses (--spike=windows and --spike=input):
// line logging (stdout + a file, because a packaged app started with `open` has no visible stdout),
// app identity facts for the TCC-attribution evidence, and starting bitbot-helper through HelperClient.
//
// Privacy: nothing here logs input events, key codes, window titles or URLs.

import { appendFileSync, mkdirSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { HelperClient } from '../../helper/helperClient'
import { resolveHelperPath } from '../../helper/paths'
import type { HelloMsg } from '../../helper/protocol'
import { bundleIdFromInfoPlist, bundlePathOf, errorText } from './format'

/** Synchronous stdout write (survives an exit right after printing; retries a momentarily full pipe). */
export function writeStdout(text: string): void {
  const line = `${text}\n`
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      writeSync(1, line)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') return
    }
  }
}

/** Tagged line logger: stdout, plus an optional append-only log file with ISO timestamps. */
export class SpikeLog {
  private file: string | null = null
  private fileError: string | null = null

  constructor(private readonly tag: string) {}

  /** Starts mirroring lines into `path` (created with its directory). */
  mirrorTo(path: string): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, '')
      this.file = path
    } catch (err) {
      this.fileError = errorText(err)
      this.line(`WARN cannot write log file ${path}: ${this.fileError}`)
    }
  }

  get filePath(): string | null {
    return this.file
  }

  line(text: string): void {
    const line = `${this.tag} ${text}`
    writeStdout(line)
    if (this.file === null) return
    try {
      appendFileSync(this.file, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // The stdout copy is enough; never let logging break a run.
    }
  }
}

export interface AppIdentity {
  isPackaged: boolean
  pid: number
  /** 1 (launchd) when started by LaunchServices (`open`, Finder); a shell pid when started from a terminal. */
  ppid: number
  execPath: string
  /** The .app bundle containing execPath (dev: node_modules/electron/dist/Electron.app). */
  bundlePath: string | null
  /** CFBundleIdentifier of that bundle: the identity TCC records grants under. */
  bundleId: string | null
  appPath: string
  resourcesPath: string
  logsPath: string
  cwd: string
  versions: { electron: string | undefined; chrome: string | undefined; node: string }
  arch: string
}

export function appIdentity(): AppIdentity {
  const bundlePath = bundlePathOf(process.execPath)
  let bundleId: string | null = null
  if (bundlePath) {
    try {
      bundleId = bundleIdFromInfoPlist(readFileSync(join(bundlePath, 'Contents', 'Info.plist'), 'utf8'))
    } catch {
      bundleId = null
    }
  }
  let logsPath = ''
  try {
    logsPath = app.getPath('logs')
  } catch (err) {
    logsPath = `unavailable: ${errorText(err)}`
  }
  return {
    isPackaged: app.isPackaged,
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    bundlePath,
    bundleId,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    logsPath,
    cwd: process.cwd(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    arch: process.arch,
  }
}

/**
 * Default results directory: <app root>/spike-results in dev; app.getPath('logs') when packaged
 * (~/Library/Logs/Bitbot — the packaged app's cwd is '/', and its bundle must stay unmodified).
 */
export function defaultResultsDir(): string {
  return app.isPackaged ? app.getPath('logs') : join(app.getAppPath(), 'spike-results')
}

/** bitbot-helper's path for this build: build/helper in dev, Contents/Resources when packaged. */
export function helperBinaryPath(): string {
  return resolveHelperPath({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath })
}

export function createHelperClient(binaryPath: string, onListenerError: (err: unknown) => void): HelperClient {
  return new HelperClient({ binaryPath, onListenerError })
}

/** Resolves with the helper's hello (rejects after timeoutMs). Subscribe before helper.start(). */
export function waitForHello(helper: HelperClient, timeoutMs: number): Promise<HelloMsg> {
  const existing = helper.helloMessage
  if (existing) return Promise.resolve(existing)
  return new Promise<HelloMsg>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`bitbot-helper sent no hello within ${timeoutMs} ms`))
    }, timeoutMs)
    const unsubscribe = helper.on('hello', (hello) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(hello)
    })
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The promise's value, or `fallback` once timeoutMs has passed (the promise keeps running). */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** True while a process with this pid exists (signal 0 probes without signalling). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * SIGINT / SIGTERM: the first one finishes the run cleanly (results are written). A terminal Ctrl+C
 * reaches Electron twice within a few ms (the process group gets it and electron's cli.js forwards it),
 * so repeats within `graceMs` are ignored; a later one exits at once without results.
 * Returns a function that removes the handlers.
 */
export function installSignalHandlers(
  graceMs: number,
  onFirst: (signal: string) => void,
  onForce: (signal: string) => void,
): () => void {
  let firstAt: number | null = null
  const handler = (signal: string) => (): void => {
    const now = performance.now()
    if (firstAt === null) {
      firstAt = now
      onFirst(signal)
    } else if (now - firstAt >= graceMs) {
      onForce(signal)
    }
  }
  const sigint = handler('SIGINT')
  const sigterm = handler('SIGTERM')
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)
  return () => {
    process.off('SIGINT', sigint)
    process.off('SIGTERM', sigterm)
  }
}
