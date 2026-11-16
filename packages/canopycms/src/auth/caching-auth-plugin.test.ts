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

    it('returns no name when user not in cache, never the id', async () => {
      mockVerifier = vi.fn(async () => ({ userId: 'unknown_user' }))
      plugin = new CachingAuthPlugin(mockVerifier, mockCache)

      const result = await plugin.authenticate({})

      expect(result.success).toBe(true)
      expect(result.user?.userId).toBe('unknown_user')
      expect(result.user?.name).toBeUndefined()
      expect(result.user?.externalGroups).toEqual([])
    })

    it.each([
      ['empty', ''],
      ['blank', '   '],
      ['the id', 'user_9'],
    ])('returns no name for a cached user whose name is %s', async (_label, name) => {
      const cache = createMockCache({
        getUser: vi.fn(async () => ({ id: 'user_9', name, email: 'nameless@example.com' })),
      })
      plugin = new CachingAuthPlugin(
        vi.fn(async () => ({ userId: 'user_9' })),
        cache,
      )

      const result = await plugin.authenticate({})

      expect(result.user?.name).toBeUndefined()
      expect(result.user?.email).toBe('nameless@example.com')
    })

    it('passes context to verifier', async () => {
      const context = { headers: new Headers({ Authorization: 'Bearer test' }) }
      await plugin.authenticate(context)

      expect(mockVerifier).toHaveBeenCalledWith(context)
    })

    it('returns minimal user info when cache throws', async () => {
      const failingCache = createMockCache({
        getUser: vi.fn().mockRejectedValue(new Error('cache corrupt')),
        getUserExternalGroups: vi.fn().mockRejectedValue(new Error('cache corrupt')),
      })
      plugin = new CachingAuthPlugin(mockVerifier, failingCache)

      const result = await plugin.authenticate({})

      expect(result.success).toBe(true)
      expect(result.user?.userId).toBe('user_1')
      expect(result.user?.name).toBeUndefined()
      expect(result.user?.externalGroups).toEqual([])
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

    it('returns empty array when getAllUsers throws', async () => {
      const failingCache = createMockCache({
        getAllUsers: vi.fn().mockRejectedValue(new Error('cache unavailable')),
      })
      plugin = new CachingAuthPlugin(mockVerifier, failingCache)

      const results = await plugin.searchUsers('alice')
      expect(results).toEqual([])
    })
  })

  describe('findUserByEmail', () => {
    it('finds the user with exactly that address, ignoring case, and no one for part of one', async () => {
      expect((await plugin.findUserByEmail('  Bob@Example.COM '))?.id).toBe('user_2')
      expect(await plugin.findUserByEmail('bob@example')).toBeNull()
      expect(await plugin.findUserByEmail('ob@example.com')).toBeNull()
    })

    it('indexes each list the cache answers with once, and again after the cache reloads', async () => {
      const first: UserSearchResult[] = [{ id: 'u1', name: 'One', email: 'one@example.com' }]
      const reloaded: UserSearchResult[] = [{ id: 'u2', name: 'Two', email: 'one@example.com' }]
      let current = first
      const cache = createMockCache({ getAllUsers: vi.fn(async () => current) })
      const indexed = new CachingAuthPlugin(mockVerifier, cache)

      expect((await indexed.findUserByEmail('one@example.com'))?.id).toBe('u1')
      // The same list is not indexed again, so a change made to it in place goes unseen.
      first.push({ id: 'u3', name: 'Three', email: 'three@example.com' })
      expect(await indexed.findUserByEmail('three@example.com')).toBeNull()
      current = reloaded
      expect((await indexed.findUserByEmail('one@example.com'))?.id).toBe('u2')
    })

    it('finds no one for an address two users share', async () => {
      const cache = createMockCache({
        getAllUsers: vi.fn(async () => [
          { id: 'u1', name: 'One', email: 'same@example.com' },
          { id: 'u2', name: 'Two', email: 'SAME@example.com' },
        ]),
      })

      expect(
        await new CachingAuthPlugin(mockVerifier, cache).findUserByEmail('same@example.com'),
      ).toBeNull()
    })

    it('rejects when the cache cannot be read, rather than finding no one', async () => {
      const cache = createMockCache({
        getAllUsers: vi.fn(async () => {
          throw new Error('unreadable')
        }),
      })

      await expect(
        new CachingAuthPlugin(mockVerifier, cache).findUserByEmail('bob@example.com'),
      ).rejects.toThrow('unreadable')
    })
  })

  describe('getAllUsers', () => {
    it("answers with the cache's users, or none when it can't be read", async () => {
      expect((await plugin.getAllUsers()).map((u) => u.id)).toEqual(['user_1', 'user_2'])
      const broken = createMockCache({
        getAllUsers: vi.fn(async () => {
          throw new Error('unreadable')
        }),
      })
      expect(await new CachingAuthPlugin(mockVerifier, broken).getAllUsers()).toEqual([])
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

    it('returns null when cache throws', async () => {
      const failingCache = createMockCache({
        getUser: vi.fn().mockRejectedValue(new Error('cache corrupt')),
      })
      plugin = new CachingAuthPlugin(mockVerifier, failingCache)

      const user = await plugin.getUserMetadata('user_1')
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

    it('returns null when cache throws', async () => {
      const failingCache = createMockCache({
        getGroup: vi.fn().mockRejectedValue(new Error('cache corrupt')),
      })
      plugin = new CachingAuthPlugin(mockVerifier, failingCache)

      const group = await plugin.getGroupMetadata('org_1')
      expect(group).toBeNull()
    })
  })

  describe('lazyRefresher', () => {
    it('calls the lazy refresher on first successful authenticate', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      plugin = new CachingAuthPlugin(mockVerifier, mockCache, refresher)

      await plugin.authenticate({})

      expect(refresher).toHaveBeenCalledOnce()
    })

    it('calls the refresher only once across multiple authenticate calls', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      plugin = new CachingAuthPlugin(mockVerifier, mockCache, refresher)

      await plugin.authenticate({})
      await plugin.authenticate({})
      await plugin.authenticate({})

      expect(refresher).toHaveBeenCalledOnce()
    })

    it('does not block authentication when the refresher fails', async () => {
      const refresher = vi.fn().mockRejectedValue(new Error('network error'))
      plugin = new CachingAuthPlugin(mockVerifier, mockCache, refresher)

      const result = await plugin.authenticate({})

      expect(result.success).toBe(true)
      expect(result.user?.userId).toBe('user_1')
    })

    it('coalesces concurrent authenticate calls into a single refresh', async () => {
      let resolveRefresh!: () => void
      const refresher = vi.fn(() => new Promise<void>((resolve) => (resolveRefresh = resolve)))
      plugin = new CachingAuthPlugin(mockVerifier, mockCache, refresher)

      // Fire 3 concurrent authenticate calls
      const results = Promise.all([
        plugin.authenticate({}),
        plugin.authenticate({}),
        plugin.authenticate({}),
      ])

      // Let token verification resolve so the refresher is invoked
      await vi.waitFor(() => expect(refresher).toHaveBeenCalled())

      // Resolve the single refresh
      resolveRefresh()
      const settled = await results

      expect(refresher).toHaveBeenCalledOnce()
      expect(settled.every((r) => r.success)).toBe(true)
    })

    it('retries the refresher after a previous failure', async () => {
      const refresher = vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(undefined)
      plugin = new CachingAuthPlugin(mockVerifier, mockCache, refresher)

      // First call — refresher fails but auth still succeeds
      const result1 = await plugin.authenticate({})
      expect(result1.success).toBe(true)
      expect(refresher).toHaveBeenCalledTimes(1)

      // Second call — refresher should be retried (promise was nulled on failure)
      const result2 = await plugin.authenticate({})
      expect(result2.success).toBe(true)
      expect(refresher).toHaveBeenCalledTimes(2)
    })

    it('does not call the refresher when token verification fails', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      mockVerifier = vi.fn(async () => null)
      plugin = new CachingAuthPlugin(mockVerifier, mockCache, refresher)

      await plugin.authenticate({})

      expect(refresher).not.toHaveBeenCalled()
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

    it('returns empty array when getAllGroups throws', async () => {
      const failingCache = createMockCache({
        getAllGroups: vi.fn().mockRejectedValue(new Error('cache unavailable')),
      })
      plugin = new CachingAuthPlugin(mockVerifier, failingCache)

      const groups = await plugin.listGroups()
      expect(groups).toEqual([])
    })
  })
})
