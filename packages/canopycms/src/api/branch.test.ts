import { describe, expect, it, vi, beforeEach } from 'vitest'

import { createBranch, listBranches, deleteBranch, updateBranchAccess, canCreateBranch, canDeleteBranch, canModifyBranchAccess } from './branch'
import type { ApiContext } from './types'
import { RESERVED_GROUPS } from '../reserved-groups'

// Mock permissions loader
vi.mock('../permissions-loader', () => ({
  loadPathPermissions: vi.fn(),
}))

import * as permissionsLoader from '../permissions-loader'

vi.mock('../branch-workspace', () => {
  return {
    BranchWorkspaceManager: vi.fn().mockImplementation(() => ({
      openOrCreateBranch: vi.fn().mockResolvedValue({
        state: {
          branch: {
            name: 'feature/test',
            status: 'editing',
            access: {},
            createdBy: 'user-1',
            createdAt: 'now',
            updatedAt: 'now',
          },
        },
      }),
    })),
  }
})

vi.mock('../branch-registry', () => {
  return {
    BranchRegistry: vi.fn().mockImplementation(() => ({
      list: vi.fn().mockResolvedValue([
        {
          branch: { name: 'feature/a', status: 'editing', access: {}, createdBy: 'u1', createdAt: 'now', updatedAt: 'now' },
        },
        {
          branch: { name: 'feature/b', status: 'editing', access: {}, createdBy: 'u2', createdAt: 'now', updatedAt: 'now' },
        },
        {
          branch: {
            name: 'feature/c',
            status: 'editing',
            access: { allowedUsers: ['u1'] },
            createdBy: 'u3',
            createdAt: 'now',
            updatedAt: 'now',
          },
        },
        {
          branch: {
            name: 'feature/d',
            status: 'editing',
            access: { allowedGroups: ['editors'] },
            createdBy: 'u3',
            createdAt: 'now',
            updatedAt: 'now',
          },
        },
      ]),
      remove: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    })),
  }
})

vi.mock('../branch-metadata', () => {
  return {
    BranchMetadata: vi.fn().mockImplementation(() => ({
      update: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        branch: {
          name: 'feature/x',
          status: 'editing',
          access: { allowedUsers: ['u2'] },
          createdBy: 'u1',
          createdAt: 'now',
          updatedAt: 'updated-now',
        },
      }),
    })),
  }
})

const makeBranchStateForMain = () => ({
  branch: { name: 'main', status: 'editing' as const, access: {}, createdBy: 'system', createdAt: 'now', updatedAt: 'now' },
  workspaceRoot: '/test/repo',
})

const baseCtx: ApiContext = {
  services: {
    config: { schema: [], defaultBaseBranch: 'main', mode: 'local-simple' } as any,
    checkBranchAccess: vi.fn(),
    checkContentAccess: vi.fn(),
    bootstrapAdminIds: new Set<string>(),
  },
  getBranchState: vi.fn().mockResolvedValue(makeBranchStateForMain()),
}

beforeEach(() => {
  // Default: no path permissions (open access)
  vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue([])
})

