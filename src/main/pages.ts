import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// Renderer pages built by electron-vite (see electron.vite.config.ts `renderer.build.rollupOptions.input`).
export const PAGES = {
  pet: 'pet/index.html',
  spikeDebug: 'spike/debug.html',
} as const
export type PageId = keyof typeof PAGES

// Resolve from the app root rather than __dirname: main is code-split into out/main/chunks/,
// so __dirname differs between modules. getAppPath() is the project root in dev and the asar root when packaged.
export function preloadPath(): string {
  return join(app.getAppPath(), 'out/preload/index.js')
}

/** Loads a renderer page from the dev server (dev) or the built files (preview/packaged). */
export function loadPage(win: BrowserWindow, page: PageId, query: Record<string, string> = {}): Promise<void> {
  const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const url = new URL(PAGES[page], devUrl.endsWith('/') ? devUrl : `${devUrl}/`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return win.loadURL(url.toString())
  }
  return win.loadFile(join(app.getAppPath(), 'out/renderer', PAGES[page]), { query })
}
