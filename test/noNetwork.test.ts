import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Design principle #1: the app makes zero network requests (BITBOT_SPEC.md §2, §13).
// This scans shipped source for network APIs so a regression fails `npm test`.

const ROOT = join(__dirname, '..')
// src/ and helper/ ship; spikes/ and scripts/ are dev tooling but are held to the same rule.
const SCAN_DIRS = ['src', 'helper', 'spikes', 'scripts']
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.html', '.css', '.swift', '.sh']

const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /\bfetch\s*\(/, what: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { pattern: /\bnew\s+WebSocket\b/, what: 'WebSocket' },
  { pattern: /\bEventSource\b/, what: 'EventSource' },
  { pattern: /\bsendBeacon\b/, what: 'navigator.sendBeacon' },
  { pattern: /\bnet\.(request|fetch)\b/, what: 'Electron net' },
  { pattern: /import\s*\{[^}]*\bnet\b[^}]*\}\s*from\s*['"]electron['"]/, what: 'Electron net import' },
  { pattern: /from\s+['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/, what: 'Node network module import' },
  { pattern: /require\(\s*['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]\s*\)/, what: 'Node network module require' },
  { pattern: /\bautoUpdater\b/, what: 'Electron autoUpdater' },
  { pattern: /openExternal\(\s*['"`]https?:/, what: 'shell.openExternal of a web URL' },
  { pattern: /\bRTCPeerConnection\b/, what: 'WebRTC' },
  { pattern: /rel\s*=\s*["'](preconnect|dns-prefetch|prefetch)["']/, what: 'resource hint (opens connections)' },
  { pattern: /url\(\s*['"]?https?:/, what: 'remote URL in CSS' },
  { pattern: /['"`\s](curl|wget)\s/, what: 'curl/wget in a shell command' },
  { pattern: /\bcrashReporter\b/, what: 'crashReporter' },
  { pattern: /\b(src|href)\s*=\s*["']https?:/, what: 'remote URL in markup' },
  { pattern: /\bURLSession\b|\bNSURLConnection\b|\bNWConnection\b|\bCFSocket\b|\bCFStreamCreatePairWithSocket|\bgetaddrinfo\b/, what: 'Swift networking' },
  { pattern: /\bsocket\s*\(\s*(AF_|PF_)/, what: 'BSD socket' },
  { pattern: /^\s*import\s+Network\b/m, what: 'Swift Network framework' },
]

const FORBIDDEN_PACKAGES = [/^@sentry\//, /^electron-updater$/, /^update-electron-app$/, /analytics/i, /mixpanel/i, /posthog/i, /bugsnag/i, /amplitude/i, /firebase/i, /segment/i]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(full)
  }
  return out
}

describe('no network code', () => {
  it('shipped source uses no network APIs', () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      let files: string[] = []
      try {
        files = walk(join(ROOT, dir))
      } catch {
        continue
      }
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        for (const { pattern, what } of FORBIDDEN) {
          if (pattern.test(text)) offenders.push(`${relative(ROOT, file)}: ${what}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('has no analytics, crash-reporting or auto-update dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
    expect(names.filter((name) => FORBIDDEN_PACKAGES.some((re) => re.test(name)))).toEqual([])
  })
})
