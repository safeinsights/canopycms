import { describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'

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
  BranchMetadataFileManager: vi.fn().mockImplementation(function () {
    return {
      save: mockMetadataUpdate,
    }
  }),
  getBranchMetadataFileManager: vi.fn().mockImplementation(function () {
    return {
      save: mockMetadataUpdate,
    }
  }),
}))

// deleteBranch wraps the metadata unlink in the real server-enforced file
// lock; these are API-logic unit tests on fake paths (/test/repo), where the
// lock's mkdir would fail. Pass the critical section through unchanged.
vi.mock('../utils/occ-json-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/occ-json-write')>()
  return {
    ...actual,
    withOccFileLock: vi.fn(<T>(_path: string, fn: () => Promise<T>) => fn()),
  }
})

vi.mock('../branch-workspace', () => ({
  BranchWorkspaceManager: vi.fn().mockImplementation(function () {
    return {
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
    }
  }),
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
import { RESERVED_GROUPS } from '../authorization'
import { unsafeAsPermissionPath } from '../authorization/test-utils'
import { createMockApiContext, createMockBranchContext, createMockRegistry } from '../test-utils'
import * as authorization from '../authorization'
import { unsafeAsBranchName } from '../paths/test-utils'

// Alias for convenience (tests reference permissionsLoader)
const permissionsLoader = {
  loadPathPermissions: authorization.loadPathPermissions,
}

const mockRegistry = createMockRegistry([
  createMockBranchContext({
    branchName: 'feature/a',
    createdBy: 'u1',
    baseRoot: '/test/base',
  }),
  createMockBranchContext({
    branchName: 'feature/b',
    createdBy: 'u2',
    baseRoot: '/test/base',
  }),
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
      [
        {
          path: unsafeAsPermissionPath('content/**'),
          edit: { allowedUsers: ['other'] },
        },
      ],
    )
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('privileged_user')
  })

  it('allows reviewers to create branches', () => {
    const result = canCreateBranch(
      {
        type: 'authenticated',
        userId: 'u1',
        groups: [RESERVED_GROUPS.REVIEWERS],
      },
      [
        {
          path: unsafeAsPermissionPath('content/**'),
          edit: { allowedUsers: ['other'] },
        },
      ],
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
      {
        path: unsafeAsPermissionPath('content/**'),
        edit: { allowedUsers: ['u1', 'u2'] },
      },
    ])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('path_access')
  })

  it('allows user with matching group in path rule', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: ['editors'] }, [
      {
        path: unsafeAsPermissionPath('content/**'),
        edit: { allowedGroups: ['editors'] },
      },
    ])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('path_access')
  })

  it('allows anyone for open path rules (no user/group constraints)', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [
      { path: unsafeAsPermissionPath('content/**'), edit: {} },
    ])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('open_path_rule')
  })

  it('denies user with no matching path access', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [
      {
        path: unsafeAsPermissionPath('content/**'),
        edit: { allowedUsers: ['other'] },
      },
    ])
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no_path_access')
  })

  it('allows user with matching userId in path rule with edit permissions', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [
      {
        path: unsafeAsPermissionPath('admin/**'),
        edit: { allowedUsers: ['admin-only'] },
      },
      {
        path: unsafeAsPermissionPath('content/**'),
        edit: { allowedUsers: ['u1'] },
      },
    ])
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('path_access')
  })

  it('denies when all rules restrict to other users', () => {
    const result = canCreateBranch({ type: 'authenticated', userId: 'u1', groups: [] }, [
      {
        path: unsafeAsPermissionPath('admin/**'),
        edit: { allowedUsers: ['admin-only'] },
      },
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
      { branch: unsafeAsBranchName('feature/test') },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch.name).toBe('feature/test')
  })

  it('rejects branch creation when user has no path access', async () => {
    // Mock permissions loaded from JSON file
    vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue([
      {
        path: unsafeAsPermissionPath('content/**'),
        edit: { allowedUsers: ['other-user'] },
      },
    ])
    const res = await createBranch(
      baseCtx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/test') },
    )
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.error).toBe('You do not have permission to create branches')
  })

  it('allows admin to create branch even with restrictions', async () => {
    // Mock permissions loaded from JSON file
    vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue([
      {
        path: unsafeAsPermissionPath('content/**'),
        edit: { allowedUsers: ['other-user'] },
      },
    ])
    const res = await createBranch(
      baseCtx,
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: unsafeAsBranchName('feature/test') },
    )
    expect(res.ok).toBe(true)
  })

  it('loads permissions from JSON file via main branch', async () => {
    // This test verifies the new behavior: permissions come from JSON, not config
    const mockPermissions = [
      {
        path: unsafeAsPermissionPath('content/**'),
        edit: { allowedUsers: ['u1'] },
      },
    ]
    vi.mocked(permissionsLoader.loadPathPermissions).mockResolvedValue(mockPermissions)

    const res = await createBranch(
      baseCtx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/test') },
    )

    expect(res.ok).toBe(true)
    expect(permissionsLoader.loadPathPermissions).toHaveBeenCalled()
  })

  it('rejects creating a branch with the base branch name (400)', async () => {
    const res = await createBranch(
      baseCtx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('main') },
    )
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    expect(res.error).toBe('Cannot create a branch with the base branch name')
  })

  it('rejects creating a branch whose name already exists (409)', async () => {
    // registry.get resolving truthy simulates a name collision with an
    // existing branch -- see Fix 1's doc comment on the ACL-injection this
    // guards against (POST /branches with an existing name + a caller
    // `access` object would otherwise field-merge into that branch's ACL).
    const registry = createMockRegistry([])
    registry.get.mockResolvedValue(
      createMockBranchContext({ branchName: 'feature/test', createdBy: 'someone-else' }),
    )
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: { registry: registry as any },
    })

    const res = await createBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/test') },
    )
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(res.error).toBe('A branch with this name already exists')
  })

  describe('branch-name collision guards (settings-branch + reserved namespace)', () => {
    // baseCtx's mock config defaults to mode: 'dev' (see createMockServices),
    // so DevStrategy.getSettingsBranchName(config) resolves to
    // 'canopycms-settings-local' (no deploymentName override -- mode default
    // is 'local', see operating-mode/client-unsafe-strategy.ts).

    it('rejects a raw name that only SANITIZES into colliding with the settings branch (the bypass fix) -- would slip through a raw-string comparison', async () => {
      // parseBranchName permits '/', and sanitizeBranchName() collapses
      // 'canopycms/settings-local' into 'canopycms-settings-local' -- this
      // deployment's actual settings branch name. A raw `branchName ===
      // settingsBranchName` comparison (the pre-fix code) compares
      // 'canopycms/settings-local' to 'canopycms-settings-local' -- NOT
      // equal -- so the request would sail through and end up creating a
      // content branch whose real git ref (post-sanitization, in
      // openOrCreateBranch) IS the settings branch.
      const res = await createBranch(
        baseCtx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('canopycms/settings-local') },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      expect(res.error).toBe(
        'Cannot create content branch with settings branch name (git branch name collision)',
      )
    })

    it('still rejects the exact settings branch name', async () => {
      const res = await createBranch(
        baseCtx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('canopycms-settings-local') },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      expect(res.error).toBe(
        'Cannot create content branch with settings branch name (git branch name collision)',
      )
    })

    it("rejects another deployment's settings branch name as a reserved-namespace collision", async () => {
      // NOT this deployment's own settings branch ('canopycms-settings-local')
      // -- but still inside the reserved canopycms-settings- namespace that
      // ANY CanopyCMS deployment sharing this GitHub repo might own.
      const res = await createBranch(
        baseCtx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('canopycms-settings-anything') },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      expect(res.error).toContain('reserved')
    })

    it('rejects a raw name whose SANITIZED form (not its raw form) falls inside the reserved prefix', async () => {
      // Raw name does not literally start with "canopycms-settings-", but
      // sanitizeBranchName's slash-to-hyphen replacement makes the sanitized
      // form start with it.
      const res = await createBranch(
        baseCtx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('canopycms/settings/prod') },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      expect(res.error).toContain('reserved')
    })

    it('still accepts a normal branch name', async () => {
      const res = await createBranch(
        baseCtx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('feature/totally-normal') },
      )
      expect(res.ok).toBe(true)
    })
  })

  it('lists all branches for admins', async () => {
    const res = await listBranches(baseCtx, {
      user: {
        type: 'authenticated',
        userId: 'admin',
        groups: [RESERVED_GROUPS.ADMINS],
      },
    })
    expect(res.ok).toBe(true)
    expect(res.data?.branches).toHaveLength(4)
  })

  it('lists all branches for reviewers', async () => {
    const res = await listBranches(baseCtx, {
      user: {
        type: 'authenticated',
        userId: 'reviewer',
        groups: [RESERVED_GROUPS.REVIEWERS],
      },
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

  it('emits isProtected/readOnly flags on branches -- prod base is true/true, feature is false/false', async () => {
    const registry = createMockRegistry([
      createMockBranchContext({
        branchName: 'main',
        createdBy: 'canopycms-system',
        baseRoot: '/test/repo',
        branchRoot: '/test/repo',
      }),
      createMockBranchContext({ branchName: 'feature/x', createdBy: 'u1', baseRoot: '/test/base' }),
    ])
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: {
        registry: registry as any,
        config: { defaultBaseBranch: 'main', mode: 'prod' } as any,
      },
    })

    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })

    const main = res.data?.branches.find((b) => b.name === 'main')
    expect(main?.isProtected).toBe(true)
    expect(main?.readOnly).toBe(true)

    const feature = res.data?.branches.find((b) => b.name === 'feature/x')
    expect(feature?.isProtected).toBe(false)
    expect(feature?.readOnly).toBe(false)
  })

  it('emits isProtected: true, readOnly: false for the base branch in dev', async () => {
    const registry = createMockRegistry([
      createMockBranchContext({
        branchName: 'main',
        createdBy: 'canopycms-system',
        baseRoot: '/test/repo',
        branchRoot: '/test/repo',
      }),
    ])
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: {
        registry: registry as any,
        config: { defaultBaseBranch: 'main', mode: 'dev' } as any,
      },
    })

    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })

    const main = res.data?.branches.find((b) => b.name === 'main')
    expect(main?.isProtected).toBe(true)
    expect(main?.readOnly).toBe(false)
  })

  it('emits flags on the filtered (non-privileged) listing path too', async () => {
    const registry = createMockRegistry([
      createMockBranchContext({
        branchName: 'main',
        createdBy: 'canopycms-system',
        baseRoot: '/test/repo',
        branchRoot: '/test/repo',
      }),
      createMockBranchContext({ branchName: 'feature/x', createdBy: 'u1', baseRoot: '/test/base' }),
    ])
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: {
        registry: registry as any,
        config: { defaultBaseBranch: 'main', mode: 'prod' } as any,
      },
    })

    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'u1', groups: [] },
    })

    // u1 created feature/x; 'main' isn't visible to them via the filter, but
    // the visible entry still carries correct (unprotected) flags.
    const feature = res.data?.branches.find((b) => b.name === 'feature/x')
    expect(feature?.isProtected).toBe(false)
    expect(feature?.readOnly).toBe(false)
  })

  it('includes the protected base branch (read-only) for non-privileged users with no ACL access to it', async () => {
    const registry = createMockRegistry([
      createMockBranchContext({
        branchName: 'main',
        createdBy: 'canopycms-system',
        baseRoot: '/test/repo',
        branchRoot: '/test/repo',
      }),
      createMockBranchContext({
        branchName: 'feature/x',
        createdBy: 'someone-else',
        baseRoot: '/test/base',
      }),
    ])
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: {
        registry: registry as any,
        config: { defaultBaseBranch: 'main', mode: 'prod' } as any,
      },
    })

    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'u1', groups: [] },
    })

    // u1 is neither the creator of 'main' nor in its (empty) ACL, but the
    // base branch must still surface -- see listBranchesHandler's
    // getBranchProtection short-circuit in the visibleBranches filter.
    const names = res.data?.branches.map((b) => b.name)
    expect(names).toContain('main')
    expect(names).not.toContain('feature/x')

    const main = res.data?.branches.find((b) => b.name === 'main')
    expect(main?.isProtected).toBe(true)
    expect(main?.readOnly).toBe(true)
  })

  it('reports the effective default branch for all users', async () => {
    const expected =
      baseCtx.services.config.defaultActiveBranch ??
      baseCtx.services.config.defaultBaseBranch ??
      'main'

    const admin = await listBranches(baseCtx, {
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })
    expect(admin.data?.defaultBranch).toBe(expected)

    const nobody = await listBranches(baseCtx, {
      user: { type: 'authenticated', userId: 'nobody', groups: [] },
    })
    expect(nobody.data?.defaultBranch).toBe(expected)
  })
})

