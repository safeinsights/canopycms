/**
 * Groups file loader
 *
 * Handles loading internal groups from the filesystem and mutating
 * groups.json under the cross-host layered lock in
 * authorization/settings-file-store.ts.
 */

import { promises as fs } from 'node:fs'
import { GroupsFileSchema, type InternalGroup, type GroupsFile } from './schema'
import type { OperatingMode } from '../../operating-mode'
import { operatingStrategy } from '../../operating-mode'
import { RESERVED_GROUPS } from '../helpers'
import { mutateSettingsJsonFile } from '../settings-file-store'
import type { OccWriteResult } from '../../utils/occ-json-write'

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
 * Derive the effective internal groups list from the raw groups array
 * stored on disk: ensures the reserved Admins/Reviewers groups always exist
 * (synthesizing defaults when absent) and merges bootstrap admin IDs into
 * Admins. Pure — no disk I/O — so a caller that already holds a freshly
 * loaded file (e.g. a settings-file mutator, which reloads on every retry
 * attempt) can reconcile against it without a second read.
 */
export function deriveInternalGroups(
  fileGroups: InternalGroup[],
  bootstrapAdminIds: Set<string> = new Set(),
): InternalGroup[] {
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
  return deriveInternalGroups(file?.groups ?? [], bootstrapAdminIds)
}

/**
 * Mutate groups.json (or .local.json in dev mode) under the full cross-host
 * lock + OCC-retry stack (see authorization/settings-file-store.ts).
 * `mutate` is called with the current parsed file (`null` if it doesn't
 * exist yet) and the version to write under; it returns the next raw
 * payload, or `null` for a deliberate no-op. The returned payload is
 * validated against {@link GroupsFileSchema} before being written,
 * preserving the previous validate-before-write behavior of the old
 * `saveInternalGroups`.
 */
export async function mutateGroupsFile(
  branchRoot: string,
  mode: OperatingMode,
  mutate: (current: GroupsFile | null, version: number) => Record<string, unknown> | null,
  options?: { settleMs?: number; maxAttempts?: number },
): Promise<OccWriteResult | null> {
  const groupsPath = getGroupsFilePath(branchRoot, mode)

  return mutateSettingsJsonFile<GroupsFile>({
    filePath: groupsPath,
    parse: (raw) => GroupsFileSchema.parse(JSON.parse(raw)),
    mutate: (current, version) => {
      const payload = mutate(current, version)
      return payload === null ? null : GroupsFileSchema.parse(payload)
    },
    settleMs: options?.settleMs,
    maxAttempts: options?.maxAttempts,
  })
}
