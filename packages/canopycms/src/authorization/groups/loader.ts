/**
 * Loads internal groups, and mutates groups.json under the cross-host layered
 * lock in authorization/settings-file-store.ts.
 */

import { promises as fs } from 'node:fs'
import { GroupsFileSchema, type InternalGroup, type GroupsFile } from './schema'
import type { OperatingMode } from '../../operating-mode'
import { operatingStrategy } from '../../operating-mode'
import { RESERVED_GROUPS } from '../helpers'
import { mutateSettingsJsonFile } from '../settings-file-store'
import type { OccWriteResult } from '../../utils/occ-json-write'

function getGroupsFilePath(branchRoot: string, mode: OperatingMode): string {
  return operatingStrategy(mode).getGroupsFilePath(branchRoot)
}

/** Returns null when the file doesn't exist. */
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * The effective internal groups for a raw on-disk groups array: the reserved
 * Admins/Reviewers groups always exist (synthesized when absent) and bootstrap
 * admin IDs merge into Admins. Pure — no disk I/O — so a caller holding a
 * freshly loaded file (e.g. a settings-file mutator, which reloads on every
 * retry attempt) can reconcile against it without a second read.
 */
export function deriveInternalGroups(
  fileGroups: InternalGroup[],
  bootstrapAdminIds: Set<string> = new Set(),
): InternalGroup[] {
  let adminsGroup = fileGroups.find((g) => g.id === RESERVED_GROUPS.ADMINS)
  let reviewersGroup = fileGroups.find((g) => g.id === RESERVED_GROUPS.REVIEWERS)

  if (adminsGroup) {
    const allAdmins = new Set([...adminsGroup.members, ...bootstrapAdminIds])
    adminsGroup = {
      ...adminsGroup,
      members: Array.from(allAdmins),
    }
  } else {
    adminsGroup = {
      id: RESERVED_GROUPS.ADMINS,
      name: RESERVED_GROUPS.ADMINS,
      description: 'Full access to all CMS operations',
      members: Array.from(bootstrapAdminIds),
    }
  }

  if (!reviewersGroup) {
    reviewersGroup = {
      id: RESERVED_GROUPS.REVIEWERS,
      name: RESERVED_GROUPS.REVIEWERS,
      description: 'Can review branches, request changes, approve PRs',
      members: [],
    }
  }

  const otherGroups = fileGroups.filter(
    (g) => g.id !== RESERVED_GROUPS.ADMINS && g.id !== RESERVED_GROUPS.REVIEWERS,
  )

  return [adminsGroup, reviewersGroup, ...otherGroups]
}

/** Loads .canopycms/groups.json (groups.local.json in dev mode). */
export async function loadInternalGroups(
  branchRoot: string,
  mode: OperatingMode,
  bootstrapAdminIds: Set<string> = new Set(),
): Promise<InternalGroup[]> {
  const file = await loadGroupsFile(branchRoot, mode)
  return deriveInternalGroups(file?.groups ?? [], bootstrapAdminIds)
}

/**
 * Mutate groups.json (groups.local.json in dev mode) under the full cross-host
 * lock + OCC-retry stack (see authorization/settings-file-store.ts). `mutate`
 * receives the current parsed file (`null` if absent) and the version to write
 * under, and returns the next raw payload or `null` for a deliberate no-op.
 * The payload is validated against {@link GroupsFileSchema} before writing.
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
