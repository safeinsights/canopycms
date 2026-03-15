import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CachingAuthPlugin } from './caching-auth-plugin'
import type { AuthCacheProvider, TokenVerifier } from './caching-auth-plugin'
import type { UserSearchResult, GroupMetadata } from './types'

function createMockCache(overrides: Partial<AuthCacheProvider> = {}): AuthCacheProvider {
  const users: UserSearchResult[] = [
    {
      id: 'user_1',
      name: 'Alice Smith',
      email: 'alice@example.com',
      avatarUrl: 'https://avatar/alice',
    },
    { id: 'user_2', name: 'Bob Jones', email: 'bob@example.com' },
  ]
  const groups: GroupMetadata[] = [
    { id: 'org_1', name: 'Engineering', memberCount: 5 },
    { id: 'org_2', name: 'Design', memberCount: 3 },
  ]
  const memberships: Record<string, string[]> = {
    user_1: ['org_1', 'org_2'],
    user_2: ['org_1'],
  }

  return {
    getUser: vi.fn(async (userId) => users.find((u) => u.id === userId) ?? null),
    getGroup: vi.fn(async (groupId) => groups.find((g) => g.id === groupId) ?? null),
    getAllUsers: vi.fn(async () => users),
    getAllGroups: vi.fn(async () => groups),
    getUserExternalGroups: vi.fn(async (userId) => memberships[userId] ?? []),
    ...overrides,
  }
}

describe('CachingAuthPlugin', () => {
  let mockVerifier: TokenVerifier
  let mockCache: AuthCacheProvider
  let plugin: CachingAuthPlugin

  beforeEach(() => {
    mockVerifier = vi.fn(async () => ({ userId: 'user_1' }))
    mockCache = createMockCache()
    plugin = new CachingAuthPlugin(mockVerifier, mockCache)
  })

  describe('authenticate', () => {
    it('returns user with cached metadata on successful token verification', async () => {
      const result = await plugin.authenticate({})

      expect(result.success).toBe(true)
      expect(result.user).toEqual({
        userId: 'user_1',
        name: 'Alice Smith',
        email: 'alice@example.com',
        avatarUrl: 'https://avatar/alice',
        externalGroups: ['org_1', 'org_2'],
      })
    })

    it('returns failure when token verification fails', async () => {
      mockVerifier = vi.fn(async () => null)
      plugin = new CachingAuthPlugin(mockVerifier, mockCache)

      const result = await plugin.authenticate({})

      expect(result.success).toBe(false)
      expect(result.error).toBe('No valid authentication token')
    })

    it('returns userId as name when user not in cache', async () => {
      mockVerifier = vi.fn(async () => ({ userId: 'unknown_user' }))
      plugin = new CachingAuthPlugin(mockVerifier, mockCache)

      const result = await plugin.authenticate({})

      expect(result.success).toBe(true)
      expect(result.user?.userId).toBe('unknown_user')
      expect(result.user?.name).toBe('unknown_user')
      expect(result.user?.externalGroups).toEqual([])
    })

    it('passes context to verifier', async () => {
      const context = { headers: new Headers({ Authorization: 'Bearer test' }) }
      await plugin.authenticate(context)

      expect(mockVerifier).toHaveBeenCalledWith(context)
    })
  })

  describe('searchUsers', () => {
    it('filters users by name', async () => {
      const results = await plugin.searchUsers('alice')
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice Smith')
    })

    it('filters users by email', async () => {
      const results = await plugin.searchUsers('bob@')
      expect(results).toHaveLength(1)
      expect(results[0].email).toBe('bob@example.com')
    })

    it('is case insensitive', async () => {
      const results = await plugin.searchUsers('ALICE')
      expect(results).toHaveLength(1)
    })

    it('respects limit', async () => {
      const results = await plugin.searchUsers('', 1)
      expect(results).toHaveLength(1)
    })

    it('returns empty for no matches', async () => {
      const results = await plugin.searchUsers('nonexistent')
      expect(results).toHaveLength(0)
    })
  })

  describe('getUserMetadata', () => {
    it('returns user from cache', async () => {
      const user = await plugin.getUserMetadata('user_1')
      expect(user?.name).toBe('Alice Smith')
    })

    it('returns null for unknown user', async () => {
      const user = await plugin.getUserMetadata('unknown')
      expect(user).toBeNull()
    })
  })

  describe('getGroupMetadata', () => {
    it('returns group from cache', async () => {
      const group = await plugin.getGroupMetadata('org_1')
      expect(group?.name).toBe('Engineering')
    })

    it('returns null for unknown group', async () => {
      const group = await plugin.getGroupMetadata('unknown')
      expect(group).toBeNull()
    })
  })

  describe('listGroups', () => {
    it('returns all groups', async () => {
      const groups = await plugin.listGroups()
      expect(groups).toHaveLength(2)
    })

    it('respects limit', async () => {
      const groups = await plugin.listGroups(1)
      expect(groups).toHaveLength(1)
    })
  })
})
