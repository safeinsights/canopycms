import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { PathPermission, CanopyConfig } from '../config'
import type { AuthPlugin } from '../auth/plugin'
import type { UserSearchResult, GroupMetadata } from '../auth/types'
import { RESERVED_GROUPS } from '../reserved-groups'
import {
  createMockApiContext,
  createMockBranchContext,
  createMockGitManager,
  createMockPermissionsLoader,
} from '../test-utils'

// Mock permissions loader
vi.mock('../permissions-loader', () => createMockPermissionsLoader())

import { PERMISSION_ROUTES } from './permissions'
import * as permissionsLoader from '../permissions-loader'

// Extract handlers for testing
const getPermissions = PERMISSION_ROUTES.get.handler
const updatePermissions = PERMISSION_ROUTES.update.handler
const searchUsers = PERMISSION_ROUTES.searchUsers.handler
const listGroups = PERMISSION_ROUTES.listGroups.handler
const getUserMetadata = PERMISSION_ROUTES.getUserMetadata.handler

describe('permissions API', () => {
  let mockContext: ApiContext
  let mockAuthPlugin: AuthPlugin
  let mockGit: ReturnType<typeof createMockGitManager>

  beforeEach(() => {
    mockAuthPlugin = {
      authenticate: vi.fn(),
      searchUsers: vi.fn(),
      getUserMetadata: vi.fn(),
      getGroupMetadata: vi.fn(),
      listGroups: vi.fn(),
    }

    mockGit = createMockGitManager()

    const mockConfig: Partial<CanopyConfig> = {
      defaultBaseBranch: 'main',
      mode: 'local-simple',
      gitBotAuthorName: 'Test Bot',
      gitBotAuthorEmail: 'bot@test.com',
    }

    mockContext = createMockApiContext({
      services: {
        config: mockConfig as CanopyConfig,
        createGitManagerFor: vi.fn(() => mockGit) as any,
      },
      authPlugin: mockAuthPlugin,
    })
  })

  describe('getPermissions', () => {
    it('returns permissions for admin user', async () => {
      const mockPermissions: PathPermission[] = [
        { path: 'content/admin/**', edit: {} },
        { path: 'content/public/**', edit: { allowedUsers: ['user-1'] } },
      ]

      mockContext.getBranchContext = vi.fn().mockResolvedValue(
        createMockBranchContext({
          branchName: 'main',
          createdBy: 'admin-1',
          access: { allowedUsers: [], allowedGroups: [] },
          baseRoot: '/test/repo',
          branchRoot: '/test/repo',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        }),
      )

      vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue(mockPermissions)

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await getPermissions(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.permissions).toEqual(mockPermissions)
    })

    it('denies access for non-admin users', async () => {
      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'user-1', groups: [] },
      }

      const result = await getPermissions(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin access required')
    })

    it('returns error when main branch not found', async () => {
      const mockGetBranchState = vi.fn().mockResolvedValue(null)
      mockContext.getBranchContext = mockGetBranchState

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await getPermissions(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error).toBe('Main branch not found')
    })
  })

  describe('updatePermissions', () => {
    it('updates permissions for admin user', async () => {
      const newPermissions: PathPermission[] = [
        { path: 'content/updated/**', edit: { allowedGroups: ['new-group'] } },
      ]

      mockContext.getBranchContext = vi.fn().mockResolvedValue(
        createMockBranchContext({
          branchName: 'main',
          createdBy: 'admin-1',
          access: { allowedUsers: [], allowedGroups: [] },
          baseRoot: '/test/repo',
          branchRoot: '/test/repo',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        }),
      )

      const localMockGit = {
        add: vi.fn(),
        commit: vi.fn(),
        ensureAuthor: vi.fn(),
      }
      mockContext.services.createGitManagerFor = vi.fn().mockReturnValue(localMockGit)

      const req: ApiRequest = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await updatePermissions(mockContext, req, { permissions: newPermissions })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)

      // Verify commitFiles was called with the correct arguments
      expect(mockContext.services.commitFiles).toHaveBeenCalledWith({
        context: {
          baseRoot: '/test/repo',
          branchRoot: '/test/repo',
          branch: {
            name: 'main',
            status: 'editing',
            access: { allowedUsers: [], allowedGroups: [] },
            createdBy: 'admin-1',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        },
        files: '.canopycms/permissions.json',
        message: 'Update permissions',
      })
    })

    it('denies access for non-admin users', async () => {
      const req: ApiRequest = {
        user: { type: 'authenticated', userId: 'user-1', groups: [] },
      }

      const result = await updatePermissions(mockContext, req, { permissions: [] })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin access required')
    })

    it('requires permissions array in body', async () => {
      // Type as Partial to test runtime validation
      const req: ApiRequest = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await updatePermissions(mockContext, req, {} as any)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toBe('permissions array required')
    })

    it('returns error when main branch not found', async () => {
      const mockGetBranchState = vi.fn().mockResolvedValue(null)
      mockContext.getBranchContext = mockGetBranchState

      const req: ApiRequest = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await updatePermissions(mockContext, req, { permissions: [] })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error).toBe('Main branch not found')
    })
  })

  describe('searchUsers', () => {
    it('searches users for admin', async () => {
      const mockUsers: UserSearchResult[] = [
        { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
        { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
      ]

      vi.mocked(mockAuthPlugin.searchUsers).mockResolvedValue(mockUsers)

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
        query: { q: 'alice' },
      }

      const result = await searchUsers(mockContext, req, { q: 'alice' })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      if (result.ok && result.data) {
        expect((result.data as { users: UserSearchResult[] }).users).toEqual(mockUsers)
      }
      expect(mockAuthPlugin.searchUsers).toHaveBeenCalledWith('alice', undefined)
    })

    it('searches users for reviewer', async () => {
      const mockUsers: UserSearchResult[] = []
      vi.mocked(mockAuthPlugin.searchUsers).mockResolvedValue(mockUsers)

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'reviewer-1', groups: [RESERVED_GROUPS.REVIEWERS] },
        query: { q: 'test', limit: '5' },
      }

      const result = await searchUsers(mockContext, req, { q: 'test', limit: '5' })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockAuthPlugin.searchUsers).toHaveBeenCalledWith('test', 5)
    })

    it('denies access for regular users', async () => {
      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'user-1', groups: [] },
        query: { q: 'test' },
      }

      const result = await searchUsers(mockContext, req, { q: 'test' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin or Reviewer access required')
    })

    it('returns error when auth plugin not configured', async () => {
      mockContext.authPlugin = undefined

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
        query: { q: 'test' },
      }

      const result = await searchUsers(mockContext, req, { q: 'test' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(501)
      expect(result.error).toBe('Auth plugin not configured')
    })

    it('handles search errors gracefully', async () => {
      vi.mocked(mockAuthPlugin.searchUsers).mockRejectedValue(new Error('API error'))

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
        query: { q: 'test' },
      }

      const result = await searchUsers(mockContext, req, { q: 'test' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error).toBe('API error')
    })

    it('validates that q parameter is required', () => {
      // Test that the endpoint has proper validation schema
      const endpoint = PERMISSION_ROUTES.searchUsers

      // Validate with missing 'q' parameter
      const validationResult = endpoint.validate({ params: {} })

      expect(validationResult.ok).toBe(false)
      if (!validationResult.ok) {
        expect(validationResult.error).toContain('q')
      }
    })
  })

  describe('listGroups', () => {
    it('lists groups for admin', async () => {
      const mockGroups: GroupMetadata[] = [
        { id: 'group-1', name: 'Engineering', memberCount: 10 },
        { id: 'group-2', name: 'Marketing', memberCount: 5 },
      ]

      vi.mocked(mockAuthPlugin.listGroups).mockResolvedValue(mockGroups)

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      if (result.ok && result.data) {
        expect((result.data as { groups: GroupMetadata[] }).groups).toEqual(mockGroups)
      }
      expect(mockAuthPlugin.listGroups).toHaveBeenCalled()
    })

    it('lists groups for reviewer', async () => {
      const mockGroups: GroupMetadata[] = []
      vi.mocked(mockAuthPlugin.listGroups).mockResolvedValue(mockGroups)

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'reviewer-1', groups: [RESERVED_GROUPS.REVIEWERS] },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
    })

    it('denies access for regular users', async () => {
      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'user-1', groups: [] },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin or Reviewer access required')
    })

    it('returns error when auth plugin not configured', async () => {
      mockContext.authPlugin = undefined

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(501)
      expect(result.error).toBe('Auth plugin not configured')
    })

    it('handles list errors gracefully', async () => {
      vi.mocked(mockAuthPlugin.listGroups).mockRejectedValue(new Error('Network error'))

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error).toBe('Network error')
    })
  })

  describe('getUserMetadata', () => {
    it('gets user metadata for admin', async () => {
      const mockUser: UserSearchResult = {
        id: 'user-1',
        name: 'Alice Smith',
        email: 'alice@example.com',
        avatarUrl: 'https://example.com/avatar.jpg',
      }

      vi.mocked(mockAuthPlugin.getUserMetadata).mockResolvedValue(mockUser)

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await getUserMetadata(mockContext, req, { userId: 'user-1' })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      if (result.ok && result.data) {
        expect((result.data as { user: UserSearchResult }).user).toEqual(mockUser)
      }
      expect(mockAuthPlugin.getUserMetadata).toHaveBeenCalledWith('user-1')
    })

    it('gets user metadata for reviewer', async () => {
      const mockUser: UserSearchResult = {
        id: 'user-2',
        name: 'Bob Jones',
        email: 'bob@example.com',
      }

      vi.mocked(mockAuthPlugin.getUserMetadata).mockResolvedValue(mockUser)

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'reviewer-1', groups: [RESERVED_GROUPS.REVIEWERS] },
      }

      const result = await getUserMetadata(mockContext, req, { userId: 'user-2' })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockAuthPlugin.getUserMetadata).toHaveBeenCalledWith('user-2')
    })

    it('denies access for regular users', async () => {
      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'user-1', groups: [] },
      }

      const result = await getUserMetadata(mockContext, req, { userId: 'user-2' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin or Reviewer access required')
      expect(mockAuthPlugin.getUserMetadata).not.toHaveBeenCalled()
    })

    it('returns error when auth plugin not configured', async () => {
      mockContext.authPlugin = undefined

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await getUserMetadata(mockContext, req, { userId: 'user-1' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(501)
      expect(result.error).toBe('Auth plugin not configured')
    })

    it('handles errors gracefully', async () => {
      vi.mocked(mockAuthPlugin.getUserMetadata).mockRejectedValue(new Error('Database error'))

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await getUserMetadata(mockContext, req, { userId: 'user-1' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error).toBe('Database error')
    })

    it('returns null for non-existent user', async () => {
      vi.mocked(mockAuthPlugin.getUserMetadata).mockResolvedValue(null)

      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await getUserMetadata(mockContext, req, { userId: 'non-existent' })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      if (result.ok && result.data) {
        expect((result.data as { user: UserSearchResult | null }).user).toBeNull()
      }
      expect(mockAuthPlugin.getUserMetadata).toHaveBeenCalledWith('non-existent')
    })
  })
})
