import fs from 'node:fs/promises'
import path from 'node:path'
import { createClerkClient } from '@clerk/backend'

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

  // Fetch all users
  const usersResponse = (await clerkClient.users.getUserList({
    limit: 500,
  })) as ClerkResponse<ClerkUserData>
  const clerkUsers = unwrapClerkResponse(usersResponse)

  const users = clerkUsers.map((u) => ({
    id: u.id,
    name:
      u.fullName ??
      u.full_name ??
      u.username ??
      u.id,
    email:
      u.primaryEmailAddress?.emailAddress ??
      u.email_addresses?.[0]?.email_address ??
      '',
    avatarUrl: (u.imageUrl ?? u.image_url) ?? undefined,
  }))

  let groups: Array<{ id: string; name: string; memberCount?: number }> = []
  const memberships: Record<string, string[]> = {}

  if (useOrganizationsAsGroups) {
    // Fetch all organizations
    const orgsResponse = (await clerkClient.organizations.getOrganizationList({
      limit: 100,
    })) as ClerkResponse<ClerkOrganization>
    const clerkOrgs = unwrapClerkResponse(orgsResponse)

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

  // Write cache files atomically
  await fs.mkdir(cachePath, { recursive: true })
  await writeJsonAtomic(path.join(cachePath, 'users.json'), { users })
  await writeJsonAtomic(path.join(cachePath, 'orgs.json'), { groups })
  await writeJsonAtomic(path.join(cachePath, 'memberships.json'), { memberships })

  return {
    userCount: users.length,
    groupCount: groups.length,
    membershipCount: Object.keys(memberships).length,
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmpPath, filePath)
}
