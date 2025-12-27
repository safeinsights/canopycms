import { createClerkClient, verifyToken as clerkVerifyToken } from '@clerk/backend'
import type { CanopyRequest } from 'canopycms/http'
import type { AuthPlugin, AuthPluginFactory } from 'canopycms/auth'
import type { AuthUser, UserSearchResult, GroupMetadata, TokenVerificationResult } from 'canopycms/auth'

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

/**
 * Map Clerk user to CanopyCMS AuthUser.
 *
 * Note: CanopyCMS no longer uses roles from auth providers. Instead, permissions
 * are managed through internal groups (Admins, Reviewers) within CanopyCMS.
 * Organizations from Clerk are passed through as groups for ACL matching.
 */
const mapClerkUser = (
  clerkUser: any,
  organizationIds?: string[]
): AuthUser => {
  return {
    userId: clerkUser.id,
    email: clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.email_addresses?.[0]?.email_address,
    name: clerkUser.fullName ?? clerkUser.full_name ?? clerkUser.username ?? clerkUser.id,
    groups: organizationIds,
  }
}

/**
 * Extract token from request headers.
 * Looks for Bearer token in Authorization header or __session cookie.
 */
const extractToken = (req: CanopyRequest): string | null => {
  // Try Authorization header first
  const authHeader = req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  // Try __session cookie
  const cookie = req.header('Cookie')
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
      throw new Error('ClerkAuthPlugin: CLERK_SECRET_KEY environment variable or secretKey config is required')
    }

    const jwtKey = config.jwtKey ?? process.env.CLERK_JWT_KEY
    const authorizedParties = config.authorizedParties ?? process.env.CLERK_AUTHORIZED_PARTIES?.split(',').map(s => s.trim()).filter(Boolean)

    this.config = {
      useOrganizationsAsGroups: config.useOrganizationsAsGroups ?? true,
      secretKey,
      jwtKey,
      authorizedParties,
    }

    this.clerkClient = createClerkClient({ secretKey })
  }

  async verifyToken(req: CanopyRequest): Promise<TokenVerificationResult> {
    try {
      const token = extractToken(req)
      if (!token) {
        return { valid: false, error: 'No authentication token found' }
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
        return { valid: false, error: 'Invalid token payload' }
      }

      const userId = payload.sub

      // Get user details
      const clerkUser = await this.clerkClient.users.getUser(userId)

      // Get organizations if enabled - these become the user's groups
      let organizationIds: string[] | undefined
      if (this.config.useOrganizationsAsGroups) {
        const orgs = await this.clerkClient.users.getOrganizationMembershipList({
          userId: clerkUser.id,
        })
        const orgList = Array.isArray(orgs) ? orgs : orgs.data
        organizationIds = orgList.map((m: any) => m.organization.id)
      }

      const user = mapClerkUser(clerkUser, organizationIds)

      return { valid: true, user }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Token verification failed',
      }
    }
  }

  async searchUsers(query: string, limit = 10): Promise<UserSearchResult[]> {
    try {
      const response = await this.clerkClient.users.getUserList({
        query,
        limit,
      })

      const users = Array.isArray(response) ? response : response.data
      return users.map((u: any) => ({
        id: u.id,
        name: u.fullName ?? u.full_name ?? u.username ?? u.id,
        email: u.primaryEmailAddress?.emailAddress ?? u.email_addresses?.[0]?.email_address ?? '',
        avatarUrl: u.imageUrl ?? u.image_url,
      }))
    } catch (error) {
      console.error('ClerkAuthPlugin: searchUsers failed', error)
      return []
    }
  }

  async getUserMetadata(userId: string): Promise<UserSearchResult | null> {
    try {
      const user = await this.clerkClient.users.getUser(userId)
      return {
        id: user.id,
        name: user.fullName ?? (user as any).full_name ?? user.username ?? user.id,
        email: user.primaryEmailAddress?.emailAddress ?? (user as any).email_addresses?.[0]?.email_address ?? '',
        avatarUrl: user.imageUrl ?? (user as any).image_url,
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
      const org = await this.clerkClient.organizations.getOrganization({
        organizationId: groupId,
      })

      return {
        id: org.id,
        name: org.name,
        memberCount: org.membersCount ?? (org as any).members_count,
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
      const response = await this.clerkClient.organizations.getOrganizationList({ limit })
      const orgs = Array.isArray(response) ? response : response.data
      return orgs.map((o: any) => ({
        id: o.id,
        name: o.name,
        memberCount: o.membersCount ?? o.members_count,
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
