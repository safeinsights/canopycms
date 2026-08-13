import { createClerkClient } from '@clerk/backend'
import { writeAuthCacheSnapshot } from 'canopycms/auth/cache'

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
  /**
   * Where a recoverable warning goes. Defaults to `console.warn`.
   *
   * The EC2 worker passes `workerLogWarn` here: everything it writes lands in
   * `/var/log/canopy-worker/worker.log`, where the CloudWatch agent's
   * `multi_line_start_pattern` treats a line WITHOUT an ISO-8601 prefix as a
   * continuation of the previous event rather than a new one - so an
   * unprefixed warning inherits a stale timestamp and loses its severity tag
   * (see `canopycms`'s `worker/log.ts`).
   *
   * Injected as a callback rather than imported: `canopycms` is only a PEER
   * dependency here, and reaching into its process-scoped logger would couple
   * this package to canopycms internals for one warning. The worker entrypoint
   * that already imports both is the natural place to join them.
   */
  warn?: (...args: unknown[]) => void
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
  const {
    secretKey,
    cachePath,
    useOrganizationsAsGroups = true,
    warn = (...args: unknown[]) => console.warn(...args),
  } = options

  const clerkClient = createClerkClient({ secretKey })

  // Fetch all users (paginate to handle large organizations)
  const clerkUsers: ClerkUserData[] = []
  const pageSize = 500
  let offset = 0
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
      } catch (err) {
        warn(
          `Failed to fetch memberships for user ${user.id}:`,
          err instanceof Error ? err.message : err,
        )
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
