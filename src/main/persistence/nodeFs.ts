// The real file system for SaveStore (saveStore.ts SaveFs), on node:fs, synchronous. writeFile flushes the data to
// disk (fsync) before returning, so the rename that follows never publishes a half-written save. The save is created
// readable by the user only (0600): counts only, but it lists which apps were opened (§16 knownBundleIds).

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import type { SaveFs } from './saveStore'

export const nodeSaveFs: SaveFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, data) => {
    const fd = openSync(path, 'w', 0o600)
    try {
      const buf = Buffer.from(data, 'utf8')
      for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  },
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  stat: (path) => {
    const st = statSync(path, { throwIfNoEntry: false })
    return st && st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
  },
  mkdir: (path) => {
    mkdirSync(path, { recursive: true })
  },
  readdir: (path) => {
    try {
      return readdirSync(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
  },
}
