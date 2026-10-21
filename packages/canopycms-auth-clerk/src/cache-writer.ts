import { createClerkClient } from '@clerk/backend'
import { writeAuthSnapshot, type AuthCacheSnapshot } from 'canopycms/auth/cache'
import { toUserSearchResult, type ClerkUserData } from './clerk-user'

interface ClerkOrganization {
  id: string
  name: string
  membersCount?: number
  members_count?: number
}

interface ClerkOrganizationMembership {
  organization?: ClerkOrganization
  publicUserData?: { userId?: string }
}

interface ClerkPaginatedResponse<T> {
  data: T[]
}

type ClerkResponse<T> = T[] | ClerkPaginatedResponse<T>

function unwrapClerkResponse<T>(response: ClerkResponse<T>): T[] {
  return Array.isArray(response) ? response : response.data
}

/** Read structurally: a peer-dependency copy of `@clerk/backend` defeats `instanceof`. */
function clerkErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined
  const status = (err as { status: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/** The first Clerk error code (`ClerkAPIResponseError.errors[0].code`), if there is one. */
function clerkErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('errors' in err)) return undefined
  const { errors } = err as { errors: unknown }
  if (!Array.isArray(errors)) return undefined
  const first: unknown = errors[0]
  if (typeof first !== 'object' || first === null || !('code' in first)) return undefined
  const { code } = first as { code: unknown }
  return typeof code === 'string' ? code : undefined
}

export interface FetchClerkSnapshotOptions {
  /** Clerk Secret Key (CLERK_SECRET_KEY) */
  secretKey: string
  /** Whether to treat Clerk organizations as groups (default: true) */
  useOrganizationsAsGroups?: boolean
  /**
   * Where a recoverable warning goes. Defaults to `console.warn`; the EC2
   * worker passes `workerLogWarn` (see canopycms's `worker/log.ts`).
   *
   * Every warning here must start with an ISO-8601 timestamp: an unprefixed
   * line inherits the previous line's timestamp under CloudWatch's
   * `multi_line_start_pattern`, merging into that event and losing its own
   * severity tag.
   *
   * Injected as a callback rather than imported: `canopycms` is only a peer
   * dependency here, so this package doesn't reach into its process-scoped
   * logger for one warning.
   */
  warn?: (...args: unknown[]) => void
}

export interface RefreshClerkCacheOptions extends FetchClerkSnapshotOptions {
  /** Directory to write cache files to (e.g., /mnt/efs/.cache) */
  cachePath: string
}

export interface RefreshClerkCacheResult {
  userCount: number
  groupCount: number
  membershipCount: number
}

/** Fetches all user/org metadata from the Clerk API as one snapshot, writing nothing. */
export async function fetchClerkSnapshot(
  options: FetchClerkSnapshotOptions,
): Promise<AuthCacheSnapshot> {
  const {
    secretKey,
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

  const users = clerkUsers.map(toUserSearchResult)

  if (!useOrganizationsAsGroups) return { users, groups: [], memberships: {} }

  try {
    const clerkOrgs: ClerkOrganization[] = []
    let orgOffset = 0
    while (true) {
      const orgsResponse = (await clerkClient.organizations.getOrganizationList({
        limit: pageSize,
        offset: orgOffset,
      })) as ClerkResponse<ClerkOrganization>
      const page = unwrapClerkResponse(orgsResponse)
      clerkOrgs.push(...page)
      if (page.length < pageSize) break
      orgOffset += pageSize
    }

    // Oldest first, so a membership added mid-paging lands on a later page, not a shifted one.
    const memberSets = new Map<string, Set<string>>()
    let membershipOffset = 0
    while (true) {
      const membershipResponse =
        (await clerkClient.organizations.getInstanceOrganizationMembershipList({
          limit: pageSize,
          offset: membershipOffset,
          orderBy: '+created_at',
        })) as ClerkResponse<ClerkOrganizationMembership>
      const page = unwrapClerkResponse(membershipResponse)
      for (const membership of page) {
        const userId = membership.publicUserData?.userId
        const orgId = membership.organization?.id
        if (!userId || !orgId) continue
        const orgIds = memberSets.get(userId) ?? new Set<string>()
        orgIds.add(orgId)
        memberSets.set(userId, orgIds)
      }
      if (page.length < pageSize) break
      membershipOffset += pageSize
    }

    const memberships: Record<string, string[]> = {}
    for (const [userId, orgIds] of memberSets) memberships[userId] = [...orgIds]

    const groups = clerkOrgs.map((o) => ({
      id: o.id,
      name: o.name,
      memberCount: o.membersCount ?? o.members_count,
    }))
    return { users, groups, memberships }
  } catch (err) {
    // A 403 after the user list succeeded is not a rejected key: the instance refuses the
    // Organizations API. Empty, not the stale groups, so an org-ID ACL grants nothing (fail
    // closed). Anything else rethrows and the caller keeps the last good snapshot.
    if (clerkErrorStatus(err) !== 403) throw err
    const code = clerkErrorCode(err)
    warn(
      `Clerk refused the Organizations API (403${code ? ` ${code}` : ''}): Organizations is ` +
        'probably disabled on this Clerk instance. Writing users with no groups; set ' +
        'clerkOrganizationsAsGroups: false (CANOPYCMS_CLERK_ORGANIZATIONS_AS_GROUPS=false) to ' +
        'stop asking.',
    )
    return { users, groups: [], memberships: {} }
  }
}

/**
 * Fetches the snapshot ({@link fetchClerkSnapshot}) and writes it atomically
 * via writeAuthSnapshot (canopycms/auth/cache); FileBasedAuthCache reads it back.
 *
 * Output files:
 * - {cachePath}/users.json    — { users: UserSearchResult[] }
 * - {cachePath}/orgs.json     — { groups: GroupMetadata[] }
 * - {cachePath}/memberships.json — { memberships: { [userId]: groupId[] } }
 */
export async function refreshClerkCache(
  options: RefreshClerkCacheOptions,
): Promise<RefreshClerkCacheResult> {
  const { cachePath, ...fetchOptions } = options
  const snapshot = await fetchClerkSnapshot(fetchOptions)
  await writeAuthSnapshot(cachePath, snapshot)

  return {
    userCount: snapshot.users.length,
    groupCount: snapshot.groups.length,
    membershipCount: Object.keys(snapshot.memberships).length,
  }
}
