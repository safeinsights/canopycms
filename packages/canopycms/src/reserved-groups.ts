/**
 * Reserved groups for CanopyCMS permission system.
 *
 * These groups have special meaning and cannot be deleted or renamed.
 * - Admins: Full access to all CMS operations
 * - Reviewers: Can review branches, request changes, approve PRs
 */

export const RESERVED_GROUPS = {
  ADMINS: 'Admins',
  REVIEWERS: 'Reviewers',
} as const

export type ReservedGroupId = (typeof RESERVED_GROUPS)[keyof typeof RESERVED_GROUPS]

/**
 * Check if a group ID is a reserved group
 */
export const isReservedGroup = (groupId: string): groupId is ReservedGroupId =>
  Object.values(RESERVED_GROUPS).includes(groupId as ReservedGroupId)

/**
 * Check if user is in the Admins group
 */
export const isAdmin = (groups: readonly string[] | undefined): boolean =>
  groups?.includes(RESERVED_GROUPS.ADMINS) ?? false

/**
 * Check if user is in the Reviewers group (or is an Admin, since Admins can do everything)
 */
export const isReviewer = (groups: readonly string[] | undefined): boolean =>
  isAdmin(groups) || (groups?.includes(RESERVED_GROUPS.REVIEWERS) ?? false)

/**
 * Check if user has privileged access (Admin or Reviewer)
 * Used for operations that require elevated permissions but not full admin
 */
export const isPrivileged = (groups: readonly string[] | undefined): boolean => isReviewer(groups)
