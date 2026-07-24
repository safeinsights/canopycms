import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { InternalGroup, GroupsFile } from '../authorization'
import type { CanopyGroupId, CanopyUserId } from '../types'
import { RESERVED_GROUPS, SettingsFileConflictError } from '../authorization'
import {
  createMockApiContext,
  createMockBranchContext,
  createMockGitManager,
  createMockSettingsMutation,
} from '../test-utils'

// Mock authorization module (specifically the groups loader/mutator).
// `deriveInternalGroups`, `RESERVED_GROUPS`, `isReservedGroup` etc. are left
// as the REAL implementation (via `...original`) since they're pure and are
// exactly what updateInternalGroupsHandler now runs under the settings-file
// lock to reconcile against the mutator's own fresh file.
vi.mock('../authorization', async (importOriginal) => {
  const { vi } = await import('vitest')
  const original = await importOriginal<typeof import('../authorization')>()
  return {
    ...original,
    loadInternalGroups: vi.fn(),
    loadGroupsFile: vi.fn(),
    mutateGroupsFile: vi.fn(),
  }
})

import {
  GROUP_ROUTES,
  validateAdminGroupUpdate,
  validateReservedGroups,
  type UpdateInternalGroupsBody,
  type SearchExternalGroupsParams,
} from './groups'
import * as authorization from '../authorization'

// Alias for convenience (tests reference groupsLoader)
const groupsLoader = {
  loadInternalGroups: authorization.loadInternalGroups,
  loadGroupsFile: authorization.loadGroupsFile,
  mutateGroupsFile: authorization.mutateGroupsFile,
}

/** Build a minimal GroupsFile for createMockSettingsMutation's `currentFile`. */
function groupsFile(groups: InternalGroup[], version = 0): GroupsFile {
  return {
    version,
    updatedAt: '2024-01-01T00:00:00.000Z',
    updatedBy: 'prior-admin' as CanopyUserId,
    groups,
  }
}

// Extract handlers for testing
const getInternalGroups = GROUP_ROUTES.getInternal.handler
const updateInternalGroups = GROUP_ROUTES.updateInternal.handler
const searchExternalGroups = GROUP_ROUTES.searchExternal.handler