describe('canCreateBranch', () => {
  it('allows admins to create branches', () => {
    const result = canCreateBranch(
      { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] },
      [{ path: 'content/**', allowedUsers: ['other'] }]
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('privileged_user')
  })

  it('allows reviewers to create branches', () => {
    const result = canCreateBranch(
      { userId: 'u1', groups: [RESERVED_GROUPS.REVIEWERS] },
      [{ path: 'content/**', allowedUsers: ['other'] }]
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('privileged_user')
  })

  it('allows anyone when no path permissions defined', () => {
    const result = canCreateBranch({ userId: 'u1', groups: [] }, [])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('no_restrictions')
  })

  it('allows user with matching userId in path rule', () => {
    const result = canCreateBranch({ userId: 'u1', groups: [] }, [{ path: 'content/**', allowedUsers: ['u1', 'u2'] }])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('path_access')
  })

  it('allows user with matching group in path rule', () => {
    const result = canCreateBranch({ userId: 'u1', groups: ['editors'] }, [{ path: 'content/**', allowedGroups: ['editors'] }])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('path_access')
  })

  it('allows anyone for open path rules (no user/group constraints)', () => {
    const result = canCreateBranch({ userId: 'u1', groups: [] }, [{ path: 'content/**' }])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('open_path_rule')
  })

  it('denies user with no matching path access', () => {
    const result = canCreateBranch({ userId: 'u1', groups: [] }, [{ path: 'content/**', allowedUsers: ['other'] }])
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_path_access')
  })

  it('skips managerOrAdminAllowed rules for non-privileged users', () => {
    const result = canCreateBranch(
      { userId: 'u1', groups: [] },
      [
        { path: 'admin/**', managerOrAdminAllowed: true },
        { path: 'content/**', allowedUsers: ['u1'] },
      ]
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('path_access')
  })

  it('denies when all rules are managerOrAdminAllowed', () => {
    const result = canCreateBranch({ userId: 'u1', groups: [] }, [{ path: 'admin/**', managerOrAdminAllowed: true }])
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_path_access')
  })
})

describe('branch api', () => {
  it('rejects missing branch name', async () => {
    const res = await createBranch(baseCtx, { user: { userId: 'u1' } })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })

  it('creates branch via workspace manager', async () => {
    const res = await createBranch(baseCtx, { user: { userId: 'u1' }, body: { branch: 'feature/test' } })
    expect(res.ok).toBe(true)
    expect(res.data?.branch.branch.name).toBe('feature/test')
  })

  it('rejects branch creation when user has no path access', async () => {
    // Mock permissions loaded from JSON file
    vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue([
      { path: 'content/**', allowedUsers: ['other-user'] },
    ])
    const res = await createBranch(baseCtx, { user: { userId: 'u1', groups: [] }, body: { branch: 'feature/test' } })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.error).toBe('You do not have permission to create branches')
  })

  it('allows admin to create branch even with restrictions', async () => {
    // Mock permissions loaded from JSON file
    vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue([
      { path: 'content/**', allowedUsers: ['other-user'] },
    ])
    const res = await createBranch(baseCtx, {
      user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] },
      body: { branch: 'feature/test' },
    })
    expect(res.ok).toBe(true)
  })

  it('loads permissions from JSON file via main branch', async () => {
    // This test verifies the new behavior: permissions come from JSON, not config
    const mockPermissions = [{ path: 'content/**', allowedUsers: ['u1'] }]
    vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue(mockPermissions)

    const res = await createBranch(baseCtx, { user: { userId: 'u1', groups: [] }, body: { branch: 'feature/test' } })

    expect(res.ok).toBe(true)
    expect(permissionsLoader.loadPathPermissions).toHaveBeenCalled()
  })

  it('lists all branches for admins', async () => {
    const res = await listBranches(baseCtx, { user: { userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] } })
    expect(res.ok).toBe(true)
    expect(res.data?.branches).toHaveLength(4)
  })

  it('lists all branches for reviewers', async () => {
    const res = await listBranches(baseCtx, { user: { userId: 'reviewer', groups: [RESERVED_GROUPS.REVIEWERS] } })
    expect(res.ok).toBe(true)
    expect(res.data?.branches).toHaveLength(4)
  })

  it('filters branches for regular users - shows own branches', async () => {
    const res = await listBranches(baseCtx, { user: { userId: 'u1', groups: [] } })
    expect(res.ok).toBe(true)
    // u1 created feature/a and is in allowedUsers for feature/c
    const names = res.data?.branches.map((b) => b.branch.name)
    expect(names).toContain('feature/a')
    expect(names).toContain('feature/c')
    expect(names).not.toContain('feature/b')
    expect(names).not.toContain('feature/d')
  })

  it('filters branches for users - shows branches where user group is allowed', async () => {
    const res = await listBranches(baseCtx, { user: { userId: 'u4', groups: ['editors'] } })
    expect(res.ok).toBe(true)
    // u4 has 'editors' group which is in allowedGroups for feature/d
    const names = res.data?.branches.map((b) => b.branch.name)
    expect(names).toContain('feature/d')
    expect(names).not.toContain('feature/a')
    expect(names).not.toContain('feature/b')
    expect(names).not.toContain('feature/c')
  })

  it('shows empty list when user has no access', async () => {
    const res = await listBranches(baseCtx, { user: { userId: 'nobody', groups: [] } })
    expect(res.ok).toBe(true)
    expect(res.data?.branches).toHaveLength(0)
  })
})

describe('canDeleteBranch', () => {
  const makeBranchState = (createdBy: string, status = 'editing' as const) => ({
    branch: { name: 'feature/x', status, access: {}, createdBy, createdAt: 'now', updatedAt: 'now' },
  })

  it('allows admins to delete any branch', () => {
    const result = canDeleteBranch({ userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] }, makeBranchState('other'))
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('admin')
  })

  it('allows branch creator to delete their branch', () => {
    const result = canDeleteBranch({ userId: 'u1', groups: [] }, makeBranchState('u1'))
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('creator')
  })

  it('denies non-creator non-admin from deleting', () => {
    const result = canDeleteBranch({ userId: 'u2', groups: [] }, makeBranchState('u1'))
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not_authorized')
  })

  it('denies reviewers from deleting others branches', () => {
    const result = canDeleteBranch({ userId: 'u2', groups: [RESERVED_GROUPS.REVIEWERS] }, makeBranchState('u1'))
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not_authorized')
  })
})

