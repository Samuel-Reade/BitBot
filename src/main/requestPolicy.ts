// Pure request policy (no Electron imports, unit-tested in test/requestPolicy.test.ts).
// Design principle #1: Bitbot makes zero network requests. Only local resources load; in dev,
// the electron-vite dev server on localhost is the single exception (never present when packaged).

const LOCAL_SCHEMES = ['file:', 'devtools:', 'data:', 'blob:'] as const

export function devServerOrigins(devUrl: string | undefined): string[] {
  if (!devUrl) return []
  const origin = new URL(devUrl).origin
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return []
  return [origin, origin.replace(/^http/, 'ws')]
}

export function isAllowedRequestUrl(url: string, allowedOrigins: readonly string[]): boolean {
  if (LOCAL_SCHEMES.some((scheme) => url.startsWith(scheme))) return true
  return allowedOrigins.some((origin) => url === origin || url.startsWith(`${origin}/`))
}
