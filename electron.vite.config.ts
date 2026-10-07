import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const root = process.cwd()
const r = (p: string): string => resolve(root, p)

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: r('src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: { index: r('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: r('src/renderer'),
    build: {
      rollupOptions: {
        input: {
          pet: r('src/renderer/pet/index.html'),
          spikeDebug: r('src/renderer/spike/debug.html'),
        },
      },
    },
  },
})
