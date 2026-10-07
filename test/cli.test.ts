import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../src/main/cli'

describe('parseCliArgs', () => {
  it('parses --key=value and bare --flag, ignoring everything else', () => {
    const args = parseCliArgs(['/path/Electron', '.', '--spike=overlay', '--verbose', '-psn_0_1234', '--x=a=b'])
    expect(args).toEqual({ spike: 'overlay', verbose: 'true', x: 'a=b' })
  })
})
