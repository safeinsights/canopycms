import { auth, clerkClient } from '@clerk/nextjs/server'
import type { NextRequest } from 'next/server'
import type { AuthPlugin, AuthPluginFactory } from 'canopycms/auth'
import type { AuthUser, UserSearchResult, GroupMetadata, TokenVerificationResult } from 'canopycms/auth'

/**
 * Get Clerk client - handles both v5 (direct object) and v6 (async function)
 */
async function getClient() {
  return typeof clerkClient === 'function' ? await clerkClient() : clerkClient
}

export interface ClerkAuthConfig {
  /**
   * Use organizations as groups
   * @default true
   */
  useOrganizationsAsGroups?: boolean
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
    email: clerkUser.primaryEmailAddress?.emailAddress,
    name: clerkUser.fullName ?? clerkUser.username ?? clerkUser.id,
    groups: organizationIds,
  }
}

/**
 * Clerk authentication plugin implementation for CanopyCMS
 */
export class ClerkAuthPlugin implements AuthPlugin {
  private config: Required<ClerkAuthConfig>

  constructor(config: ClerkAuthConfig = {}) {
    this.config = {
      useOrganizationsAsGroups: config.useOrganizationsAsGroups ?? true,
    }

    if (!process.env.CLERK_SECRET_KEY) {
      throw new Error('ClerkAuthPlugin: CLERK_SECRET_KEY environment variable is required')
    }
  }

  async verifyToken(_req: NextRequest): Promise<TokenVerificationResult> {
    try {
      // Use Clerk's auth() helper which properly verifies the session
      // This works with Clerk's middleware and handles token verification internally
      const { userId, sessionId } = await auth()

      if (!userId || !sessionId) {
        return { valid: false, error: 'No authenticated session' }
      }

      const client = await getClient()

      // Get user details
      const clerkUser = await client.users.getUser(userId)

      // Get organizations if enabled - these become the user's groups
      let organizationIds: string[] | undefined
      if (this.config.useOrganizationsAsGroups) {
        const orgs = await client.users.getOrganizationMembershipList({
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
      const client = await getClient()
      const response = await client.users.getUserList({
        query,
        limit,
      })

      const users = Array.isArray(response) ? response : response.data
      return users.map((u: any) => ({
        id: u.id,
        name: u.fullName ?? u.username ?? u.id,
        email: u.primaryEmailAddress?.emailAddress ?? '',
        avatarUrl: u.imageUrl,
      }))
    } catch (error) {
      console.error('ClerkAuthPlugin: searchUsers failed', error)
      return []
    }
  }

  async getUserMetadata(userId: string): Promise<UserSearchResult | null> {
    try {
      const client = await getClient()
      const user = await client.users.getUser(userId)
      return {
        id: user.id,
        name: user.fullName ?? user.username ?? user.id,
        email: user.primaryEmailAddress?.emailAddress ?? '',
        avatarUrl: user.imageUrl,
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
      const client = await getClient()
      const org = await client.organizations.getOrganization({
        organizationId: groupId,
      })

      return {
        id: org.id,
        name: org.name,
        memberCount: org.membersCount,
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
      const client = await getClient()
      const response = await client.organizations.getOrganizationList({ limit })
      const orgs = Array.isArray(response) ? response : response.data
      return orgs.map((o: any) => ({
        id: o.id,
        name: o.name,
        memberCount: o.membersCount,
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
