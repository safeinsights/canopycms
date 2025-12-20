import type { CanopyUserId, CanopyGroupId, Role } from '../types'

/**
 * User context returned by auth plugins
 */
export interface AuthUser {
  userId: CanopyUserId
  groups?: CanopyGroupId[]
  role?: Role
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
