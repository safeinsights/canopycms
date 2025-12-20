import fs from 'node:fs/promises'
import path from 'node:path'
import type { PathPermission, CanopyConfig } from './config'
import type { PermissionsFile } from './permissions-file'
import { PermissionsFileSchema, createDefaultPermissionsFile } from './permissions-file'

const PERMISSIONS_FILE_PATH = '.canopycms/permissions.json'

/**
 * Load path permissions from .canopycms/permissions.json
 * Falls back to config.pathPermissions if file doesn't exist
 *
 * @param repoRoot - Repository root directory
 * @param config - CanopyConfig for fallback
 */
export const loadPathPermissions = async (
  repoRoot: string,
  config: CanopyConfig,
): Promise<PathPermission[]> => {
  const permissionsPath = path.join(repoRoot, PERMISSIONS_FILE_PATH)

  try {
    const fileContent = await fs.readFile(permissionsPath, 'utf-8')
    const parsed = JSON.parse(fileContent)
    const validated = PermissionsFileSchema.parse(parsed)

    return validated.pathPermissions
  } catch (error) {
    // File doesn't exist or is invalid, fall back to config
    if ((error as any).code === 'ENOENT') {
      // File doesn't exist - use config fallback
      return config.pathPermissions ?? []
    }

    // Parse/validation error - this is more serious
    console.error('CanopyCMS: Failed to parse permissions file', error)
    throw new Error(
      `Invalid permissions file: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
}

/**
 * Save path permissions to .canopycms/permissions.json
 */
export const savePathPermissions = async (
  repoRoot: string,
  permissions: PathPermission[],
  updatedBy: string,
): Promise<void> => {
  const permissionsPath = path.join(repoRoot, PERMISSIONS_FILE_PATH)
  const canopyDir = path.dirname(permissionsPath)

  // Ensure .canopycms directory exists
  await fs.mkdir(canopyDir, { recursive: true })

  const permissionsFile: PermissionsFile = {
    version: 1,
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
export const ensurePermissionsFile = async (repoRoot: string, userId: string): Promise<void> => {
  const permissionsPath = path.join(repoRoot, PERMISSIONS_FILE_PATH)

  try {
    await fs.access(permissionsPath)
    // File exists, nothing to do
  } catch {
    // File doesn't exist, create default
    await savePathPermissions(repoRoot, [], userId)
  }
}
