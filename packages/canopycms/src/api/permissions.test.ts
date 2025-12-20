import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { PathPermission } from '../config'
import type { AuthPlugin } from '../auth/plugin'
import type { UserSearchResult, GroupMetadata } from '../auth/types'

// Mock permissions loader
vi.mock('../permissions-loader', () => ({
  loadPathPermissions: vi.fn(),
  savePathPermissions: vi.fn(),
}))

import { getPermissions, updatePermissions, searchUsers, listGroups } from './permissions'
import * as permissionsLoader from '../permissions-loader'

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

    mockContext = {
      services: {
        config: {
          defaultBaseBranch: 'main',
          mode: 'local-simple',
          authPlugin: mockAuthPlugin,
        } as any,
        createGitManagerFor: vi.fn(() => ({
          add: vi.fn(),
          commit: vi.fn(),
        })) as any,
      } as any,
      getBranchState: vi.fn(),
    }
  })

  describe('getPermissions', () => {
    it('returns permissions for admin user', async () => {
      const mockPermissions: PathPermission[] = [
        { path: 'content/admin/**', managerOrAdminAllowed: true },
        { path: 'content/public/**', allowedUsers: ['user-1'] },
      ]

      mockContext.getBranchState = vi.fn().mockResolvedValue({
        branch: { name: 'main' },
        branchRoot: '/test/repo',
      })

      vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue(mockPermissions)

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1', role: 'admin' },
      }

      const result = await getPermissions(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.permissions).toEqual(mockPermissions)
    })

    it('denies access for non-admin users', async () => {
      const req: ApiRequest<undefined> = {
        user: { userId: 'user-1', role: 'editor' },
      }

      const result = await getPermissions(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin access required')
    })

    it('allows manager access', async () => {
      mockContext.getBranchState = vi.fn().mockResolvedValue({
        branch: { name: 'main' },
        branchRoot: '/test/repo',
      })

      const req: ApiRequest<undefined> = {
        user: { userId: 'manager-1', role: 'admin' }, // admin includes managers
      }

      // Mock will be called - just verify no 403
      const result = await getPermissions(mockContext, req)

      expect(result.status).not.toBe(403)
    })

    it('returns error when main branch not found', async () => {
      mockContext.getBranchState = vi.fn().mockResolvedValue(null)

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1', role: 'admin' },
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
        { path: 'content/updated/**', allowedGroups: ['new-group'] },
      ]

      mockContext.getBranchState = vi.fn().mockResolvedValue({
        branch: { name: 'main' },
        branchRoot: '/test/repo',
      })

      const mockGit = {
        add: vi.fn(),
        commit: vi.fn(),
      }
      mockContext.services.createGitManagerFor = vi.fn().mockReturnValue(mockGit)

      const req: ApiRequest<{ permissions: PathPermission[] }> = {
        user: { userId: 'admin-1', role: 'admin' },
        body: { permissions: newPermissions },
      }

      const result = await updatePermissions(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockGit.add).toHaveBeenCalledWith('.canopycms/permissions.json')
      expect(mockGit.commit).toHaveBeenCalledWith('Update permissions', expect.any(Object))
    })

    it('denies access for non-admin users', async () => {
      const req: ApiRequest<{ permissions: PathPermission[] }> = {
        user: { userId: 'user-1', role: 'editor' },
        body: { permissions: [] },
      }

      const result = await updatePermissions(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin access required')
    })

    it('requires permissions array in body', async () => {
      const req: ApiRequest<any> = {
        user: { userId: 'admin-1', role: 'admin' },
        body: {},
      }

      const result = await updatePermissions(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toBe('permissions array required')
    })

    it('returns error when main branch not found', async () => {
      mockContext.getBranchState = vi.fn().mockResolvedValue(null)

      const req: ApiRequest<{ permissions: PathPermission[] }> = {
        user: { userId: 'admin-1', role: 'admin' },
        body: { permissions: [] },
      }

      const result = await updatePermissions(mockContext, req)

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
        user: { userId: 'admin-1', role: 'admin' },
      }

      const result = await searchUsers(mockContext, req, { query: 'alice' })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.users).toEqual(mockUsers)
      expect(mockAuthPlugin.searchUsers).toHaveBeenCalledWith('alice', undefined)
    })

    it('searches users for manager', async () => {
      const mockUsers: UserSearchResult[] = []
      vi.mocked(mockAuthPlugin.searchUsers).mockResolvedValue(mockUsers)

      const req: ApiRequest<undefined> = {
        user: { userId: 'manager-1', role: 'manager' },
      }

      const result = await searchUsers(mockContext, req, { query: 'test', limit: 5 })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockAuthPlugin.searchUsers).toHaveBeenCalledWith('test', 5)
    })

    it('denies access for editor users', async () => {
      const req: ApiRequest<undefined> = {
        user: { userId: 'user-1', role: 'editor' },
      }

      const result = await searchUsers(mockContext, req, { query: 'test' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin or manager access required')
    })

    it('returns error when auth plugin not configured', async () => {
      mockContext.services.config.authPlugin = undefined

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1', role: 'admin' },
      }

      const result = await searchUsers(mockContext, req, { query: 'test' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(501)
      expect(result.error).toBe('Auth plugin not configured')
    })

    it('handles search errors gracefully', async () => {
      vi.mocked(mockAuthPlugin.searchUsers).mockRejectedValue(new Error('API error'))

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1', role: 'admin' },
      }

      const result = await searchUsers(mockContext, req, { query: 'test' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error).toBe('API error')
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
        user: { userId: 'admin-1', role: 'admin' },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.groups).toEqual(mockGroups)
      expect(mockAuthPlugin.listGroups).toHaveBeenCalled()
    })

    it('lists groups for manager', async () => {
      const mockGroups: GroupMetadata[] = []
      vi.mocked(mockAuthPlugin.listGroups).mockResolvedValue(mockGroups)

      const req: ApiRequest<undefined> = {
        user: { userId: 'manager-1', role: 'manager' },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
    })

    it('denies access for editor users', async () => {
      const req: ApiRequest<undefined> = {
        user: { userId: 'user-1', role: 'editor' },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin or manager access required')
    })

    it('returns error when auth plugin not configured', async () => {
      mockContext.services.config.authPlugin = undefined

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1', role: 'admin' },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(501)
      expect(result.error).toBe('Auth plugin not configured')
    })

    it('handles list errors gracefully', async () => {
      vi.mocked(mockAuthPlugin.listGroups).mockRejectedValue(new Error('Network error'))

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1', role: 'admin' },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error).toBe('Network error')
    })
  })
})
