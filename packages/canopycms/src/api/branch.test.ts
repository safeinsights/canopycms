import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock authorization module (specifically loadPathPermissions)
vi.mock('../authorization', async (importOriginal) => {
  const { vi } = await import('vitest')
  const original = await importOriginal<typeof import('../authorization')>()
  return {
    ...original,
    loadPathPermissions: vi.fn(),
  }
})

const mockMetadataUpdate = vi.fn().mockImplementation((updates: { branch?: { access?: any } }) => {
  return Promise.resolve({
    schemaVersion: 1,
    branch: {
      name: 'feature/x',
      status: 'editing',
      access: updates?.branch?.access ?? { allowedUsers: ['u2'] },
      createdBy: 'u1',
      createdAt: 'now',
      updatedAt: 'updated-now',
    },
  })
})

vi.mock('../branch-metadata', () => ({
  BranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataUpdate,
  })),
  getBranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataUpdate,
  })),
}))

vi.mock('../branch-workspace', () => ({
  BranchWorkspaceManager: vi.fn().mockImplementation(() => ({
    openOrCreateBranch: vi.fn().mockResolvedValue({
      baseRoot: '/tmp/base',
      branchRoot: '/tmp/base/feature-test',
      branch: {
        name: 'feature/test',
        status: 'editing',
        access: {},
        createdBy: 'user-1',
        createdAt: 'now',
        updatedAt: 'now',
      },
    }),
  })),
}))

import {
  createBranchHandler as createBranch,
  listBranchesHandler as listBranches,
  deleteBranchHandler as deleteBranch,
  updateBranchAccessHandler as updateBranchAccess,
  canCreateBranch,
  canDeleteBranch,
  canModifyBranchAccess,
} from './branch'
import type { ApiContext } from './types'
import { RESERVED_GROUPS } from '../authorization'
import { createMockApiContext, createMockBranchContext, createMockRegistry } from '../test-utils'
import * as authorization from '../authorization'

// Alias for convenience (tests reference permissionsLoader)
const permissionsLoader = {
  loadPathPermissions: authorization.loadPathPermissions,
}

const mockRegistry = createMockRegistry([
  createMockBranchContext({ branchName: 'feature/a', createdBy: 'u1', baseRoot: '/test/base' }),
  createMockBranchContext({ branchName: 'feature/b', createdBy: 'u2', baseRoot: '/test/base' }),
  createMockBranchContext({
    branchName: 'feature/c',
    createdBy: 'u3',
    access: { allowedUsers: ['u1'] },
    baseRoot: '/test/base',
  }),
  createMockBranchContext({
    branchName: 'feature/d',
    createdBy: 'u3',
    access: { allowedGroups: ['editors'] },
    baseRoot: '/test/base',
  }),
])

const baseCtx = createMockApiContext({
  branchContext: createMockBranchContext({
    branchName: 'main',
    createdBy: 'system',
    baseRoot: '/test/repo',
    branchRoot: '/test/repo',
  }),
  services: {
    registry: mockRegistry as any,
  },
})

beforeEach(() => {
  // Default: no path permissions (open access)
  vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue([])
})

describe('canCreateBranch', () => {
  it('allows admins to create branches', () => {
    const result = canCreateBranch(
      { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] },
      [{ path: 'content/**', edit: { allowedUsers: ['other'] } }],
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('privileged_user')
  })

  it('allows reviewers to create branches', () => {
    const result = canCreateBranch(
      { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.REVIEWERS] },
      [{ path: 'content/**', edit: { allowedUsers: ['other'] } }],
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('privileged_user')
  })

  it('allows anyone when no path permissions defined', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('no_restrictions')
  })

  it('allows user with matching userId in path rule', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [
      { path: 'content/**', edit: { allowedUsers: ['u1', 'u2'] } },
    ])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('path_access')
  })

  it('allows user with matching group in path rule', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: ['editors'] }, [
      { path: 'content/**', edit: { allowedGroups: ['editors'] } },
    ])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('path_access')
  })

  it('allows anyone for open path rules (no user/group constraints)', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [
      { path: 'content/**', edit: {} },
    ])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('open_path_rule')
  })

  it('denies user with no matching path access', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [
      { path: 'content/**', edit: { allowedUsers: ['other'] } },
    ])
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_path_access')
  })

  it('allows user with matching userId in path rule with edit permissions', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [
      { path: 'admin/**', edit: { allowedUsers: ['admin-only'] } },
      { path: 'content/**', edit: { allowedUsers: ['u1'] } },
    ])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('path_access')
  })

  it('denies when all rules restrict to other users', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [
      { path: 'admin/**', edit: { allowedUsers: ['admin-only'] } },
    ])
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_path_access')
  })
})

