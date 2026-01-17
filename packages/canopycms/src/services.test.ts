import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { defineCanopyTestConfig } from './config-test'
import { createCanopyServices, getBootstrapAdminIds } from './services'
import { authResultToCanopyUser } from './user'
import { RESERVED_GROUPS } from './reserved-groups'
import type { AuthenticationResult } from './auth/types'
import type { InternalGroup } from './groups-file'

vi.mock('simple-git', () => {
  const stub = vi.fn(() => ({
    status: vi.fn().mockResolvedValue({ files: [], ahead: 0, behind: 0, current: 'main' }),
    branch: vi.fn().mockResolvedValue({ all: ['main'] }),
    checkout: vi.fn(),
    checkoutBranch: vi.fn(),
    fetch: vi.fn(),
    merge: vi.fn(),
    rebase: vi.fn(),
    add: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    revparse: vi.fn().mockResolvedValue('main'),
  }))
  return { simpleGit: stub }
})

describe('createCanopyServices', () => {
  it('creates helpers with defaults and reuses config', async () => {
    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          entries: { format: 'md' as const, fields: [{ name: 'title', type: 'string' as const }] },
        },
      ],
      singletons: [],
    }
    const cfg = defineCanopyTestConfig({
      schema,
      defaultBranchAccess: 'deny',
    })

    const services = await createCanopyServices(cfg, { schema })

    // Path permissions are now loaded from JSON file at runtime, not from config
    // Service creates checkPathAccess with empty rules (default deny)
    const pathResult = services.checkPathAccess({
      relativePath: 'content/any/file.md',
      user: { type: 'authenticated', userId: 'user-1', groups: [] },
      level: 'read',
    })
    expect(pathResult.allowed).toBe(false) // No rules = default deny
    expect(pathResult.reason).toBe('no_rule_match')

    const branchAllowed = services.checkBranchAccess(
      {
        baseRoot: '/tmp/base',
        branchRoot: '/tmp/base/feature-x',
        branch: {
          name: 'feature/x',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      { type: 'authenticated', userId: 'u1', groups: [] },
    )
    expect(branchAllowed.allowed).toBe(false) // default deny, no ACL
  })

  it('creates git manager using defaults', async () => {
    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          entries: { format: 'md' as const, fields: [{ name: 'title', type: 'string' as const }] },
        },
      ],
      singletons: [],
    }
    const cfg = defineCanopyTestConfig({
      schema,
      defaultBaseBranch: 'main',
      defaultRemoteName: 'origin',
    })
    const services = await createCanopyServices(cfg, { schema })
    const gm = services.createGitManagerFor('/tmp/repo')
    const status = await gm.status()
    expect(status.current).toBe('main')
  })
})

describe('getBootstrapAdminIds', () => {
  const originalEnv = process.env.CANOPY_BOOTSTRAP_ADMIN_IDS

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CANOPY_BOOTSTRAP_ADMIN_IDS
    } else {
      process.env.CANOPY_BOOTSTRAP_ADMIN_IDS = originalEnv
    }
  })

  it('returns empty set when env var not set', () => {
    delete process.env.CANOPY_BOOTSTRAP_ADMIN_IDS
    const ids = getBootstrapAdminIds()
    expect(ids.size).toBe(0)
  })

  it('parses comma-separated user IDs', () => {
    process.env.CANOPY_BOOTSTRAP_ADMIN_IDS = 'user_1,user_2,user_3'
    const ids = getBootstrapAdminIds()
    expect(ids.size).toBe(3)
    expect(ids.has('user_1')).toBe(true)
    expect(ids.has('user_2')).toBe(true)
    expect(ids.has('user_3')).toBe(true)
  })

  it('trims whitespace from IDs', () => {
    process.env.CANOPY_BOOTSTRAP_ADMIN_IDS = ' user_1 , user_2 '
    const ids = getBootstrapAdminIds()
    expect(ids.has('user_1')).toBe(true)
    expect(ids.has('user_2')).toBe(true)
  })

  it('filters out empty strings', () => {
    process.env.CANOPY_BOOTSTRAP_ADMIN_IDS = 'user_1,,user_2,'
    const ids = getBootstrapAdminIds()
    expect(ids.size).toBe(2)
  })
})

