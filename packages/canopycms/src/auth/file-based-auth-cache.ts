import fs from 'node:fs/promises'
import path from 'node:path'
import type { AuthCacheProvider } from './caching-auth-plugin'
import type { UserSearchResult, GroupMetadata } from './types'
import type { CanopyUserId, CanopyGroupId } from '../types'
import { createDebugLogger } from '../utils/debug'

const log = createDebugLogger({ prefix: 'FileBasedAuthCache' })

interface CachedUsers {
  users: UserSearchResult[]
}

interface CachedGroups {
  groups: GroupMetadata[]
}

interface CachedMemberships {
  memberships: Record<string, string[]> // userId -> groupId[]
}

interface LoadedCache {
  users: Map<CanopyUserId, UserSearchResult>
  groups: Map<CanopyGroupId, GroupMetadata>
  memberships: Map<CanopyUserId, CanopyGroupId[]>
  allUsers: UserSearchResult[]
  allGroups: GroupMetadata[]
}

/**
 * Resolve the active cache directory.
 *
 * Supports two layouts:
 * 1. Snapshot layout (preferred): {cachePath}/current → {cachePath}/snapshot-{ts}/
 *    The `current` symlink points to the active snapshot directory.
 * 2. Flat layout (legacy/simple): files directly in {cachePath}/
 *
 * Returns the directory path where users.json, orgs.json, memberships.json live.
 */
async function resolveActiveCacheDir(cachePath: string): Promise<string> {
  const currentLink = path.join(cachePath, 'current')
  try {
    const target = await fs.readlink(currentLink)
    // Symlink target may be relative or absolute
    const resolved = path.isAbsolute(target) ? target : path.resolve(cachePath, target)
    // SECURITY: Validate that resolved target stays within the expected cache directory
    const normalizedCache = path.resolve(cachePath)
    const normalizedTarget = path.resolve(resolved)
    if (
      !normalizedTarget.startsWith(normalizedCache + path.sep) &&
      normalizedTarget !== normalizedCache
    ) {
      log.debug('cache', 'Symlink target escapes cache directory', {
        cachePath: normalizedCache,
        target: normalizedTarget,
      })
      return cachePath
    }
    return resolved
  } catch {
    // No symlink — fall back to flat layout
    return cachePath
  }
}

/**
 * File-based auth cache provider.
 * Reads JSON files from a directory that is populated externally
 * (e.g., by an EC2 worker running refreshClerkCache).
 *
 * Supports two directory layouts:
 * - Snapshot layout: {cachePath}/current/ symlink → snapshot-{ts}/ directory
 * - Flat layout: files directly in {cachePath}/
 *
 * Expects:
 * - users.json   — { users: UserSearchResult[] }
 * - orgs.json    — { groups: GroupMetadata[] }
 * - memberships.json — { memberships: { [userId]: groupId[] } }
 *
 * Caches in memory and re-reads when file mtime changes.
 */
export class FileBasedAuthCache implements AuthCacheProvider {
  private cache: LoadedCache | null = null
  private lastMtime = 0

  constructor(private readonly cachePath: string) {}

  async getUser(userId: CanopyUserId): Promise<UserSearchResult | null> {
    const cache = await this.ensureLoaded()
    return cache.users.get(userId) ?? null
  }

  async getGroup(groupId: CanopyGroupId): Promise<GroupMetadata | null> {
    const cache = await this.ensureLoaded()
    return cache.groups.get(groupId) ?? null
  }

  async getAllUsers(): Promise<UserSearchResult[]> {
    const cache = await this.ensureLoaded()
    return cache.allUsers
  }

  async getAllGroups(): Promise<GroupMetadata[]> {
    const cache = await this.ensureLoaded()
    return cache.allGroups
  }

  async getUserExternalGroups(userId: CanopyUserId): Promise<CanopyGroupId[]> {
    const cache = await this.ensureLoaded()
    return cache.memberships.get(userId) ?? []
  }

