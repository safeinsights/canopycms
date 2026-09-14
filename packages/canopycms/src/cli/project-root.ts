/**
 * Resolves an existing CanopyCMS project's root for sync/worker/generate-ai-content:
 * walks up from the given directory to the nearest canopycms.config.ts (like git
 * and .git), so commands work from any subdirectory without scattering state
 * (e.g. .canopy-dev/) into the wrong place.
 */

import path from 'node:path'
import { filePathExists } from '../utils/fs'

/** Config file that marks the root of a CanopyCMS project. */
export const PROJECT_MARKER = 'canopycms.config.ts'

export async function findProjectRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir)
  for (;;) {
    if (await filePathExists(path.join(dir, PROJECT_MARKER))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
