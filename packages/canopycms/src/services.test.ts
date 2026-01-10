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
  it('creates helpers with defaults and reuses config', () => {
    const cfg = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'pages',
            path: 'pages',
            entries: { format: 'md', fields: [{ name: 'title', type: 'string' }] },
          },
        ],
        singletons: [],
      },
      defaultBranchAccess: 'deny',
    })

    const services = createCanopyServices(cfg)

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
    const cfg = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'pages',
            path: 'pages',
            entries: { format: 'md', fields: [{ name: 'title', type: 'string' }] },
          },
        ],
        singletons: [],
      },
      defaultBaseBranch: 'main',
      defaultRemoteName: 'origin',
    })
    const services = createCanopyServices(cfg)
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
