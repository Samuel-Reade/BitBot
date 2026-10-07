import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { isAllowedChannel } from '../shared/ipc'
import type { BitbotBridge } from './api'

// Sandboxed preload: exposes a tiny, prefix-allowlisted message bridge. No Node APIs leak to renderers.
const bridge: BitbotBridge = {
  send(channel, payload) {
    if (!isAllowedChannel(channel)) throw new Error(`IPC channel not allowed: ${channel}`)
    ipcRenderer.send(channel, payload)
  },
  invoke(channel, payload) {
    if (!isAllowedChannel(channel)) return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel, listener) {
    if (!isAllowedChannel(channel)) throw new Error(`IPC channel not allowed: ${channel}`)
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('bitbot', bridge)
