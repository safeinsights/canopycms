/**
 * Permissions file loader
 *
 * Handles loading and saving path permissions from the filesystem.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { PathPermission } from '../../config'
import type { PermissionsFile } from './schema'
import { PermissionsFileSchema } from './schema'
import type { OperatingMode } from '../../operating-mode'
import { operatingStrategy } from '../../operating-mode'

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
 * Save path permissions to .canopycms/permissions.json (or .local.json in dev mode)
 */
export async function savePathPermissions(
  repoRoot: string,
  permissions: PathPermission[],
  updatedBy: string,
  mode: OperatingMode,
  contentVersion?: number,
): Promise<void> {
  const permissionsPath = getPermissionsFilePath(repoRoot, mode)
  const canopyDir = path.dirname(permissionsPath)

  // Ensure .canopycms directory exists
  await fs.mkdir(canopyDir, { recursive: true })

  const permissionsFile: PermissionsFile = {
    version: 1,
    contentVersion: contentVersion ?? 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
    pathPermissions: permissions,
  }

  // Validate before writing
  PermissionsFileSchema.parse(permissionsFile)

  await fs.writeFile(permissionsPath, JSON.stringify(permissionsFile, null, 2), 'utf-8')
}

/**
 * Initialize permissions file if it doesn't exist
 */
export async function ensurePermissionsFile(
  repoRoot: string,
  userId: string,
  mode: OperatingMode,
): Promise<void> {
  const permissionsPath = getPermissionsFilePath(repoRoot, mode)

  try {
    await fs.access(permissionsPath)
    // File exists, nothing to do
  } catch {
    // File doesn't exist, create default
    await savePathPermissions(repoRoot, [], userId, mode)
  }
}
