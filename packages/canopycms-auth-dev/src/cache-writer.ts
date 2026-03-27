import { writeAuthCacheSnapshot } from 'canopycms/auth/cache'
import { DEFAULT_USERS, DEFAULT_GROUPS } from './dev-defaults'
import type { DevUser, DevGroup } from './dev-defaults'

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

  // Write cache files atomically via snapshot directory + symlink swap
  await writeAuthCacheSnapshot(cachePath, {
    'users.json': usersData,
    'orgs.json': groupsData,
    'memberships.json': membershipsData,
  })

  return { userCount: users.length, groupCount: groups.length }
}
