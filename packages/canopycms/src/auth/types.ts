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
 * Where a group offered as a permission target came from: the auth provider
 * ('external'), Canopy's own groups.json ('internal'), or BOTH -- the same ID
 * exists in each universe.
 *
 * 'both' matters for what a grant actually does. The two ID spaces are not
 * namespaced against each other, and `checkPathPermission` matches one
 * flattened `user.groups` list by ID, so granting a colliding ID reaches the
 * internal group's members AND every provider user whose external groups
 * include that ID. Labeling such an option merely 'internal' would understate
 * its blast radius to the admin making the grant.
 */
export type GroupSource = 'internal' | 'external' | 'both'

/**
 * A group offered as a permission target by `permissions.listGroups`.
 *
 * Both universes are valid `allowedGroups` values -- `authResultToCanopyUser`
 * (user.ts) flattens external and internal groups into one `user.groups` list
 * and `checkPathPermission` matches `allowedGroups` against it by ID -- so the
 * picker has to offer both. The two ID spaces are not namespaced against each
 * other, hence `source` to disambiguate them in the UI.
 *
 * Internal options deliberately carry no `memberCount`: member identities and
 * counts stay behind the admin-only `groups.getInternal`, while this endpoint
 * is `privileged` (admin or reviewer).
 */
export interface PermissionGroupOption extends GroupMetadata {
  source: GroupSource
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
