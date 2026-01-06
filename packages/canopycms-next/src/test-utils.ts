import type { AuthPlugin } from 'canopycms/auth'
import type { AuthenticatedUser } from 'canopycms'

const ADMINS = 'Admins'

/**
 * Create a mock AuthPlugin for testing.
 * Returns a valid user by default (as Admin), or can be configured to return specific users.
 */
export const createMockAuthPlugin = (
  user: AuthenticatedUser = { type: 'authenticated', userId: 'test-user', groups: [ADMINS] }
): AuthPlugin => ({
  authenticate: async () => ({
    success: true,
    user: {
      userId: user.userId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      externalGroups: user.groups,
    },
  }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

/**
 * Create a mock AuthPlugin that rejects all authentication.
 */
export const createRejectingAuthPlugin = (error = 'Unauthorized'): AuthPlugin => ({
  authenticate: async () => ({ success: false, error }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})
