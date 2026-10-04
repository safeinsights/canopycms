import type { CanopyUserId, CanopyGroupId } from '../types'

/** A user offered as a permission target. */
export interface UserSearchResult {
  id: CanopyUserId
  name: string
  email: string
  avatarUrl?: string
}

/** Group metadata for the permission UI. */
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
 * 'both' changes what a grant does. The two ID spaces are not namespaced against
 * each other and `checkPathPermission` matches one flattened `user.groups` list
 * by ID, so granting a colliding ID reaches the internal group's members AND
 * every provider user carrying that ID externally. Labeling such an option
 * merely 'internal' would understate that blast radius to the granting admin.
 */
export type GroupSource = 'internal' | 'external' | 'both'

/**
 * A group offered as a permission target by `permissions.listGroups`.
 *
 * Both universes are valid `allowedGroups` values -- `authResultToCanopyUser`
 * (user.ts) flattens external and internal groups into one `user.groups` list
 * that `checkPathPermission` matches by ID -- so the picker offers both, with
 * `source` disambiguating the two un-namespaced ID spaces in the UI.
 *
 * Internal options deliberately carry no `memberCount`: member identities and
 * counts stay behind the admin-only `groups.getInternal`, while this endpoint
 * only needs the `privileged` guard (authorization/helpers.ts's `isPrivileged`).
 */
export interface PermissionGroupOption extends GroupMetadata {
  source: GroupSource
}

/** An auth plugin's verdict: on success, user identity without final groups. */
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
