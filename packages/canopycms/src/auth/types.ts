import type { CanopyUserId, CanopyGroupId } from '../types'

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
 * Authentication result from auth plugins.
 * Returns user identity (without final groups) on success.
 */
export interface AuthenticationResult {
  success: boolean
  user?: {
    userId: CanopyUserId
    email?: string
    name?: string
    avatarUrl?: string
    /** Groups from external auth provider (e.g., Clerk organizations) */
    externalGroups?: CanopyGroupId[]
  }
  error?: string
}
