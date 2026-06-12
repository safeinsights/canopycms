/**
 * Project root discovery for CLI commands.
 *
 * Commands that operate on an existing CanopyCMS project (sync, worker,
 * generate-ai-content) resolve the project root by walking up from the
 * current directory to the nearest canopycms.config.ts — like git does
 * with .git — so running from a subdirectory works and never scatters
 * state (e.g. .canopy-dev/) into the wrong directory.
 */

import path from 'node:path'
import { filePathExists } from '../utils/fs'

/** Config file that marks the root of a CanopyCMS project. */
export const PROJECT_MARKER = 'canopycms.config.ts'

/**
 * Walk up from startDir to the nearest directory containing canopycms.config.ts.
 * Returns null when no project root is found.
 */
export async function findProjectRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir)
  for (;;) {
    if (await filePathExists(path.join(dir, PROJECT_MARKER))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
