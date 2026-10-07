// Minimal `--key=value` / `--flag` parser for dev tools and spike harnesses.
// Unknown arguments (Electron's own, macOS -psn_*) are ignored.
export type CliArgs = Readonly<Record<string, string>>

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const out: Record<string, string> = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq === -1) out[arg.slice(2)] = 'true'
    else out[arg.slice(2, eq)] = arg.slice(eq + 1)
  }
  return out
}
