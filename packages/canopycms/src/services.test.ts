import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { defineCanopyTestConfig, createTestServices } from './config-test'
import { createCanopyServices, getBootstrapAdminIds } from './services'
import { authResultToCanopyUser } from './user'
import { RESERVED_GROUPS } from './authorization'
import type { AuthenticationResult } from './auth/types'
import type { InternalGroup } from './authorization'
import { unsafeAsPhysicalPath } from './paths/test-utils'
import { mockConsole } from './test-utils/console-spy'

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({})),
}))

// Wrap detectHeadBranch so tests can assert whether services shell out to git
vi.mock('./utils/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/git')>()
  return { ...actual, detectHeadBranch: vi.fn(actual.detectHeadBranch) }
})

/** Create a mock git instance with sensible defaults and optional overrides. */
function createMockGitInstance(overrides?: {
  currentBranch?: string
  branches?: string[]
  fetch?: ReturnType<typeof vi.fn>
  push?: ReturnType<typeof vi.fn>
  raw?: ReturnType<typeof vi.fn>
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
    // GitManager.push()/forcePush() route through raw() so --end-of-options can
    // guard the positional refspec (SEC-H2); mock it here for those paths.
    raw: overrides?.raw ?? vi.fn().mockResolvedValue(''),
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

describe('active branch detection', () => {
  const mockBranchSchemaCache = {
    getSchema: async () => ({ schema: testSchema, flatSchema: [] }),
    invalidate: async () => {},
  } as unknown as NonNullable<Parameters<typeof createCanopyServices>[1]>['branchSchemaCache']

  const makeServices = async (overrides: Record<string, unknown>) => {
    const cfg = defineCanopyTestConfig({ schema: testSchema }, overrides)
    return createCanopyServices(cfg, { branchSchemaCache: mockBranchSchemaCache })
  }

  beforeEach(async () => {
    mockConsole()
    const { detectHeadBranch } = await import('./utils/git')
    vi.mocked(detectHeadBranch).mockReset()
  })

  it('dev mode detects the active branch from git HEAD at creation', async () => {
    const { detectHeadBranch } = await import('./utils/git')
    vi.mocked(detectHeadBranch).mockResolvedValue('feature-x')

    const services = await makeServices({ mode: 'dev' })
    expect(detectHeadBranch).toHaveBeenCalled()
    expect(services.config.defaultActiveBranch).toBe('feature-x')
  })

  it('dev mode bakes the detected HEAD as base branch when unset', async () => {
    const { detectHeadBranch } = await import('./utils/git')
    vi.mocked(detectHeadBranch).mockResolvedValue('feature-x')

    const services = await makeServices({ mode: 'dev' })
    expect(services.config.defaultBaseBranch).toBe('feature-x')
  })

  it('explicit defaultBaseBranch pins the fork point while active follows HEAD', async () => {
    const { detectHeadBranch } = await import('./utils/git')
    vi.mocked(detectHeadBranch).mockResolvedValue('feature-x')

    const services = await makeServices({ mode: 'dev', defaultBaseBranch: 'develop' })
    expect(services.config.defaultBaseBranch).toBe('develop')
    expect(services.config.defaultActiveBranch).toBe('feature-x')

    await services.refreshActiveBranch()
    expect(services.config.defaultBaseBranch).toBe('develop')
  })

  it('detached HEAD falls back to defaultBaseBranch, not main', async () => {
    const { detectHeadBranch } = await import('./utils/git')
    // Simulate the real detached-HEAD behavior: detectHeadBranch returns its fallback
    vi.mocked(detectHeadBranch).mockImplementation(async (_root, fallback) => fallback ?? 'main')

    const services = await makeServices({ mode: 'dev', defaultBaseBranch: 'develop' })
    expect(services.config.defaultActiveBranch).toBe('develop')
  })

  it('static deployments never shell out to git, at creation or on refresh', async () => {
    const { detectHeadBranch } = await import('./utils/git')

    const services = await makeServices({ mode: 'dev', deployedAs: 'static' })
    expect(services.config.defaultActiveBranch).toBe('main')

    await services.refreshActiveBranch()
    expect(detectHeadBranch).not.toHaveBeenCalled()
  })

  it('static deployments serve from a non-default configured base branch', async () => {
    const { detectHeadBranch } = await import('./utils/git')

    const services = await makeServices({
      mode: 'dev',
      deployedAs: 'static',
      defaultBaseBranch: 'develop',
    })
    expect(services.config.defaultActiveBranch).toBe('develop')
    expect(services.config.defaultBaseBranch).toBe('develop')
    expect(detectHeadBranch).not.toHaveBeenCalled()
  })

  it('explicit branch identity is never overridden by detection or refresh', async () => {
    const { detectHeadBranch } = await import('./utils/git')

    const services = await makeServices({
      mode: 'dev',
      defaultActiveBranch: 'pinned',
      defaultBaseBranch: 'base-pin',
    })
    await services.refreshActiveBranch()

    expect(services.config.defaultActiveBranch).toBe('pinned')
    expect(services.config.defaultBaseBranch).toBe('base-pin')
    expect(detectHeadBranch).not.toHaveBeenCalled()
  })

  it('with active pinned, an unset base branch still follows git HEAD', async () => {
    const { detectHeadBranch } = await import('./utils/git')
    vi.mocked(detectHeadBranch).mockResolvedValue('feature-x')

    const services = await makeServices({ mode: 'dev', defaultActiveBranch: 'pinned' })
    expect(services.config.defaultActiveBranch).toBe('pinned')
    expect(services.config.defaultBaseBranch).toBe('feature-x')
  })

  it('refreshActiveBranch adopts a new git HEAD after the detection TTL', async () => {
    const { detectHeadBranch } = await import('./utils/git')
    vi.mocked(detectHeadBranch).mockResolvedValue('feature-x')
    vi.useFakeTimers()
    try {
      const services = await makeServices({ mode: 'dev' })
      expect(services.config.defaultActiveBranch).toBe('feature-x')

      vi.mocked(detectHeadBranch).mockResolvedValue('feature-y')
      // Within the 5s TTL the cached HEAD is reused
      await services.refreshActiveBranch()
      expect(services.config.defaultActiveBranch).toBe('feature-x')

      vi.advanceTimersByTime(6000)
      await services.refreshActiveBranch()
      expect(services.config.defaultActiveBranch).toBe('feature-y')
      // The unset base branch follows HEAD too, so workspaces provisioned
      // mid-session fork from the developer's current branch
      expect(services.config.defaultBaseBranch).toBe('feature-y')
    } finally {
      vi.useRealTimers()
    }
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
    const rawMock = vi.fn().mockResolvedValue('')
    const mock = createMockGitInstance({
      currentBranch: 'custom-settings-branch',
      fetch: fetchMock,
      raw: rawMock,
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
    // push() now goes through raw(['push', ...]) to place --end-of-options
    // before the positional refspec (SEC-H2 guard).
    expect(rawMock).toHaveBeenCalledWith(expect.arrayContaining(['push', '--end-of-options']))
  })
})
