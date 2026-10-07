import { app } from 'electron'
import type { CliArgs } from '../cli'
import { writeStdout } from './windows/common'
import { errorText } from './windows/format'
import { WindowsHarness } from './windows/harness'
import { WINDOWS_USAGE, parseWindowsOptions } from './windows/options'

// Spike B — helper window geometry, z-order, levels, app events, fullscreen and helper cost
// (BITBOT_SPEC.md §12). Throwaway harness; see spikes/README-input-helper.md.
//   electron . --spike=windows [--duration=S] [--auto-app-test] [--overlay=true|false] [--capture=FILE.png]
export async function runWindowsSpike(args: CliArgs): Promise<void> {
  let options
  try {
    options = parseWindowsOptions(args, process.cwd())
  } catch (err) {
    writeStdout(`[spike:windows] ${errorText(err)}`)
    writeStdout(WINDOWS_USAGE)
    app.exit(2)
    return
  }
  await new WindowsHarness(options).run()
}
