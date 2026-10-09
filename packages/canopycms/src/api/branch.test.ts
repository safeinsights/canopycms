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

const mockEnqueueTask = vi.fn()
vi.mock('../task-queue/cms-task-queue', () => ({
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
}))

vi.mock('../branch-workspace', () => ({
  BranchWorkspaceManager: vi.fn().mockImplementation(function () {
    return {
      provisionBranch: vi.fn().mockResolvedValue({
        kind: 'created',
        context: {
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
import { RESERVED_ROUTE_BRANCH_NAMES } from '../paths'
import type { BranchRegistry } from '../branch-registry'
import type { CanopyConfig } from '../config'
import type { GitHubService } from '../github-service'

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

  it('returns the created branch as a list item carrying the server-computed flags', async () => {
    const res = await createBranch(
      baseCtx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/test') },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch).toMatchObject({
      name: 'feature/test',
      isProtected: false,
      readOnly: false,
      writeBlocked: false,
      submitBlocked: false,
    })
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

  describe('a create naming an existing branch that its own creator just made', () => {
    const createAgainst = async (
      existing: { createdBy: string; ageMs: number },
      userId: string,
    ) => {
      const registry = createMockRegistry([])
      registry.get.mockResolvedValue(
        createMockBranchContext({
          branchName: 'feature/test',
          createdBy: existing.createdBy,
          createdAt: new Date(Date.now() - existing.ageMs).toISOString(),
        }),
      )
      const ctx = createMockApiContext({
        branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
        services: { registry: registry as unknown as BranchRegistry },
      })
      return createBranch(
        ctx,
        { user: { type: 'authenticated', userId, groups: [] } },
        { branch: unsafeAsBranchName('feature/test') },
      )
    }

    it('answers the same creator within the window with the existing branch (200)', async () => {
      const res = await createAgainst({ createdBy: 'u1', ageMs: 60_000 }, 'u1')
      expect(res.ok).toBe(true)
      expect(res.status).toBe(200)
      expect(res.data?.branch.name).toBe('feature/test')
      expect(res.data?.branch.createdBy).toBe('u1')
    })

    it('answers a different user with a 409, however recent the branch', async () => {
      const res = await createAgainst({ createdBy: 'someone-else', ageMs: 60_000 }, 'u1')
      expect(res.ok).toBe(false)
      expect(res.status).toBe(409)
      expect(res.error).toBe('A branch with this name already exists')
    })

    it('answers the same creator with a 409 once the window has passed', async () => {
      const res = await createAgainst({ createdBy: 'u1', ageMs: 6 * 60_000 }, 'u1')
      expect(res.ok).toBe(false)
      expect(res.status).toBe(409)
      expect(res.error).toBe('A branch with this name already exists')
    })
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

    // The router prefers a literal path segment over `:branch`, so a branch
    // named after a static top-level namespace has its own routes shadowed --
    // and only partially, since bare `GET /admin` still reaches the branch
    // handler. http/router.test.ts pins the list itself against the live routes.
    it.each([...RESERVED_ROUTE_BRANCH_NAMES])(
      'rejects "%s" because it collides with a static API route namespace',
      async (name) => {
        const res = await createBranch(
          baseCtx,
          { user: { type: 'authenticated', userId: 'u1', groups: [] } },
          { branch: unsafeAsBranchName(name) },
        )
        expect(res.ok).toBe(false)
        expect(res.status).toBe(400)
        expect(res.error).toContain('reserved')
        expect(res.error).toContain(`/${name}`)
      },
    )

    it('accepts names that merely contain or extend a reserved namespace', async () => {
      for (const name of ['admin-docs', 'assets-2026', 'feature/admin']) {
        const res = await createBranch(
          baseCtx,
          { user: { type: 'authenticated', userId: 'u1', groups: [] } },
          { branch: unsafeAsBranchName(name) },
        )
        expect(res.ok).toBe(true)
      }
    })

    it('is case-sensitive, mirroring how the router matches path segments', async () => {
      // `/Admin` does not match the static `/admin/...` routes, so `Admin` is
      // not shadowed and must stay creatable.
      const res = await createBranch(
        baseCtx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('Admin') },
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

  it('emits writeBlocked reflecting branch status, so the editor need not re-derive it', async () => {
    const registry = createMockRegistry([
      createMockBranchContext({
        branchName: 'feature/editing',
        createdBy: 'u1',
        status: 'editing',
      }),
      createMockBranchContext({
        branchName: 'feature/submitted',
        createdBy: 'u1',
        status: 'submitted',
      }),
      createMockBranchContext({
        branchName: 'feature/archived',
        createdBy: 'u1',
        status: 'archived',
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
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })

    const byName = (n: string) => res.data?.branches.find((b) => b.name === n)

    expect(byName('feature/editing')?.writeBlocked).toBe(false)
    expect(byName('feature/submitted')?.writeBlocked).toBe(true)
    expect(byName('feature/archived')?.writeBlocked).toBe(true)

    // readOnly stays purely about base-branch protection -- it is what the
    // editor uses to pick WHICH lock banner to show.
    expect(byName('feature/submitted')?.readOnly).toBe(false)
    expect(byName('feature/submitted')?.isProtected).toBe(false)
  })

  it('emits submitBlocked as the compound answer (base-branch OR non-editing status), not the base-only protection.submitBlocked', async () => {
    const registry = createMockRegistry([
      createMockBranchContext({
        branchName: 'main',
        createdBy: 'canopycms-system',
        baseRoot: '/test/repo',
        branchRoot: '/test/repo',
        status: 'editing',
      }),
      createMockBranchContext({
        branchName: 'feature/editing',
        createdBy: 'u1',
        status: 'editing',
      }),
      createMockBranchContext({
        branchName: 'feature/submitted',
        createdBy: 'u1',
        status: 'submitted',
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
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })

    const byName = (n: string) => res.data?.branches.find((b) => b.name === n)

    // Editing, unprotected: neither half of the compound is true.
    expect(byName('feature/editing')?.submitBlocked).toBe(false)
    // Non-editing status alone blocks submit, even though this branch is not
    // the base branch -- proves the STATUS half, not just protection.submitBlocked
    // (which would be false here).
    expect(byName('feature/submitted')?.submitBlocked).toBe(true)
    // The base branch is submit-blocked even while 'editing' -- proves the
    // BASE-BRANCH half, and specifically that this is NOT just a copy of
    // writeBlocked (which a dev-mode base branch could have as false).
    expect(byName('main')?.submitBlocked).toBe(true)
  })

  it('emits writeBlocked for a branch whose status is missing (UI locks with the server)', async () => {
    // Same fail-closed contract the writableBranch guard has: if the wire flag
    // said "writable" here while the guard refused, the editor would offer a
    // Save that 403s.
    const damaged = createMockBranchContext({ branchName: 'feature/damaged', createdBy: 'u1' })
    delete (damaged.branch as { status?: unknown }).status

    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: {
        registry: createMockRegistry([damaged]) as any,
        config: { defaultBaseBranch: 'main', mode: 'prod' } as any,
      },
    })

    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })

    expect(res.data?.branches.find((b) => b.name === 'feature/damaged')?.writeBlocked).toBe(true)
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

  it('hides a settings-branch workspace left on disk, even from admins', async () => {
    const registry = createMockRegistry(
      ['main', 'feature/x', 'canopycms-settings-other', 'site-settings'].map((branchName) =>
        createMockBranchContext({ branchName, createdBy: 'canopycms-system' }),
      ),
    )
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: {
        registry: registry as unknown as BranchRegistry,
        config: {
          defaultBaseBranch: 'main',
          mode: 'prod',
          settingsBranch: 'site-settings',
        } as unknown as CanopyConfig,
      },
    })

    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })

    expect(res.data?.branches.map((b) => b.name)).toEqual(['main', 'feature/x'])
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
  const makeBranchContext = (
    createdBy: string,
    status: 'editing' | 'submitted' | 'approved' = 'editing',
  ) => createMockBranchContext({ branchName: 'feature/x', createdBy, status })

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

  // CF1/A7: a branch a reviewer has already approved -- its PR awaiting
  // merge -- must be just as refused as a merely-submitted one. Before this
  // guard, deletion here unlinked branch.json, removed the clone, and
  // removed the branch head from the local git mirror, leaving the approved
  // PR dangling on GitHub with mark-merged made impossible and no signal
  // back to the reviewer who approved it.
  it('returns 400 if branch has approved status, same shape as the submitted refusal', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1', 'approved')),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
    )
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    expect(res.error).toBe('Cannot delete branch with open pull request')
  })

  // No over-blocking: an ordinary editing branch (the common case) must
  // still delete cleanly once the guard above is extended.
  it('still permits deleting an ordinary editing branch', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1', 'editing')),
    }
    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
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

  it('surfaces a cleanupWarning (but still reports deleted: true) when the directory cannot be moved aside', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1')),
    }
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      )
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValueOnce(undefined)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
    )

    // Unlisted either way (branch.json is removed in place), so it must not
    // report failure, but the directory left behind must not be hidden.
    expect(res.ok).toBe(true)
    expect(res.data?.deleted).toBe(true)
    expect(res.data?.cleanupWarning).toContain('EACCES')
    expect(unlinkSpy).toHaveBeenCalledWith(expect.stringMatching(/branch\.json$/))
    expect(consoleErrorSpy).toHaveBeenCalled()

    renameSpy.mockRestore()
    unlinkSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('moves the branch directory aside to a .deleting-* sibling before removing it', async () => {
    const ctx = {
      ...deleteCtx,
      getBranchContext: vi.fn().mockResolvedValue(makeBranchContext('u1')),
    }
    const renameSpy = vi.spyOn(fs, 'rename').mockResolvedValueOnce(undefined)
    const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValueOnce(undefined)

    const res = await deleteBranch(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x') },
    )

    expect(res.ok).toBe(true)
    const [from, to] = renameSpy.mock.calls[0] ?? []
    expect(from).toBe('/tmp/base/feature/x')
    expect(to).toMatch(/^\/tmp\/base\/\.deleting-x-[0-9a-f]{10}-[0-9a-f]{6}-\d{8}T\d{6}Z$/)
    expect(rmSpy).toHaveBeenCalledWith(to, expect.objectContaining({ recursive: true }))

    renameSpy.mockRestore()
    rmSpy.mockRestore()
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

  describe('the branch on GitHub', () => {
    const user = { type: 'authenticated' as const, userId: 'u1', groups: [] }
    const branch = { branch: unsafeAsBranchName('feature/x') }
    const withPr = createMockBranchContext({
      branchName: 'feature/x',
      createdBy: 'u1',
      status: 'editing',
      pullRequestNumber: 42,
    })
    const ghError = (status: number, message: string) =>
      Object.assign(new Error(message), { status })

    beforeEach(() => {
      mockEnqueueTask.mockReset()
      mockEnqueueTask.mockResolvedValue('task-1')
    })

    const ctxWith = (
      context: ReturnType<typeof createMockBranchContext>,
      services: { githubService?: GitHubService; mode?: CanopyConfig['mode'] },
    ) =>
      createMockApiContext({
        branchContext: context,
        services: {
          registry: mockRegistry as unknown as BranchRegistry,
          githubService: services.githubService,
          config: { mode: services.mode ?? 'dev' } as CanopyConfig,
        },
      })

    it('is deleted directly when a githubService is available', async () => {
      const deleteBranchMock = vi.fn().mockResolvedValue(undefined)
      const ctx = ctxWith(withPr, {
        githubService: { deleteBranch: deleteBranchMock } as unknown as GitHubService,
      })

      const res = await deleteBranch(ctx, { user }, branch)

      expect(res.ok).toBe(true)
      expect(deleteBranchMock).toHaveBeenCalledWith('feature/x')
      expect(mockEnqueueTask).not.toHaveBeenCalled()
      expect(res.data?.cleanupWarning).toBeUndefined()
    })

    it('is queued for the worker when there is no githubService and the mode has PRs', async () => {
      const ctx = ctxWith(withPr, { mode: 'prod' })

      const res = await deleteBranch(ctx, { user }, branch)

      expect(res.ok).toBe(true)
      expect(mockEnqueueTask).toHaveBeenCalledTimes(1)
      expect(mockEnqueueTask).toHaveBeenCalledWith(expect.any(String), {
        action: 'delete-remote-branch',
        payload: { branch: 'feature/x', pullRequestNumber: 42 },
      })
      expect(res.data?.cleanupWarning).toBeUndefined()
    })

    it('is deleted when a submit pushed it but GitHub opened no PR', async () => {
      const deleteBranchMock = vi.fn().mockResolvedValue(undefined)
      const pushedNoPr = createMockBranchContext({ branchName: 'feature/x', createdBy: 'u1' })
      pushedNoPr.branch.submittedAt = '2026-01-02T03:04:05.000Z'

      const direct = await deleteBranch(
        ctxWith(pushedNoPr, {
          githubService: { deleteBranch: deleteBranchMock } as unknown as GitHubService,
        }),
        { user },
        branch,
      )
      const queued = await deleteBranch(ctxWith(pushedNoPr, { mode: 'prod' }), { user }, branch)

      expect(direct.ok).toBe(true)
      expect(queued.ok).toBe(true)
      expect(deleteBranchMock).toHaveBeenCalledWith('feature/x')
      expect(mockEnqueueTask).toHaveBeenCalledWith(expect.any(String), {
        action: 'delete-remote-branch',
        payload: { branch: 'feature/x', submittedAt: '2026-01-02T03:04:05.000Z' },
      })
    })

    it('is never touched when the branch has neither a PR nor a submit stamp, so the CMS never pushed it', async () => {
      const deleteBranchMock = vi.fn().mockResolvedValue(undefined)
      const noPr = createMockBranchContext({ branchName: 'feature/x', createdBy: 'u1' })

      const direct = await deleteBranch(
        ctxWith(noPr, {
          githubService: { deleteBranch: deleteBranchMock } as unknown as GitHubService,
        }),
        { user },
        branch,
      )
      const queued = await deleteBranch(ctxWith(noPr, { mode: 'prod' }), { user }, branch)

      expect(direct.ok).toBe(true)
      expect(queued.ok).toBe(true)
      expect(deleteBranchMock).not.toHaveBeenCalled()
      expect(mockEnqueueTask).not.toHaveBeenCalled()
    })

    it('is a success when GitHub says the branch is already gone', async () => {
      const deleteBranchMock = vi.fn().mockRejectedValue(ghError(422, 'Reference does not exist'))
      const ctx = ctxWith(withPr, {
        githubService: { deleteBranch: deleteBranchMock } as unknown as GitHubService,
      })

      const res = await deleteBranch(ctx, { user }, branch)

      expect(res.ok).toBe(true)
      expect(res.data?.cleanupWarning).toBeUndefined()
    })

    it('turns a GitHub failure into a cleanupWarning, never a failed delete', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const deleteBranchMock = vi.fn().mockRejectedValue(ghError(403, 'Resource not accessible'))
      const ctx = ctxWith(withPr, {
        githubService: { deleteBranch: deleteBranchMock } as unknown as GitHubService,
      })

      const res = await deleteBranch(ctx, { user }, branch)

      expect(res.ok).toBe(true)
      expect(res.data?.deleted).toBe(true)
      expect(res.data?.cleanupWarning).toContain('could not be deleted on GitHub')
      expect(consoleErrorSpy).toHaveBeenCalled()
      consoleErrorSpy.mockRestore()
    })

    it('turns a failed enqueue into a cleanupWarning, never a failed delete', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockEnqueueTask.mockRejectedValue(new Error('disk full'))
      const ctx = ctxWith(withPr, { mode: 'prod' })

      const res = await deleteBranch(ctx, { user }, branch)

      expect(res.ok).toBe(true)
      expect(res.data?.cleanupWarning).toContain('could not be queued')
      consoleErrorSpy.mockRestore()
    })
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

  // A base-branch ACL entry is not inert: canPerformWorkflowAction's
  // `allowed_by_acl` grant reads it, so writing one here would hand arbitrary
  // users Withdraw rights on the base branch.
  it('rejects an ACL write on the protected base branch, even for an admin', async () => {
    const ctx = {
      ...baseCtx,
      getBranchContext: vi.fn().mockResolvedValue(
        createMockBranchContext({
          branchName: 'main',
          createdBy: 'canopycms-system',
          baseRoot: '/test/repo',
          branchRoot: '/test/repo',
        }),
      ),
      services: { ...baseCtx.services, config: { defaultBaseBranch: 'main', mode: 'prod' } as any },
    }
    const res = await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: unsafeAsBranchName('main') },
      { allowedUsers: ['u2'] },
    )
    expect(res.status).toBe(403)
    expect(res.error).toBe(
      'The base branch does not take an access list. Create a branch to manage access.',
    )
  })

  it('rejects an ACL write on the base branch in dev too (the grant is mode-independent)', async () => {
    const ctx = {
      ...baseCtx,
      getBranchContext: vi.fn().mockResolvedValue(
        createMockBranchContext({
          branchName: 'main',
          createdBy: 'canopycms-system',
          baseRoot: '/test/repo',
          branchRoot: '/test/repo',
        }),
      ),
      services: { ...baseCtx.services, config: { defaultBaseBranch: 'main', mode: 'dev' } as any },
    }
    const res = await updateBranchAccess(
      ctx,
      { user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: unsafeAsBranchName('main') },
      { allowedUsers: ['u2'] },
    )
    expect(res.status).toBe(403)
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
