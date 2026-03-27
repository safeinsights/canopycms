import type { UserSearchResult, GroupMetadata, AuthenticationResult } from './types'
import type { CanopyUserId, CanopyGroupId } from '../types'

/**
 * Abstract auth provider interface.
 * Implement this to integrate different auth systems (Clerk, Auth0, NextAuth, etc.)
 */
export interface AuthPlugin {
  /**
   * Authenticate user from request context.
   * Returns user identity (without final groups) - core will apply bootstrap admins.
   *
   * @param context - Framework-specific context (CanopyRequest, headers, etc.)
   * @returns AuthenticationResult with user identity or error
   */
  authenticate(context: unknown): Promise<AuthenticationResult>

  /**
   * Search for users (for permission management UI)
   * @param query - Search string (email, name, etc.)
   * @param limit - Max results (default 10)
   */
  searchUsers(query: string, limit?: number): Promise<UserSearchResult[]>

  /**
   * Get detailed user metadata by ID
   */
  getUserMetadata(userId: CanopyUserId): Promise<UserSearchResult | null>

  /**
   * Get group/organization metadata by ID
   */
  getGroupMetadata(groupId: CanopyGroupId): Promise<GroupMetadata | null>

  /**
   * List all groups (for permission UI dropdowns)
   */
  listGroups(limit?: number): Promise<GroupMetadata[]>

  /**
   * Search for external groups/organizations (for group management UI)
   * Optional - only needed if auth provider supports external groups
   * @param query - Search string (name, ID, etc.)
   */
  searchExternalGroups?(query: string): Promise<Array<{ id: CanopyGroupId; name: string }>>

  /**
   * Optional: lightweight token-only verification (no user metadata lookup, no network).
   * When present, createNextCanopyContext automatically wraps this plugin with
   * CachingAuthPlugin in prod/prod-sim modes. The cache is populated by the worker daemon.
   */
  verifyTokenOnly?(context: unknown): Promise<{ userId: CanopyUserId } | null>

  /**
   * Optional: create a function that refreshes the auth cache for this plugin.
   * Used by the worker daemon and CLI run-once to populate the file-based auth cache.
   * Returns undefined if this plugin doesn't support cache refresh (e.g., missing credentials).
   */
  createCacheRefresher?(
    cachePath: string,
  ): (() => Promise<{ userCount: number; groupCount: number }>) | undefined
}

/**
 * Factory function type for creating auth plugins
 */
export type AuthPluginFactory<TConfig = unknown> = (config: TConfig) => AuthPlugin
