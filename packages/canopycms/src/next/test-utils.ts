import type { AuthPlugin } from '../auth'
import type { AuthUser } from '../auth/types'

/**
 * Create a mock AuthPlugin for testing.
 * Returns a valid user by default, or can be configured to return specific users.
 */
export const createMockAuthPlugin = (
  user: AuthUser = { userId: 'test-user', role: 'admin' }
): AuthPlugin => ({
  verifyToken: async () => ({ valid: true, user }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

/**
 * Create a mock AuthPlugin that rejects all authentication.
 */
export const createRejectingAuthPlugin = (error = 'Unauthorized'): AuthPlugin => ({
  verifyToken: async () => ({ valid: false, error }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})
