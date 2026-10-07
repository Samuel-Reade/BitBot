// Where the bitbot-helper binary lives (BITBOT_SPEC.md §5.3). Pure: callers pass in the Electron
// facts (app.isPackaged, app.getAppPath(), process.resourcesPath), so this needs no Electron import.
import { join } from 'node:path'

export const HELPER_BINARY_NAME = 'bitbot-helper'

export interface HelperPathContext {
  /** app.isPackaged */
  isPackaged: boolean
  /** app.getAppPath(): the project root in dev. */
  appPath: string
  /** process.resourcesPath: <Bitbot.app>/Contents/Resources when packaged. */
  resourcesPath: string
}

/**
 * Dev: <appPath>/build/helper/bitbot-helper (written by helper/build-helper.sh).
 * Packaged: <resourcesPath>/bitbot-helper (copied there by electron-builder `extraResources`;
 * it must stay outside app.asar because it is executed directly).
 */
export function resolveHelperPath(context: HelperPathContext): string {
  return context.isPackaged
    ? join(context.resourcesPath, HELPER_BINARY_NAME)
    : join(context.appPath, 'build', 'helper', HELPER_BINARY_NAME)
}