describe('authResultToCanopyUser with bootstrap admins', () => {
  it('returns ANONYMOUS_USER when auth fails', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const authResult: AuthenticationResult = { success: false }
    const user = authResultToCanopyUser(authResult, bootstrapAdminIds)

    expect(user.type).toBe('anonymous')
    expect(user.userId).toBe('anonymous')
  })

  it('returns user with original groups when not in bootstrap set', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'user_1',
        externalGroups: ['group_a', 'group_b'],
      },
    }
    const user = authResultToCanopyUser(authResult, bootstrapAdminIds)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      expect(user.userId).toBe('user_1')
      expect(user.groups).toEqual(['group_a', 'group_b'])
    }
  })

  it('adds Admins group when user is in bootstrap set', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'admin_1',
        externalGroups: ['group_a'],
      },
    }
    const user = authResultToCanopyUser(authResult, bootstrapAdminIds)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      expect(user.groups).toContain(RESERVED_GROUPS.ADMINS)
      expect(user.groups).toContain('group_a')
    }
  })

  it('does not duplicate Admins group if already present', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'admin_1',
        externalGroups: [RESERVED_GROUPS.ADMINS],
      },
    }
    const user = authResultToCanopyUser(authResult, bootstrapAdminIds)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      const adminCount = user.groups.filter((g) => g === RESERVED_GROUPS.ADMINS).length
      expect(adminCount).toBe(1)
    }
  })

  it('handles undefined external groups', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'admin_1',
      },
    }
    const user = authResultToCanopyUser(authResult, bootstrapAdminIds)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      expect(user.groups).toEqual([RESERVED_GROUPS.ADMINS])
    }
  })

  it('handles non-bootstrap user with no groups', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'user_1',
      },
    }
    const user = authResultToCanopyUser(authResult, bootstrapAdminIds)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      expect(user.groups).toEqual([])
    }
  })
})

describe('authResultToCanopyUser with internal groups', () => {
  it('merges internal group memberships', () => {
    const bootstrapAdminIds = new Set<string>()
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'user-1',
        externalGroups: ['team-a'],
      },
    }
    const internalGroups: InternalGroup[] = [
      { id: 'Reviewers', name: 'Reviewers', members: ['user-1', 'user-2'] },
      { id: 'Editors', name: 'Editors', members: ['user-2'] },
    ]

    const user = authResultToCanopyUser(authResult, bootstrapAdminIds, internalGroups)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      expect(user.groups).toEqual(['team-a', 'Reviewers'])
    }
  })

  it('does not duplicate groups from both external and internal', () => {
    const bootstrapAdminIds = new Set<string>()
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'user-1',
        externalGroups: ['Reviewers'], // Already in external
      },
    }
    const internalGroups: InternalGroup[] = [
      { id: 'Reviewers', name: 'Reviewers', members: ['user-1'] },
    ]

    const user = authResultToCanopyUser(authResult, bootstrapAdminIds, internalGroups)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      expect(user.groups).toEqual(['Reviewers']) // Not duplicated
    }
  })

  it('combines bootstrap admins, external groups, and internal groups', () => {
    const bootstrapAdminIds = new Set(['user-1'])
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'user-1',
        externalGroups: ['team-a', 'team-b'],
      },
    }
    const internalGroups: InternalGroup[] = [
      { id: 'Reviewers', name: 'Reviewers', members: ['user-1'] },
      { id: 'Editors', name: 'Editors', members: ['user-2'] },
    ]

    const user = authResultToCanopyUser(authResult, bootstrapAdminIds, internalGroups)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      expect(user.groups).toContain(RESERVED_GROUPS.ADMINS) // From bootstrap
      expect(user.groups).toContain('team-a') // From external
      expect(user.groups).toContain('team-b') // From external
      expect(user.groups).toContain('Reviewers') // From internal
      expect(user.groups).not.toContain('Editors') // Not a member
      expect(user.groups.length).toBe(4)
    }
  })

  it('works without internal groups parameter (backward compat)', () => {
    const bootstrapAdminIds = new Set<string>()
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'user-1',
        externalGroups: ['team-a'],
      },
    }

    const user = authResultToCanopyUser(authResult, bootstrapAdminIds)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      expect(user.groups).toEqual(['team-a'])
    }
  })

  it('handles empty internal groups array', () => {
    const bootstrapAdminIds = new Set<string>()
    const authResult: AuthenticationResult = {
      success: true,
      user: {
        userId: 'user-1',
        externalGroups: ['team-a'],
      },
    }
    const internalGroups: InternalGroup[] = []

    const user = authResultToCanopyUser(authResult, bootstrapAdminIds, internalGroups)

    expect(user.type).toBe('authenticated')
    if (user.type === 'authenticated') {
      expect(user.groups).toEqual(['team-a'])
    }
  })
})

