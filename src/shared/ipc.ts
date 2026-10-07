// IPC channel names shared by main, preload and renderers.
// The preload bridge only forwards channels whose prefix is listed in IPC_ALLOWED_PREFIXES,
// so renderers cannot reach arbitrary main-process handlers.

export const IPC_ALLOWED_PREFIXES = ['pet:', 'spike:', 'snapshot:', 'debug:'] as const

export function isAllowedChannel(channel: string): boolean {
  return IPC_ALLOWED_PREFIXES.some((prefix) => channel.startsWith(prefix))
}

export const IPC = {
  /** renderer → main: pointer is over / no longer over the pet's silhouette. Payload: PetHoverMsg */
  petHover: 'pet:hover',
  /** renderer → main: pointer interaction on the pet. Payload: PetPointerMsg */
  petPointer: 'pet:pointer',
  /** renderer → main: dev snapshot tool — the frame is rendered and ready to capture. */
  snapshotReady: 'snapshot:ready',
} as const

export interface PetHoverMsg {
  over: boolean
}

export type PetPointerMsg =
  | { kind: 'down'; button: number; screenX: number; screenY: number }
  | { kind: 'up'; button: number; screenX: number; screenY: number }
  | { kind: 'contextmenu'; screenX: number; screenY: number }
