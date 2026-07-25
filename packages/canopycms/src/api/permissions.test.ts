import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { PathPermission, CanopyConfig } from '../config'
import type { AuthPlugin } from '../auth/plugin'
import type { UserSearchResult, GroupMetadata } from '../auth/types'
import { RESERVED_GROUPS, SettingsFileConflictError } from '../authorization'
import {
  createMockApiContext,
  createMockBranchContext,
  createMockGitManager,
  createMockSettingsMutation,
  mockConsole,
} from '../test-utils'

// Mock authorization module (specifically the permissions loader/mutator)
vi.mock('../authorization', async (importOriginal) => {
  const { vi } = await import('vitest')
  const original = await importOriginal<typeof import('../authorization')>()
  return {
    ...original,
    loadPermissionsFile: vi.fn().mockResolvedValue(null),
    mutatePermissionsFile: vi.fn().mockResolvedValue(null),
  }
})

import { PERMISSION_ROUTES } from './permissions'
import * as authorization from '../authorization'
import { unsafeAsPermissionPath } from '../authorization/test-utils'

// Alias for convenience (tests reference permissionsLoader)
const permissionsLoader = {
  loadPermissionsFile: authorization.loadPermissionsFile,
  mutatePermissionsFile: authorization.mutatePermissionsFile,
}

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
    vi.clearAllMocks()

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
      mode: 'dev',
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
    it('returns permissions and version for admin user', async () => {
      const mockPermissions: PathPermission[] = [
        { path: unsafeAsPermissionPath('content/admin/**'), edit: {} },
        {
          path: unsafeAsPermissionPath('content/public/**'),
          edit: { allowedUsers: ['user-1'] },
        },
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

      vi.mocked(permissionsLoader.loadPermissionsFile).mockResolvedValue({
        version: 3,
        updatedAt: '2024-01-01T00:00:00Z',
        updatedBy: 'admin-1',
        pathPermissions: mockPermissions,
      })

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await getPermissions(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.permissions).toEqual(mockPermissions)
      expect(result.data?.version).toBe(3)
    })

    it('returns version 0 when no permissions file exists yet', async () => {
      mockContext.getBranchContext = vi.fn().mockResolvedValue(
        createMockBranchContext({
          branchName: 'main',
          createdBy: 'admin-1',
          baseRoot: '/test/repo',
          branchRoot: '/test/repo',
        }),
      )
      vi.mocked(permissionsLoader.loadPermissionsFile).mockResolvedValue(null)

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await getPermissions(mockContext, req)

      expect(result.ok).toBe(true)
      expect(result.data?.permissions).toEqual([])
      expect(result.data?.version).toBe(0)
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
  })

  describe('updatePermissions', () => {
    it('updates permissions for admin user', async () => {
      const newPermissions: PathPermission[] = [
        {
          path: unsafeAsPermissionPath('content/updated/**'),
          edit: { allowedGroups: ['new-group'] },
        },
      ]

      const settingsMutation = createMockSettingsMutation({ currentFile: null })
      vi.mocked(permissionsLoader.mutatePermissionsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutatePermissionsFile,
      )

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
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updatePermissions(mockContext, req, {
        permissions: newPermissions,
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(settingsMutation.getPayload()).toMatchObject({
        updatedBy: 'admin-1',
        pathPermissions: newPermissions,
      })

      // In dev mode (default), no git operations are performed
      expect(mockContext.services.commitFiles).not.toHaveBeenCalled()
    })

    it('denies access for non-admin users', async () => {
      const req: ApiRequest = {
        user: { type: 'authenticated', userId: 'user-1', groups: [] },
      }

      const result = await updatePermissions(mockContext, req, {
        permissions: [],
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Admin access required')
    })

    it('surfaces a non-200 failure when the settings commit is saved but not pushed (API-H1)', async () => {
      // The "committed but not pushed" path warns by design; swallow (and
      // assert) it so it doesn't clutter the test reporter.
      const consoleSpy = mockConsole()
      const settingsMutation = createMockSettingsMutation({ currentFile: null })
      vi.mocked(permissionsLoader.mutatePermissionsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutatePermissionsFile,
      )

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
      mockContext.services.commitToSettingsBranch = vi.fn().mockResolvedValue({
        committed: true,
        pushed: false,
        error: 'network unreachable',
      })

      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updatePermissions(mockContext, req, { permissions: [] })

      // permissions.json was written, but the client must be told the push
      // failed - it is NOT durably persisted and could be lost on redeploy.
      expect(result.ok).toBe(false)
      expect(result.status).toBe(502)
      expect(result.error).toContain('network unreachable')
      expect(consoleSpy).toHaveWarned('committed but not pushed')
      consoleSpy.restore()
    })

    it('requires permissions array in body', async () => {
      // Type as Partial to test runtime validation
      const req: ApiRequest = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updatePermissions(mockContext, req, {} as any)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toBe('permissions array required')
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
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
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
        user: {
          type: 'authenticated',
          userId: 'reviewer-1',
          groups: [RESERVED_GROUPS.REVIEWERS],
        },
        query: { q: 'test', limit: '5' },
      }

      const result = await searchUsers(mockContext, req, {
        q: 'test',
        limit: 5,
      })

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
      expect(result.error).toBe('Privileged access required')
    })

    it('returns error when auth plugin not configured', async () => {
      mockContext.authPlugin = undefined

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
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
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
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

    it('rejects a non-numeric limit instead of silently becoming NaN (API-M2)', () => {
      const endpoint = PERMISSION_ROUTES.searchUsers

      const validationResult = endpoint.validate({ params: { q: 'test', limit: 'not-a-number' } })

      expect(validationResult.ok).toBe(false)
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
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
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
        user: {
          type: 'authenticated',
          userId: 'reviewer-1',
          groups: [RESERVED_GROUPS.REVIEWERS],
        },
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
      expect(result.error).toBe('Privileged access required')
    })

    it('returns error when auth plugin not configured', async () => {
      mockContext.authPlugin = undefined

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await listGroups(mockContext, req)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(501)
      expect(result.error).toBe('Auth plugin not configured')
    })

    it('handles list errors gracefully', async () => {
      vi.mocked(mockAuthPlugin.listGroups).mockRejectedValue(new Error('Network error'))

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
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
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await getUserMetadata(mockContext, req, {
        userId: 'user-1',
      })

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
        user: {
          type: 'authenticated',
          userId: 'reviewer-1',
          groups: [RESERVED_GROUPS.REVIEWERS],
        },
      }

      const result = await getUserMetadata(mockContext, req, {
        userId: 'user-2',
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockAuthPlugin.getUserMetadata).toHaveBeenCalledWith('user-2')
    })

    it('denies access for regular users', async () => {
      const req: ApiRequest<undefined> = {
        user: { type: 'authenticated', userId: 'user-1', groups: [] },
      }

      const result = await getUserMetadata(mockContext, req, {
        userId: 'user-2',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toBe('Privileged access required')
      expect(mockAuthPlugin.getUserMetadata).not.toHaveBeenCalled()
    })

    it('returns error when auth plugin not configured', async () => {
      mockContext.authPlugin = undefined

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await getUserMetadata(mockContext, req, {
        userId: 'user-1',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(501)
      expect(result.error).toBe('Auth plugin not configured')
    })

    it('handles errors gracefully', async () => {
      vi.mocked(mockAuthPlugin.getUserMetadata).mockRejectedValue(new Error('Database error'))

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await getUserMetadata(mockContext, req, {
        userId: 'user-1',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(500)
      expect(result.error).toBe('Database error')
    })

    it('returns null for non-existent user', async () => {
      vi.mocked(mockAuthPlugin.getUserMetadata).mockResolvedValue(null)

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await getUserMetadata(mockContext, req, {
        userId: 'non-existent',
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      if (result.ok && result.data) {
        expect((result.data as { user: UserSearchResult | null }).user).toBeNull()
      }
      expect(mockAuthPlugin.getUserMetadata).toHaveBeenCalledWith('non-existent')
    })
  })

  describe('settings branch auto-creation', () => {
    it('should auto-create settings branch in prod mode when it does not exist', async () => {
      // Note: In prod and dev modes, settings use a separate settings branch
      // In dev mode, settings use the main branch

      // Create a new context with prod mode
      const prodConfig: Partial<CanopyConfig> = {
        defaultBaseBranch: 'main',
        mode: 'prod',
        settingsBranch: 'canopycms-settings',
        gitBotAuthorName: 'Test Bot',
        gitBotAuthorEmail: 'bot@test.com',
      }

      const prodContext = createMockApiContext({
        services: {
          config: prodConfig as CanopyConfig,
          createGitManagerFor: vi.fn(() => mockGit) as any,
        },
        authPlugin: mockAuthPlugin,
      })

      // Mock getSettingsBranchRoot to simulate settings workspace
      prodContext.services.getSettingsBranchRoot = vi.fn().mockResolvedValue('/test/repo/settings')

      vi.mocked(permissionsLoader.loadPermissionsFile).mockResolvedValue(null)

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await getPermissions(prodContext, req)

      // Should succeed because getSettingsBranchRoot returns settings path
      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(prodContext.services.getSettingsBranchRoot).toHaveBeenCalled()
    })

    it('should auto-create settings branch in dev mode when it does not exist', async () => {
      // Create a new context with dev mode
      const devConfig: Partial<CanopyConfig> = {
        defaultBaseBranch: 'main',
        mode: 'dev',
        settingsBranch: 'canopycms-settings',
        gitBotAuthorName: 'Test Bot',
        gitBotAuthorEmail: 'bot@test.com',
      }

      const devContext = createMockApiContext({
        services: {
          config: devConfig as CanopyConfig,
          createGitManagerFor: vi.fn(() => mockGit) as any,
        },
        authPlugin: mockAuthPlugin,
      })

      // Mock getSettingsBranchRoot to simulate settings workspace
      devContext.services.getSettingsBranchRoot = vi
        .fn()
        .mockResolvedValue('/test/repo/.canopy-dev/settings')

      vi.mocked(permissionsLoader.loadPermissionsFile).mockResolvedValue(null)

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await getPermissions(devContext, req)

      // Should succeed because getSettingsBranchRoot returns settings path
      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(devContext.services.getSettingsBranchRoot).toHaveBeenCalled()
    })
  })

  describe('optimistic locking with expectedContentVersion', () => {
    it('returns 409 when expectedContentVersion does not match the current version', async () => {
      // The mutator sees the file's real version (5) and throws
      // SettingsVersionConflictError when it doesn't match the client's
      // expectedContentVersion (3) — exactly like the real
      // mutatePermissionsFile-backed handler does.
      const settingsMutation = createMockSettingsMutation({
        currentFile: {
          version: 5,
          updatedAt: '2024-01-01T00:00:00Z',
          updatedBy: 'other-admin',
          pathPermissions: [],
        },
      })
      vi.mocked(permissionsLoader.mutatePermissionsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutatePermissionsFile,
      )

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const body = {
        permissions: [],
        expectedContentVersion: 3, // Client thinks version is 3, but it's actually 5
      }

      const result = await updatePermissions(mockContext, req, body)

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.error).toBe(
        'Permissions were modified by another user. Please reload and try again.',
      )
      // The version mismatch is detected inside the mutator BEFORE any
      // payload is computed for a write.
      expect(settingsMutation.getPayload()).toBeNull()
    })

    it('succeeds when expectedContentVersion matches the current version', async () => {
      const settingsMutation = createMockSettingsMutation({
        currentFile: {
          version: 5,
          updatedAt: '2024-01-01T00:00:00Z',
          updatedBy: 'admin-1',
          pathPermissions: [],
        },
      })
      vi.mocked(permissionsLoader.mutatePermissionsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutatePermissionsFile,
      )

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const body = {
        permissions: [],
        expectedContentVersion: 5, // Matches current version
      }

      const result = await updatePermissions(mockContext, req, body)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(settingsMutation.getPayload()).toMatchObject({
        updatedBy: 'admin-1',
        pathPermissions: [],
      })
    })

    it('allows the update when expectedContentVersion is not provided (backward compatible)', async () => {
      const settingsMutation = createMockSettingsMutation({
        currentFile: {
          version: 5,
          updatedAt: '2024-01-01T00:00:00Z',
          updatedBy: 'admin-1',
          pathPermissions: [],
        },
      })
      vi.mocked(permissionsLoader.mutatePermissionsFile).mockImplementation(
        settingsMutation.impl as typeof authorization.mutatePermissionsFile,
      )

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const body = {
        permissions: [],
        // No expectedContentVersion provided
      }

      const result = await updatePermissions(mockContext, req, body)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
    })

    it('returns 409 with a busy message when the file lock is contended', async () => {
      vi.mocked(permissionsLoader.mutatePermissionsFile).mockRejectedValueOnce(
        new SettingsFileConflictError(),
      )

      const req: ApiRequest<undefined> = {
        user: {
          type: 'authenticated',
          userId: 'admin-1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      }

      const result = await updatePermissions(mockContext, req, { permissions: [] })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.error).toBe('Settings are busy, please try again.')
    })
  })
})
