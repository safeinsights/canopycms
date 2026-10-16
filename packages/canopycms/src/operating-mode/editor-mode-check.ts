/**
 * The run-time check that the editor bundle and its server agree on `mode` (see mode-env.ts).
 * Without it, a dev bundle against a prod server fails only as a sign-in that never succeeds. The
 * generated client sends its mode in `EDITOR_MODE_HEADER`, and the request handler refuses a
 * mismatch with `EDITOR_MODE_MISMATCH_STATUS` before auth, naming only the editor's value (with
 * two modes, that still tells the editor the server's). A request without the header is not
 * checked; only the editor's client sends it. Dependency-free: it reaches the browser bundle.
 */

import type { OperatingMode } from './types'

export const EDITOR_MODE_HEADER = 'x-canopy-editor-mode'

/** Not 409, which the editor reads as a save conflict to reload past. */
export const EDITOR_MODE_MISMATCH_STATUS = 412

function otherOperatingMode(mode: OperatingMode): OperatingMode {
  return mode === 'prod' ? 'dev' : 'prod'
}

/** The header's value, or undefined for an absent or unrecognized one, which is not checked. */
export function parseEditorModeHeader(value: string | null): OperatingMode | undefined {
  return value === 'prod' || value === 'dev' ? value : undefined
}

export function editorModeMismatchMessage(editorMode: OperatingMode): string {
  const serverMode = otherOperatingMode(editorMode)
  return (
    `This editor was built for "${editorMode}" mode, but the CMS server runs in "${serverMode}" ` +
    `mode, so signing in cannot work. Whoever deploys this site needs to rebuild the editor with ` +
    `NEXT_PUBLIC_CANOPY_MODE=${serverMode} set at build time. Reloading this page will not help.`
  )
}
