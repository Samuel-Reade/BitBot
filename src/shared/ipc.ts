// IPC channel names shared by main, preload and renderers.
// The preload bridge only forwards channels whose prefix is listed in IPC_ALLOWED_PREFIXES,
// so renderers cannot reach arbitrary main-process handlers.
// Payload types and their validators for the pet channels are in ./petProtocol.ts.

export const IPC_ALLOWED_PREFIXES = ['pet:', 'spike:', 'snapshot:', 'debug:', 'onboarding:', 'settings:'] as const

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
  /** main → overlay: shown / hidden (the user, macOS, a fullscreen app, the locked screen; §8.6 fade). Payload: PetVisibleMsg */
  petVisible: 'pet:visible',
  /** main → overlay: are you alive? Payload: PetPingMsg */
  petPing: 'pet:ping',
  /** overlay → main: yes. Payload: PetPongMsg */
  petPong: 'pet:pong',
  /** overlay → main: problem report. Payload: PetLogMsg */
  petLog: 'pet:log',
  /** overlay → main: pointer is over / no longer over the pet's silhouette. Payload: PetHoverMsg */
  petHover: 'pet:hover',
  /** overlay → main: pointer interaction on the pet. Payload: PetPointerMsg */
  petPointer: 'pet:pointer',
  /** main → overlay: show or hide the speech bubble (§9.4 daily summary); main runs its timer. Payload: PetBubbleMsg */
  petBubble: 'pet:bubble',
  /** overlay → main: the bubble is drawn, with its measured size (the grab area covers it). Payload: PetBubbleShownMsg */
  petBubbleShown: 'pet:bubble-shown',
  /** main → overlay (the dev check, the dev panel): send the renderer's counters. No payload. */
  debugOverlayStatsRequest: 'debug:overlay-stats-request',
  /** overlay → main: the renderer's counters (sample lists only with PetConfig.debug). Payload: OverlayStatsMsg */
  debugOverlayStats: 'debug:overlay-stats',
  /** main → overlay (dev builds): the dev panel's renderer-side overrides. Payload: DevPetMsg */
  debugPet: 'debug:pet',
  /** dev panel → main (invoke): the panel's current status. Returns DevPanelStatus (src/shared/devPanel.ts). */
  debugPanelGet: 'debug:panel-get',
  /** dev panel → main: change overrides. Payload: DevPanelSet (src/shared/devPanel.ts) */
  debugPanelSet: 'debug:panel-set',
  /** dev panel → main: do something once (go somewhere, stop). Payload: DevPanelAction (src/shared/devPanel.ts) */
  debugPanelAction: 'debug:panel-action',
  /** dev panel → main: inject activity (keys, clicks, scroll, mileage, launches, wake, a break). Payload: DevInject (src/shared/economy.ts) */
  debugPanelInject: 'debug:panel-inject',
  /** main → overlay (dev builds, while "show world" is on): the surfaces and the route. Payload: DebugWorldMsg (src/shared/world.ts) */
  debugWorld: 'debug:world',
  /** main → dev panel: the status changed (and about once a second while open). Payload: DevPanelStatus */
  debugPanelStatus: 'debug:panel-status',
  /** renderer → main: dev snapshot tool — the frame is rendered and ready to capture. */
  snapshotReady: 'snapshot:ready',

  // The settings window (§15.4; messages in ./settingsProtocol.ts, main side src/main/windows/settingsWindow.ts).
  /** settings page → main (invoke): the current view. Returns SettingsView. */
  settingsGet: 'settings:get',
  /** settings page → main: one change. Payload: SettingsChange */
  settingsChange: 'settings:change',
  /** main → settings page: the view changed. Payload: SettingsView */
  settingsView: 'settings:view',
  /** main → settings page: show this section (open(section) while it is already open). Payload: SettingsSection */
  settingsSection: 'settings:section',

  // §15.1 onboarding (page src/renderer/onboarding/, window src/main/windows/onboardingWindow.ts; payloads and their
  // validators in src/shared/onboarding.ts). Accepted only from the onboarding window's own page.
  /** onboarding page → main (invoke): the current view. Returns OnboardingView. */
  onboardingState: 'onboarding:state',
  /** main → onboarding page: the view changed (step, grant, relaunch offer). Payload: OnboardingView */
  onboardingView: 'onboarding:view',
  /** onboarding page → main: Next / Back. Payload: OnboardingNav */
  onboardingNav: 'onboarding:nav',
  /** onboarding page → main: "Allow Input Monitoring" (ask macOS, open System Settings). No payload. */
  onboardingRequestAccess: 'onboarding:request-access',
  /** onboarding page → main: "Skip for now" on the permission step. No payload. */
  onboardingSkipPermission: 'onboarding:skip-permission',
  /** onboarding page → main: "Relaunch Bitbot" (honoured only while offered). No payload. */
  onboardingRelaunch: 'onboarding:relaunch',
  /** onboarding page → main: name and colour chosen, the egg hatches. Payload: OnboardingHatch */
  onboardingHatch: 'onboarding:hatch',
  /** onboarding page → main: the hatch animation is over. No payload. */
  onboardingFinish: 'onboarding:finish',
} as const
