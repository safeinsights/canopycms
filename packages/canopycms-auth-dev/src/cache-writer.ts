import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_USERS, DEFAULT_GROUPS } from './dev-plugin'
import type { DevUser, DevGroup } from './dev-plugin'

export interface RefreshDevCacheOptions {
  /** Directory to write cache files to (e.g., .canopy-prod-sim/.cache) */
  cachePath: string
  /** Custom users (defaults to DEFAULT_USERS) */
  users?: DevUser[]
  /** Custom groups (defaults to DEFAULT_GROUPS) */
  groups?: DevGroup[]
}

/**
 * Write dev users/groups to cache files for FileBasedAuthCache.
 *
 * This is the dev-auth equivalent of refreshClerkCache() — it populates
 * the same JSON files that CachingAuthPlugin reads. Since dev users are
 * hardcoded, no API calls are needed.
 *
 * Used by the worker's `run-once` command in prod-sim mode with dev auth.
 */
export async function refreshDevCache(
  options: RefreshDevCacheOptions,
): Promise<{ userCount: number; groupCount: number }> {
  const { cachePath } = options
  const users = options.users ?? DEFAULT_USERS
  const groups = options.groups ?? DEFAULT_GROUPS

  const usersData = {
    users: users.map((u) => ({
      id: u.userId,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
    })),
  }

  const groupsData = {
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
    })),
  }

  const membershipsData = {
    memberships: Object.fromEntries(
      users.filter((u) => u.externalGroups.length > 0).map((u) => [u.userId, u.externalGroups]),
    ),
  }

  await fs.mkdir(cachePath, { recursive: true })
  await writeJsonAtomic(path.join(cachePath, 'users.json'), usersData)
  await writeJsonAtomic(path.join(cachePath, 'orgs.json'), groupsData)
  await writeJsonAtomic(path.join(cachePath, 'memberships.json'), membershipsData)

  return { userCount: users.length, groupCount: groups.length }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmpPath, filePath)
}
