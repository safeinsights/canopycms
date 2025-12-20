import { clerkClient } from '@clerk/nextjs/server'
import type { NextRequest } from 'next/server'
import type { AuthPlugin, AuthPluginFactory } from '../plugin'
import type { AuthUser, UserSearchResult, GroupMetadata, TokenVerificationResult } from '../types'
import type { Role } from '../../types'

export interface ClerkAuthConfig {
  /**
   * Clerk secret key (defaults to process.env.CLERK_SECRET_KEY)
   */
  secretKey?: string

  /**
   * Field in public metadata for role mapping
   * @default 'canopyRole'
   */
  roleMetadataKey?: string

  /**
   * Use organizations as groups
   * @default true
   */
  useOrganizationsAsGroups?: boolean
}

/**
 * Map Clerk user to CanopyCMS AuthUser
 */
const mapClerkUser = (clerkUser: any, roleKey: string, organizationIds?: string[]): AuthUser => {
  const role = clerkUser.publicMetadata?.[roleKey] as Role | undefined

  return {
    userId: clerkUser.id,
    email: clerkUser.primaryEmailAddress?.emailAddress,
    name: clerkUser.fullName ?? clerkUser.username ?? clerkUser.id,
    role: role ?? 'editor', // default to editor
    groups: organizationIds,
  }
}

/**
 * Clerk authentication plugin implementation
 */
export class ClerkAuthPlugin implements AuthPlugin {
  private config: Required<ClerkAuthConfig>

  constructor(config: ClerkAuthConfig = {}) {
    this.config = {
      secretKey: config.secretKey ?? process.env.CLERK_SECRET_KEY ?? '',
      roleMetadataKey: config.roleMetadataKey ?? 'canopyRole',
      useOrganizationsAsGroups: config.useOrganizationsAsGroups ?? true,
    }

    if (!this.config.secretKey) {
      throw new Error('ClerkAuthPlugin: CLERK_SECRET_KEY is required')
    }
  }

  async verifyToken(req: NextRequest): Promise<TokenVerificationResult> {
    try {
      // Extract session token from cookies
      const sessionToken = req.cookies.get('__session')?.value
      if (!sessionToken) {
        return { valid: false, error: 'No session token' }
      }

      // Verify with Clerk
      const session = await clerkClient.sessions.verifySession(sessionToken)
      if (!session) {
        return { valid: false, error: 'Invalid session' }
      }

      // Get user details
      const clerkUser = await clerkClient.users.getUser(session.userId)

      // Get organizations if enabled
      let organizationIds: string[] | undefined
      if (this.config.useOrganizationsAsGroups) {
        const orgs = await clerkClient.users.getOrganizationMembershipList({
          userId: clerkUser.id,
        })
        organizationIds = orgs.map((m) => m.organization.id)
      }

      const user = mapClerkUser(clerkUser, this.config.roleMetadataKey, organizationIds)

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
      const users = await clerkClient.users.getUserList({
        query,
        limit,
      })

      return users.map((u) => ({
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
      const user = await clerkClient.users.getUser(userId)
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
      const org = await clerkClient.organizations.getOrganization({
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
      const orgs = await clerkClient.organizations.getOrganizationList({ limit })
      return orgs.map((o) => ({
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
 * Factory for Clerk auth plugin
 */
export const createClerkAuthPlugin: AuthPluginFactory<ClerkAuthConfig> = (config) => {
  return new ClerkAuthPlugin(config)
}
