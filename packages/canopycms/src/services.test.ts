import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { defineCanopyTestConfig, createTestServices } from './config-test'
import { getBootstrapAdminIds } from './services'
import { authResultToCanopyUser } from './user'
import { RESERVED_GROUPS } from './authorization'
import type { AuthenticationResult } from './auth/types'
import type { InternalGroup } from './authorization'
import { unsafeAsPhysicalPath } from './paths/test-utils'
import { mockConsole } from './test-utils/console-spy'

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({})),
}))

/** Create a mock git instance with sensible defaults and optional overrides. */
function createMockGitInstance(overrides?: {
  currentBranch?: string
  branches?: string[]
  fetch?: ReturnType<typeof vi.fn>
  push?: ReturnType<typeof vi.fn>
  /** Extra properties merged into the mock (e.g., addConfig, listConfig). */
  extra?: Record<string, unknown>
}) {
  const branch = overrides?.currentBranch ?? 'main'
  const instance: Record<string, unknown> = {
    status: vi.fn().mockResolvedValue({ files: [], ahead: 0, behind: 0, current: branch }),
    branch: vi.fn().mockResolvedValue({ all: overrides?.branches ?? [branch], current: branch }),
    checkout: vi.fn().mockResolvedValue(undefined),
    checkoutBranch: vi.fn().mockResolvedValue(undefined),
    fetch: overrides?.fetch ?? vi.fn(),
    merge: vi.fn().mockResolvedValue(undefined),
    rebase: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    push: overrides?.push ?? vi.fn(),
    revparse: vi.fn().mockResolvedValue('main'),
    ...overrides?.extra,
  }
  instance.env = vi.fn().mockReturnValue(instance)
  return instance
}

/** Install a mock git instance for the current test. */
async function installMockGit(instance: Record<string, unknown>) {
  const { simpleGit } = await import('simple-git')
  vi.mocked(simpleGit).mockReturnValue(instance as any)
}

const testSchema = {
  collections: [
    {
      name: 'pages',
      path: 'pages',
      entries: [
        {
          name: 'page',
          format: 'md' as const,
          schema: [{ name: 'title', type: 'string' as const }],
        },
      ],
    },
  ],
}

describe('createCanopyServices', () => {
  beforeEach(async () => {
    mockConsole()
    await installMockGit(createMockGitInstance())
  })

  it('creates helpers with defaults and reuses config', async () => {
    const cfg = defineCanopyTestConfig({
      schema: testSchema,
      defaultBranchAccess: 'deny',
    })

    const services = await createTestServices({ ...cfg, schema: testSchema })

    // Path permissions are now loaded from JSON file at runtime, not from config
    // Service creates checkPathAccess with empty rules (default deny)
    const pathResult = services.checkPathAccess({
      relativePath: unsafeAsPhysicalPath('content/any/file.md'),
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
    const cfg = defineCanopyTestConfig({
      schema: testSchema,
      defaultBaseBranch: 'main',
      defaultRemoteName: 'origin',
    })
    const services = await createTestServices({ ...cfg, schema: testSchema })
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
    mockConsole()
    vi.clearAllMocks()
  })

  it('should default to strategy-computed branch name when settingsBranch not configured', async () => {
    const fetchMock = vi.fn()
    const mock = createMockGitInstance({
      currentBranch: 'canopycms-settings-prod',
      fetch: fetchMock,
    })
    await installMockGit(mock)

    const cfg = defineCanopyTestConfig({ schema: testSchema, mode: 'prod' })
    const services = await createTestServices({ ...cfg, schema: testSchema })

    await services.commitToSettingsBranch({
      branchRoot: '/tmp/repo',
      files: '.canopycms/permissions.json',
      message: 'Update permissions',
    })

    expect(fetchMock).toHaveBeenCalledWith('origin', 'canopycms-settings-prod')
  })

  it('should pull from the correct settings branch', async () => {
    const fetchMock = vi.fn()
    const mock = createMockGitInstance({ currentBranch: 'my-settings', fetch: fetchMock })
    await installMockGit(mock)

    const cfg = defineCanopyTestConfig({
      schema: testSchema,
      mode: 'prod',
      settingsBranch: 'my-settings',
    })
    const services = await createTestServices({ ...cfg, schema: testSchema })

    await services.commitToSettingsBranch({
      branchRoot: '/tmp/repo',
      files: '.canopycms/permissions.json',
      message: 'Update permissions',
    })

    expect(fetchMock).toHaveBeenCalledWith('origin', 'my-settings')
  })

  it('should use configured settingsBranch value', async () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    const pushMock = vi.fn().mockResolvedValue(undefined)
    const mock = createMockGitInstance({
      currentBranch: 'custom-settings-branch',
      fetch: fetchMock,
      push: pushMock,
      extra: {
        addConfig: vi.fn().mockResolvedValue(undefined),
        listConfig: vi.fn().mockResolvedValue({
          all: {
            'canopycms.managed': 'true',
            'user.name': 'Test Bot',
            'user.email': 'bot@test.com',
          },
        }),
      },
    })
    await installMockGit(mock)

    const cfg = defineCanopyTestConfig({
      schema: testSchema,
      mode: 'prod',
      settingsBranch: 'custom-settings-branch',
    })
    const services = await createTestServices({ ...cfg, schema: testSchema })

    await services.commitToSettingsBranch({
      branchRoot: '/tmp/repo',
      files: '.canopycms/permissions.json',
      message: 'Update permissions',
    })

    expect(fetchMock).toHaveBeenCalledWith('origin', 'custom-settings-branch')
    expect(pushMock).toHaveBeenCalled()
  })
})
