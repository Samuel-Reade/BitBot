import { describe, expect, it } from 'vitest'
import { devServerOrigins, isAllowedRequestUrl } from '../src/main/requestPolicy'

describe('requestPolicy', () => {
  it('allows local resources only', () => {
    expect(isAllowedRequestUrl('file:///Users/x/out/renderer/pet/index.html', [])).toBe(true)
    expect(isAllowedRequestUrl('devtools://devtools/bundled/x.html', [])).toBe(true)
    expect(isAllowedRequestUrl('https://example.com/', [])).toBe(false)
    expect(isAllowedRequestUrl('http://localhost:5173/pet/index.html', [])).toBe(false)
  })

  it('allows only the dev server origin (http + ws) when one is given', () => {
    const origins = devServerOrigins('http://localhost:5173/')
    expect(origins).toEqual(['http://localhost:5173', 'ws://localhost:5173'])
    expect(isAllowedRequestUrl('http://localhost:5173/@vite/client', origins)).toBe(true)
    expect(isAllowedRequestUrl('ws://localhost:5173/', origins)).toBe(true)
    expect(isAllowedRequestUrl('http://localhost:5174/', origins)).toBe(false)
    expect(isAllowedRequestUrl('http://localhost:5173.evil.com/', origins)).toBe(false)
  })

  it('refuses non-loopback dev server URLs', () => {
    expect(devServerOrigins('http://192.168.1.4:5173')).toEqual([])
    expect(devServerOrigins(undefined)).toEqual([])
  })
})
