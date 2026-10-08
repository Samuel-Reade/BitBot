import { app, session, webContents } from 'electron'
import { devServerOrigins, isAllowedRequestUrl } from './requestPolicy'

// Design principle #1: Bitbot makes zero network requests. Every request from every renderer is
// cancelled unless requestPolicy allows it; pages also get no permissions, popups or navigation.
//
// Popups: every webContents starts with a deny-all window-open handler. Exactly one webContents gets another:
// PetWindow (src/main/windows/petWindow.ts) replaces the overlay's handler with one that allows only its grab area
// (about:blank under the name main issued for that page load); everything else stays denied, and the grab area's
// own webContents keeps the deny-all.

let blockedCount = 0

export function blockedRequestCount(): number {
  return blockedCount
}

export function installSecurity(): void {
  const allowedOrigins = devServerOrigins(app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'])
  const ses = session.defaultSession

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedRequestUrl(details.url, allowedOrigins)) {
      callback({})
      return
    }
    blockedCount += 1
    console.warn(`[bitbot] blocked network request: ${details.url}`)
    callback({ cancel: true })
  })

  // No camera/mic/notifications/geolocation/etc. for any page.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
  })
  // Covers contents created before the listener above was attached.
  for (const contents of webContents.getAllWebContents()) {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }
}
