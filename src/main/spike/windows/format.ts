// Pure formatting helpers shared by the two Spike B harnesses (windows and input). No Electron imports.

/** Local time as YYYYMMDD-HHMMSS (results file names). */
export function localStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** CFBundleIdentifier from an XML Info.plist (electron-builder and Electron both write XML), or null. */
export function bundleIdFromInfoPlist(xml: string): string | null {
  const match = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/.exec(xml)
  return match?.[1] ?? null
}

/** <bundle>.app for an executable at <bundle>.app/Contents/MacOS/<name>, else null. */
export function bundlePathOf(executablePath: string): string | null {
  const match = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(executablePath)
  return match?.[1] ?? null
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
