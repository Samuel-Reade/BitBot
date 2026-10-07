// Type of the bridge the preload exposes as `window.bitbot`.
export interface BitbotBridge {
  send(channel: string, payload?: unknown): void
  invoke(channel: string, payload?: unknown): Promise<unknown>
  /** Returns an unsubscribe function. */
  on(channel: string, listener: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    bitbot: BitbotBridge
  }
}