describe('groups API', () => {
  let mockContext: ApiContext
  let mockGit: ReturnType<typeof createMockGitManager>

  beforeEach(() => {
    mockGit = createMockGitManager()

    mockContext = createMockApiContext({
      services: {
        config: {
          defaultBaseBranch: 'main',
          mode: 'dev',
          gitBotAuthorName: 'Canopy Bot',
          gitBotAuthorEmail: 'bot@example.com',
          sourceRoot: '/test/workspace',
        } as any,
        createGitManagerFor: vi.fn(() => mockGit) as any,
      },
      branchContext: createMockBranchContext({
        branchName: 'main',
        createdBy: 'admin-1' as CanopyUserId,
        baseRoot: '/test',
        branchRoot: '/test/main',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }),
    })
  })

  describe('getInternalGroups', () => {
    it('should return 403 for non-admin users', async () => {
      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'user-1' as CanopyUserId,
          groups: [],
        },
      }

      const result = await getInternalGroups(mockContext, req)

      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'Admin access required',
      })
    })

    it('should return derived reserved groups and version 0 when groups file does not exist', async () => {
      vi.mocked(groupsLoader.loadGroupsFile).mockResolvedValue(null)

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
        // Even with no file, the handler derives the reserved Admins/Reviewers
        // groups (deriveInternalGroups is real here) — version 0 with a
        // non-empty groups array is the documented legitimate combination
        expect(result.data?.groups).toEqual(authorization.deriveInternalGroups([]))
        expect(result.data?.version).toBe(0)
      }
    })

    it('should return the version from the groups file alongside the derived groups', async () => {
      const derivedGroups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Admins',
          members: ['admin-1' as CanopyUserId],
        },
        { id: RESERVED_GROUPS.REVIEWERS as CanopyGroupId, name: 'Reviewers', members: [] },
      ]
      vi.mocked(groupsLoader.loadGroupsFile).mockResolvedValue(groupsFile(derivedGroups, 7))

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await getInternalGroups(mockContext, req)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data?.groups).toEqual(derivedGroups)
        expect(result.data?.version).toBe(7)
      }
    })
  })

  describe('updateInternalGroups', () => {
    it('should return 403 for non-admin users', async () => {
      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'user-1' as CanopyUserId,
          groups: [],
        },
      }

      const result = await updateInternalGroups(mockContext, req, {
        groups: [],
      })

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

    it('should save groups and commit changes for admin', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({ currentFile: null })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )
      // Add bootstrap admin so validation passes
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: '' as CanopyGroupId, // Empty ID for new group
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

      // Verify groups were saved with generated IDs
      const payload = settingsMutation.getPayload()
      expect(payload).toMatchObject({ updatedBy: 'admin-1' })
      const savedGroups = payload?.groups as InternalGroup[]
      expect(savedGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Content Editors',
            description: 'Team members who can edit content',
            members: ['user-1', 'user-2'],
            id: expect.any(String), // Should have generated ID
          }),
        ]),
      )

      // Verify the generated ID is not empty
      expect(savedGroups[0].id).not.toBe('')
      expect(savedGroups[0].id.length).toBeGreaterThan(0)

      // In dev mode (default), no git operations are performed
      expect(mockContext.services.commitFiles).not.toHaveBeenCalled()
    })

    it('surfaces a non-200 failure when the settings commit is saved but not pushed (API-H1)', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({ currentFile: null })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])
      mockContext.services.commitToSettingsBranch = vi.fn().mockResolvedValue({
        committed: true,
        pushed: false,
        error: 'network unreachable',
      })

      const groups: InternalGroup[] = [
        {
          id: '' as CanopyGroupId,
          name: 'Content Editors',
          members: [],
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

      // Data was saved (mutateGroupsFile ran) but the client must be told the
      // push failed - it is NOT durably persisted and could be lost.
      expect(settingsMutation.getPayload()).not.toBeNull()
      expect(result.ok).toBe(false)
      expect(result.status).toBe(502)
      expect(result.error).toContain('network unreachable')
    })
  })

  describe('searchExternalGroups', () => {
    it('should return 403 for non-admin users', async () => {
      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'user-1' as CanopyUserId,
          groups: [],
        },
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
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Admins',
          members: [],
        },
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
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Admins',
          members: [],
        },
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
        {
          id: 'editors' as CanopyGroupId,
          name: 'Content Editors',
          members: [],
        },
      ]
      const result = validateReservedGroups(groups)
      expect(result.valid).toBe(true)
    })

    it('should return valid when reserved group name matches ID', () => {
      const groups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Admins',
          members: [],
        },
        {
          id: RESERVED_GROUPS.REVIEWERS as CanopyGroupId,
          name: 'Reviewers',
          members: [],
        },
      ]
      const result = validateReservedGroups(groups)
      expect(result.valid).toBe(true)
    })

    it('should return invalid when Admins group is renamed', () => {
      const groups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Administrators',
          members: [],
        },
      ]
      const result = validateReservedGroups(groups)
      expect(result.valid).toBe(false)
      expect(result.error).toBe("Reserved group 'Admins' cannot be renamed")
    })

    it('should return invalid when Reviewers group is renamed', () => {
      const groups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.REVIEWERS as CanopyGroupId,
          name: 'Content Reviewers',
          members: [],
        },
      ]
      const result = validateReservedGroups(groups)
      expect(result.valid).toBe(false)
      expect(result.error).toBe("Reserved group 'Reviewers' cannot be renamed")
    })
  })

  describe('updateInternalGroups safety validations', () => {
    it('should reject update that removes last admin', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({ currentFile: null })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )

      const groups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Admins',
          members: [],
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
      expect(result.error).toBe('Cannot remove last admin - at least one admin is required')
    })

    it('should reject update that renames reserved group', async () => {
      // Existing Admins group so it's recognized as an existing ID
      const settingsMutation = createMockSettingsMutation<GroupsFile>({
        currentFile: groupsFile([
          {
            id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
            name: RESERVED_GROUPS.ADMINS,
            members: ['admin-1' as CanopyUserId],
          },
        ]),
      })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )

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
      const settingsMutation = createMockSettingsMutation<GroupsFile>({ currentFile: null })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )

      // Add bootstrap admin
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
          name: 'Admins',
          members: [],
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
    })
  })

  describe('collision detection', () => {
    it('should reject duplicate group names', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({ currentFile: null })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: '' as CanopyGroupId,
          name: 'Editors',
          members: [],
        },
        {
          id: '' as CanopyGroupId,
          name: 'Editors', // Duplicate name
          members: [],
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
      expect(result.error).toBe('Duplicate group name detected: Editors')
    })

    it('should reject duplicate group names case-insensitively', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({ currentFile: null })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: '' as CanopyGroupId,
          name: 'Editors',
          members: [],
        },
        {
          id: '' as CanopyGroupId,
          name: 'editors', // Same name, different case
          members: [],
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
      expect(result.error).toBe('Duplicate group name detected: editors')
    })

    it('should reject groups with manually specified duplicate IDs', async () => {
      const existingGroups: InternalGroup[] = [
        {
          id: 'existing-1' as CanopyGroupId,
          name: 'Existing Group',
          members: [],
        },
      ]

      const settingsMutation = createMockSettingsMutation<GroupsFile>({
        currentFile: groupsFile(existingGroups),
      })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: 'existing-1' as CanopyGroupId,
          name: 'Existing Group',
          members: [],
        },
        {
          id: 'existing-1' as CanopyGroupId, // Duplicate ID
          name: 'Another Group',
          members: [],
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
      expect(result.error).toBe('Duplicate group ID detected: existing-1')
    })
  })

  describe('autogenerated group IDs', () => {
    it('should generate unique IDs for new groups', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({ currentFile: null })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: '' as CanopyGroupId,
          name: 'Group 1',
          members: [],
        },
        {
          id: '' as CanopyGroupId,
          name: 'Group 2',
          members: [],
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

      const savedGroups = settingsMutation.getPayload()?.groups as InternalGroup[]
      expect(savedGroups).toBeDefined()
      expect(savedGroups.length).toBe(2)
      expect(savedGroups[0].id).not.toBe('')
      expect(savedGroups[1].id).not.toBe('')
      expect(savedGroups[0].id).not.toBe(savedGroups[1].id) // Different IDs
    })

    it('should preserve IDs for existing groups', async () => {
      const existingGroups: InternalGroup[] = [
        {
          id: 'existing-group-id' as CanopyGroupId,
          name: 'Existing Group',
          members: [],
        },
      ]

      const settingsMutation = createMockSettingsMutation<GroupsFile>({
        currentFile: groupsFile(existingGroups),
      })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: 'existing-group-id' as CanopyGroupId,
          name: 'Existing Group (updated)',
          members: ['user-1' as CanopyUserId],
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

      const savedGroups = settingsMutation.getPayload()?.groups as InternalGroup[]
      expect(savedGroups.length).toBe(1)
      expect(savedGroups[0].id).toBe('existing-group-id') // ID preserved
      expect(savedGroups[0].name).toBe('Existing Group (updated)') // But name updated
    })

    it('should use group name as ID for reserved groups', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({ currentFile: null })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: '' as CanopyGroupId,
          name: 'Admins',
          members: ['admin-1' as CanopyUserId],
        },
        {
          id: '' as CanopyGroupId,
          name: 'Reviewers',
          members: [],
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

      const savedGroups = settingsMutation.getPayload()?.groups as InternalGroup[]
      expect(savedGroups.length).toBe(2)
      expect(savedGroups[0].id).toBe('Admins') // Reserved group uses name as ID
      expect(savedGroups[1].id).toBe('Reviewers') // Reserved group uses name as ID
    })

    it('should mix existing groups with new groups correctly', async () => {
      const existingGroups: InternalGroup[] = [
        {
          id: 'existing-1' as CanopyGroupId,
          name: 'Existing Group',
          members: [],
        },
      ]

      const settingsMutation = createMockSettingsMutation<GroupsFile>({
        currentFile: groupsFile(existingGroups),
      })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )
      ;(mockContext.services as any).bootstrapAdminIds = new Set(['bootstrap-admin'])

      const groups: InternalGroup[] = [
        {
          id: 'existing-1' as CanopyGroupId,
          name: 'Existing Group',
          members: [],
        },
        {
          id: '' as CanopyGroupId,
          name: 'New Group',
          members: [],
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

      const savedGroups = settingsMutation.getPayload()?.groups as InternalGroup[]
      expect(savedGroups.length).toBe(2)
      expect(savedGroups[0].id).toBe('existing-1') // Existing ID preserved
      expect(savedGroups[1].id).not.toBe('') // New group got generated ID
      expect(savedGroups[1].id).not.toBe('existing-1') // Different from existing
    })
  })

  describe('optimistic locking with expectedContentVersion', () => {
    it('should return 409 when expectedContentVersion does not match current version', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({
        currentFile: groupsFile(
          [
            {
              id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
              name: 'Admins',
              members: ['admin-1' as CanopyUserId],
            },
          ],
          5,
        ),
      })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const body = {
        groups: [
          {
            id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
            name: 'Admins',
            members: ['admin-1' as CanopyUserId],
          },
        ],
        expectedContentVersion: 3, // Client thinks version is 3, but it's actually 5
      }

      const result = await updateInternalGroups(mockContext, req, body)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.error).toBe(
        'Groups were modified by another user. Please reload and try again.',
      )
      expect(settingsMutation.getPayload()).toBeNull()
    })

    it('should succeed when expectedContentVersion matches current version', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({
        currentFile: groupsFile(
          [
            {
              id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
              name: 'Admins',
              members: ['admin-1' as CanopyUserId],
            },
          ],
          5,
        ),
      })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const body = {
        groups: [
          {
            id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
            name: 'Admins',
            members: ['admin-1' as CanopyUserId],
          },
        ],
        expectedContentVersion: 5, // Matches current version
      }

      const result = await updateInternalGroups(mockContext, req, body)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(settingsMutation.getPayload()).toMatchObject({
        groups: [{ id: RESERVED_GROUPS.ADMINS, name: 'Admins', members: ['admin-1'] }],
      })
    })

    it('should allow update when expectedContentVersion is not provided (backward compatible)', async () => {
      const settingsMutation = createMockSettingsMutation<GroupsFile>({
        currentFile: groupsFile(
          [
            {
              id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
              name: 'Admins',
              members: ['admin-1' as CanopyUserId],
            },
          ],
          5,
        ),
      })
      vi.mocked(groupsLoader.mutateGroupsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutateGroupsFile,
      )

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const body = {
        groups: [
          {
            id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
            name: 'Admins',
            members: ['admin-1' as CanopyUserId],
          },
        ],
        // No expectedContentVersion provided
      }

      const result = await updateInternalGroups(mockContext, req, body)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
    })

    it('should return 409 with a busy message when the file lock is contended', async () => {
      vi.mocked(groupsLoader.mutateGroupsFile).mockRejectedValueOnce(
        new SettingsFileConflictError(),
      )

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1' as CanopyUserId,
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const body = {
        groups: [
          {
            id: RESERVED_GROUPS.ADMINS as CanopyGroupId,
            name: 'Admins',
            members: ['admin-1' as CanopyUserId],
          },
        ],
      }

      const result = await updateInternalGroups(mockContext, req, body)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.error).toBe('Settings are busy, please try again.')
    })
  })
})
