import { writeSync } from 'node:fs'

// Synchronous stdout lines for the harness. The bench runner parses some of them (wid=…, RESULT),
// and synchronous writes cannot be lost when the harness exits right after printing.
export function out(line: string): void {
  const text = `${line}\n`
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      writeSync(1, text)
      return
    } catch (err) {
      // A non-blocking pipe whose reader is momentarily behind reports EAGAIN; anything else = stdout gone.
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') return
    }
  }
}

export const TAG = '[spike:overlay]'
