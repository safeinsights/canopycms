import fs from 'node:fs/promises'
import path from 'node:path'
import type { PathPermission } from './config'
import type { PermissionsFile } from './permissions-file'
import { PermissionsFileSchema } from './permissions-file'
import type { BranchMode } from './paths'

const PERMISSIONS_FILE_PATH = '.canopycms/permissions.json'
const PERMISSIONS_LOCAL_FILE_PATH = '.canopycms/permissions.local.json'

/**
 * Get the appropriate permissions file path based on mode
 */
function getPermissionsFilePath(repoRoot: string, mode?: BranchMode): string {
  if (mode === 'local-simple') {
    return path.join(repoRoot, PERMISSIONS_LOCAL_FILE_PATH)
  }
  return path.join(repoRoot, PERMISSIONS_FILE_PATH)
}

/**
 * Load full permissions file (for version checking)
 * Returns null if file doesn't exist.
 *
 * @param repoRoot - Repository root directory
 * @param mode - Branch mode (determines file path)
 */
export const loadPermissionsFile = async (
  repoRoot: string,
  mode?: BranchMode
): Promise<PermissionsFile | null> => {
  const permissionsPath = getPermissionsFilePath(repoRoot, mode)

  try {
    const fileContent = await fs.readFile(permissionsPath, 'utf-8')
    const parsed = JSON.parse(fileContent)
    const validated = PermissionsFileSchema.parse(parsed)
    return validated
  } catch (error) {
    // File doesn't exist - try fallback in local-simple mode
    if ((error as any).code === 'ENOENT') {
      // In local-simple, try fallback to regular .json file
      if (mode === 'local-simple') {
        const fallbackPath = path.join(repoRoot, PERMISSIONS_FILE_PATH)
        try {
          const fileContent = await fs.readFile(fallbackPath, 'utf-8')
          const parsed = JSON.parse(fileContent)
          const validated = PermissionsFileSchema.parse(parsed)
          return validated
        } catch {
          // Fallback also doesn't exist
          return null
        }
      }
      // No file found
      return null
    }

    // Parse/validation error - this is more serious
    console.error('CanopyCMS: Failed to parse permissions file', error)
    throw new Error(
      `Invalid permissions file: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

/**
 * Load path permissions from .canopycms/permissions.json (or .local.json in local-simple mode)
 * Returns empty array if file doesn't exist (no restrictions).
 *
 * @param repoRoot - Repository root directory
 * @param mode - Branch mode (determines file path)
 */
export const loadPathPermissions = async (
  repoRoot: string,
  mode?: BranchMode
): Promise<PathPermission[]> => {
  const file = await loadPermissionsFile(repoRoot, mode)
  return file?.pathPermissions ?? []
}

/**
 * Save path permissions to .canopycms/permissions.json (or .local.json in local-simple mode)
 */
export const savePathPermissions = async (
  repoRoot: string,
  permissions: PathPermission[],
  updatedBy: string,
  mode?: BranchMode,
  contentVersion?: number
): Promise<void> => {
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
export const ensurePermissionsFile = async (
  repoRoot: string,
  userId: string,
  mode?: BranchMode
): Promise<void> => {
  const permissionsPath = getPermissionsFilePath(repoRoot, mode)

  try {
    await fs.access(permissionsPath)
    // File exists, nothing to do
  } catch {
    // File doesn't exist, create default
    await savePathPermissions(repoRoot, [], userId, mode)
  }
}
