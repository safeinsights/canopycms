import type { AuthPlugin } from 'canopycms/auth'
import type { UserSearchResult, GroupMetadata, AuthenticationResult } from 'canopycms/auth'
import { extractHeaders } from 'canopycms/auth'
import type { CanopyUserId, CanopyGroupId } from 'canopycms'
import { getDevUserCookieFromHeaders } from './cookie-utils'

/**
 * WARNING: This plugin is for development and testing only!
 * Do not use in production environments.
 */

export interface DevUser {
  userId: CanopyUserId
  name: string
  email: string
  avatarUrl?: string
  externalGroups: CanopyGroupId[]
}

export interface DevGroup {
  id: CanopyGroupId
  name: string
  description?: string
}

export const DEV_ADMIN_USER_ID: CanopyUserId = 'dev_admin_3xY6zW1qR5'

export interface DevAuthConfig {
  /**
   * Custom mock users. If not provided, uses default users.
   */
  users?: DevUser[]

  /**
   * Custom mock groups. If not provided, uses default groups.
   */
  groups?: DevGroup[]

  /**
   * Default user ID when no user is selected.
   * @default 'dev_user1_2nK8mP4xL9' (user1)
   */
  defaultUserId?: CanopyUserId

  /**
   * Whether to auto-set CANOPY_BOOTSTRAP_ADMIN_IDS for the admin dev user
   * when the env var is not already set. Defaults to true.
   */
  autoBootstrapAdmin?: boolean
}

export const DEFAULT_USERS: DevUser[] = [
  {
    userId: 'dev_user1_2nK8mP4xL9',
    name: 'User One',
    email: 'user1@localhost.dev',
    externalGroups: ['team-a', 'team-b'],
  },
  {
    userId: 'dev_user2_7qR3tY6wN2',
    name: 'User Two',
    email: 'user2@localhost.dev',
    externalGroups: ['team-b'],
  },
  {
    userId: 'dev_user3_5vS1pM8kJ4',
    name: 'User Three',
    email: 'user3@localhost.dev',
    externalGroups: ['team-c'],
  },
  {
    userId: 'dev_reviewer_9aB4cD2eF7',
    name: 'Reviewer One',
    email: 'reviewer1@localhost.dev',
    externalGroups: ['team-a'],
    // Note: 'Reviewers' membership comes from internal groups file, not auth plugin
  },
  {
    userId: DEV_ADMIN_USER_ID,
    name: 'Admin One',
    email: 'admin1@localhost.dev',
    externalGroups: ['team-a', 'team-b', 'team-c'],
    // Note: Does NOT include 'Admins' - that's applied by bootstrap admin config or auto-bootstrap
  },
]

export const DEFAULT_GROUPS: DevGroup[] = [
  { id: 'team-a', name: 'Team A', description: 'Team A' },
  { id: 'team-b', name: 'Team B', description: 'Team B' },
  { id: 'team-c', name: 'Team C', description: 'Team C' },
]

/**
 * Dev authentication plugin implementation for CanopyCMS.
 * Supports both cookie-based (UI) and header-based (tests) authentication.
 */
export class DevAuthPlugin implements AuthPlugin {
  private users: DevUser[]
  private groups: DevGroup[]
  private defaultUserId: CanopyUserId

  constructor(config: DevAuthConfig = {}) {
    this.users = config.users ?? DEFAULT_USERS
    this.groups = config.groups ?? DEFAULT_GROUPS
    this.defaultUserId = config.defaultUserId ?? 'dev_user1_2nK8mP4xL9'
  }

  async verifyTokenOnly(context: unknown): Promise<{ userId: string } | null> {
    const headers = extractHeaders(context)
    if (!headers) return null
    let userId = headers.get('X-Test-User')
    if (!userId) userId = headers.get('x-dev-user-id') ?? getDevUserCookieFromHeaders(headers)
    if (!userId) userId = this.defaultUserId
    return { userId: this.mapTestUserKey(userId) }
  }

