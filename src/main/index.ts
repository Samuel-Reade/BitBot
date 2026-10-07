import { app } from 'electron'
import { parseCliArgs } from './cli'
import { installSecurity } from './security'

// Entry point. During the §12 spikes this dispatches to throwaway harnesses selected by CLI flags:
//   --snapshot=out.png          render the pet to a PNG (dev tool, kept after the spikes)
//   --spike=overlay             Spike A: overlay window approach
//   --spike=input               Spike B: global input capture
//   --spike=windows             Spike B: helper window snapshots, coordinates, debug rectangles
const args = parseCliArgs(process.argv)

// Snapshot PNGs are compared against palette hex values; capturePage would otherwise return the
// display's color space (Display P3 on this Mac). Must be set before the app is ready.
if (args['snapshot']) app.commandLine.appendSwitch('force-color-profile', 'srgb')

app.whenReady().then(async () => {
  try {
    await dispatch()
  } catch (err) {
    console.error('[bitbot] fatal:', err)
    app.exit(1)
  }
})

async function dispatch(): Promise<void> {
  // Agent app: no Dock icon (§3). Packaged builds also set LSUIElement so the icon never flashes.
  app.dock?.hide()
  installSecurity()

  if (args['snapshot']) {
    const { runSnapshot } = await import('./dev/snapshot')
    await runSnapshot(args)
    return
  }

  switch (args['spike']) {
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
      console.log('Bitbot: no mode selected. Use --snapshot=<file>, --spike=overlay|input|windows.')
      app.quit()
  }
}

app.on('window-all-closed', () => {
  // Agent app: closing windows never quits; the harnesses quit explicitly.
})