describe('commitToSettingsBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should default to "canopycms-settings" branch when settingsBranch not configured', async () => {
    const branchMock = vi
      .fn()
      .mockResolvedValue({ all: ['canopycms-settings'], current: 'canopycms-settings' })
    const fetchMock = vi.fn()
    const mockGitInstance = {
      status: vi
        .fn()
        .mockResolvedValue({ files: [], ahead: 0, behind: 0, current: 'canopycms-settings' }),
      branch: branchMock,
      checkout: vi.fn(),
      checkoutBranch: vi.fn(),
      fetch: fetchMock,
      merge: vi.fn(),
      rebase: vi.fn(),
      add: vi.fn(),
      commit: vi.fn(),
      push: vi.fn(),
      revparse: vi.fn().mockResolvedValue('main'),
    }

    const { simpleGit } = await import('simple-git')
    const mockGit = vi.mocked(simpleGit)
    mockGit.mockReturnValue(mockGitInstance as any)

    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          entries: { format: 'md' as const, fields: [{ name: 'title', type: 'string' as const }] },
        },
      ],
      singletons: [],
    }
    const cfg = defineCanopyTestConfig({
      schema,
      mode: 'prod',
      // settingsBranch not specified - should default to 'canopycms-settings'
    })

    const services = await createCanopyServices(cfg, { schema })

    await services.commitToSettingsBranch({
      branchRoot: '/tmp/repo',
      files: '.canopycms/permissions.json',
      message: 'Update permissions',
    })

    // Should attempt to pull from the settings branch
    expect(fetchMock).toHaveBeenCalledWith('origin', 'canopycms-settings')
  })

  it('should pull from the correct settings branch', async () => {
    const branchMock = vi.fn().mockResolvedValue({ all: ['my-settings'], current: 'my-settings' })
    const fetchMock = vi.fn()
    const mockGitInstance = {
      status: vi.fn().mockResolvedValue({ files: [], ahead: 0, behind: 0, current: 'my-settings' }),
      branch: branchMock,
      checkout: vi.fn(),
      checkoutBranch: vi.fn(),
      fetch: fetchMock,
      merge: vi.fn(),
      rebase: vi.fn(),
      add: vi.fn(),
      commit: vi.fn(),
      push: vi.fn(),
      revparse: vi.fn().mockResolvedValue('main'),
    }

    const { simpleGit } = await import('simple-git')
    const mockGit = vi.mocked(simpleGit)
    mockGit.mockReturnValue(mockGitInstance as any)

    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          entries: { format: 'md' as const, fields: [{ name: 'title', type: 'string' as const }] },
        },
      ],
      singletons: [],
    }
    const cfg = defineCanopyTestConfig({
      schema,
      mode: 'prod',
      settingsBranch: 'my-settings',
    })

    const services = await createCanopyServices(cfg, { schema })

    await services.commitToSettingsBranch({
      branchRoot: '/tmp/repo',
      files: '.canopycms/permissions.json',
      message: 'Update permissions',
    })

    // Should pull from the settings branch (not base branch)
    expect(fetchMock).toHaveBeenCalledWith('origin', 'my-settings')
  })

  it('should use configured settingsBranch value', async () => {
    const branchMock = vi
      .fn()
      .mockResolvedValue({ all: ['custom-settings-branch'], current: 'custom-settings-branch' })
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    const pushMock = vi.fn().mockResolvedValue(undefined)
    const mockGitInstance = {
      status: vi
        .fn()
        .mockResolvedValue({ files: [], ahead: 0, behind: 0, current: 'custom-settings-branch' }),
      branch: branchMock,
      checkout: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      fetch: fetchMock,
      merge: vi.fn().mockResolvedValue(undefined),
      rebase: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      push: pushMock,
      revparse: vi.fn().mockResolvedValue('main'),
      addConfig: vi.fn().mockResolvedValue(undefined),
      listConfig: vi
        .fn()
        .mockResolvedValue({ all: { 'user.name': 'Test Bot', 'user.email': 'bot@test.com' } }),
    }

    const { simpleGit } = await import('simple-git')
    const mockGit = vi.mocked(simpleGit)
    mockGit.mockReturnValue(mockGitInstance as any)

    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          entries: { format: 'md' as const, fields: [{ name: 'title', type: 'string' as const }] },
        },
      ],
      singletons: [],
    }
    const cfg = defineCanopyTestConfig({
      schema,
      mode: 'prod',
      settingsBranch: 'custom-settings-branch',
    })

    const services = await createCanopyServices(cfg, { schema })

    await services.commitToSettingsBranch({
      branchRoot: '/tmp/repo',
      files: '.canopycms/permissions.json',
      message: 'Update permissions',
    })

    // Should pull from the settings branch (not base branch)
    expect(fetchMock).toHaveBeenCalledWith('origin', 'custom-settings-branch')
    // Should push to the settings branch
    expect(pushMock).toHaveBeenCalledWith('origin', 'custom-settings-branch')
  })
})
