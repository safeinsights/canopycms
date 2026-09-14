/**
 * Loads path permissions, and mutates permissions.json under the cross-host
 * layered lock in authorization/settings-file-store.ts.
 */

import fs from 'node:fs/promises'
import type { PathPermission } from '../../config'
import type { PermissionsFile } from './schema'
import { PermissionsFileSchema } from './schema'
import type { OperatingMode } from '../../operating-mode'
import { operatingStrategy } from '../../operating-mode'
import { mutateSettingsJsonFile } from '../settings-file-store'
import type { OccWriteResult } from '../../utils/occ-json-write'

function getPermissionsFilePath(repoRoot: string, mode: OperatingMode): string {
  return operatingStrategy(mode).getPermissionsFilePath(repoRoot)
}

/** Returns null when the file doesn't exist. */
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    console.error('CanopyCMS: Failed to parse permissions file', error)
    throw new Error(
      `Invalid permissions file: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
}

/**
 * Loads .canopycms/permissions.json (permissions.local.json in dev mode).
 * Returns an empty array when the file doesn't exist: no restrictions.
 */
export async function loadPathPermissions(
  repoRoot: string,
  mode: OperatingMode,
): Promise<PathPermission[]> {
  const file = await loadPermissionsFile(repoRoot, mode)
  return file?.pathPermissions ?? []
}

/**
 * Mutate permissions.json (permissions.local.json in dev mode) under the full
 * cross-host lock + OCC-retry stack (see authorization/settings-file-store.ts).
 * `mutate` receives the current parsed file (`null` if absent) and the version
 * to write under, and returns the next raw payload or `null` for a deliberate
 * no-op. The payload is validated against {@link PermissionsFileSchema} before
 * writing.
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
 * Create the permissions file if it doesn't exist; a no-op when it is already
 * present (the mutator returns `null`, so no write happens).
 * @internal Exported for tests.
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
