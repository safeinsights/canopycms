/**
 * Authorization helper functions
 *
 * Simple utilities for checking user roles and permissions.
 */

/**
 * Reserved groups for CanopyCMS permission system.
 *
 * These groups have special meaning and cannot be deleted or renamed.
 * - Admins: Full access to all CMS operations
 * - Reviewers: Can review branches, request changes, approve PRs
 *
 * SECURITY: membership in a reserved group grants privilege, so these IDs must
 * only ever come from Canopy-managed sources (internal groups in
 * .canopycms/groups.json and bootstrapAdminIds) — never from an identity
 * provider's group list. Use stripReservedGroups() on any provider-supplied
 * group list before merging it into a user's effective groups.
 */
export const RESERVED_GROUPS = {
  ADMINS: 'Admins',
  REVIEWERS: 'Reviewers',
} as const

export type ReservedGroupId = (typeof RESERVED_GROUPS)[keyof typeof RESERVED_GROUPS]

/**
 * Check if a group ID is a reserved group
 */
export function isReservedGroup(groupId: string): groupId is ReservedGroupId {
  return Object.values(RESERVED_GROUPS).includes(groupId as ReservedGroupId)
}

/**
 * Remove reserved privileged group IDs (Admins, Reviewers) from a group list.
 *
 * SECURITY (SEC-H1): apply this to externally-supplied group lists (identity
 * provider groups) before merging them into a user's effective groups, so a
 * provider-controlled group name can never grant CanopyCMS privilege.
 * Non-reserved groups pass through unchanged and remain usable for ordinary
 * path/branch ACL membership.
 */
export function stripReservedGroups<T extends string>(groups: readonly T[]): T[] {
  return groups.filter((group) => !isReservedGroup(group))
}

/**
 * Check if user is in the Admins group
 */
export function isAdmin(groups: readonly string[] | undefined): boolean {
  return groups?.includes(RESERVED_GROUPS.ADMINS) ?? false
}

/**
 * Check if user is in the Reviewers group (or is an Admin, since Admins can do everything)
 */
export function isReviewer(groups: readonly string[] | undefined): boolean {
  return isAdmin(groups) || (groups?.includes(RESERVED_GROUPS.REVIEWERS) ?? false)
}

/**
 * Check if user has privileged access (Admin or Reviewer)
 * Used for operations that require elevated permissions but not full admin
 */
export function isPrivileged(groups: readonly string[] | undefined): boolean {
  return isReviewer(groups)
}
