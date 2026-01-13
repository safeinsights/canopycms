import { promises as fs } from 'fs'
import { join } from 'path'
import type { CanopyUserId } from './types'
import { GroupsFileSchema, createDefaultGroupsFile, type InternalGroup, type GroupsFile } from './groups-file'
import type { BranchMode } from './paths'

const GROUPS_FILE_PATH = '.canopycms/groups.json'
const GROUPS_LOCAL_FILE_PATH = '.canopycms/groups.local.json'

/**
 * Get the appropriate groups file path based on mode
 */
function getGroupsFilePath(branchRoot: string, mode?: BranchMode): string {
  if (mode === 'local-simple') {
    return join(branchRoot, GROUPS_LOCAL_FILE_PATH)
  }
  return join(branchRoot, GROUPS_FILE_PATH)
}

/**
 * Load full groups file (for version checking)
 * Returns null if file doesn't exist.
 */
export const loadGroupsFile = async (
  branchRoot: string,
  mode?: BranchMode
): Promise<GroupsFile | null> => {
  const groupsPath = getGroupsFilePath(branchRoot, mode)

  try {
    const content = await fs.readFile(groupsPath, 'utf-8')
    const parsed = JSON.parse(content)
    const validated = GroupsFileSchema.parse(parsed)
    return validated
  } catch (error) {
    // File doesn't exist - try fallback in local-simple mode
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // In local-simple, try fallback to regular .json file
      if (mode === 'local-simple') {
        const fallbackPath = join(branchRoot, GROUPS_FILE_PATH)
        try {
          const content = await fs.readFile(fallbackPath, 'utf-8')
          const parsed = JSON.parse(content)
          const validated = GroupsFileSchema.parse(parsed)
          return validated
        } catch {
          // Fallback also doesn't exist
          return null
        }
      }
      // No file found
      return null
    }
    throw error
  }
}

/**
 * Load internal groups from .canopycms/groups.json (or .local.json in local-simple mode)
 */
export const loadInternalGroups = async (
  branchRoot: string,
  mode?: BranchMode
): Promise<InternalGroup[]> => {
  const file = await loadGroupsFile(branchRoot, mode)
  return file?.groups ?? []
}

/**
 * Save internal groups to .canopycms/groups.json (or .local.json in local-simple mode)
 */
export const saveInternalGroups = async (
  branchRoot: string,
  groups: InternalGroup[],
  updatedBy: CanopyUserId,
  mode?: BranchMode,
  contentVersion?: number
): Promise<void> => {
  const groupsPath = getGroupsFilePath(branchRoot, mode)
  const groupsDir = join(branchRoot, '.canopycms')

  // Ensure .canopycms directory exists
  await fs.mkdir(groupsDir, { recursive: true })

  const groupsFile: GroupsFile = {
    version: 1,
    contentVersion: contentVersion ?? 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
    groups,
  }

  // Validate before writing
  GroupsFileSchema.parse(groupsFile)

  await fs.writeFile(groupsPath, JSON.stringify(groupsFile, null, 2), 'utf-8')
}
