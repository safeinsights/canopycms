/**
 * Groups file loader
 *
 * Handles loading and saving internal groups from the filesystem.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { CanopyUserId } from '../../types'
import { GroupsFileSchema, type InternalGroup, type GroupsFile } from './schema'
import type { OperatingMode } from '../../operating-mode'
import { operatingStrategy } from '../../operating-mode'
import { RESERVED_GROUPS } from '../helpers'

/**
 * Get the appropriate groups file path based on mode
 */
function getGroupsFilePath(branchRoot: string, mode: OperatingMode): string {
  return operatingStrategy(mode).getGroupsFilePath(branchRoot)
}

/**
 * Load full groups file (for version checking)
 * Returns null if file doesn't exist.
 */
export async function loadGroupsFile(
  branchRoot: string,
  mode: OperatingMode,
): Promise<GroupsFile | null> {
  const groupsPath = getGroupsFilePath(branchRoot, mode)

  try {
    const content = await fs.readFile(groupsPath, 'utf-8')
    const parsed = JSON.parse(content)
    const validated = GroupsFileSchema.parse(parsed)
    return validated
  } catch (error) {
    // File doesn't exist
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * Load internal groups from .canopycms/groups.json (or .local.json in dev mode)
 * Ensures Admins and Reviewers groups always exist, adding them dynamically if not present.
 * If Admins group exists in file, merges with bootstrap admin IDs.
 */
export async function loadInternalGroups(
  branchRoot: string,
  mode: OperatingMode,
  bootstrapAdminIds: Set<string> = new Set(),
): Promise<InternalGroup[]> {
  const file = await loadGroupsFile(branchRoot, mode)
  const fileGroups = file?.groups ?? []

  // Find existing Admins and Reviewers groups
  let adminsGroup = fileGroups.find((g) => g.id === RESERVED_GROUPS.ADMINS)
  let reviewersGroup = fileGroups.find((g) => g.id === RESERVED_GROUPS.REVIEWERS)

  // Ensure Admins group exists and includes bootstrap admins
  if (adminsGroup) {
    // Merge bootstrap admin IDs with existing members
    const allAdmins = new Set([...adminsGroup.members, ...bootstrapAdminIds])
    adminsGroup = {
      ...adminsGroup,
      members: Array.from(allAdmins),
    }
  } else {
    // Create Admins group with bootstrap admins
    adminsGroup = {
      id: RESERVED_GROUPS.ADMINS,
      name: RESERVED_GROUPS.ADMINS,
      description: 'Full access to all CMS operations',
      members: Array.from(bootstrapAdminIds),
    }
  }

  // Ensure Reviewers group exists
  if (!reviewersGroup) {
    reviewersGroup = {
      id: RESERVED_GROUPS.REVIEWERS,
      name: RESERVED_GROUPS.REVIEWERS,
      description: 'Can review branches, request changes, approve PRs',
      members: [],
    }
  }

  // Return all groups: reserved groups first, then other groups
  const otherGroups = fileGroups.filter(
    (g) => g.id !== RESERVED_GROUPS.ADMINS && g.id !== RESERVED_GROUPS.REVIEWERS,
  )

  return [adminsGroup, reviewersGroup, ...otherGroups]
}

/**
 * Save internal groups to .canopycms/groups.json (or .local.json in dev mode)
 */
export async function saveInternalGroups(
  branchRoot: string,
  groups: InternalGroup[],
  updatedBy: CanopyUserId,
  mode: OperatingMode,
  contentVersion?: number,
): Promise<void> {
  const groupsPath = getGroupsFilePath(branchRoot, mode)
  const groupsDir = join(groupsPath, '..')

  // Ensure parent directory exists (e.g., .canopy-meta or .canopycms)
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
