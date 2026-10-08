// Which profile (userData folder under ~/Library/Application Support) each way of starting Bitbot uses. Pure, so the
// rule "no dev run ever opens the packaged Bitbot's profile" is unit-tested (test/appSupport.test.ts); index.ts applies it.

export type Mode = 'pet' | 'snapshot' | 'check' | 'spike'

/**
 * The profile folder for `mode`, or null for Electron's default ("Bitbot", the packaged app's own, where its save file
 * will live). Dev runs never use the default: the pet has its own (and its own single-instance lock), and the snapshot
 * and spike tools share one that a running dev pet never opens. The dev check always has its own. Packaged spike runs
 * keep the default on purpose: Spike B's permission tests run the packaged app (spikes/README-input-helper.md).
 */
export function profileDirName(mode: Mode, isPackaged: boolean): string | null {
  if (mode === 'check') return 'Bitbot-check'
  if (isPackaged) return null
  return mode === 'pet' ? 'Bitbot-dev' : 'Bitbot-dev-tools'
}
