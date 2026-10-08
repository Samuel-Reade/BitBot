import { join } from 'node:path'
import { app } from 'electron'
import { BitbotApp } from './bitbotApp'
import { parseCliArgs } from './cli'
import { profileDirName, type Mode } from './profiles'
import { installSecurity } from './security'

// Entry point. With no mode flag it runs Bitbot: the pet, its tray icon and its hotkey (src/main/bitbotApp.ts).
// Mode flags select the dev tools and the §12 spike harnesses (throwaway):
//   --snapshot=out.png               render the pet to a PNG (dev tool)
//   --check=overlay                  the M1 dev check (src/main/dev/overlayCheck.ts)
//   --spike=overlay                  Spike A: overlay window approach
//   --spike=input                    Spike B: global input capture
//   --spike=windows                  Spike B: helper window snapshots, coordinates, debug rectangles
const args = parseCliArgs(process.argv)

function modeOf(a: typeof args): Mode {
  if (a['snapshot']) return 'snapshot'
  if (a['check'] !== undefined) return 'check'
  if (a['spike'] !== undefined) return 'spike'
  return 'pet'
}
const mode = modeOf(args)

// Every dev run, and the dev check, gets a profile of its own (profiles.ts), so none shares state with a packaged
// Bitbot. Must be set before the app is ready (and before the single-instance lock, which lives in the profile).
const profileDir = profileDirName(mode, app.isPackaged)
if (profileDir !== null) app.setPath('userData', join(app.getPath('appData'), profileDir))

// Snapshot PNGs are compared against palette hex values; capturePage would otherwise return the
// display's color space (Display P3 on this Mac). Must be set before the app is ready.
if (mode === 'snapshot') app.commandLine.appendSwitch('force-color-profile', 'srgb')

/** Pet mode, before app ready: one instance per profile (a dev run never blocks a packaged Bitbot) and the error handlers. */
function preparePet(): BitbotApp | null {
  if (!app.requestSingleInstanceLock()) {
    // The running Bitbot got 'second-instance' and shows its pet.
    console.log('[bitbot] Bitbot is already running (it shows its pet now); this launch quits')
    app.quit()
    return null
  }
  const bitbot = new BitbotApp()
  // Before anything can throw: an uncaught error must never reach Electron's error dialog (it would activate Bitbot, §2).
  bitbot.installErrorHandlers()
  // A second launch, or a reopen from Finder, shows a hidden pet.
  app.on('second-instance', () => bitbot.showPet('a second launch'))
  app.on('activate', () => bitbot.showPet('reopened'))
  return bitbot
}

const bitbot = mode === 'pet' ? preparePet() : null

// The dev check runs its own Bitbot in its own profile and never takes the pet's single-instance lock, so it runs beside
// a dev or packaged Bitbot without touching either's state.

app.whenReady().then(async () => {
  try {
    await dispatch()
  } catch (err) {
    console.error('[bitbot] fatal:', err)
    app.exit(1)
  }
})

async function dispatch(): Promise<void> {
  if (mode === 'pet' && !bitbot) return // a second instance, quitting
  // Agent app: no Dock icon (§3). Packaged builds also set LSUIElement so the icon never flashes.
  app.dock?.hide()
  installSecurity()

  switch (mode) {
    case 'pet':
      await bitbot?.start()
      return
    case 'snapshot': {
      const { runSnapshot } = await import('./dev/snapshot')
      await runSnapshot(args)
      return
    }
    case 'check':
      if (args['check'] === 'overlay') {
        const { runOverlayCheck } = await import('./dev/overlayCheck')
        await runOverlayCheck(args)
        return
      }
      console.log(`Bitbot: unknown check --check=${args['check']}. Use --check=overlay.`)
      app.exit(2)
      return
    case 'spike':
      await runSpike(args['spike'])
      return
  }
}

async function runSpike(spike: string | undefined): Promise<void> {
  switch (spike) {
    case 'overlay': {
      const { runOverlaySpike } = await import('./spike/overlaySpike')
      await runOverlaySpike(args)
      return
    }
    case 'input': {
      const { runInputSpike } = await import('./spike/inputSpike')
      await runInputSpike(args)
      return
    }
    case 'windows': {
      const { runWindowsSpike } = await import('./spike/windowsSpike')
      await runWindowsSpike(args)
      return
    }
    default:
      console.log('Bitbot: unknown spike. Use --spike=overlay|input|windows.')
      app.quit()
  }
}

app.on('window-all-closed', () => {
  // Agent app: closing windows never quits; Bitbot and the harnesses quit explicitly.
})
