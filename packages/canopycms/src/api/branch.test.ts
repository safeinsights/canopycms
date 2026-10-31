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

const mockReadWorkerStatus = vi.fn()
vi.mock('../task-queue/worker-status', () => ({
  readWorkerStatus: (...args: unknown[]) => mockReadWorkerStatus(...args),
}))

const mockEnqueueTask = vi.fn()
vi.mock('../task-queue/cms-task-queue', () => ({
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
}))

vi.mock('../branch-workspace', () => ({
  BranchWorkspaceManager: vi.fn().mockImplementation(function () {
    return {
      provisionBranch: vi
        .fn()
        .mockImplementation(async ({ branchName }: { branchName: string }) => ({
          kind: 'created',
          context: {
            baseRoot: '/tmp/base',
            branchRoot: `/tmp/base/${branchName}`,
            branch: {
              name: branchName,
              status: 'editing',
              access: {},
              createdBy: 'user-1',
              createdAt: 'now',
              updatedAt: 'now',
            },
          },
        })),
    }
  }),
}))

import {
  createBranchHandler as createBranch,
  listBranchesHandler,
  deleteBranchHandler as deleteBranch,
  updateBranchAccessHandler as updateBranchAccess,
  canCreateBranch,
  canDeleteBranch,
  canModifyBranchAccess,
  toBranchListItem,
} from './branch'
import { RESERVED_GROUPS } from '../authorization'
import { unsafeAsPermissionPath } from '../authorization/test-utils'
import { createMockApiContext, createMockBranchContext, createMockRegistry } from '../test-utils'
import * as authorization from '../authorization'
import { unsafeAsBranchName } from '../paths/test-utils'
import { BranchWorkspaceManager } from '../branch-workspace'
import { BranchDirOccupiedError } from '../branch-provisioning'
import type { BranchRegistry } from '../branch-registry'
import type { CanopyConfig } from '../config'
import type { GitHubService } from '../github-service'
import { createCheckBranchAccess } from '../authorization/branch'
import type { BranchMetadata } from '../types'
import type { ApiContext, ApiRequest } from './types'

/**
 * The mock services grant every branch, and the list filters with `services.checkBranchAccess`,
 * so these tests bind the real check from the context's config, as services.ts does.
 */
