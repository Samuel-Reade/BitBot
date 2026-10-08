import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { tuning } from '../../shared/tuning'
import type { PetSize } from '../../shared/types'
import type { CliArgs } from '../cli'
import { loadPage, preloadPath } from '../pages'

// Dev tool: renders the pet once in a hidden window and writes a PNG.
//   electron . --snapshot=out.png [--palette=mint] [--size=S|M|L] [--yaw=<radians>] [--bg=transparent|checker|<css color>]
//     [--eyes=<eyes>] [--mouth=<mouth>] [--overlays=blush,zzz,...] [--frame=<n>] [--shadow=0..1]
//     [--state=<behavior state> [--t=<s>] [--mood=<mood>] [--dust=0..1] [--facing=1|-1]]  (src/shared/faceStates.ts, types.ts)
//     [--show=hit,attach,anchor,measure,hitmask]   (measure logs numbers; run with --enable-logging to see them)
// Any extra --key=value args are forwarded to the renderer as query params (see src/renderer/pet/main.ts).
// Never pass --debug=...: Electron treats it as its own (removed) flag and exits with code 9.
// --force-device-scale-factor=1 simulates a non-Retina display.
// Uses webContents.capturePage(), which needs no Screen Recording permission. Colors are captured in
// sRGB (index.ts forces the color profile in snapshot mode) so PNG pixels can be compared to palette hexes.
export async function runSnapshot(args: CliArgs): Promise<void> {
  const out = resolve(args['snapshot'] ?? 'snapshot.png')
  const size = (args['size'] ?? 'M') as PetSize
  const edge = Math.round(tuning.render.bodyHeightPt[size] * tuning.render.viewportScale)

  const win = new BrowserWindow({
    width: edge,
    height: edge,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })

  const ready = new Promise<void>((resolveReady, reject) => {
    const timeoutMs = tuning.dev.snapshotReadyTimeoutMs
    const timer = setTimeout(() => reject(new Error(`snapshot: renderer did not report ready within ${timeoutMs} ms`)), timeoutMs)
    ipcMain.once(IPC.snapshotReady, () => {
      clearTimeout(timer)
      resolveReady()
    })
  })

  const query: Record<string, string> = { mode: 'snapshot' }
  for (const [key, value] of Object.entries(args)) if (key !== 'snapshot') query[key] = value

  try {
    await loadPage(win, 'pet', query)
    await ready
    const image = await win.webContents.capturePage()
    writeFileSync(out, image.toPNG())
    const { width, height } = image.getSize()
    console.log(`[snapshot] wrote ${out} (${width}x${height})`)
    app.exit(0)
  } catch (err) {
    console.error('[snapshot] failed:', err)
    app.exit(1)
  }
}