  async authenticate(context: unknown): Promise<AuthenticationResult> {
    // 1. Extract headers using extractHeaders() helper
    const headers = extractHeaders(context)
    if (!headers) {
      return { success: false, error: 'Invalid context' }
    }

    // 2. Check X-Test-User header (for test-app compatibility) FIRST
    let userId = headers.get('X-Test-User')

    // 3. If no test header, check x-dev-user-id header OR canopy-dev-user cookie
    if (!userId) {
      userId = headers.get('x-dev-user-id') ?? getDevUserCookieFromHeaders(headers)
    }

    // 4. Fall back to default user
    if (!userId) {
      userId = this.defaultUserId
    }

    // 5. Map test user keys to dev user IDs for test compatibility
    const userIdMapped = this.mapTestUserKey(userId)

    // 6. Find user in config
    const user = this.users.find((u) => u.userId === userIdMapped)
    if (!user) {
      return { success: false, error: `Dev user not found: ${userId}` }
    }

    // 7. Return AuthenticationResult with externalGroups
    return {
      success: true,
      user: {
        userId: user.userId,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        externalGroups: user.externalGroups,
      },
    }
  }

  /**
   * Map test-app user keys to dev user IDs for backward compatibility
   */
  private mapTestUserKey(key: string): CanopyUserId {
    const testUserMap: Record<string, CanopyUserId> = {
      admin: DEV_ADMIN_USER_ID, // admin1
      editor: 'dev_user1_2nK8mP4xL9', // user1
      viewer: 'dev_user2_7qR3tY6wN2', // user2
      reviewer: 'dev_reviewer_9aB4cD2eF7', // reviewer1
    }
    return testUserMap[key] ?? key
  }

  async searchUsers(query: string, limit?: number): Promise<UserSearchResult[]> {
    const lowerQuery = query.toLowerCase()
    const filtered = this.users.filter(
      (u) =>
        u.name.toLowerCase().includes(lowerQuery) || u.email.toLowerCase().includes(lowerQuery),
    )

    const results = filtered.slice(0, limit)
    return results.map((u) => ({
      id: u.userId,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
    }))
  }

  async getUserMetadata(userId: CanopyUserId): Promise<UserSearchResult | null> {
    const user = this.users.find((u) => u.userId === userId)
    if (!user) return null

    return {
      id: user.userId,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
    }
  }

  async getGroupMetadata(groupId: CanopyGroupId): Promise<GroupMetadata | null> {
    const group = this.groups.find((g) => g.id === groupId)
    if (!group) return null

    return {
      id: group.id,
      name: group.name,
      description: group.description,
    }
  }

  async listGroups(limit?: number): Promise<GroupMetadata[]> {
    const groups = limit ? this.groups.slice(0, limit) : this.groups
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
    }))
  }

  async searchExternalGroups(query: string): Promise<Array<{ id: CanopyGroupId; name: string }>> {
    const lowerQuery = query.toLowerCase()
    return this.groups
      .filter((g) => g.name.toLowerCase().includes(lowerQuery))
      .map((g) => ({
        id: g.id,
        name: g.name,
      }))
  }

  createCacheRefresher(cachePath: string) {
    const users = this.users
    const groups = this.groups
    return async () => {
      const { refreshDevCache } = await import('./cache-writer')
      return refreshDevCache({ cachePath, users, groups })
    }
  }
}

/**
 * Factory function for creating dev auth plugin.
 * By default, auto-sets CANOPY_BOOTSTRAP_ADMIN_IDS to the admin dev user
 * if the env var is not already set. Disable with { autoBootstrapAdmin: false }.
 */
export function createDevAuthPlugin(config?: DevAuthConfig): AuthPlugin {
  const shouldAutoBootstrap = config?.autoBootstrapAdmin ?? true
  if (shouldAutoBootstrap && !process.env.CANOPY_BOOTSTRAP_ADMIN_IDS) {
    const users = config?.users ?? DEFAULT_USERS
    const adminUser = users.find((u) => u.userId === DEV_ADMIN_USER_ID)
    if (adminUser) {
      process.env.CANOPY_BOOTSTRAP_ADMIN_IDS = adminUser.userId
      console.info(
        `CanopyCMS dev-auth: Auto-configured ${adminUser.name} (${adminUser.userId}) as bootstrap admin. ` +
          `Set CANOPY_BOOTSTRAP_ADMIN_IDS env var or pass autoBootstrapAdmin: false to override.`,
      )
    }
  }
  return new DevAuthPlugin(config ?? {})
}
