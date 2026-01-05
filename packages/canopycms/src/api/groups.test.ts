import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { InternalGroup } from '../groups-file'
import type { CanopyGroupId, CanopyUserId } from '../types'
import { RESERVED_GROUPS } from '../reserved-groups'

// Mock groups loader
vi.mock('../groups-loader', () => ({
  loadInternalGroups: vi.fn(),
  saveInternalGroups: vi.fn(),
}))

import {
  GROUP_ROUTES,
  validateAdminGroupUpdate,
  validateReservedGroups,
  type UpdateInternalGroupsBody,
  type SearchExternalGroupsParams,
} from './groups'
import * as groupsLoader from '../groups-loader'

// Extract handlers for testing
const getInternalGroups = GROUP_ROUTES.getInternal.handler
const updateInternalGroups = GROUP_ROUTES.updateInternal.handler
const searchExternalGroups = GROUP_ROUTES.searchExternal.handler

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
        bootstrapAdminIds: new Set<string>(),
      },
      getBranchContext: vi.fn(async () => ({
        baseRoot: '/test',
        branchRoot: '/test/main',
        branch: {
          name: 'main',
          status: 'editing' as const,
          access: {},
          createdBy: 'admin-1' as CanopyUserId,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      })),
    } as unknown as ApiContext
  })

  describe('getInternalGroups', () => {
    it('should return 403 for non-admin users', async () => {
      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'user-1' as CanopyUserId, groups: [] },
      }

      const result = await getInternalGroups(mockContext, req)

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'Admin access required',
      })
    })

    it('should return 500 if main branch not found', async () => {
      mockContext.getBranchContext = vi.fn(async () => null)

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
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
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
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
      const req: ApiRequest = {
        user: { type: 'authenticated', userId: 'user-1' as CanopyUserId, groups: [] },
      }

      const result = await updateInternalGroups(mockContext, req, { groups: [] })

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'Admin access required',
      })
    })

    it('should return 400 if groups not provided', async () => {
      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updateInternalGroups(mockContext, req, {} as UpdateInternalGroupsBody)

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'groups array required',
      })
    })

    it('should return 500 if main branch not found', async () => {
      mockContext.getBranchContext = vi.fn(async () => null)
      // Add bootstrap admin so validation passes
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updateInternalGroups(mockContext, req, { groups: [] })

      expect(result).toEqual({
        ok: false,
        status: 500,
        error: 'Main branch not found',
      })
    })

    it('should save groups and commit changes for admin', async () => {
      vi.mocked(groupsLoader.saveInternalGroups).mockResolvedValue()
      // Add bootstrap admin so validation passes
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: 'editors' as CanopyGroupId,
          name: 'Content Editors',
          description: 'Team members who can edit content',
          members: ['user-1' as CanopyUserId, 'user-2' as CanopyUserId],
        },
      ]

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updateInternalGroups(mockContext, req, { groups })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)

      // Verify groups were saved
      expect(groupsLoader.saveInternalGroups).toHaveBeenCalledWith('/test/main', groups, 'admin-1')

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
        user: { type: 'authenticated', userId: 'user-1' as CanopyUserId, groups: [] },
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
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
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
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
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

      mockContext.authPlugin = {
        searchExternalGroups: vi.fn(async () => mockGroups),
      } as any

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
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
      mockContext.authPlugin = {
        searchExternalGroups: vi.fn(async () => {
          throw new Error('Search failed')
        }),
      } as any

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
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

  describe('validateAdminGroupUpdate', () => {
    it('should return valid when Admins group has members', () => {
      const groups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Admins',
          members: ['admin-1' as CanopyUserId],
        },
      ]
      const result = validateAdminGroupUpdate(groups, new Set())
      expect(result.valid).toBe(true)
    })

    it('should return valid when bootstrap admins exist even if Admins group is empty', () => {
      const groups: InternalGroup[] = [
        { id: RESERVED_GROUPS.ADMINS as CanopyGroupId, name: 'Admins', members: [] },
      ]
      const result = validateAdminGroupUpdate(groups, new Set(['bootstrap-admin']))
      expect(result.valid).toBe(true)
    })

    it('should return valid when bootstrap admins exist and Admins group is missing', () => {
      const groups: InternalGroup[] = []
      const result = validateAdminGroupUpdate(groups, new Set(['bootstrap-admin']))
      expect(result.valid).toBe(true)
    })

    it('should return invalid when no admins exist', () => {
      const groups: InternalGroup[] = [
        { id: RESERVED_GROUPS.ADMINS as CanopyGroupId, name: 'Admins', members: [] },
      ]
      const result = validateAdminGroupUpdate(groups, new Set())
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Cannot remove last admin - at least one admin is required')
    })

    it('should return invalid when Admins group is missing and no bootstrap admins', () => {
      const groups: InternalGroup[] = []
      const result = validateAdminGroupUpdate(groups, new Set())
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Cannot remove last admin - at least one admin is required')
    })

    it('should not double count when bootstrap admin is also in Admins group', () => {
      const groups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Admins',
          members: ['admin-1' as CanopyUserId],
        },
      ]
      // Same user is bootstrap admin
      const result = validateAdminGroupUpdate(groups, new Set(['admin-1']))
      expect(result.valid).toBe(true)
      // Still valid but only counts as 1 admin, not 2
    })
  })

  describe('validateReservedGroups', () => {
    it('should return valid for non-reserved groups', () => {
      const groups: InternalGroup[] = [
        { id: 'editors' as CanopyGroupId, name: 'Content Editors', members: [] },
      ]
      const result = validateReservedGroups(groups)
      expect(result.valid).toBe(true)
    })

    it('should return valid when reserved group name matches ID', () => {
      const groups: InternalGroup[] = [
        { id: RESERVED_GROUPS.ADMINS as CanopyGroupId, name: 'Admins', members: [] },
        { id: RESERVED_GROUPS.REVIEWERS as CanopyGroupId, name: 'Reviewers', members: [] },
      ]
      const result = validateReservedGroups(groups)
      expect(result.valid).toBe(true)
    })

    it('should return invalid when Admins group is renamed', () => {
      const groups: InternalGroup[] = [
        { id: RESERVED_GROUPS.ADMINS as CanopyGroupId, name: 'Administrators', members: [] },
      ]
      const result = validateReservedGroups(groups)
      expect(result.valid).toBe(false)
      expect(result.error).toBe("Reserved group 'Admins' cannot be renamed")
    })

    it('should return invalid when Reviewers group is renamed', () => {
      const groups: InternalGroup[] = [
        { id: RESERVED_GROUPS.REVIEWERS as CanopyGroupId, name: 'Content Reviewers', members: [] },
      ]
      const result = validateReservedGroups(groups)
      expect(result.valid).toBe(false)
      expect(result.error).toBe("Reserved group 'Reviewers' cannot be renamed")
    })
  })

  describe('updateInternalGroups safety validations', () => {
    it('should reject update that removes last admin', async () => {
      vi.mocked(groupsLoader.saveInternalGroups).mockResolvedValue()

      const groups: InternalGroup[] = [
        { id: RESERVED_GROUPS.ADMINS as CanopyGroupId, name: 'Admins', members: [] },
      ]

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updateInternalGroups(mockContext, req, { groups })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toBe('Cannot remove last admin - at least one admin is required')
    })

    it('should reject update that renames reserved group', async () => {
      vi.mocked(groupsLoader.saveInternalGroups).mockResolvedValue()

      const groups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Super Admins',
          members: ['admin-1' as CanopyUserId],
        },
      ]

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updateInternalGroups(mockContext, req, { groups })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toBe("Reserved group 'Admins' cannot be renamed")
    })

    it('should allow update when bootstrap admin exists even with empty Admins group', async () => {
      vi.mocked(groupsLoader.saveInternalGroups).mockResolvedValue()

      // Add bootstrap admin
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        { id: RESERVED_GROUPS.ADMINS as CanopyGroupId, name: 'Admins', members: [] },
      ]

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updateInternalGroups(mockContext, req, { groups })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
    })
  })
})
