import { createClerkClient, verifyToken as clerkVerifyToken } from '@clerk/backend'
import type { AuthPlugin, AuthPluginFactory } from 'canopycms/auth'
import type { UserSearchResult, GroupMetadata, AuthenticationResult } from 'canopycms/auth'
import { extractHeaders, type HeadersLike } from 'canopycms/auth'

export interface ClerkAuthConfig {
  /**
   * Use organizations as groups
   * @default true
   */
  useOrganizationsAsGroups?: boolean

  /**
   * Clerk Secret Key. If not provided, will use CLERK_SECRET_KEY env var.
   */
  secretKey?: string

  /**
   * PEM public key for networkless JWT verification.
   * If not provided, will use CLERK_JWT_KEY env var.
   */
  jwtKey?: string

  /**
   * List of authorized parties (domains) for CSRF protection.
   * If not provided, will parse from CLERK_AUTHORIZED_PARTIES env var.
   */
  authorizedParties?: string[]
}

// Clerk API Response Types
// These handle both camelCase and snake_case variants from different Clerk SDK versions

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
  totalCount?: number
}

type ClerkResponse<T> = T[] | ClerkPaginatedResponse<T>

/**
 * Unwrap Clerk paginated response to array.
 * Clerk SDK sometimes returns arrays directly, sometimes paginated objects.
 */
function unwrapClerkResponse<T>(response: ClerkResponse<T>): T[] {
  return Array.isArray(response) ? response : response.data
}

/**
 * Map Clerk user data to Canopy user metadata.
 * Handles both camelCase and snake_case property variants.
 */
function mapClerkUserData(clerkUser: ClerkUserData): {
  email?: string
  name: string
  avatarUrl?: string
} {
  const avatarUrl = clerkUser.imageUrl ?? clerkUser.image_url
  return {
    email:
      clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.email_addresses?.[0]?.email_address,
    name: clerkUser.fullName ?? clerkUser.full_name ?? clerkUser.username ?? clerkUser.id,
    avatarUrl: avatarUrl ?? undefined,
  }
}

/**
 * Get member count from organization, handling property name variants.
 */
function getOrgMemberCount(org: ClerkOrganization): number | undefined {
  return org.membersCount ?? org.members_count
}

/**
 * Extract token from headers.
 * Looks for Bearer token in Authorization header or __session cookie.
 */
const extractToken = (headers: HeadersLike): string | null => {
  // Try Authorization header first
  const authHeader = headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  // Try __session cookie
  const cookie = headers.get('Cookie')
  if (cookie) {
    const match = cookie.match(/__session=([^;]+)/)
    if (match) {
      return match[1]
    }
  }

  return null
}

/**
 * Clerk authentication plugin implementation for CanopyCMS.
 * Uses @clerk/backend for framework-agnostic JWT verification.
 */
export class ClerkAuthPlugin implements AuthPlugin {
  private config: Required<Omit<ClerkAuthConfig, 'secretKey' | 'jwtKey' | 'authorizedParties'>> & {
    secretKey: string
    jwtKey?: string
    authorizedParties?: string[]
  }
  private clerkClient: ReturnType<typeof createClerkClient>

  constructor(config: ClerkAuthConfig = {}) {
    const secretKey = config.secretKey ?? process.env.CLERK_SECRET_KEY
    if (!secretKey) {
      throw new Error(
        'ClerkAuthPlugin: CLERK_SECRET_KEY environment variable or secretKey config is required',
      )
    }

    const jwtKey = config.jwtKey ?? process.env.CLERK_JWT_KEY
    const authorizedParties =
      config.authorizedParties ??
      process.env.CLERK_AUTHORIZED_PARTIES?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)

    this.config = {
      useOrganizationsAsGroups: config.useOrganizationsAsGroups ?? true,
      secretKey,
      jwtKey,
      authorizedParties,
    }