describe('branch api', () => {
  it('creates branch via workspace manager', async () => {
    const res = await createBranch(
      baseCtx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/test' },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch.name).toBe('feature/test')
  })

  it('rejects branch creation when user has no path access', async () => {
    // Mock permissions loaded from JSON file
    vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue([
      { path: 'content/**', edit: { allowedUsers: ['other-user'] } },
    ])
    const res = await createBranch(
      baseCtx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/test' },
    )
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.error).toBe('You do not have permission to create branches')
  })

  it('allows admin to create branch even with restrictions', async () => {
    // Mock permissions loaded from JSON file
    vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue([
      { path: 'content/**', edit: { allowedUsers: ['other-user'] } },
    ])
    const res = await createBranch(
      baseCtx,
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/test' },
    )
    expect(res.ok).toBe(true)
  })

  it('loads permissions from JSON file via main branch', async () => {
    // This test verifies the new behavior: permissions come from JSON, not config
    const mockPermissions = [{ path: 'content/**', edit: { allowedUsers: ['u1'] } }]
    vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue(mockPermissions)

    const res = await createBranch(
      baseCtx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/test' },
    )

    expect(res.ok).toBe(true)
    expect(permissionsLoader.loadPathPermissions).toHaveBeenCalled()
  })

  it('lists all branches for admins', async () => {
    const res = await listBranches(baseCtx, {
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })
    expect(res.ok).toBe(true)
    expect(res.data?.branches).toHaveLength(4)
  })

  it('lists all branches for reviewers', async () => {
    const res = await listBranches(baseCtx, {
      user: { type: 'authenticated', userId: 'reviewer', groups: [RESERVED_GROUPS.REVIEWERS] },
    })
    expect(res.ok).toBe(true)
    expect(res.data?.branches).toHaveLength(4)
  })

  it('filters branches for regular users - shows own branches', async () => {
    const res = await listBranches(baseCtx, {
      user: { type: 'authenticated', userId: 'u1', groups: [] },
    })
    expect(res.ok).toBe(true)
    // u1 created feature/a and is in allowedUsers for feature/c
    const names = res.data?.branches.map((b) => b.name)
    expect(names).toContain('feature/a')
    expect(names).toContain('feature/c')
    expect(names).not.toContain('feature/b')
    expect(names).not.toContain('feature/d')
  })

  it('filters branches for users - shows branches where user group is allowed', async () => {
    const res = await listBranches(baseCtx, {
      user: { type: 'authenticated', userId: 'u4', groups: ['editors'] },
    })
    expect(res.ok).toBe(true)
    // u4 has 'editors' group which is in allowedGroups for feature/d
    const names = res.data?.branches.map((b) => b.name)
    expect(names).toContain('feature/d')
    expect(names).not.toContain('feature/a')
    expect(names).not.toContain('feature/b')
    expect(names).not.toContain('feature/c')
  })

  it('shows empty list when user has no access', async () => {
    const res = await listBranches(baseCtx, {
      user: { type: 'authenticated', userId: 'nobody', groups: [] },
    })
    expect(res.ok).toBe(true)
    expect(res.data?.branches).toHaveLength(0)
  })
})

