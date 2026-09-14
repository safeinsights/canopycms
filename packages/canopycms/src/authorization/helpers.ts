/**
 * Reserved groups for the CanopyCMS permission system; they cannot be deleted
 * or renamed. Admins have full access to every CMS operation; Reviewers can
 * review branches, request changes and approve PRs.
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

export function isReservedGroup(groupId: string): groupId is ReservedGroupId {
  return Object.values(RESERVED_GROUPS).includes(groupId as ReservedGroupId)
}

/**
 * Remove reserved privileged group IDs (Admins, Reviewers) from a group list.
 *
 * SECURITY: apply this to identity-provider group lists before merging them
 * into a user's effective groups, so a provider-controlled group name can never
 * grant CanopyCMS privilege. Non-reserved groups pass through unchanged and
 * remain usable for ordinary path/branch ACL membership.
 */
export function stripReservedGroups<T extends string>(groups: readonly T[]): T[] {
  return groups.filter((group) => !isReservedGroup(group))
}

export function isAdmin(groups: readonly string[] | undefined): boolean {
  return groups?.includes(RESERVED_GROUPS.ADMINS) ?? false
}

/** True for the Reviewers group and for Admins, who can do everything. */
export function isReviewer(groups: readonly string[] | undefined): boolean {
  return isAdmin(groups) || (groups?.includes(RESERVED_GROUPS.REVIEWERS) ?? false)
}

/** For operations that need elevated rights but not full admin. */
export function isPrivileged(groups: readonly string[] | undefined): boolean {
  return isReviewer(groups)
}
