import type { CanopyUserId, CanopyGroupId } from './types'
import type { AuthenticationResult } from './auth/types'
// Import from client-safe subpaths to avoid pulling in server-only loader code
import { RESERVED_GROUPS, stripReservedGroups } from './authorization/helpers'
import type { InternalGroup } from './authorization/groups/schema'

/** Anonymous user — explicit public/unauthenticated access. */
export interface AnonymousUser {
  type: 'anonymous'
  userId: 'anonymous'
  groups: readonly []
}

/** Authenticated user — verified identity from the auth provider. */
export interface AuthenticatedUser {
  type: 'authenticated'
  userId: CanopyUserId
  groups: CanopyGroupId[]
  email?: string
  name?: string
  avatarUrl?: string
}

/** Unified user type for all CanopyCMS operations. */
export type CanopyUser = AnonymousUser | AuthenticatedUser

/** Pass this constant explicitly wherever anonymous access is intended. */
export const ANONYMOUS_USER: AnonymousUser = Object.freeze({
  type: 'anonymous',
  userId: 'anonymous',
  groups: [] as const,
}) as AnonymousUser

/**
 * Convert an authentication result to a CanopyUser: applies bootstrap admin groups, merges
 * internal groups, returns ANONYMOUS_USER when not authenticated. The SINGLE source of truth
 * for turning external auth into a CanopyUser.
 *
 * @param internalGroups - Internal groups from .canopycms/groups.json, loaded by the caller.
 */
export function authResultToCanopyUser(
  authResult: AuthenticationResult,
  bootstrapAdminIds: Set<string>,
  internalGroups?: InternalGroup[],
): CanopyUser {
  if (!authResult.success || !authResult.user) {
    return ANONYMOUS_USER
  }

  // SECURITY (SEC-H1): the privileged group IDs held in `RESERVED_GROUPS` are stripped from the
  // provider's list here, so a provider-controlled group name can never grant CanopyCMS
  // privilege. Reserved membership is added only below, from bootstrapAdminIds and
  // Canopy-managed internal groups.
  const groups = stripReservedGroups(authResult.user.externalGroups ?? [])

  if (bootstrapAdminIds.has(authResult.user.userId) && !groups.includes(RESERVED_GROUPS.ADMINS)) {
    groups.push(RESERVED_GROUPS.ADMINS)
  }

  // Internal groups from .canopycms/groups.json.
  if (internalGroups) {
    for (const group of internalGroups) {
      if (group.members.includes(authResult.user.userId) && !groups.includes(group.id)) {
        groups.push(group.id)
      }
    }
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
