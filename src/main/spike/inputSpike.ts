import { app } from 'electron'
import type { CliArgs } from '../cli'
import { InputHarness } from './input/harness'
import { INPUT_USAGE, parseInputOptions } from './input/options'
import { writeStdout } from './windows/common'
import { errorText } from './windows/format'

// Spike B — global input capture (BITBOT_SPEC.md §12) with bitbot-helper's listen-only tap.
// CAN SHOW macOS PERMISSION PROMPTS: only for the user's manual tests (spikes/README-input-helper.md).
//   electron . --spike=input --source=helper [--keys=true|false] [--mouse=true|false] [--request] [--duration=S]
export async function runInputSpike(args: CliArgs): Promise<void> {
  let options
  try {
    options = parseInputOptions(args, process.cwd())
  } catch (err) {
    writeStdout(`[spike:input] ${errorText(err)}`)
    writeStdout(INPUT_USAGE)
    app.exit(2)
    return
  }
  await new InputHarness(options).run()
}