describe('canDeleteBranch', () => {
  const makeBranchContext = (createdBy: string, status = 'editing' as const) =>
    createMockBranchContext({ branchName: 'feature/x', createdBy, status })

  it('allows admins to delete any branch', () => {
    const result = canDeleteBranch(
      {
        type: 'authenticated',
        userId: 'admin',
        groups: [RESERVED_GROUPS.ADMINS],
      },
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
      {
        type: 'authenticated',
        userId: 'u2',
        groups: [RESERVED_GROUPS.REVIEWERS],
      },
      makeBranchContext('u1'),
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not_authorized')
  })
})

describe('deleteBranch api', () => {
  const makeBranchContext = (createdBy: string, status: 'editing' | 'submitted' = 'editing') =>
    createMockBranchContext({ branchName: 'feature/x', createdBy, status })

  const deleteCtx = baseCtx

  it('returns 404 if branch not found', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(null),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/missing') },
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
      { branch: unsafeAsBranchName('feature/x') },
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
      { branch: unsafeAsBranchName('feature/x') },
    )
    expect(res.status).toBe(400)
    expect(res.error).toBe('Cannot delete branch with open pull request')
  })

  it('refuses to delete the base (protected) branch, even for an admin', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(
        createMockBranchContext({
          branchName: 'main',
          createdBy: 'canopycms-system',
          baseRoot: '/test/repo',
          branchRoot: '/test/repo',
        }),
      ),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: unsafeAsBranchName('main') },
    )
    expect(res.status).toBe(400)
    expect(res.error).toBe('Cannot delete the base branch')
  })

  it('deletes branch when user is creator', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1')),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
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
      {
        user: {
          type: 'authenticated',
          userId: 'admin',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: unsafeAsBranchName('feature/x') },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
  })

  it('surfaces a cleanupWarning (but still reports deleted: true) when the directory rm fails (regression)', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1')),
    }
    const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('EACCES: permission denied'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
    )

    // Metadata is gone either way -- the branch is logically deleted and
    // must not silently report failure, but the orphan clone's persistence
    // must not be hidden from the caller either.
    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
    expect(res.data?.cleanupWarning).toContain('EACCES')
    expect(consoleErrorSpy).toHaveBeenCalled()

    rmSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('omits cleanupWarning when the directory rm succeeds', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1')),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.cleanupWarning).toBeUndefined()
  })
})

