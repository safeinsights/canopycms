import type { CanopyUserId, CanopyGroupId } from './types'

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
