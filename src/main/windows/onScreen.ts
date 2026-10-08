// Is the overlay on screen? (design 3.2, docs/decisions/overlay.md) The grab area is a panel, and AppKit puts panels on
// every Space, fullscreen ones included, while the overlay (a normal window) stays off fullscreen Spaces and Split
// View. So the grab area may only be shown while the helper's on-screen window list (CGWindowListCopyWindowInfo with
// optionOnScreenOnly) contains the overlay. Pure: the helper client is injected (HelperClient is a SnapshotSource).

/** The CGWindowID in a BrowserWindow.getMediaSourceId() ('window:<CGWindowID>:0' on macOS); null for anything else. */
export function windowNumber(mediaSourceId: string): number | null {
  if (typeof mediaSourceId !== 'string') return null
  const match = /^window:(\d+):/.exec(mediaSourceId)
  if (!match?.[1]) return null
  const wid = Number(match[1])
  return Number.isSafeInteger(wid) && wid > 0 ? wid : null
}

export interface SnapshotSource {
  readonly isRunning: boolean
  snapshot(): Promise<{ windows: readonly { wid: number; onScreen: boolean }[] }>
}

/** true: the window is in the helper's on-screen list with onScreen; false: it isn't; null: can't tell (no source, not running, no wid, request failed). Never rejects. */
export async function windowOnScreen(source: SnapshotSource | null, wid: number | null): Promise<boolean | null> {
  if (source === null || wid === null || !Number.isSafeInteger(wid) || wid <= 0) return null
  try {
    if (!source.isRunning) return null
    const snapshot = await source.snapshot()
    const windows: unknown = snapshot?.windows
    if (!Array.isArray(windows)) return null
    return windows.some((w: unknown) => isEntry(w) && w.wid === wid && w.onScreen === true)
  } catch {
    return null
  }
}

function isEntry(value: unknown): value is { wid: unknown; onScreen: unknown } {
  return typeof value === 'object' && value !== null
}
