import type { AuthPlugin } from './plugin'
import type { UserSearchResult, GroupMetadata, AuthenticationResult } from './types'
import type { CanopyUserId, CanopyGroupId } from '../types'
import { createDebugLogger } from '../utils/debug'

const log = createDebugLogger({ prefix: 'CachingAuthPlugin' })

/**
 * Generic cache provider interface for auth metadata.
 * Any auth system can implement its own cache backend
 * (file-based, Redis, in-memory, etc.)
 */
export interface AuthCacheProvider {
  getUser(userId: CanopyUserId): Promise<UserSearchResult | null>
  getGroup(groupId: CanopyGroupId): Promise<GroupMetadata | null>
  getAllUsers(): Promise<UserSearchResult[]>
  getAllGroups(): Promise<GroupMetadata[]>
  getUserExternalGroups(userId: CanopyUserId): Promise<CanopyGroupId[]>
}

/**
 * Token verifier function type.
 * Given a request context, extracts and verifies the auth token,
 * returning the user ID on success.
 */
export type TokenVerifier = (context: unknown) => Promise<{ userId: CanopyUserId } | null>

/**
 * Auth plugin that wraps a token verifier with cached metadata lookups.
 *
 * Used in environments where the auth provider API is not reachable
 * (e.g., Lambda with no internet). JWT verification is done locally,
 * and user/group metadata comes from a cache populated externally
 * (e.g., by an EC2 worker).
 *
 * In dev mode, an optional `lazyRefresher` can be provided to auto-populate
 * the cache on first request, eliminating the need to run `worker run-once` manually.
 */
export class CachingAuthPlugin implements AuthPlugin {
  private refreshPromise: Promise<void> | null = null

  constructor(
    private readonly verifyToken: TokenVerifier,
    private readonly cache: AuthCacheProvider,
    private readonly lazyRefresher?: () => Promise<unknown>,
  ) {}

  private async ensureCachePopulated(): Promise<void> {
    if (!this.lazyRefresher) return
    // Use a shared promise so concurrent callers coalesce into a single refresh
    this.refreshPromise ??= this.lazyRefresher()
      .then(() => log.debug('auth', 'Lazy cache refresh completed'))
      .catch((err) => {
        log.debug('auth', 'Lazy cache refresh failed', { error: String(err) })
        this.refreshPromise = null // allow retry on next call
      })
    await this.refreshPromise
  }

  async authenticate(context: unknown): Promise<AuthenticationResult> {
    const identity = await this.verifyToken(context)
    if (!identity) {
      return { success: false, error: 'No valid authentication token' }
    }

    await this.ensureCachePopulated()

    try {
      const user = await this.cache.getUser(identity.userId)
      const externalGroups = await this.cache.getUserExternalGroups(identity.userId)

      return {
        success: true,
        user: {
          userId: identity.userId,
          name: user?.name ?? identity.userId,
          email: user?.email,
          avatarUrl: user?.avatarUrl,
          externalGroups,
        },
      }
    } catch {
      // Cache error — still return authenticated with minimal info
      log.debug('auth', 'Cache lookup failed, returning minimal user', {
        userId: identity.userId,
      })
      return {
        success: true,
        user: {
          userId: identity.userId,
          name: identity.userId,
          externalGroups: [],
        },
      }
    }
  }

  async searchUsers(query: string, limit = 10): Promise<UserSearchResult[]> {
    try {
      const allUsers = await this.cache.getAllUsers()
      const lowerQuery = query.toLowerCase()
      return allUsers
        .filter(
          (u) =>
            u.name.toLowerCase().includes(lowerQuery) || u.email.toLowerCase().includes(lowerQuery),
        )
        .slice(0, limit)
    } catch {
      return []
    }
  }

  async getUserMetadata(userId: CanopyUserId): Promise<UserSearchResult | null> {
    try {
      return await this.cache.getUser(userId)
    } catch {
      return null
    }
  }

  async getGroupMetadata(groupId: CanopyGroupId): Promise<GroupMetadata | null> {
    try {
      return await this.cache.getGroup(groupId)
    } catch {
      return null
    }
  }

  async listGroups(limit = 50): Promise<GroupMetadata[]> {
    try {
      const allGroups = await this.cache.getAllGroups()
      return allGroups.slice(0, limit)
    } catch {
      return []
    }
  }
}