describe('canDeleteBranch', () => {
  const makeBranchContext = (createdBy: string, status = 'editing' as const) =>
    createMockBranchContext({ branchName: 'feature/x', createdBy, status })

  it('allows admins to delete any branch', () => {
    const result = canDeleteBranch(
      { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
      makeBranchContext('other'),
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('admin')
  })

  it('allows branch creator to delete their branch', () => {
    const result = canDeleteBranch(
      { type: 'authenticated', userId: 'u1', groups: [] },
      makeBranchContext('u1'),
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('creator')
  })

  it('denies non-creator non-admin from deleting', () => {
    const result = canDeleteBranch(
      { type: 'authenticated', userId: 'u2', groups: [] },
      makeBranchContext('u1'),
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not_authorized')
  })

  it('denies reviewers from deleting others branches', () => {
    const result = canDeleteBranch(
      { type: 'authenticated', userId: 'u2', groups: [RESERVED_GROUPS.REVIEWERS] },
      makeBranchContext('u1'),
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not_authorized')
  })
})

describe('deleteBranch api', () => {
  const makeBranchContext = (createdBy: string, status: 'editing' | 'submitted' = 'editing') =>
    createMockBranchContext({ branchName: 'feature/x', createdBy, status })

  // Context with mode that allows deletion
  const deleteCtx: ApiContext = {
    ...baseCtx,
    services: {
      ...baseCtx.services,
      config: { ...baseCtx.services.config, mode: 'prod-sim' } as any,
    },
  }

  it('returns 400 in modes that do not support branching', async () => {
    const res = await deleteBranch(
      baseCtx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(400)
    expect(res.error).toBe('Cannot delete branches in this operating mode')
  })

  it('returns 404 if branch not found', async () => {
    const ctx = { ...deleteCtx, getBranchContext: vi.fn().mockResolvedValue(null) }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/missing' },
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 if user not authorized', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('other')),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(403)
    expect(res.error).toBe('You do not have permission to delete this branch')
  })

  it('returns 400 if branch has submitted status', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1', 'submitted')),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(400)
    expect(res.error).toBe('Cannot delete branch with open pull request')
  })

  it('deletes branch when user is creator', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1')),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
  })

  it('deletes branch when user is admin', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('other')),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
  })
})

describe('canModifyBranchAccess', () => {
  const makeBranchContext = (createdBy: string) =>
    createMockBranchContext({ branchName: 'feature/x', createdBy })

  it('allows admins to modify any branch', () => {
    const result = canModifyBranchAccess(
      { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
      makeBranchContext('other'),
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('admin')
  })

  it('allows branch creator to modify their branch', () => {
    const result = canModifyBranchAccess(
      { type: 'authenticated', userId: 'u1', groups: [] },
      makeBranchContext('u1'),
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('creator')
  })

  it('denies non-creator non-admin from modifying', () => {
    const result = canModifyBranchAccess(
      { type: 'authenticated', userId: 'u2', groups: [] },
      makeBranchContext('u1'),
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not_authorized')
  })

  it('denies reviewers from modifying others branches', () => {
    const result = canModifyBranchAccess(
      { type: 'authenticated', userId: 'u2', groups: [RESERVED_GROUPS.REVIEWERS] },
      makeBranchContext('u1'),
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not_authorized')
  })
})

describe('updateBranchAccess api', () => {
  const makeBranchContext = (createdBy: string) =>
    createMockBranchContext({ branchName: 'feature/x', createdBy })

  it('returns 404 if branch not found', async () => {
    const ctx = { ...baseCtx, getBranchContext: vi.fn().mockResolvedValue(null) }
    const res = await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/missing' },
      {},
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 if user not authorized', async () => {
    const ctx = {
      ...baseCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('other')),
    }
    const res = await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      {},
    )
    expect(res.status).toBe(403)
    expect(res.error).toBe('You do not have permission to modify this branch')
  })

  it('updates branch access when user is creator', async () => {
    const ctx = { ...baseCtx, getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1')) }
    const res = await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      { allowedUsers: ['u2', 'u3'] },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch.access.allowedUsers).toEqual(['u2', 'u3'])
  })

  it('updates branch access when user is admin', async () => {
    const ctx = {
      ...baseCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('other')),
    }
    const res = await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
      { allowedGroups: ['editors'] },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch.access.allowedGroups).toEqual(['editors'])
  })

  // Test for missing branchRoot removed - BranchContext now requires branchRoot at type level
})
