import type { AuthPlugin } from '../../auth/plugin'
import type { AuthenticatedUser } from '../../user'
import type { UserSearchResult, GroupMetadata, AuthenticationResult } from '../../auth/types'
import type { CanopyUserId, CanopyGroupId } from '../../types'

export type TestUserRole = 'admin' | 'reviewer' | 'editor'

export interface TestUser {
  userId: CanopyUserId
  name: string
  email: string
  role: TestUserRole
  groups: CanopyGroupId[]
}

/**
 * Predefined test user personas with different permission levels
 */
export const TEST_USERS: Record<TestUserRole, TestUser> = {
  admin: {
    userId: 'test-admin',
    name: 'Admin User',
    email: 'admin@test.local',
    role: 'admin',
    groups: ['Admins'], // Reserved group with full access
  },
  reviewer: {
    userId: 'test-reviewer',
    name: 'Reviewer User',
    email: 'reviewer@test.local',
    role: 'reviewer',
    groups: ['Reviewers'], // Reserved group with review access
  },
  editor: {
    userId: 'test-editor',
    name: 'Editor User',
    email: 'editor@test.local',
    role: 'editor',
    groups: ['ContentEditors'], // Custom group with limited access
  },
}

/**
 * Convert test user persona to AuthenticatedUser
 */
export function createTestUser(role: TestUserRole): AuthenticatedUser {
  const user = TEST_USERS[role]
  return {
    type: 'authenticated',
    userId: user.userId,
    email: user.email,
    name: user.name,
    groups: user.groups,
  }
}

/**
 * Create a mock auth plugin for integration tests.
 * Allows switching between test users to simulate multi-user scenarios.
 */
export function createMockAuthPlugin(currentRole: TestUserRole): AuthPlugin {
  const currentUser = TEST_USERS[currentRole]

  return {
    async authenticate(_context: unknown): Promise<AuthenticationResult> {
      const testUser = createTestUser(currentRole)
      return {
        success: true,
        user: {
          userId: testUser.userId,
          email: testUser.email,
          name: testUser.name,
          externalGroups: testUser.groups,
        },
      }
    },

    async searchUsers(query: string, limit = 10): Promise<UserSearchResult[]> {
      const allUsers = Object.values(TEST_USERS)
      return allUsers
        .filter((u) => u.name.toLowerCase().includes(query.toLowerCase()) || u.email.toLowerCase().includes(query.toLowerCase()))
        .slice(0, limit)
        .map((u) => ({
          id: u.userId,
          name: u.name,
          email: u.email,
        }))
    },

    async getUserMetadata(userId: CanopyUserId): Promise<UserSearchResult | null> {
      const user = Object.values(TEST_USERS).find((u) => u.userId === userId)
      return user
        ? {
            id: user.userId,
            name: user.name,
            email: user.email,
          }
        : null
    },

    async getGroupMetadata(groupId: CanopyGroupId): Promise<GroupMetadata | null> {
      const groups: Record<string, GroupMetadata> = {
        Admins: { id: 'Admins', name: 'Administrators', memberCount: 1 },
        Reviewers: { id: 'Reviewers', name: 'Reviewers', memberCount: 1 },
        ContentEditors: { id: 'ContentEditors', name: 'Content Editors', memberCount: 1 },
      }
      return groups[groupId] || null
    },

    async listGroups(limit = 100): Promise<GroupMetadata[]> {
      return [
        { id: 'Admins', name: 'Administrators', memberCount: 1 },
        { id: 'Reviewers', name: 'Reviewers', memberCount: 1 },
        { id: 'ContentEditors', name: 'Content Editors', memberCount: 1 },
      ].slice(0, limit)
    },

    async searchExternalGroups(query: string) {
      // Return empty for tests - external groups are optional
      return []
    },
  }
}
