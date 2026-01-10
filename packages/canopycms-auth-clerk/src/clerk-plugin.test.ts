import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockConsole } from '../../canopycms/src/test-utils/console-spy.js'

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
import { verifyToken } from '@clerk/backend'
import type { CanopyRequest } from 'canopycms/http'

const mockVerifyToken = verifyToken as any

describe('ClerkAuthPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Set default env var
    process.env.CLERK_SECRET_KEY = 'sk_test_1234'
  })

  describe('constructor', () => {
    it('throws error if CLERK_SECRET_KEY not provided', () => {
      delete process.env.CLERK_SECRET_KEY
      expect(() => new ClerkAuthPlugin()).toThrow('CLERK_SECRET_KEY')
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
        data: [
          { organization: { id: 'org_1' } },
          { organization: { id: 'org_2' } },
        ],
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

  describe('createClerkAuthPlugin factory', () => {
    it('creates plugin instance', async () => {
      const { createClerkAuthPlugin } = await import('./clerk-plugin')
      const plugin = createClerkAuthPlugin({})

      expect(plugin).toBeInstanceOf(ClerkAuthPlugin)
    })
  })
})
