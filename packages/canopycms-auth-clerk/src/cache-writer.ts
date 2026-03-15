import { createClerkClient } from '@clerk/backend'
import { writeAuthCacheSnapshot } from 'canopycms/auth'

/**
 * Response types that handle both camelCase and snake_case Clerk SDK variants.
 */
interface ClerkUserData {
  id: string
  username?: string
  fullName?: string | null
  full_name?: string | null
  imageUrl?: string | null
  image_url?: string | null
  primaryEmailAddress?: { emailAddress: string } | null
  email_addresses?: Array<{ email_address: string }> | null
}

interface ClerkOrganization {
  id: string
  name: string
  membersCount?: number
  members_count?: number
}

interface ClerkOrganizationMembership {
  organization: ClerkOrganization
}

interface ClerkPaginatedResponse<T> {
  data: T[]
}

type ClerkResponse<T> = T[] | ClerkPaginatedResponse<T>

function unwrapClerkResponse<T>(response: ClerkResponse<T>): T[] {
  return Array.isArray(response) ? response : response.data
}

export interface RefreshClerkCacheOptions {
  /** Clerk Secret Key (CLERK_SECRET_KEY) */
  secretKey: string
  /** Directory to write cache files to (e.g., /mnt/efs/workspace/.cache) */
  cachePath: string
  /** Whether to treat Clerk organizations as groups (default: true) */
  useOrganizationsAsGroups?: boolean
}

export interface RefreshClerkCacheResult {
  userCount: number
  groupCount: number
  membershipCount: number
}

/**
 * Fetches all user/org metadata from Clerk API and writes to JSON cache files.
 *
 * Used by the EC2 worker to populate the cache that FileBasedAuthCache reads.
 * Writes atomically (write to temp file, then rename) to avoid partial reads.
 *
 * Output files:
 * - {cachePath}/users.json    — { users: UserSearchResult[] }
 * - {cachePath}/orgs.json     — { groups: GroupMetadata[] }
 * - {cachePath}/memberships.json — { memberships: { [userId]: groupId[] } }
 */
export async function refreshClerkCache(
  options: RefreshClerkCacheOptions,
): Promise<RefreshClerkCacheResult> {
  const { secretKey, cachePath, useOrganizationsAsGroups = true } = options

  const clerkClient = createClerkClient({ secretKey })

  // Fetch all users (paginate to handle large organizations)
  const clerkUsers: ClerkUserData[] = []
  const pageSize = 500
  let offset = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const usersResponse = (await clerkClient.users.getUserList({
      limit: pageSize,
      offset,
    })) as ClerkResponse<ClerkUserData>
    const page = unwrapClerkResponse(usersResponse)
    clerkUsers.push(...page)
    if (page.length < pageSize) break
    offset += pageSize
  }

  const users = clerkUsers.map((u) => ({
    id: u.id,
    name: u.fullName ?? u.full_name ?? u.username ?? u.id,
    email: u.primaryEmailAddress?.emailAddress ?? u.email_addresses?.[0]?.email_address ?? '',
    avatarUrl: u.imageUrl ?? u.image_url ?? undefined,
  }))

  let groups: Array<{ id: string; name: string; memberCount?: number }> = []
  const memberships: Record<string, string[]> = {}

  if (useOrganizationsAsGroups) {
    // Fetch all organizations (paginate)
    const clerkOrgs: ClerkOrganization[] = []
    let orgOffset = 0
    const orgPageSize = 100
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const orgsResponse = (await clerkClient.organizations.getOrganizationList({
        limit: orgPageSize,
        offset: orgOffset,
      })) as ClerkResponse<ClerkOrganization>
      const page = unwrapClerkResponse(orgsResponse)
      clerkOrgs.push(...page)
      if (page.length < orgPageSize) break
      orgOffset += orgPageSize
    }

    groups = clerkOrgs.map((o) => ({
      id: o.id,
      name: o.name,
      memberCount: o.membersCount ?? o.members_count,
    }))

    // Fetch memberships per user
    for (const user of clerkUsers) {
      try {
        const membershipResponse = (await clerkClient.users.getOrganizationMembershipList({
          userId: user.id,
        })) as ClerkResponse<ClerkOrganizationMembership>
        const userMemberships = unwrapClerkResponse(membershipResponse)
        if (userMemberships.length > 0) {
          memberships[user.id] = userMemberships.map((m) => m.organization.id)
        }
      } catch {
        // Skip users whose memberships can't be fetched
      }
    }
  }

  // Write cache files atomically via snapshot directory + symlink swap
  await writeAuthCacheSnapshot(cachePath, {
    'users.json': { users },
    'orgs.json': { groups },
    'memberships.json': { memberships },
  })

  return {
    userCount: users.length,
    groupCount: groups.length,
    membershipCount: Object.keys(memberships).length,
  }
}