const listBranches = (ctx: ApiContext, req: ApiRequest) =>
  listBranchesHandler(
    {
      ...ctx,
      services: {
        ...ctx.services,
        checkBranchAccess: createCheckBranchAccess(
          ctx.services.config.defaultBranchAccess ?? 'deny',
          ctx.services.config,
        ),
      },
    },
    req,
  )

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
  mockReadWorkerStatus.mockResolvedValue({ workerStatus: null })
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
  const asU1: ApiRequest = { user: { type: 'authenticated', userId: 'u1', groups: [] } }

  it('creates the typed name in the namespace, holding the ref in its name', async () => {
    const res = await createBranch(baseCtx, asU1, { branch: unsafeAsBranchName('feature-test') })
    expect(res.ok).toBe(true)
    expect(res.data?.branch.name).toBe('canopycms/local/feature-test')
    expect(res.data?.branch.shortName).toBe('feature-test')
  })

  it('returns the created branch as a list item carrying the server-computed flags', async () => {
    const res = await createBranch(baseCtx, asU1, { branch: unsafeAsBranchName('feature-test') })
    expect(res.ok).toBe(true)
    expect(res.data?.branch).toMatchObject({
      name: 'canopycms/local/feature-test',
      shortName: 'feature-test',
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
    const res = await createBranch(baseCtx, asU1, { branch: unsafeAsBranchName('feature-test') })
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
      { branch: unsafeAsBranchName('feature-test') },
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

    const res = await createBranch(baseCtx, asU1, { branch: unsafeAsBranchName('feature-test') })

    expect(res.ok).toBe(true)
    expect(permissionsLoader.loadPathPermissions).toHaveBeenCalled()
  })

  it('rejects creating a branch whose created name is the base branch name (400)', async () => {
    // A created name always carries the namespace, so only a base branch inside it can collide.
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: {
        config: { defaultBaseBranch: 'canopycms/local/main', mode: 'dev' } as any,
        registry: mockRegistry as any,
      },
    })
    const res = await createBranch(ctx, asU1, { branch: unsafeAsBranchName('main') })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    expect(res.error).toBe('Cannot create a branch with the base branch name')
    expect(res.code).toBe('BRANCH_NAME_REFUSED')
  })

  it('rejects creating a branch whose workspace already exists (409), naming its short name', async () => {
    // A name collision with an existing branch is answered before anything else: POST /branches
    // with an existing name and a caller `access` object would otherwise field-merge into that
    // branch's ACL.
    const registry = createMockRegistry([])
    registry.getByKey.mockResolvedValue(
      createMockBranchContext({
        branchName: 'canopycms/local/feature-test',
        createdBy: 'someone-else',
      }),
    )
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: { registry: registry as any },
    })

    const res = await createBranch(ctx, asU1, { branch: unsafeAsBranchName('feature/test') })
    expect(registry.getByKey).toHaveBeenCalledWith('canopycms-local-feature-test')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(res.error).toBe('A branch named "feature-test" already exists')
    expect(res.code).toBe('BRANCH_NAME_REFUSED')
  })

  it("refuses a create whose key another branch's workspace holds, naming that branch", async () => {
    // A branch outside the namespace, stored under the name that is the new ref's key.
    const registry = createMockRegistry([])
    registry.getByKey.mockResolvedValue(
      createMockBranchContext({
        branchName: 'canopycms-local-feature-test',
        createdBy: 'u1',
        createdAt: new Date().toISOString(),
      }),
    )
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: { registry: registry as unknown as BranchRegistry },
    })

    const res = await createBranch(ctx, asU1, { branch: unsafeAsBranchName('feature-test') })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(res.error).toBe(
      '"feature-test" would clash with the existing branch "canopycms-local-feature-test". ' +
        'Choose a different name.',
    )
    expect(res.code).toBe('BRANCH_NAME_REFUSED')
  })

  it('names a nested namespace branch holding the key by its full name, as it has no short name', async () => {
    const registry = createMockRegistry([])
    registry.getByKey.mockResolvedValue(
      createMockBranchContext({ branchName: 'canopycms/local/feature/test', createdBy: 'u1' }),
    )
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: { registry: registry as unknown as BranchRegistry },
    })

    const res = await createBranch(ctx, asU1, { branch: unsafeAsBranchName('feature-test') })
    expect(res.status).toBe(409)
    expect(res.error).toBe(
      '"feature-test" would clash with the existing branch "canopycms/local/feature/test". Choose a different name.',
    )
    expect(res.code).toBe('BRANCH_NAME_REFUSED')
  })

  it('refuses a provisioning that finds another branch under the key, naming that branch', async () => {
    const holder = createMockBranchContext({
      branchName: 'canopycms-local-feature-test',
      createdBy: 'u1',
      createdAt: new Date().toISOString(),
    })
    vi.mocked(BranchWorkspaceManager).mockImplementationOnce(function () {
      return { provisionBranch: async () => ({ kind: 'exists', context: holder }) }
    } as unknown as typeof BranchWorkspaceManager)
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: { registry: createMockRegistry([]) as unknown as BranchRegistry },
    })

    const res = await createBranch(ctx, asU1, { branch: unsafeAsBranchName('feature-test') })
    expect(res.status).toBe(409)
    expect(res.error).toBe(
      '"feature-test" would clash with the existing branch "canopycms-local-feature-test". ' +
        'Choose a different name.',
    )
    expect(res.code).toBe('BRANCH_NAME_REFUSED')
  })

  it('refuses a name whose workspace directory holds a repository it did not create', async () => {
    vi.mocked(BranchWorkspaceManager).mockImplementationOnce(function () {
      return {
        provisionBranch: async () => {
          throw new BranchDirOccupiedError('canopycms-local-feature-test')
        },
      }
    } as unknown as typeof BranchWorkspaceManager)
    const ctx = createMockApiContext({
      branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
      services: { registry: createMockRegistry([]) as unknown as BranchRegistry },
    })

    const res = await createBranch(ctx, asU1, { branch: unsafeAsBranchName('feature-test') })
    expect(res.status).toBe(409)
    expect(res.error).toContain("A directory named 'canopycms-local-feature-test' already exists")
    expect(res.code).toBe('BRANCH_NAME_REFUSED')
  })

  describe('a create naming an existing branch that its own creator just made', () => {
    const createAgainst = async (
      existing: { createdBy: string; ageMs: number },
      userId: string,
    ) => {
      const registry = createMockRegistry([])
      registry.getByKey.mockResolvedValue(
        createMockBranchContext({
          branchName: 'canopycms/local/feature-test',
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
        { branch: unsafeAsBranchName('feature-test') },
      )
    }

    it('answers the same creator within the window with the existing branch (200)', async () => {
      const res = await createAgainst({ createdBy: 'u1', ageMs: 60_000 }, 'u1')
      expect(res.ok).toBe(true)
      expect(res.status).toBe(200)
      expect(res.data?.branch.name).toBe('canopycms/local/feature-test')
      expect(res.data?.branch.createdBy).toBe('u1')
    })

    it('answers a different user with a 409, however recent the branch', async () => {
      const res = await createAgainst({ createdBy: 'someone-else', ageMs: 60_000 }, 'u1')
      expect(res.ok).toBe(false)
      expect(res.status).toBe(409)
      expect(res.error).toBe('A branch named "feature-test" already exists')
    })

    it('answers the same creator with a 409 once the window has passed', async () => {
      const res = await createAgainst({ createdBy: 'u1', ageMs: 6 * 60_000 }, 'u1')
      expect(res.ok).toBe(false)
      expect(res.status).toBe(409)
      expect(res.error).toBe('A branch named "feature-test" already exists')
    })
  })

  describe('branch-name collision guards (settings branch, API routes)', () => {
    // baseCtx's mock config defaults to mode: 'dev' (see createMockServices), so the namespace is
    // 'canopycms/local/' and the settings branch 'canopycms-settings-local'.

    it('rejects a typed name whose created branch is a configured settings branch', async () => {
      const ctx = createMockApiContext({
        services: {
          config: { mode: 'dev', settingsBranch: 'canopycms-local-site' } as any,
          registry: mockRegistry as any,
        },
      })
      const res = await createBranch(ctx, asU1, { branch: unsafeAsBranchName('site') })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      expect(res.error).toBe(
        'Cannot create content branch with settings branch name (git branch name collision)',
      )
      expect(res.code).toBe('BRANCH_NAME_REFUSED')
    })

    it.each([
      ['canopycms-settings-local', 'canopycms-settings-local'],
      ['canopycms/settings-local', 'canopycms-settings-local'],
      ['canopycms-settings-anything', 'canopycms-settings-anything'],
    ])(
      'refuses the typed name "%s", whose short name the handler keeps for settings',
      async (typed, short) => {
        const res = await createBranch(baseCtx, asU1, { branch: unsafeAsBranchName(typed) })
        expect(res.ok).toBe(false)
        expect(res.status).toBe(400)
        expect(res.error).toBe(
          `"${short}" is a name CanopyCMS keeps for its settings. Choose a different name.`,
        )
        expect(res.code).toBe('BRANCH_NAME_REFUSED')
      },
    )

    it('refuses a short name equal to a configured settings branch', async () => {
      const ctx = createMockApiContext({
        services: {
          config: { mode: 'dev', settingsBranch: 'site-settings' } as any,
          registry: mockRegistry as any,
        },
      })
      const res = await createBranch(ctx, asU1, { branch: unsafeAsBranchName('site-settings') })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      expect(res.error).toBe(
        '"site-settings" is a name CanopyCMS keeps for its settings. Choose a different name.',
      )
      expect(res.code).toBe('BRANCH_NAME_REFUSED')
    })

    it('creates a settings-like name outside the settings range', async () => {
      const res = await createBranch(baseCtx, asU1, { branch: unsafeAsBranchName('settings-prod') })
      expect(res.ok).toBe(true)
      expect(res.data?.branch.name).toBe('canopycms/local/settings-prod')
    })

    it.each(['admin', 'assets', 'branches'])(
      'refuses the short name "%s", which an API route outranks',
      async (typed) => {
        const res = await createBranch(baseCtx, asU1, { branch: unsafeAsBranchName(typed) })
        expect(res.ok).toBe(false)
        expect(res.status).toBe(400)
        expect(res.error).toBe(
          `"${typed}" is a name CanopyCMS uses for itself. Choose a different name.`,
        )
        expect(res.code).toBe('BRANCH_NAME_REFUSED')
      },
    )

    it('accepts names that merely contain or extend a route segment', async () => {
      for (const [name, created] of [
        ['admin-docs', 'canopycms/local/admin-docs'],
        ['assets-2026', 'canopycms/local/assets-2026'],
        ['feature/admin', 'canopycms/local/feature-admin'],
      ]) {
        const res = await createBranch(baseCtx, asU1, { branch: unsafeAsBranchName(name) })
        expect(res.ok).toBe(true)
        expect(res.data?.branch.name).toBe(created)
      }
    })

    it('keeps the case of a typed name', async () => {
      // `Admin` is not folded to lower case, so it is no route's segment.
      const res = await createBranch(baseCtx, asU1, { branch: unsafeAsBranchName('Admin') })
      expect(res.ok).toBe(true)
      expect(res.data?.branch.name).toBe('canopycms/local/Admin')
    })
  })

  describe('the namespace', () => {
    const create = (typed: string, ctx: ApiContext = baseCtx, as: ApiRequest = asU1) =>
      createBranch(ctx, as, { branch: unsafeAsBranchName(typed) })

    const ctxWith = (
      config: Partial<CanopyConfig>,
      branches: Parameters<typeof createMockRegistry>[0] = [],
    ) =>
      createMockApiContext({
        branchContext: createMockBranchContext({ branchName: 'main', createdBy: 'system' }),
        services: {
          config: { mode: 'dev', ...config } as CanopyConfig,
          registry: createMockRegistry(branches) as unknown as BranchRegistry,
        },
      })

    it('creates a typed name in the namespace the config names', async () => {
      const res = await create('spring', ctxWith({ branchNamespace: 'cms/{deployment}/' }))
      expect(res.status).toBe(200)
      expect(res.data?.branch).toMatchObject({ name: 'cms/local/spring', shortName: 'spring' })
    })

    it('sanitizes the typed name into the short name', async () => {
      const res = await create('feature/x')
      expect(res.status).toBe(200)
      expect(res.data?.branch.name).toBe('canopycms/local/feature-x')
    })

    it('refuses a typed name that already carries the namespace, never doubling it', async () => {
      const res = await create('canopycms/local/spring')
      expect(res.status).toBe(400)
      expect(res.error).toContain('without "canopycms/local/" in front')
      expect(res.code).toBe('BRANCH_NAME_REFUSED')
    })

    it.each(['_', '__', '@_'])(
      'refuses the typed name %s, which holds no letter or digit',
      async (typed) => {
        const res = await create(typed)
        expect(res.status).toBe(400)
        expect(res.error).toBe('Branch name needs at least one letter (a–z) or digit')
      },
    )

    it('takes a typed name that holds a letter or digit beside an underscore', async () => {
      const res = await create('a_')
      expect(res.status).toBe(200)
      expect(res.data?.branch.name).toBe('canopycms/local/a_')
    })

    it('refuses a typed name the namespace pushes past the length limit, and takes one that fits', async () => {
      const tooLong = await create('a'.repeat(235))
      expect(tooLong.status).toBe(400)
      expect(tooLong.error).toBe('Branch name too long (max 234 characters)')

      const fits = await create('a'.repeat(234))
      expect(fits.status).toBe(200)
      expect(fits.data?.branch.name).toBe(`canopycms/local/${'a'.repeat(234)}`)
    })

    it('answers an uninitialized registry with no name code, since no name would pass', async () => {
      const ctx = ctxWith({})
      const res = await create('spring', {
        ...ctx,
        services: { ...ctx.services, registry: undefined },
      })
      expect(res.status).toBe(400)
      expect(res.error).toMatch(/^Branch registry not initialized/)
      expect(res.code).toBeUndefined()
    })

    it('refuses, as a 500 an administrator can act on, a namespace the CMS cannot resolve', async () => {
      const res = await create('spring', ctxWith({ branchNamespace: 'no-slash' }))
      expect(res.status).toBe(500)
      expect(res.error).toMatch(
        /until an administrator fixes the branch namespace: .*end with "\/"/,
      )
    })

    describe('a short name another branch a URL reaches already has', () => {
      const refused = (typed: string) =>
        `"${typed}" is already the name of another branch. Choose a different name.`

      it('refuses the base branch and the configured active branch', async () => {
        const ctx = ctxWith({ defaultBaseBranch: 'main', defaultActiveBranch: 'develop' })
        for (const typed of ['main', 'develop']) {
          const res = await create(typed, ctx)
          expect(res.status).toBe(409)
          expect(res.error).toBe(refused(typed))
        }
      })

      it('refuses a workspace outside the namespace, and answers a retry of one inside it', async () => {
        const inside = createMockBranchContext({
          branchName: 'canopycms/local/inside',
          createdBy: 'u1',
          createdAt: new Date().toISOString(),
        })
        const ctx = ctxWith({}, [createMockBranchContext({ branchName: 'legacy-update' }), inside])
        vi.mocked(ctx.services.registry!.getByKey).mockResolvedValue(inside)

        const outside = await create('legacy-update', ctx)
        expect(outside.status).toBe(409)
        expect(outside.error).toBe(refused('legacy-update'))
        expect(outside.code).toBe('BRANCH_NAME_REFUSED')

        const retry = await create('inside', ctx)
        expect(retry.status).toBe(200)
        expect(retry.data?.branch.name).toBe('canopycms/local/inside')
      })

      it('refuses a ref the gateway protects exactly', async () => {
        mockReadWorkerStatus.mockResolvedValue({
          workerStatus: { gatewayProtectedBranches: ['canopycms/local/release'] },
        })
        const res = await create('release', ctxWith({}))
        expect(res.status).toBe(409)
        expect(res.error).toBe(refused('release'))
      })

      it('refuses the ref of an active branch configured inside the namespace', async () => {
        const res = await create(
          'develop',
          ctxWith({ defaultActiveBranch: 'canopycms/local/develop' }),
        )
        expect(res.status).toBe(409)
        expect(res.error).toBe(refused('develop'))
      })

      it('refuses an exact name the gateway protects, as the worker last recorded them', async () => {
        mockReadWorkerStatus.mockResolvedValue({
          workerStatus: { gatewayProtectedBranches: ['release', 'main'] },
        })
        const res = await create('release', ctxWith({}))
        expect(res.status).toBe(409)
        expect(res.error).toBe(refused('release'))
      })
    })

    describe("the gateway's namespace, as the worker last recorded it", () => {
      it('refuses with a 409 naming both when it differs', async () => {
        mockReadWorkerStatus.mockResolvedValue({
          workerStatus: { gatewayBranchNamespace: 'canopycms/prod/' },
        })
        const res = await create('spring')
        expect(res.status).toBe(409)
        expect(res.error).toContain('"canopycms/local/"')
        expect(res.error).toContain('"canopycms/prod/"')
        // No name would pass, so it is no refusal of this one.
        expect(res.code).toBeUndefined()
      })

      it('creates when it agrees, or when none is recorded', async () => {
        mockReadWorkerStatus.mockResolvedValue({
          workerStatus: { gatewayBranchNamespace: 'canopycms/local/' },
        })
        expect((await create('spring')).status).toBe(200)
        mockReadWorkerStatus.mockResolvedValue({ workerStatus: null })
        expect((await create('summer')).status).toBe(200)
      })

      describe('in prod, where branches publish through the worker', () => {
        const prodCtx = () =>
          ctxWith({ mode: 'prod', defaultBaseBranch: 'main', deploymentName: 'prod' })

        it.each([
          ['no status file', { workerStatus: null }],
          ['a status file from a worker that reports no namespace', { workerStatus: {} }],
        ])('refuses with a 503 naming the worker upgrade for %s', async (_label, status) => {
          mockReadWorkerStatus.mockResolvedValue(status)
          const res = await create('spring', prodCtx())
          expect(res.status).toBe(503)
          expect(res.error).toBe(
            "Branches cannot be created yet: the CMS worker has not reported the GitHub gateway's " +
              'branch namespace. Ask an administrator to check that the worker (canopycms-cdk) ' +
              'runs this release and that its git sync reaches the gateway, then try again.',
          )
          expect(res.code).toBeUndefined()
        })

        it('creates once the worker reports the namespace the CMS creates in', async () => {
          mockReadWorkerStatus.mockResolvedValue({
            workerStatus: { gatewayBranchNamespace: 'canopycms/prod/' },
          })
          const res = await create('spring', prodCtx())
          expect(res.status).toBe(200)
          expect(res.data?.branch.name).toBe('canopycms/prod/spring')
        })
      })
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

  it('hides a locked-down branch from everyone its ACL or creator grant would admit', async () => {
    const ctx = createMockApiContext({
      services: {
        registry: createMockRegistry([
          createMockBranchContext({
            branchName: 'feature/locked',
            createdBy: 'u1',
            access: {
              managerOrAdminAllowed: true,
              allowedUsers: ['u2'],
              allowedGroups: ['editors'],
            },
            baseRoot: '/test/base',
          }),
          createMockBranchContext({
            branchName: 'feature/open',
            createdBy: 'u3',
            access: { managerOrAdminAllowed: false, allowedUsers: ['u2'] },
            baseRoot: '/test/base',
          }),
        ]) as any,
      },
    })
    const namesFor = async (userId: string, groups: string[] = []) =>
      (
        await listBranches(ctx, { user: { type: 'authenticated', userId, groups } })
      ).data?.branches.map((b) => b.name)

    expect(await namesFor('u1')).toEqual([])
    expect(await namesFor('u2')).toEqual(['feature/open'])
    expect(await namesFor('u4', ['editors'])).toEqual([])
    expect(await namesFor('boss', [RESERVED_GROUPS.REVIEWERS])).toEqual([
      'feature/locked',
      'feature/open',
    ])
    expect(await namesFor('root', [RESERVED_GROUPS.ADMINS])).toEqual([
      'feature/locked',
      'feature/open',
    ])
  })

  it("lists a colleague's un-ACL'd branch under defaultBranchAccess 'allow', which the access check grants", async () => {
    const ctx = createMockApiContext({
      services: {
        registry: createMockRegistry([
          createMockBranchContext({ branchName: 'feature/open', createdBy: 'u2' }),
          createMockBranchContext({
            branchName: 'feature/acl',
            createdBy: 'u2',
            access: { allowedUsers: ['u3'] },
          }),
        ]) as any,
        config: { defaultBranchAccess: 'allow' } as unknown as CanopyConfig,
      },
    })

    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'u1', groups: [] },
    })

    expect(res.data?.branches.map((b) => b.name)).toEqual(['feature/open'])
  })

  it('leaves out a branch whose explicit ACL omits its creator, which the access check refuses them', async () => {
    const ctx = createMockApiContext({
      services: {
        registry: createMockRegistry([
          createMockBranchContext({
            branchName: 'feature/taken-over',
            createdBy: 'u1',
            access: { allowedUsers: ['u2'] },
          }),
          createMockBranchContext({ branchName: 'feature/mine', createdBy: 'u1' }),
        ]) as any,
      },
    })

    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'u1', groups: [] },
    })

    expect(res.data?.branches.map((b) => b.name)).toEqual(['feature/mine'])
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
    // editor uses to pick WHICH lock its status names.
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

    // u1 created feature/x; its entry carries correct (unprotected) flags.
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
    // access check's protected-base-branch grant still lists it.
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

  it("reports as the default branch the name of the workspace the active branch's key holds", async () => {
    // A workspace provisioned under the sanitized name of a raw git HEAD keeps its own name.
    const ctx = createMockApiContext({
      services: {
        config: { mode: 'dev', defaultBaseBranch: 'main', defaultActiveBranch: 'feat/x' } as any,
        registry: createMockRegistry([
          createMockBranchContext({ branchName: 'feat-x', baseRoot: '/test/base' }),
        ]) as any,
      },
    })
    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })
    expect(res.data?.defaultBranch).toBe('feat-x')

    const fresh = createMockApiContext({
      services: {
        config: { mode: 'dev', defaultBaseBranch: 'main', defaultActiveBranch: 'feat/x' } as any,
        registry: createMockRegistry([]) as any,
      },
    })
    const unprovisioned = await listBranches(fresh, {
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })
    expect(unprovisioned.data?.defaultBranch).toBe('feat/x')
  })

  it('lists each branch with the short name its pull request links carry', async () => {
    const ctx = createMockApiContext({
      services: {
        config: { mode: 'dev', defaultBaseBranch: 'main' } as any,
        registry: createMockRegistry([
          createMockBranchContext({ branchName: 'canopycms/local/spring', baseRoot: '/test/base' }),
          createMockBranchContext({ branchName: 'legacy/update', baseRoot: '/test/base' }),
        ]) as any,
      },
    })
    const res = await listBranches(ctx, {
      user: { type: 'authenticated', userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    })
    expect(res.data?.branches.map((b) => [b.name, b.shortName])).toEqual([
      ['canopycms/local/spring', 'spring'],
      ['legacy/update', 'legacy/update'],
    ])
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
    status: 'editing' | 'submitted' | 'approved' | 'archived' = 'editing',
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

  describe('a branch that may hold commits the merge left out', () => {
    const flagged = () => {
      const context = makeBranchContext('u1', 'archived')
      return {
        ...deleteCtx,
        getBranchContext: vi.fn().mockResolvedValue({
          ...context,
          branch: { ...context.branch, unpublishedAtMerge: true },
        }),
      }
    }

    it('refuses its creator: nobody else would learn what went', async () => {
      const res = await deleteBranch(
        flagged(),
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('feature/x') },
      )

      expect(res.status).toBe(409)
      expect(res.error).toContain('Ask an admin to check it')
    })

    it('leaves the decision to an admin', async () => {
      const res = await deleteBranch(
        flagged(),
        { user: { type: 'authenticated', userId: 'a1', groups: [RESERVED_GROUPS.ADMINS] } },
        { branch: unsafeAsBranchName('feature/x') },
      )

      expect(res.ok).toBe(true)
    })
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
      pushedNoPr.branch.pushedToGitHubAt = '2026-01-02T03:04:05.000Z'

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
        payload: { branch: 'feature/x', pushedToGitHubAt: '2026-01-02T03:04:05.000Z' },
      })
    })

    it('is never touched when the branch has neither a PR nor a GitHub push stamp, so the CMS never pushed it', async () => {
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
    // A creator without the privileged lookup gets back only a count of the ids it set.
    expect(res.data?.branch.access.allowedUsers).toEqual([])
    expect(res.data?.branch.withheldAccess).toEqual({ users: 2, groups: 0 })
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

describe('toBranchListItem', () => {
  const listed = (branch: Partial<BranchMetadata>) =>
    toBranchListItem(
      baseCtx.services.config,
      { ...createMockBranchContext({ branchName: 'x', createdBy: 'u' }).branch, ...branch },
      { type: 'authenticated', userId: 'v', groups: [] },
    )

  it('says what holds a pull request while the branch is in review', () => {
    const pullRequestHold = { kind: 'retargeted', base: 'release' } as const
    expect(listed({ status: 'approved', pullRequestHold }).hold).toEqual(pullRequestHold)
    expect(listed({ status: 'submitted', pullRequestHold }).hold).toEqual(pullRequestHold)
    expect(listed({ status: 'submitted', pullRequestHold })).not.toHaveProperty('pullRequestHold')
  })

  it('drops a hold left from before the branch came back to editing', () => {
    const item = listed({ status: 'editing', pullRequestHold: { kind: 'conflicts' } })
    expect(item.hold).toBeUndefined()
  })

  it('says when no task stands behind an unfinished submit, without the field itself', () => {
    const item = listed({ status: 'submitted', submitUnfinished: true, submitNotQueued: true })
    expect(item.hold).toEqual({ kind: 'submit-unfinished', opened: false, notQueued: true })
    expect(item).not.toHaveProperty('submitNotQueued')
  })

  it('says a failed submit never finished, only while the branch is in review', () => {
    const item = listed({ status: 'submitted', submitUnfinished: true, pullRequestNumber: 7 })
    expect(item.hold).toEqual({ kind: 'submit-unfinished', opened: true })
    expect(listed({ status: 'approved', submitUnfinished: true }).hold).toEqual({
      kind: 'submit-unfinished',
      opened: false,
    })
    expect(item).not.toHaveProperty('submitUnfinished')
    const merged = listed({ status: 'archived', unpublishedAtMerge: true })
    expect(merged).not.toHaveProperty('unpublishedAtMerge')
    expect(merged.hold).toEqual({ kind: 'unpublished-at-merge' })
    expect(item.approveBlocked).toBe(true)
    // Beside a rewrite, which is the hold shown: the server's refusal stands either way.
    expect(
      listed({ status: 'submitted', submitUnfinished: true, rewrittenOnGitHub: 'a'.repeat(40) })
        .approveBlocked,
    ).toBe(true)
    expect(listed({ status: 'editing', submitUnfinished: true }).approveBlocked).toBeUndefined()
    expect(listed({ status: 'editing', submitUnfinished: true }).hold).toBeUndefined()
    expect(
      listed({ status: 'submitted', submitUnfinished: true, rewrittenOnGitHub: 'a'.repeat(40) })
        .hold,
    ).toEqual({ kind: 'rewritten' })
  })

  it('says a branch was rewritten on GitHub, without the commit, and blocks its submit', () => {
    const item = listed({ status: 'editing', rewrittenOnGitHub: 'a'.repeat(40) })
    expect(item.hold).toEqual({ kind: 'rewritten' })
    expect(item.submitBlocked).toBe(true)
  })

  it('says nothing of a rewrite on an archived branch, which nothing clears', () => {
    expect(listed({ status: 'archived', rewrittenOnGitHub: 'a'.repeat(40) }).hold).toBeUndefined()
  })

  it('ignores a hold written into the file by hand', () => {
    const forged = { hold: { kind: 'retargeted', base: 5 } } as unknown as Partial<BranchMetadata>
    expect(listed({ status: 'editing', ...forged }).hold).toBeUndefined()
  })

  it('leaves out what only the worker reads, including file paths a viewer may not see', () => {
    const item = toBranchListItem(
      { mode: 'dev' } as unknown as Parameters<typeof toBranchListItem>[0],
      {
        name: 'x',
        status: 'editing',
        access: {},
        createdBy: 'u',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        keptOverGitHub: ['content/secret.json'],
        lastGitHubTip: 'a'.repeat(40),
        rewrittenOnGitHub: 'a'.repeat(40),
        rebaseFailure: { message: 'content/secret.json', firstAt: 'x', lastAt: 'x' },
      },
      { type: 'authenticated', userId: 'v', groups: [] },
    )
    expect(item).not.toHaveProperty('keptOverGitHub')
    expect(item).not.toHaveProperty('lastGitHubTip')
    expect(item).not.toHaveProperty('rewrittenOnGitHub')
    expect(item).not.toHaveProperty('rebaseFailure')
  })

  it('leaves the reviewer out, for a privileged viewer too', () => {
    const context = createMockBranchContext({ branchName: 'feature/x', createdBy: 'u1' })
    const branch = {
      ...context.branch,
      review: {
        state: 'approved' as const,
        by: { userId: 'rev1', name: 'Rae' },
        at: '2026-10-28T14:05:00.000Z',
      },
    }
    const config = baseCtx.services.config
    for (const groups of [[], [RESERVED_GROUPS.ADMINS]]) {
      const item = toBranchListItem(config, branch, { type: 'authenticated', userId: 'v', groups })
      expect(item).not.toHaveProperty('review')
      expect(JSON.stringify(item)).not.toContain('rev1')
      expect(item.name).toBe('feature/x')
    }
  })
})
