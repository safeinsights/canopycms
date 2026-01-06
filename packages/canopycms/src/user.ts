import type { CanopyUserId, CanopyGroupId } from './types'
import type { AuthenticationResult } from './auth/types'
import { RESERVED_GROUPS } from './reserved-groups'

/**
 * Anonymous user - explicitly marked for public/unauthenticated access
 */
export interface AnonymousUser {
  type: 'anonymous'
  userId: 'anonymous'
  groups: readonly []
}

/**
 * Authenticated user - verified identity from auth provider
 */
export interface AuthenticatedUser {
  type: 'authenticated'
  userId: CanopyUserId
  groups: CanopyGroupId[]
  email?: string
  name?: string
  avatarUrl?: string
}

/**
 * Unified user type for all CanopyCMS operations
 */
export type CanopyUser = AnonymousUser | AuthenticatedUser

/**
 * Branded ANONYMOUS_USER constant - use this for intentional anonymous access.
 * Callers must explicitly pass this to indicate anonymous access is intended.
 */
export const ANONYMOUS_USER: AnonymousUser = Object.freeze({
  type: 'anonymous',
  userId: 'anonymous',
  groups: [] as const,
}) as AnonymousUser

/**
 * Type guard for anonymous user
 */
export const isAnonymousUser = (user: CanopyUser): user is AnonymousUser =>
  user.type === 'anonymous'

/**
 * Type guard for authenticated user
 */
export const isAuthenticatedUser = (user: CanopyUser): user is AuthenticatedUser =>
  user.type === 'authenticated'

/**
 * Create an authenticated user from auth provider data
 */
export const createAuthenticatedUser = (data: {
  userId: CanopyUserId
  groups?: CanopyGroupId[]
  email?: string
  name?: string
  avatarUrl?: string
}): AuthenticatedUser => ({
  type: 'authenticated',
  userId: data.userId,
  groups: data.groups ?? [],
  email: data.email,
  name: data.name,
  avatarUrl: data.avatarUrl,
})

/**
 * Convert authentication result to CanopyUser.
 * Applies bootstrap admin groups and returns ANONYMOUS_USER if not authenticated.
 *
 * This is the SINGLE source of truth for converting external auth to CanopyUser.
 *
 * @param authResult - Result from auth plugin's authenticate() method
 * @param bootstrapAdminIds - Set of user IDs that should always be admins
 * @returns CanopyUser (either authenticated with groups or ANONYMOUS_USER)
 */
export function authResultToCanopyUser(
  authResult: AuthenticationResult,
  bootstrapAdminIds: Set<string>
): CanopyUser {
  if (!authResult.success || !authResult.user) {
    return ANONYMOUS_USER
  }

  // Start with external groups from auth provider
  const groups = [...(authResult.user.externalGroups ?? [])]

  // Add Admins group if user is in bootstrap admin list
  if (bootstrapAdminIds.has(authResult.user.userId) && !groups.includes(RESERVED_GROUPS.ADMINS)) {
    groups.push(RESERVED_GROUPS.ADMINS)
  }

  return {
    type: 'authenticated',
    userId: authResult.user.userId,
    email: authResult.user.email,
    name: authResult.user.name,
    avatarUrl: authResult.user.avatarUrl,
    groups,
  }
}
