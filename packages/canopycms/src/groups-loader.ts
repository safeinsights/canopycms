import { promises as fs } from 'fs'
import { join } from 'path'
import type { CanopyUserId } from './types'
import { GroupsFileSchema, createDefaultGroupsFile, type InternalGroup } from './groups-file'

const GROUPS_FILE_PATH = '.canopycms/groups.json'

/**
 * Load internal groups from .canopycms/groups.json
 */
export const loadInternalGroups = async (branchRoot: string): Promise<InternalGroup[]> => {
  const groupsPath = join(branchRoot, GROUPS_FILE_PATH)

  try {
    const content = await fs.readFile(groupsPath, 'utf-8')
    const parsed = JSON.parse(content)
    const validated = GroupsFileSchema.parse(parsed)
    return validated.groups
  } catch (error) {
    // File doesn't exist or is invalid - return empty array
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/**
 * Save internal groups to .canopycms/groups.json
 */
export const saveInternalGroups = async (
  branchRoot: string,
  groups: InternalGroup[],
  updatedBy: CanopyUserId
): Promise<void> => {
  const groupsPath = join(branchRoot, GROUPS_FILE_PATH)
  const groupsDir = join(branchRoot, '.canopycms')

  // Ensure .canopycms directory exists
  await fs.mkdir(groupsDir, { recursive: true })

  const groupsFile = {
    version: 1 as const,
    updatedAt: new Date().toISOString(),
    updatedBy,
    groups,
  }

  // Validate before writing
  GroupsFileSchema.parse(groupsFile)

  await fs.writeFile(groupsPath, JSON.stringify(groupsFile, null, 2), 'utf-8')
}
