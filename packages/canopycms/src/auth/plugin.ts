import type { NextRequest } from 'next/server'
import type { AuthUser, UserSearchResult, GroupMetadata, TokenVerificationResult } from './types'
import type { CanopyUserId, CanopyGroupId } from '../types'

/**
 * Abstract auth provider interface.
 * Implement this to integrate different auth systems (Clerk, Auth0, NextAuth, etc.)
 */
export interface AuthPlugin {
  /**
   * Verify token from request and return user context
   */
  verifyToken(req: NextRequest): Promise<TokenVerificationResult>

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
}

/**
 * Factory function type for creating auth plugins
 */
export type AuthPluginFactory<TConfig = unknown> = (config: TConfig) => AuthPlugin
