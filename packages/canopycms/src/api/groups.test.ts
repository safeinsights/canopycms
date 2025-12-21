import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { InternalGroup } from '../groups-file'
import type { CanopyGroupId, CanopyUserId } from '../types'

// Mock groups loader
vi.mock('../groups-loader', () => ({
  loadInternalGroups: vi.fn(),
  saveInternalGroups: vi.fn(),
}))

import {
  getInternalGroups,
  updateInternalGroups,
  searchExternalGroups,
  type UpdateInternalGroupsBody,
  type SearchExternalGroupsParams,
} from './groups'
import * as groupsLoader from '../groups-loader'

describe('groups API', () => {
  let mockContext: ApiContext
  let mockGit: {
    add: ReturnType<typeof vi.fn>
    commit: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockGit = {
      add: vi.fn(),
      commit: vi.fn(),
    }

    mockContext = {
      services: {
        config: {
          defaultBaseBranch: 'main',
          mode: 'local-simple',
          gitBotAuthorName: 'Canopy Bot',
          gitBotAuthorEmail: 'bot@example.com',
        },
        createGitManagerFor: vi.fn(() => mockGit),
      },
      getBranchState: vi.fn(async () => ({
        branch: {
          name: 'main',
          status: 'editing' as const,
          access: {},
          createdBy: 'admin-1' as CanopyUserId,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        workspaceRoot: '/test/main',
      })),
    } as unknown as ApiContext
  })

  describe('getInternalGroups', () => {
    it('should return 403 for non-admin users', async () => {
      const req: ApiRequest<undefined> = {
        user: { userId: 'user-1' as CanopyUserId, role: 'editor' },
      }

      const result = await getInternalGroups(mockContext, req)

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'Admin access required',
      })
    })

    it('should return 500 if main branch not found', async () => {
      mockContext.getBranchState = vi.fn(async () => null)

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1' as CanopyUserId, role: 'admin' },
      }

      const result = await getInternalGroups(mockContext, req)

      expect(result).toEqual({
        ok: false,
        status: 500,
        error: 'Main branch not found',
      })
    })

    it('should return empty array when groups file does not exist', async () => {
      vi.mocked(groupsLoader.loadInternalGroups).mockResolvedValue([])

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1' as CanopyUserId, role: 'admin' },
      }

      const result = await getInternalGroups(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      if (result.ok) {
        expect(result.data?.groups).toEqual([])
      }
    })
  })

  describe('updateInternalGroups', () => {
    it('should return 403 for non-admin users', async () => {
      const req: ApiRequest<UpdateInternalGroupsBody> = {
        user: { userId: 'user-1' as CanopyUserId, role: 'editor' },
        body: { groups: [] },
      }

      const result = await updateInternalGroups(mockContext, req)

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'Admin access required',
      })
    })

    it('should return 400 if groups not provided', async () => {
      const req: ApiRequest<UpdateInternalGroupsBody> = {
        user: { userId: 'admin-1' as CanopyUserId, role: 'admin' },
        body: {} as UpdateInternalGroupsBody,
      }

      const result = await updateInternalGroups(mockContext, req)

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'groups array required',
      })
    })

    it('should return 500 if main branch not found', async () => {
      mockContext.getBranchState = vi.fn(async () => null)

      const req: ApiRequest<UpdateInternalGroupsBody> = {
        user: { userId: 'admin-1' as CanopyUserId, role: 'admin' },
        body: { groups: [] },
      }

      const result = await updateInternalGroups(mockContext, req)

      expect(result).toEqual({
        ok: false,
        status: 500,
        error: 'Main branch not found',
      })
    })

    it('should save groups and commit changes for admin', async () => {
      vi.mocked(groupsLoader.saveInternalGroups).mockResolvedValue()

      const groups: InternalGroup[] = [
        {
          id: 'editors' as CanopyGroupId,
          name: 'Content Editors',
          description: 'Team members who can edit content',
          members: ['user-1' as CanopyUserId, 'user-2' as CanopyUserId],
        },
      ]

      const req: ApiRequest<UpdateInternalGroupsBody> = {
        user: { userId: 'admin-1' as CanopyUserId, role: 'admin' },
        body: { groups },
      }

      const result = await updateInternalGroups(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)

      // Verify groups were saved
      expect(groupsLoader.saveInternalGroups).toHaveBeenCalledWith(
        '/test/main',
        groups,
        'admin-1'
      )

      // Verify git operations
      expect(mockGit.add).toHaveBeenCalledWith('.canopycms/groups.json')
      expect(mockGit.commit).toHaveBeenCalledWith('Update internal groups', {
        name: 'Canopy Bot',
        email: 'bot@example.com',
      })
    })
  })

  describe('searchExternalGroups', () => {
    it('should return 403 for non-admin users', async () => {
      const req: ApiRequest<undefined> = {
        user: { userId: 'user-1' as CanopyUserId, role: 'editor' },
      }

      const params: SearchExternalGroupsParams = { query: 'test' }

      const result = await searchExternalGroups(mockContext, req, params)

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'Admin access required',
      })
    })

    it('should return 501 if auth plugin not configured', async () => {
      mockContext.services.config.authPlugin = undefined

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1' as CanopyUserId, role: 'admin' },
      }

      const params: SearchExternalGroupsParams = { query: 'test' }

      const result = await searchExternalGroups(mockContext, req, params)

      expect(result).toEqual({
        ok: false,
        status: 501,
        error: 'External group search not configured',
      })
    })

    it('should return 501 if searchExternalGroups method not available', async () => {
      mockContext.services.config.authPlugin = {
        searchUsers: vi.fn(),
        // searchExternalGroups not provided
      } as any

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1' as CanopyUserId, role: 'admin' },
      }

      const params: SearchExternalGroupsParams = { query: 'test' }

      const result = await searchExternalGroups(mockContext, req, params)

      expect(result).toEqual({
        ok: false,
        status: 501,
        error: 'External group search not configured',
      })
    })

    it('should return search results from auth plugin', async () => {
      const mockGroups = [
        { id: 'org_123' as CanopyGroupId, name: 'Acme Corporation' },
        { id: 'org_456' as CanopyGroupId, name: 'Partner Organization' },
      ]

      mockContext.services.config.authPlugin = {
        searchExternalGroups: vi.fn(async () => mockGroups),
      } as any

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1' as CanopyUserId, role: 'admin' },
      }

      const params: SearchExternalGroupsParams = { query: 'test' }

      const result = await searchExternalGroups(mockContext, req, params)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      if (result.ok) {
        expect(result.data?.groups).toEqual(mockGroups)
      }
    })

    it('should return 500 on auth plugin error', async () => {
      mockContext.services.config.authPlugin = {
        searchExternalGroups: vi.fn(async () => {
          throw new Error('Search failed')
        }),
      } as any

      const req: ApiRequest<undefined> = {
        user: { userId: 'admin-1' as CanopyUserId, role: 'admin' },
      }

      const params: SearchExternalGroupsParams = { query: 'test' }

      const result = await searchExternalGroups(mockContext, req, params)

      expect(result).toEqual({
        ok: false,
        status: 500,
        error: 'Search failed',
      })
    })
  })
})
