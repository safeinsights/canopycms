import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { defineCanopyTestConfig } from './config-test'
import { createCanopyServices, getBootstrapAdminIds, getEffectiveGroups } from './services'
import { RESERVED_GROUPS } from './reserved-groups'

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
      schema: [
        { type: 'collection', name: 'pages', path: 'pages', format: 'md', fields: [{ name: 'title', type: 'string' }] },
      ],
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
      { type: 'authenticated', userId: 'u1', groups: [] }
    )
    expect(branchAllowed.allowed).toBe(false) // default deny, no ACL
  })

  it('creates git manager using defaults', async () => {
    const cfg = defineCanopyTestConfig({
      schema: [
        { type: 'collection', name: 'pages', path: 'pages', format: 'md', fields: [{ name: 'title', type: 'string' }] },
      ],
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

describe('getEffectiveGroups', () => {
  it('returns original groups when user not in bootstrap set', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const groups = getEffectiveGroups('user_1', ['group_a', 'group_b'], bootstrapAdminIds)
    expect(groups).toEqual(['group_a', 'group_b'])
  })

  it('adds Admins group when user is in bootstrap set', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const groups = getEffectiveGroups('admin_1', ['group_a'], bootstrapAdminIds)
    expect(groups).toContain(RESERVED_GROUPS.ADMINS)
    expect(groups).toContain('group_a')
  })

  it('does not duplicate Admins group if already present', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const groups = getEffectiveGroups('admin_1', [RESERVED_GROUPS.ADMINS], bootstrapAdminIds)
    expect(groups.filter((g) => g === RESERVED_GROUPS.ADMINS).length).toBe(1)
  })

  it('handles undefined groups', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const groups = getEffectiveGroups('admin_1', undefined, bootstrapAdminIds)
    expect(groups).toEqual([RESERVED_GROUPS.ADMINS])
  })

  it('returns empty array for non-bootstrap user with no groups', () => {
    const bootstrapAdminIds = new Set(['admin_1'])
    const groups = getEffectiveGroups('user_1', undefined, bootstrapAdminIds)
    expect(groups).toEqual([])
  })
})