  private async ensureLoaded(): Promise<LoadedCache> {
    const activeDir = await resolveActiveCacheDir(this.cachePath)

    const usersPath = path.join(activeDir, 'users.json')
    const orgsPath = path.join(activeDir, 'orgs.json')
    const membershipsPath = path.join(activeDir, 'memberships.json')

    // Check max mtime across all three files for cache freshness
    let maxMtime = 0
    for (const filePath of [usersPath, orgsPath, membershipsPath]) {
      try {
        const stat = await fs.stat(filePath)
        maxMtime = Math.max(maxMtime, stat.mtimeMs)
      } catch {
        // File doesn't exist — continue checking others
      }
    }

    if (maxMtime === 0) {
      // No cache files exist — return empty cache
      if (!this.cache) {
        this.cache = this.emptyCache()
      }
      return this.cache
    }

    // If max mtime hasn't changed and we have a cache, return it
    if (this.cache && maxMtime === this.lastMtime) {
      return this.cache
    }

    // Load fresh data
    this.cache = await this.loadFromDisk(activeDir)
    this.lastMtime = maxMtime
    return this.cache
  }

  private async loadFromDisk(dir: string): Promise<LoadedCache> {
    const usersPath = path.join(dir, 'users.json')
    const orgsPath = path.join(dir, 'orgs.json')
    const membershipsPath = path.join(dir, 'memberships.json')

    const [usersData, orgsData, membershipsData] = await Promise.all([
      this.readJsonFile<CachedUsers>(usersPath, { users: [] }),
      this.readJsonFile<CachedGroups>(orgsPath, { groups: [] }),
      this.readJsonFile<CachedMemberships>(membershipsPath, {
        memberships: {},
      }),
    ])

    const users = new Map<CanopyUserId, UserSearchResult>()
    for (const user of usersData.users) {
      users.set(user.id, user)
    }

    const groups = new Map<CanopyGroupId, GroupMetadata>()
    for (const group of orgsData.groups) {
      groups.set(group.id, group)
    }

    const memberships = new Map<CanopyUserId, CanopyGroupId[]>()
    for (const [userId, groupIds] of Object.entries(membershipsData.memberships)) {
      memberships.set(userId as CanopyUserId, groupIds as CanopyGroupId[])
    }

    log.debug('cache', 'Loaded auth cache', {
      dir,
      users: users.size,
      groups: groups.size,
      memberships: memberships.size,
    })

    return {
      users,
      groups,
      memberships,
      allUsers: usersData.users,
      allGroups: orgsData.groups,
    }
  }

  private async readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(content) as T
    } catch {
      log.debug('cache', 'Cache file not found or invalid', { path: filePath })
      return fallback
    }
  }

  private emptyCache(): LoadedCache {
    return {
      users: new Map(),
      groups: new Map(),
      memberships: new Map(),
      allUsers: [],
      allGroups: [],
    }
  }
}

/**
 * Write auth cache files atomically using a snapshot directory and symlink swap.
 *
 * 1. Writes files to a timestamped snapshot directory: {cachePath}/snapshot-{ts}/
 * 2. Creates a temporary symlink, then atomically renames it to {cachePath}/current
 * 3. Cleans up old snapshot directories (keeps the 2 most recent)
 *
 * This ensures readers (FileBasedAuthCache) always see a consistent set of files:
 * either the old snapshot or the new one, never a mix.
 */
export async function writeAuthCacheSnapshot(
  cachePath: string,
  files: Record<string, unknown>,
): Promise<string> {
  await fs.mkdir(cachePath, { recursive: true })

  const timestamp = Date.now()
  const snapshotDir = path.join(cachePath, `snapshot-${timestamp}`)
  await fs.mkdir(snapshotDir, { recursive: true })

  // Write all files to the snapshot directory
  for (const [fileName, data] of Object.entries(files)) {
    const tmpPath = path.join(snapshotDir, `${fileName}.tmp`)
    const finalPath = path.join(snapshotDir, fileName)
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rename(tmpPath, finalPath)
  }

  // Atomic symlink swap: create temp symlink, rename over current
  const currentLink = path.join(cachePath, 'current')
  const tmpLink = path.join(cachePath, `current-${timestamp}`)
  await fs.symlink(snapshotDir, tmpLink)
  await fs.rename(tmpLink, currentLink)

  // Clean up old snapshots (keep the 2 most recent)
  await cleanupOldSnapshots(cachePath, 2)

  return snapshotDir
}

async function cleanupOldSnapshots(cachePath: string, keepCount: number): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(cachePath)
  } catch {
    return
  }

  const snapshots = entries
    .filter((e) => e.startsWith('snapshot-'))
    .sort()
    .reverse()

  // Skip the most recent `keepCount` snapshots
  for (const snapshot of snapshots.slice(keepCount)) {
    try {
      await fs.rm(path.join(cachePath, snapshot), {
        recursive: true,
        force: true,
      })
    } catch {
      // Best effort cleanup
    }
  }
}