    this.clerkClient = createClerkClient({ secretKey })
  }

  async authenticate(context: unknown): Promise<AuthenticationResult> {
    try {
      // Extract headers from context (supports CanopyRequest and Headers)
      const headers = extractHeaders(context)
      if (!headers) {
        return {
          success: false,
          error: 'Invalid context: expected CanopyRequest or Headers object',
        }
      }

      // Extract token from headers
      const token = extractToken(headers)
      if (!token) {
        return { success: false, error: 'No authentication token found' }
      }

      // Verify the token
      const verifyOptions: Parameters<typeof clerkVerifyToken>[1] = {
        secretKey: this.config.secretKey,
      }

      if (this.config.jwtKey) {
        verifyOptions.jwtKey = this.config.jwtKey
      }

      if (this.config.authorizedParties) {
        verifyOptions.authorizedParties = this.config.authorizedParties
      }

      const payload = await clerkVerifyToken(token, verifyOptions)

      if (!payload || !payload.sub) {
        return { success: false, error: 'Invalid token payload' }
      }

      const userId = payload.sub

      // Get user details from Clerk
      const clerkUser = (await this.clerkClient.users.getUser(userId)) as ClerkUserData

      // Get organizations as external groups
      let externalGroups: string[] | undefined
      if (this.config.useOrganizationsAsGroups) {
        const orgs = (await this.clerkClient.users.getOrganizationMembershipList({
          userId: clerkUser.id,
        })) as ClerkResponse<ClerkOrganizationMembership>

        const memberships = unwrapClerkResponse(orgs)
        externalGroups = memberships.map((m) => m.organization.id)
      }

      const userData = mapClerkUserData(clerkUser)

      // Return identity only - core will apply bootstrap admins
      return {
        success: true,
        user: {
          userId: clerkUser.id,
          ...userData,
          externalGroups,
        },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication failed',
      }
    }
  }

  async searchUsers(query: string, limit = 10): Promise<UserSearchResult[]> {
    try {
      const response = (await this.clerkClient.users.getUserList({
        query,
        limit,
      })) as ClerkResponse<ClerkUserData>

      const users = unwrapClerkResponse(response)
      return users.map((u) => {
        const mapped = mapClerkUserData(u)
        return {
          id: u.id,
          name: mapped.name,
          email: mapped.email ?? '',
          avatarUrl: mapped.avatarUrl,
        }
      })
    } catch (error) {
      console.error('ClerkAuthPlugin: searchUsers failed', error)
      return []
    }
  }

  async getUserMetadata(userId: string): Promise<UserSearchResult | null> {
    try {
      const user = (await this.clerkClient.users.getUser(userId)) as ClerkUserData
      const mapped = mapClerkUserData(user)
      return {
        id: user.id,
        name: mapped.name,
        email: mapped.email ?? '',
        avatarUrl: mapped.avatarUrl,
      }
    } catch (error) {
      console.error('ClerkAuthPlugin: getUserMetadata failed', error)
      return null
    }
  }

  async getGroupMetadata(groupId: string): Promise<GroupMetadata | null> {
    if (!this.config.useOrganizationsAsGroups) {
      return null
    }

    try {
      const org = (await this.clerkClient.organizations.getOrganization({
        organizationId: groupId,
      })) as ClerkOrganization

      return {
        id: org.id,
        name: org.name,
        memberCount: getOrgMemberCount(org),
      }
    } catch (error) {
      console.error('ClerkAuthPlugin: getGroupMetadata failed', error)
      return null
    }
  }

  async listGroups(limit = 50): Promise<GroupMetadata[]> {
    if (!this.config.useOrganizationsAsGroups) {
      return []
    }

    try {
      const response = (await this.clerkClient.organizations.getOrganizationList({
        limit,
      })) as ClerkResponse<ClerkOrganization>

      const orgs = unwrapClerkResponse(response)
      return orgs.map((o) => ({
        id: o.id,
        name: o.name,
        memberCount: getOrgMemberCount(o),
      }))
    } catch (error) {
      console.error('ClerkAuthPlugin: listGroups failed', error)
      return []
    }
  }
}

/**
 * Factory function to create a Clerk auth plugin instance
 */
export const createClerkAuthPlugin: AuthPluginFactory<ClerkAuthConfig> = (config) => {
  return new ClerkAuthPlugin(config)
}
