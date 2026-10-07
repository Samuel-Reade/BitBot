import { app } from 'electron'
import type { CliArgs } from '../cli'
import { OverlayHarness } from './overlay/harness'
import { TAG, out } from './overlay/log'
import { OVERLAY_USAGE, parseOverlayOptions } from './overlay/options'

// Spike A — overlay window approach (BITBOT_SPEC.md §12, §5.2). Throwaway harness; see
// spikes/README-overlay.md for how to run it and read the results.
//   electron . --spike=overlay --variant=A1|A2|B|Bfull --mode=static|walk|synthetic|follow|interactive [...]
export async function runOverlaySpike(args: CliArgs): Promise<void> {
  let options
  try {
    options = parseOverlayOptions(args, { appPath: app.getAppPath(), cwd: process.cwd() })
  } catch (err) {
    out(`${TAG} ${err instanceof Error ? err.message : String(err)}`)
    out(OVERLAY_USAGE)
    app.exit(2)
    return
  }
  const harness = new OverlayHarness(options)
  try {
    await harness.run()
  } catch (err) {
    await harness.abort(err)
  }
}
