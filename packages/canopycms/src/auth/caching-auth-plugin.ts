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
 */
export class CachingAuthPlugin implements AuthPlugin {
  constructor(
    private readonly verifyToken: TokenVerifier,
    private readonly cache: AuthCacheProvider,
  ) {}

  async authenticate(context: unknown): Promise<AuthenticationResult> {
    const identity = await this.verifyToken(context)
    if (!identity) {
      return { success: false, error: 'No valid authentication token' }
    }

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
    } catch (err) {
      // Cache error — still return authenticated with minimal info
      log.debug('auth', 'Cache lookup failed, returning minimal user', { userId: identity.userId })
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
        .slice(0, Math.max(1, limit))
    } catch {
      return []
    }
  }

  async getUserMetadata(userId: CanopyUserId): Promise<UserSearchResult | null> {
    return this.cache.getUser(userId)
  }

  async getGroupMetadata(groupId: CanopyGroupId): Promise<GroupMetadata | null> {
    return this.cache.getGroup(groupId)
  }

  async listGroups(limit = 50): Promise<GroupMetadata[]> {
    try {
      const allGroups = await this.cache.getAllGroups()
      return allGroups.slice(0, Math.max(1, limit))
    } catch {
      return []
    }
  }
}
