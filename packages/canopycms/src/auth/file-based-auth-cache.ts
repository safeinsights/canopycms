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
 * File-based auth cache provider.
 * Reads JSON files from a directory that is populated externally
 * (e.g., by an EC2 worker running refreshClerkCache).
 *
 * Expects:
 * - {cachePath}/users.json   — { users: UserSearchResult[] }
 * - {cachePath}/orgs.json    — { groups: GroupMetadata[] }
 * - {cachePath}/memberships.json — { memberships: { [userId]: groupId[] } }
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
    const usersPath = path.join(this.cachePath, 'users.json')
    const orgsPath = path.join(this.cachePath, 'orgs.json')
    const membershipsPath = path.join(this.cachePath, 'memberships.json')

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
    this.cache = await this.loadFromDisk()
    this.lastMtime = maxMtime
    return this.cache
  }

  private async loadFromDisk(): Promise<LoadedCache> {
    const usersPath = path.join(this.cachePath, 'users.json')
    const orgsPath = path.join(this.cachePath, 'orgs.json')
    const membershipsPath = path.join(this.cachePath, 'memberships.json')

    const [usersData, orgsData, membershipsData] = await Promise.all([
      this.readJsonFile<CachedUsers>(usersPath, { users: [] }),
      this.readJsonFile<CachedGroups>(orgsPath, { groups: [] }),
      this.readJsonFile<CachedMemberships>(membershipsPath, { memberships: {} }),
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
