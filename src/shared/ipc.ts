// IPC channel names shared by main, preload and renderers.
// The preload bridge only forwards channels whose prefix is listed in IPC_ALLOWED_PREFIXES,
// so renderers cannot reach arbitrary main-process handlers.
// Payload types and their validators for the pet channels are in ./petProtocol.ts.

export const IPC_ALLOWED_PREFIXES = ['pet:', 'spike:', 'snapshot:', 'debug:'] as const

export function isAllowedChannel(channel: string): boolean {
  return IPC_ALLOWED_PREFIXES.some((prefix) => channel.startsWith(prefix))
}

export const IPC = {
  /** overlay → main (invoke): the overlay's configuration for this page load. Returns PetConfig. */
  petConfig: 'pet:config',
  /** main → overlay: the configuration changed (display change, the pet's area became known). Payload: PetConfig */
  petConfigChanged: 'pet:config-changed',
  /** overlay → main: first frame drawn, pet measured, grab area opened. Payload: PetReadyMsg */
  petReady: 'pet:ready',
  /** overlay → main: whether the pet is currently drawn for a configuration (context loss / restore, config applied). Payload: PetDrawnMsg */
  petDrawn: 'pet:drawn',
  /** main → overlay: draw the pet again even if nothing changed (GPU process restart, wake, unlock). No payload. */
  petRedraw: 'pet:redraw',
  /** main → overlay: the pet's simulated state, sent when it changes. Payload: PetStateMsg */
  petState: 'pet:state',
  /** main → overlay: cursor position while it is near the pet, so the overlay hit-tests a still cursor. Payload: PetCursorMsg */
  petCursor: 'pet:cursor',
  /** main → overlay: main reset the grab area on its own (new epoch); forget hover and any press. Payload: PetHoverResetMsg */
  petHoverReset: 'pet:hover-reset',
  /** main → overlay: shown / hidden by the user (hotkey, menus). Payload: PetVisibleMsg */
  petVisible: 'pet:visible',
  /** overlay → main: problem report. Payload: PetLogMsg */
  petLog: 'pet:log',
  /** overlay → main: pointer is over / no longer over the pet's silhouette. Payload: PetHoverMsg */
  petHover: 'pet:hover',
  /** overlay → main: pointer interaction on the pet. Payload: PetPointerMsg */
  petPointer: 'pet:pointer',
  /** main → overlay (dev check only, PetConfig.debug): send the renderer's counters. No payload. */
  debugOverlayStatsRequest: 'debug:overlay-stats-request',
  /** overlay → main (dev check only): the renderer's counters. Payload: OverlayStatsMsg */
  debugOverlayStats: 'debug:overlay-stats',
  /** renderer → main: dev snapshot tool — the frame is rendered and ready to capture. */
  snapshotReady: 'snapshot:ready',
} as const
