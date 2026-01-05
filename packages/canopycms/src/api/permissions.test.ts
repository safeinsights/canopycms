import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { PathPermission, CanopyConfig } from '../config'
import type { AuthPlugin } from '../auth/plugin'
import type { UserSearchResult, GroupMetadata } from '../auth/types'
import { RESERVED_GROUPS } from '../reserved-groups'

// Mock permissions loader
vi.mock('../permissions-loader', () => ({
  loadPathPermissions: vi.fn(),
  savePathPermissions: vi.fn(),
}))

import { PERMISSION_ROUTES } from './permissions'
import * as permissionsLoader from '../permissions-loader'

// Extract handlers for testing
const getPermissions = PERMISSION_ROUTES.get.handler
const updatePermissions = PERMISSION_ROUTES.update.handler
const searchUsers = PERMISSION_ROUTES.searchUsers.handler
const listGroups = PERMISSION_ROUTES.listGroups.handler

describe('permissions API', () => {
  let mockContext: ApiContext
  let mockAuthPlugin: AuthPlugin

  beforeEach(() => {
    mockAuthPlugin = {
      verifyToken: vi.fn(),
      searchUsers: vi.fn(),
      getUserMetadata: vi.fn(),
      getGroupMetadata: vi.fn(),
      listGroups: vi.fn(),
    }

    const mockConfig: Partial<CanopyConfig> = {
      defaultBaseBranch: 'main',
      mode: 'local-simple',
      gitBotAuthorName: 'Test Bot',
      gitBotAuthorEmail: 'bot@test.com',
    }

    mockContext = {
      services: {
        config: mockConfig as CanopyConfig,
        checkBranchAccess: vi.fn(),
        checkContentAccess: vi.fn(),
        createGitManagerFor: vi.fn(() => ({
          add: vi.fn(),
          commit: vi.fn(),
        })),
        bootstrapAdminIds: new Set<string>(),
        registry: undefined as any,
      },
      authPlugin: mockAuthPlugin,
      getBranchContext: vi.fn(),
    }
  })

  describe('getPermissions', () => {
    it('returns permissions for admin user', async () => {
      const mockPermissions: PathPermission[] = [
        { path: 'content/admin/**', edit: {} },
        { path: 'content/public/**', edit: { allowedUsers: ['user-1'] } },
      ]

      const mockGetBranchContext = vi.fn().mockResolvedValue({
        baseRoot: '/test/repo',
        branchRoot: '/test/repo',
        branch: {
          name: 'main',
          status: 'editing' as const,
          access: { allowedUsers: [], allowedGroups: [] },
          createdBy: 'admin-1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      })
      mockContext.getBranchContext = mockGetBranchContext

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

      const mockGetBranchContext = vi.fn().mockResolvedValue({
        baseRoot: '/test/repo',
        branchRoot: '/test/repo',
        branch: {
          name: 'main',
          status: 'editing' as const,
          access: { allowedUsers: [], allowedGroups: [] },
          createdBy: 'admin-1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      })
      mockContext.getBranchContext = mockGetBranchContext

      const mockGit = {
        add: vi.fn(),
        commit: vi.fn(),
      }
      mockContext.services.createGitManagerFor = vi.fn().mockReturnValue(mockGit)

      const req: ApiRequest = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
      }

      const result = await updatePermissions(mockContext, req, { permissions: newPermissions })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockGit.add).toHaveBeenCalledWith('.canopycms/permissions.json')
      expect(mockGit.commit).toHaveBeenCalledWith(
        'Update permissions',
        expect.objectContaining({
          name: 'Test Bot',
          email: 'bot@test.com',
        }),
      )
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

      const result = await searchUsers(mockContext, req)

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

      const result = await searchUsers(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockAuthPlugin.searchUsers).toHaveBeenCalledWith('test', 5)
    })

    it('denies access for regular users', async () => {
      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'user-1', groups: [] },
        query: { q: 'test' },
      }

      const result = await searchUsers(mockContext, req)

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

      const result = await searchUsers(mockContext, req)

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

      const result = await searchUsers(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error).toBe('API error')
    })

    it('returns 400 when query parameter is missing', async () => {
      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] },
        query: {}, // Missing 'q' parameter
      }

      const result = await searchUsers(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toBe('Query parameter "q" is required')
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
})
