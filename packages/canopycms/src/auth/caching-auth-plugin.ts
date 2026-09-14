import type { AuthPlugin } from './plugin'
import type { UserSearchResult, GroupMetadata, AuthenticationResult } from './types'
import type { CanopyUserId, CanopyGroupId } from '../types'
import { createDebugLogger } from '../utils/debug'

const log = createDebugLogger({ prefix: 'CachingAuthPlugin' })

/** Auth-metadata cache backend: file-based, Redis, in-memory, whatever. */
export interface AuthCacheProvider {
  getUser(userId: CanopyUserId): Promise<UserSearchResult | null>
  getGroup(groupId: CanopyGroupId): Promise<GroupMetadata | null>
  getAllUsers(): Promise<UserSearchResult[]>
  getAllGroups(): Promise<GroupMetadata[]>
  getUserExternalGroups(userId: CanopyUserId): Promise<CanopyGroupId[]>
}

/** Extracts and verifies the request's auth token, yielding its user ID. */
export type TokenVerifier = (context: unknown) => Promise<{ userId: CanopyUserId } | null>

/**
 * Wraps a token verifier with cached metadata lookups, for environments where
 * the auth provider's API is unreachable (a Lambda with no internet): JWT
 * verification happens locally, and user/group metadata comes from a cache
 * populated externally by the EC2 worker. In dev an optional `lazyRefresher`
 * populates that cache on first request instead of `worker run-once`.
 *
 * The wrapper only FORWARDS the inner plugin's `verifiesCredentials`
 * affirmation, via the `options` param. It cannot launder an insecure plugin,
 * because createNextCanopyContext asserts the INNER plugin before wrapping
 * (context-wrapper.ts).
 */
export class CachingAuthPlugin implements AuthPlugin {
  private refreshPromise: Promise<void> | null = null
  readonly verifiesCredentials: boolean

  constructor(
    private readonly verifyToken: TokenVerifier,
    private readonly cache: AuthCacheProvider,
    private readonly lazyRefresher?: () => Promise<unknown>,
    options?: { verifiesCredentials?: boolean },
  ) {
    this.verifiesCredentials = options?.verifiesCredentials === true
  }

  private async ensureCachePopulated(): Promise<void> {
    if (!this.lazyRefresher) return
    // A shared promise, so concurrent callers coalesce into one refresh.
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
      // A cache failure must not reject an already-verified token: degrade to
      // the bare identity, with no external groups.
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
