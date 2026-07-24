/**
 * Permissions file loader
 *
 * Handles loading path permissions from the filesystem and mutating
 * permissions.json under the cross-host layered lock in
 * authorization/settings-file-store.ts.
 */

import fs from 'node:fs/promises'
import type { PathPermission } from '../../config'
import type { PermissionsFile } from './schema'
import { PermissionsFileSchema } from './schema'
import type { OperatingMode } from '../../operating-mode'
import { operatingStrategy } from '../../operating-mode'
import { mutateSettingsJsonFile } from '../settings-file-store'
import type { OccWriteResult } from '../../utils/occ-json-write'

/**
 * Get the appropriate permissions file path based on mode
 */
function getPermissionsFilePath(repoRoot: string, mode: OperatingMode): string {
  return operatingStrategy(mode).getPermissionsFilePath(repoRoot)
}

/**
 * Load full permissions file (for version checking)
 * Returns null if file doesn't exist.
 *
 * @param repoRoot - Repository root directory
 * @param mode - Operating mode (determines file path)
 */
export async function loadPermissionsFile(
  repoRoot: string,
  mode: OperatingMode,
): Promise<PermissionsFile | null> {
  const permissionsPath = getPermissionsFilePath(repoRoot, mode)

  try {
    const fileContent = await fs.readFile(permissionsPath, 'utf-8')
    const parsed = JSON.parse(fileContent)
    const validated = PermissionsFileSchema.parse(parsed)
    return validated
  } catch (error) {
    // File doesn't exist
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    // Parse/validation error - this is more serious
    console.error('CanopyCMS: Failed to parse permissions file', error)
    throw new Error(
      `Invalid permissions file: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
}

/**
 * Load path permissions from .canopycms/permissions.json (or .local.json in dev mode)
 * Returns empty array if file doesn't exist (no restrictions).
 *
 * @param repoRoot - Repository root directory
 * @param mode - Operating mode (determines file path)
 */
export async function loadPathPermissions(
  repoRoot: string,
  mode: OperatingMode,
): Promise<PathPermission[]> {
  const file = await loadPermissionsFile(repoRoot, mode)
  return file?.pathPermissions ?? []
}

/**
 * Mutate permissions.json (or .local.json in dev mode) under the full
 * cross-host lock + OCC-retry stack (see
 * authorization/settings-file-store.ts). `mutate` is called with the
 * current parsed file (`null` if it doesn't exist yet) and the version to
 * write under; it returns the next raw payload, or `null` for a deliberate
 * no-op. The returned payload is validated against
 * {@link PermissionsFileSchema} before being written, preserving the
 * previous validate-before-write behavior of the old `savePathPermissions`.
 */
export async function mutatePermissionsFile(
  repoRoot: string,
  mode: OperatingMode,
  mutate: (current: PermissionsFile | null, version: number) => Record<string, unknown> | null,
  options?: { settleMs?: number; maxAttempts?: number },
): Promise<OccWriteResult | null> {
  const permissionsPath = getPermissionsFilePath(repoRoot, mode)

  return mutateSettingsJsonFile<PermissionsFile>({
    filePath: permissionsPath,
    parse: (raw) => PermissionsFileSchema.parse(JSON.parse(raw)),
    mutate: (current, version) => {
      const payload = mutate(current, version)
      return payload === null ? null : PermissionsFileSchema.parse(payload)
    },
    settleMs: options?.settleMs,
    maxAttempts: options?.maxAttempts,
  })
}

/**
 * Initialize permissions file if it doesn't exist. A no-op when the file is
 * already present (the mutator returns `null`, so no write happens).
 */
export async function ensurePermissionsFile(
  repoRoot: string,
  userId: string,
  mode: OperatingMode,
): Promise<void> {
  await mutatePermissionsFile(repoRoot, mode, (current) => {
    if (current) {
      return null
    }
    return {
      updatedAt: new Date().toISOString(),
      updatedBy: userId,
      pathPermissions: [],
    }
  })
}
