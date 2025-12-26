import type { CanopyUserId, CanopyGroupId } from '../types'

/**
 * User context returned by auth plugins.
 *
 * Note: The `groups` array should contain group IDs from both the auth provider
 * (e.g., Clerk organizations) and internal CanopyCMS groups. The reserved groups
 * "Admins" and "Reviewers" have special meaning - see reserved-groups.ts.
 */
export interface AuthUser {
  userId: CanopyUserId
  groups?: CanopyGroupId[]
  email?: string
  name?: string
}

/**
 * User search result for permission UI
 */
export interface UserSearchResult {
  id: CanopyUserId
  name: string
  email: string
  avatarUrl?: string
}

/**
 * Group metadata for permission UI
 */
export interface GroupMetadata {
  id: CanopyGroupId
  name: string
  description?: string
  memberCount?: number
}

/**
 * Token verification result
 */
export interface TokenVerificationResult {
  valid: boolean
  user?: AuthUser
  error?: string
}
