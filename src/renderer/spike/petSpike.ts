import { SPIKE_OVERLAY_IPC, isOverlayConfig } from '../../shared/spikeOverlay'
import type { PetScene } from '../pet/scene'
import { SpikeRenderer, reportToMain } from './overlay/spikeRenderer'

// Spike A renderer entry (BITBOT_SPEC.md §12): pet/main.ts hands over here when loaded with mode=spike.
// The run configuration comes from main (src/main/spike/overlay/harness.ts), not from the query —
// except the optional renderFps cap of the lead's cost-vs-frame-rate experiment (--render-fps).
export function startPetSpike(pet: PetScene, params: URLSearchParams): void {
  const fpsParam = params.get('renderFps')
  const renderFps = fpsParam !== null && Number.isFinite(Number(fpsParam)) ? Number(fpsParam) : null
  window.addEventListener('error', (e) => reportToMain('error', `${e.message} (${e.filename}:${e.lineno})`))
  window.addEventListener('unhandledrejection', (e) => reportToMain('error', `unhandled rejection: ${String(e.reason)}`))
  window.bitbot
    .invoke(SPIKE_OVERLAY_IPC.config)
    .then((config) => {
      if (!isOverlayConfig(config)) throw new Error('malformed spike:overlay:config reply')
      new SpikeRenderer(pet, config, renderFps).start()
    })
    .catch((err: unknown) => reportToMain('error', `startPetSpike failed: ${err instanceof Error ? err.message : String(err)}`))
}