describe('deleteBranch api', () => {
  const makeBranchState = (createdBy: string, status: 'editing' | 'submitted' = 'editing') => ({
    branch: { name: 'feature/x', status, access: {}, createdBy, createdAt: 'now', updatedAt: 'now' },
  })

  it('returns 400 if branch param missing', async () => {
    const res = await deleteBranch(baseCtx, { user: { userId: 'u1' } }, { branch: '' })
    expect(res.status).toBe(400)
  })

  it('returns 404 if branch not found', async () => {
    const ctx = { ...baseCtx, getBranchState: vi.fn().mockResolvedValue(null) }
    const res = await deleteBranch(ctx, { user: { userId: 'u1' } }, { branch: 'feature/missing' })
    expect(res.status).toBe(404)
  })

  it('returns 403 if user not authorized', async () => {
    const ctx = { ...baseCtx, getBranchState: vi.fn().mockResolvedValue(makeBranchState('other')) }
    const res = await deleteBranch(ctx, { user: { userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.status).toBe(403)
    expect(res.error).toBe('You do not have permission to delete this branch')
  })

  it('returns 400 if branch has submitted status', async () => {
    const ctx = { ...baseCtx, getBranchState: vi.fn().mockResolvedValue(makeBranchState('u1', 'submitted')) }
    const res = await deleteBranch(ctx, { user: { userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.status).toBe(400)
    expect(res.error).toBe('Cannot delete branch with open pull request')
  })

  it('deletes branch when user is creator', async () => {
    const ctx = { ...baseCtx, getBranchState: vi.fn().mockResolvedValue(makeBranchState('u1')) }
    const res = await deleteBranch(ctx, { user: { userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
  })

  it('deletes branch when user is admin', async () => {
    const ctx = { ...baseCtx, getBranchState: vi.fn().mockResolvedValue(makeBranchState('other')) }
    const res = await deleteBranch(ctx, { user: { userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
  })
})

describe('canModifyBranchAccess', () => {
  const makeBranchState = (createdBy: string) => ({
    branch: { name: 'feature/x', status: 'editing' as const, access: {}, createdBy, createdAt: 'now', updatedAt: 'now' },
  })

  it('allows admins to modify any branch', () => {
    const result = canModifyBranchAccess({ userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] }, makeBranchState('other'))
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('admin')
  })

  it('allows branch creator to modify their branch', () => {
    const result = canModifyBranchAccess({ userId: 'u1', groups: [] }, makeBranchState('u1'))
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('creator')
  })

  it('denies non-creator non-admin from modifying', () => {
    const result = canModifyBranchAccess({ userId: 'u2', groups: [] }, makeBranchState('u1'))
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not_authorized')
  })

  it('denies reviewers from modifying others branches', () => {
    const result = canModifyBranchAccess({ userId: 'u2', groups: [RESERVED_GROUPS.REVIEWERS] }, makeBranchState('u1'))
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not_authorized')
  })
})

describe('updateBranchAccess api', () => {
  const makeBranchState = (createdBy: string) => ({
    branch: { name: 'feature/x', status: 'editing' as const, access: {}, createdBy, createdAt: 'now', updatedAt: 'now' },
    metadataRoot: '/tmp/metadata',
  })

  it('returns 400 if branch param missing', async () => {
    const res = await updateBranchAccess(baseCtx, { user: { userId: 'u1' } }, { branch: '' })
    expect(res.status).toBe(400)
  })

  it('returns 404 if branch not found', async () => {
    const ctx = { ...baseCtx, getBranchState: vi.fn().mockResolvedValue(null) }
    const res = await updateBranchAccess(ctx, { user: { userId: 'u1' } }, { branch: 'feature/missing' })
    expect(res.status).toBe(404)
  })

  it('returns 403 if user not authorized', async () => {
    const ctx = { ...baseCtx, getBranchState: vi.fn().mockResolvedValue(makeBranchState('other')) }
    const res = await updateBranchAccess(ctx, { user: { userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.status).toBe(403)
    expect(res.error).toBe('You do not have permission to modify this branch')
  })

  it('updates branch access when user is creator', async () => {
    const ctx = { ...baseCtx, getBranchState: vi.fn().mockResolvedValue(makeBranchState('u1')) }
    const res = await updateBranchAccess(
      ctx,
      { user: { userId: 'u1', groups: [] }, body: { allowedUsers: ['u2', 'u3'] } },
      { branch: 'feature/x' }
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch.branch.access.allowedUsers).toEqual(['u2', 'u3'])
  })

  it('updates branch access when user is admin', async () => {
    const ctx = { ...baseCtx, getBranchState: vi.fn().mockResolvedValue(makeBranchState('other')) }
    const res = await updateBranchAccess(
      ctx,
      { user: { userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] }, body: { allowedGroups: ['editors'] } },
      { branch: 'feature/x' }
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch.branch.access.allowedGroups).toEqual(['editors'])
  })

  it('returns 500 if metadataRoot is missing', async () => {
    const ctx = {
      ...baseCtx,
      getBranchState: vi.fn().mockResolvedValue({
        branch: { name: 'feature/x', status: 'editing', access: {}, createdBy: 'u1', createdAt: 'now', updatedAt: 'now' },
        // No metadataRoot
      }),
    }
    const res = await updateBranchAccess(ctx, { user: { userId: 'u1', groups: [] }, body: { allowedUsers: ['u2'] } }, { branch: 'feature/x' })
    expect(res.status).toBe(500)
    expect(res.error).toBe('Branch metadata root not found')
  })
})
