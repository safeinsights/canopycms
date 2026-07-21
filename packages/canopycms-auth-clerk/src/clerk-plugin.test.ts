import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockConsole } from 'canopycms/test-utils'

// Create mock objects
const mockGetUser = vi.fn()
const mockGetUserList = vi.fn()
const mockGetOrganizationMembershipList = vi.fn()
const mockGetOrganization = vi.fn()
const mockGetOrganizationList = vi.fn()

const mockClerkClient = {
  users: {
    getUser: mockGetUser,
    getUserList: mockGetUserList,
    getOrganizationMembershipList: mockGetOrganizationMembershipList,
  },
  organizations: {
    getOrganization: mockGetOrganization,
    getOrganizationList: mockGetOrganizationList,
  },
}

// Mock @clerk/backend - must be hoisted before imports
vi.mock('@clerk/backend', () => ({
  createClerkClient: vi.fn(() => mockClerkClient),
  verifyToken: vi.fn(),
}))

import { ClerkAuthPlugin } from './clerk-plugin'
import { verifyToken, createClerkClient } from '@clerk/backend'
import type { CanopyRequest } from 'canopycms/http'

const mockVerifyToken = verifyToken as any
const mockCreateClerkClient = createClerkClient as any

describe('ClerkAuthPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Set default env var
    process.env.CLERK_SECRET_KEY = 'sk_test_1234'
  })

  describe('constructor', () => {
    it('does not throw if CLERK_SECRET_KEY not provided, and does not construct the Clerk client', () => {
      delete process.env.CLERK_SECRET_KEY
      expect(() => new ClerkAuthPlugin()).not.toThrow()
      expect(mockCreateClerkClient).not.toHaveBeenCalled()
    })

    it('uses env var for secret key by default', () => {
      const plugin = new ClerkAuthPlugin()
      expect(plugin).toBeDefined()
    })

    it('uses default config values', () => {
      const plugin = new ClerkAuthPlugin()
      // Config is private, but we can test behavior
      expect(plugin).toBeDefined()
    })

    it('sets verifiesCredentials: true (SEC-C1 allowlist marker)', () => {
      // ClerkAuthPlugin verifies Clerk-issued JWTs, so it must affirm this marker for
      // assertAuthPluginAllowedForMode to accept it in prod mode.
      const plugin = new ClerkAuthPlugin()
      expect(plugin.verifiesCredentials).toBe(true)
    })
  })

  describe('lazy secret key resolution', () => {
    it('authenticate() without the secret rejects with a CLERK_SECRET_KEY error', async () => {
      delete process.env.CLERK_SECRET_KEY
      const plugin = new ClerkAuthPlugin()
      const req = {
        method: 'GET',
        header: vi.fn().mockImplementation((name: string) => {
          if (name === 'Authorization') return 'Bearer test_token'
          return null
        }),
      } as unknown as CanopyRequest

      await expect(plugin.authenticate(req)).rejects.toThrow('CLERK_SECRET_KEY')
    })

    it('searchUsers() without the secret rejects with a CLERK_SECRET_KEY error', async () => {
      delete process.env.CLERK_SECRET_KEY
      const plugin = new ClerkAuthPlugin()

      await expect(plugin.searchUsers('test')).rejects.toThrow('CLERK_SECRET_KEY')
    })

    it('memoizes the Clerk client: two authenticated calls create it once', async () => {
      const plugin = new ClerkAuthPlugin()

      mockVerifyToken.mockResolvedValue({ sub: 'user_123' })
      mockGetUser.mockResolvedValue({
        id: 'user_123',
        fullName: 'John Doe',
        primaryEmailAddress: { emailAddress: 'john@example.com' },
      })
      mockGetOrganizationMembershipList.mockResolvedValue({ data: [] })

      const req = {
        method: 'GET',
        header: vi.fn().mockImplementation((name: string) => {
          if (name === 'Authorization') return 'Bearer valid_token'
          return null
        }),
      } as unknown as CanopyRequest

      await plugin.authenticate(req)
      await plugin.authenticate(req)

      expect(mockCreateClerkClient).toHaveBeenCalledTimes(1)
    })

    it('secretKey config override works without the env var', async () => {
      delete process.env.CLERK_SECRET_KEY
      const plugin = new ClerkAuthPlugin({ secretKey: 'sk_override' })

      mockGetUserList.mockResolvedValue({ data: [] })

      await expect(plugin.searchUsers('test')).resolves.toEqual([])
      expect(mockCreateClerkClient).toHaveBeenCalledWith({ secretKey: 'sk_override' })
    })
  })

  describe('authenticate', () => {
    it('returns failure if no token in request', async () => {
      const plugin = new ClerkAuthPlugin()
      const req = {
        method: 'GET',
        header: vi.fn().mockReturnValue(null),
      } as unknown as CanopyRequest

      const result = await plugin.authenticate(req)

      expect(result.success).toBe(false)
      expect(result.error).toBe('No authentication token found')
    })

    it('returns failure if token verification fails', async () => {
      const plugin = new ClerkAuthPlugin()
      const req = {
        method: 'GET',
        header: vi.fn().mockImplementation((name: string) => {
          if (name === 'Authorization') return 'Bearer test_token'
          return null
        }),
      } as unknown as CanopyRequest

      mockVerifyToken.mockRejectedValue(new Error('Invalid token'))

      const result = await plugin.authenticate(req)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid token')
    })

    it('verifies valid session and returns user identity', async () => {
      const plugin = new ClerkAuthPlugin()
      const req = {
        method: 'GET',
        header: vi.fn().mockImplementation((name: string) => {
          if (name === 'Authorization') return 'Bearer valid_token'
          return null
        }),
      } as unknown as CanopyRequest

      mockVerifyToken.mockResolvedValue({
        sub: 'user_123',
        sid: 'sess_123',
      })

      mockGetUser.mockResolvedValue({
        id: 'user_123',
        fullName: 'John Doe',
        primaryEmailAddress: { emailAddress: 'john@example.com' },
      })

      mockGetOrganizationMembershipList.mockResolvedValue({
        data: [{ organization: { id: 'org_1' } }, { organization: { id: 'org_2' } }],
      })

      const result = await plugin.authenticate(req)

      expect(result.success).toBe(true)
      expect(result.user).toEqual({
        userId: 'user_123',
        name: 'John Doe',
        email: 'john@example.com',
        externalGroups: ['org_1', 'org_2'],
      })
    })

    it('returns user without external groups if organizations disabled', async () => {
      const plugin = new ClerkAuthPlugin({ useOrganizationsAsGroups: false })
      const req = {
        method: 'GET',
        header: vi.fn().mockImplementation((name: string) => {
          if (name === 'Authorization') return 'Bearer valid_token'
          return null
        }),
      } as unknown as CanopyRequest

      mockVerifyToken.mockResolvedValue({
        sub: 'user_123',
        sid: 'sess_123',
      })

      mockGetUser.mockResolvedValue({
        id: 'user_123',
        fullName: 'Jane Doe',
        primaryEmailAddress: { emailAddress: 'jane@example.com' },
      })

      const result = await plugin.authenticate(req)

      expect(result.success).toBe(true)
      expect(result.user?.externalGroups).toBeUndefined()
      expect(mockGetOrganizationMembershipList).not.toHaveBeenCalled()
    })

    it('handles errors gracefully', async () => {
      const plugin = new ClerkAuthPlugin()
      const req = {
        method: 'GET',
        header: vi.fn().mockImplementation((name: string) => {
          if (name === 'Authorization') return 'Bearer valid_token'
          return null
        }),
      } as unknown as CanopyRequest

      mockVerifyToken.mockRejectedValue(new Error('Network error'))

      const result = await plugin.authenticate(req)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Network error')
    })

    it('extracts token from __session cookie', async () => {
      const plugin = new ClerkAuthPlugin()
      const req = {
        method: 'GET',
        header: vi.fn().mockImplementation((name: string) => {
          if (name === 'Cookie') return '__session=cookie_token; other=value'
          return null
        }),
      } as unknown as CanopyRequest

      mockVerifyToken.mockResolvedValue({
        sub: 'user_123',
      })

      mockGetUser.mockResolvedValue({
        id: 'user_123',
        fullName: 'Cookie User',
        primaryEmailAddress: { emailAddress: 'cookie@example.com' },
      })

      mockGetOrganizationMembershipList.mockResolvedValue({ data: [] })

      const result = await plugin.authenticate(req)

      expect(result.success).toBe(true)
      expect(mockVerifyToken).toHaveBeenCalledWith('cookie_token', expect.any(Object))
    })
  })

  describe('searchUsers', () => {
    it('searches users and returns results', async () => {
      const plugin = new ClerkAuthPlugin()

      mockGetUserList.mockResolvedValue({
        data: [
          {
            id: 'user_1',
            fullName: 'Alice Smith',
            primaryEmailAddress: { emailAddress: 'alice@example.com' },
            imageUrl: 'https://example.com/alice.jpg',
          },
          {
            id: 'user_2',
            username: 'bob',
            primaryEmailAddress: { emailAddress: 'bob@example.com' },
            imageUrl: 'https://example.com/bob.jpg',
          },
        ],
      })

      const results = await plugin.searchUsers('alice')

      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        id: 'user_1',
        name: 'Alice Smith',
        email: 'alice@example.com',
        avatarUrl: 'https://example.com/alice.jpg',
      })
      expect(results[1]).toEqual({
        id: 'user_2',
        name: 'bob',
        email: 'bob@example.com',
        avatarUrl: 'https://example.com/bob.jpg',
      })
      expect(mockGetUserList).toHaveBeenCalledWith({
        query: 'alice',
        limit: 10,
      })
    })

    it('returns empty array on error', async () => {
      const consoleSpy = mockConsole()
      const plugin = new ClerkAuthPlugin()

      mockGetUserList.mockRejectedValue(new Error('API error'))

      const results = await plugin.searchUsers('test')

      expect(results).toEqual([])
      consoleSpy.restore()
    })
  })

  describe('getUserMetadata', () => {
    it('gets user metadata by ID', async () => {
      const plugin = new ClerkAuthPlugin()

      mockGetUser.mockResolvedValue({
        id: 'user_123',
        fullName: 'Test User',
        primaryEmailAddress: { emailAddress: 'test@example.com' },
        imageUrl: 'https://example.com/test.jpg',
      })

      const result = await plugin.getUserMetadata('user_123')

      expect(result).toEqual({
        id: 'user_123',
        name: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/test.jpg',
      })
    })

    it('returns null on error', async () => {
      const consoleSpy = mockConsole()
      const plugin = new ClerkAuthPlugin()

      mockGetUser.mockRejectedValue(new Error('User not found'))

      const result = await plugin.getUserMetadata('user_123')

      expect(result).toBeNull()
      consoleSpy.restore()
    })
  })

  describe('getGroupMetadata', () => {
    it('gets organization metadata when enabled', async () => {
      const plugin = new ClerkAuthPlugin({ useOrganizationsAsGroups: true })

      mockGetOrganization.mockResolvedValue({
        id: 'org_123',
        name: 'Test Org',
        membersCount: 42,
      })

      const result = await plugin.getGroupMetadata('org_123')

      expect(result).toEqual({
        id: 'org_123',
        name: 'Test Org',
        memberCount: 42,
      })
    })

    it('returns null when organizations disabled', async () => {
      const plugin = new ClerkAuthPlugin({ useOrganizationsAsGroups: false })

      const result = await plugin.getGroupMetadata('org_123')

      expect(result).toBeNull()
      expect(mockGetOrganization).not.toHaveBeenCalled()
    })

    it('returns null on error', async () => {
      const consoleSpy = mockConsole()
      const plugin = new ClerkAuthPlugin({ useOrganizationsAsGroups: true })

      mockGetOrganization.mockRejectedValue(new Error('Org not found'))

      const result = await plugin.getGroupMetadata('org_123')

      expect(result).toBeNull()
      consoleSpy.restore()
    })
  })

  describe('listGroups', () => {
    it('lists organizations when enabled', async () => {
      const plugin = new ClerkAuthPlugin({ useOrganizationsAsGroups: true })

      mockGetOrganizationList.mockResolvedValue({
        data: [
          { id: 'org_1', name: 'Org One', membersCount: 10 },
          { id: 'org_2', name: 'Org Two', membersCount: 20 },
        ],
      })

      const results = await plugin.listGroups(50)

      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        id: 'org_1',
        name: 'Org One',
        memberCount: 10,
      })
      expect(mockGetOrganizationList).toHaveBeenCalledWith({ limit: 50 })
    })

    it('returns empty array when organizations disabled', async () => {
      const plugin = new ClerkAuthPlugin({ useOrganizationsAsGroups: false })

      const results = await plugin.listGroups()

      expect(results).toEqual([])
      expect(mockGetOrganizationList).not.toHaveBeenCalled()
    })

    it('returns empty array on error', async () => {
      const consoleSpy = mockConsole()
      const plugin = new ClerkAuthPlugin({ useOrganizationsAsGroups: true })

      mockGetOrganizationList.mockRejectedValue(new Error('API error'))

      const results = await plugin.listGroups()

      expect(results).toEqual([])
      consoleSpy.restore()
    })
  })

  describe('createCacheRefresher', () => {
    it('returns a function without the secret, but invoking it rejects with a CLERK_SECRET_KEY error', async () => {
      delete process.env.CLERK_SECRET_KEY
      const plugin = new ClerkAuthPlugin()

      const refresher = plugin.createCacheRefresher('/tmp/cache.json')

      expect(refresher).toBeInstanceOf(Function)
      await expect(refresher()).rejects.toThrow('CLERK_SECRET_KEY')
    })
  })

  describe('createClerkAuthPlugin factory', () => {
    it('creates plugin instance', async () => {
      const { createClerkAuthPlugin } = await import('./clerk-plugin')
      const plugin = createClerkAuthPlugin({})

      expect(plugin).toBeInstanceOf(ClerkAuthPlugin)
    })
  })
})