describe('canModifyBranchAccess', () => {
  const makeBranchContext = (createdBy: string) =>
    createMockBranchContext({ branchName: 'feature/x', createdBy })

  it('allows admins to modify any branch', () => {
    const result = canModifyBranchAccess(
      {
        type: 'authenticated',
        userId: 'admin',
        groups: [RESERVED_GROUPS.ADMINS],
      },
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
      {
        type: 'authenticated',
        userId: 'u2',
        groups: [RESERVED_GROUPS.REVIEWERS],
      },
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
    const ctx = {
      ...baseCtx,
      getBranchContext: vi.fn().mockResolvedValue(null),
    }
    const res = await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/missing') },
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
      { branch: unsafeAsBranchName('feature/x') },
      {},
    )
    expect(res.status).toBe(403)
    expect(res.error).toBe('You do not have permission to modify this branch')
  })

  it('updates branch access when user is creator', async () => {
    const ctx = {
      ...baseCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1')),
    }
    const res = await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
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
      {
        user: {
          type: 'authenticated',
          userId: 'admin',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: unsafeAsBranchName('feature/x') },
      { allowedGroups: ['editors'] },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch.access.allowedGroups).toEqual(['editors'])
  })

  // Test for missing branchRoot removed - BranchContext now requires branchRoot at type level

  it('omits an unsupplied field from the save() payload entirely, rather than spreading the stale snapshot (regression)', async () => {
    // branchContext.branch.access as resolved by getBranchContext() -- a
    // snapshot taken before this handler acquires anything. It carries
    // allowedGroups from some earlier state; a concurrent request could have
    // already changed allowedGroups on disk by the time save() actually
    // reloads and merges.
    const ctx = {
      ...baseCtx,
      getBranchContext: vi.fn().mockResolvedValue(
        createMockBranchContext({
          branchName: 'feature/x',
          createdBy: 'u1',
          access: { allowedGroups: ['stale-group'] },
        }),
      ),
    }
    mockMetadataUpdate.mockClear()

    const res = await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
      // Caller supplies ONLY allowedUsers -- allowedGroups is omitted.
      { allowedUsers: ['u2', 'u3'] },
    )
    expect(res.ok).toBe(true)

    // The save() payload's access delta must contain ONLY the supplied key.
    // If allowedGroups were included (even with the stale snapshot's value),
    // save()'s field-level merge (branch-metadata.ts) would let it silently
    // clobber whatever a concurrent request wrote to allowedGroups on disk.
    expect(mockMetadataUpdate).toHaveBeenCalledTimes(1)
    const payload = mockMetadataUpdate.mock.calls[0][0] as { branch?: { access?: object } }
    expect(payload.branch?.access).toEqual({ allowedUsers: ['u2', 'u3'] })
    expect(payload.branch?.access).not.toHaveProperty('allowedGroups')
  })

  it('still clears a field when the caller explicitly supplies an empty array', async () => {
    const ctx = {
      ...baseCtx,
      getBranchContext: vi.fn().mockResolvedValue(
        createMockBranchContext({
          branchName: 'feature/x',
          createdBy: 'u1',
          access: { allowedUsers: ['u2'], allowedGroups: ['editors'] },
        }),
      ),
    }
    mockMetadataUpdate.mockClear()

    await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
      { allowedUsers: [] },
    )

    const payload = mockMetadataUpdate.mock.calls[0][0] as { branch?: { access?: object } }
    expect(payload.branch?.access).toEqual({ allowedUsers: [] })
    expect(payload.branch?.access).not.toHaveProperty('allowedGroups')
  })
})
