import type { ApiErrorCode } from '../api/types'

export const SETTINGS_CHANGED_CODE = 'SETTINGS_CHANGED' satisfies ApiErrorCode

/** A groups or permissions save refused as the file changed since it loaded: shown yellow. */
export class SettingsChangedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsChangedError'
  }
}
