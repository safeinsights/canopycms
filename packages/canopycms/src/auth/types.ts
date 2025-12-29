import type { CanopyUserId, CanopyGroupId } from '../types'
import type { AuthenticatedUser } from '../user'

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
 * Token verification result from auth plugins.
 * Returns an AuthenticatedUser on success.
 */
export interface TokenVerificationResult {
  valid: boolean
  user?: AuthenticatedUser
  error?: string
}
