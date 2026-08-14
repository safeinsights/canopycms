import { describe, expect, it, vi } from 'vitest'

import {
  createCheckBranchAccess,
  createCheckContentAccess,
  createContentAccessChecker,
  RESERVED_GROUPS,
  type ContentAccessDeps,
} from '../'
import { unsafeAsPermissionPath } from '../test-utils'
import type { PathPermission } from '../../config'
import { unsafeAsPhysicalPath } from '../../paths/test-utils'

const branchContext = {
  baseRoot: '/tmp/base',
  branchRoot: '/tmp/base/feature-x',
  branch: {
    name: 'feature/x',
    status: 'editing' as const,
    access: {},
    createdBy: 'u1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
}

// Path permission rules (from .canopycms/permissions.json)
// Rule with explicit constraints - only Admins group can edit admin paths
const pathRules: PathPermission[] = [
  {
    path: unsafeAsPermissionPath('content/admin/**'),
    edit: { allowedGroups: ['Admins'] },
  },
]

describe('checkContentAccess', () => {
  it('denies when branch ACL defaults to deny and no allowlist', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue(pathRules)
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('deny'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/repo'),
    })

    const res = await checkContent(
      branchContext,
      '/repo',
      unsafeAsPhysicalPath('content/pages/foo.md'),
      // Not the branch creator (branchContext.branch.createdBy is 'u1') -- the
      // creator owns their own un-ACL'd branch and is covered separately below.
      { type: 'authenticated', userId: 'u2', groups: [] },
      'edit',
    )

    expect(mockLoadPermissions).toHaveBeenCalledWith('/repo', 'dev')
    expect(res.allowed).toBe(false)
    expect(res.branch.reason).toBe('no_acl')
  })

  it('allows the branch creator on their own no-ACL branch under default deny', async () => {
    // The content layer ANDs branch access into every check, so without the
    // creator grant a freshly created branch is inert for the person who made
    // it -- no reads, no writes -- not merely un-submittable.
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('deny'),
      loadPathPermissions: vi.fn().mockResolvedValue(pathRules),
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/repo'),
    })

    const res = await checkContent(
      branchContext,
      '/repo',
      unsafeAsPhysicalPath('content/pages/foo.md'),
      { type: 'authenticated', userId: 'u1', groups: [] },
      'edit',
    )

    expect(res.allowed).toBe(true)
    expect(res.branch.reason).toBe('creator')
  })

  it('allows Reviewer override even if branch default deny', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue(pathRules)
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('deny'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/repo'),
    })

    const res = await checkContent(
      branchContext,
      '/repo',
      unsafeAsPhysicalPath('content/pages/foo.md'),
      {
        type: 'authenticated',
        userId: 'u1',
        groups: [RESERVED_GROUPS.REVIEWERS],
      },
      'edit',
    )

    expect(res.allowed).toBe(true)
    expect(res.branch.reason).toBe('privileged')
  })

  it('denies path access for regular users hitting admin paths', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue(pathRules)
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('allow'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/repo'),
    })

    const res = await checkContent(
      branchContext,
      '/repo',
      unsafeAsPhysicalPath('content/admin/secret.md'),
      { type: 'authenticated', userId: 'u1', groups: [] },
      'edit',
    )

    expect(res.allowed).toBe(false)
    expect(res.path.allowed).toBe(false)
  })

  it('respects defaultPathAccess when no rule matches', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue([])
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('allow'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'deny',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/repo'),
    })

    const res = await checkContent(
      branchContext,
      '/repo',
      unsafeAsPhysicalPath('content/open/page.md'),
      { type: 'authenticated', userId: 'u1', groups: [] },
      'edit',
    )

    expect(res.allowed).toBe(false)
    expect(res.path.allowed).toBe(false)
    expect(res.path.reason).toBe('no_rule_match')
  })

  it('allows access when defaultPathAccess is allow and no rules match', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue([])
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('allow'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/repo'),
    })

    const res = await checkContent(
      branchContext,
      '/repo',
      unsafeAsPhysicalPath('content/open/page.md'),
      { type: 'authenticated', userId: 'u1', groups: [] },
      'edit',
    )

    expect(res.allowed).toBe(true)
    expect(res.path.allowed).toBe(true)
    expect(res.path.reason).toBe('no_rule_match')
  })

  // Level-scoped defaultPathAccess end-to-end: same unmatched path, read allowed but
  // edit denied, via the object form flowing through checkContentAccess.
  it('respects level-scoped defaultPathAccess: read allowed, edit denied', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue([])
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('allow'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: { read: 'allow', edit: 'deny' },
      mode: 'dev',
      getSettingsBranchRoot: () => Promise.resolve('/repo'),
    })

    const user = { type: 'authenticated' as const, userId: 'u1', groups: [] }
    const readRes = await checkContent(
      branchContext,
      '/repo',
      unsafeAsPhysicalPath('content/open/page.md'),
      user,
      'read',
    )
    expect(readRes.allowed).toBe(true)

    const editRes = await checkContent(
      branchContext,
      '/repo',
      unsafeAsPhysicalPath('content/open/page.md'),
      user,
      'edit',
    )
    expect(editRes.allowed).toBe(false)
  })
})

describe('createContentAccessChecker', () => {
  const deps = (overrides?: Partial<ContentAccessDeps>): ContentAccessDeps => ({
    checkBranchAccess: createCheckBranchAccess('allow'),
    loadPathPermissions: vi.fn().mockResolvedValue(pathRules),
    defaultPathAccess: 'allow',
    mode: 'dev',
    getSettingsBranchRoot: () => Promise.resolve('/repo'),
    ...overrides,
  })

  it('loads permissions and the settings root once regardless of how many paths are checked', async () => {
    const loadPathPermissions = vi.fn().mockResolvedValue(pathRules)
    const getSettingsBranchRoot = vi.fn().mockResolvedValue('/repo')
    const check = await createContentAccessChecker(
      deps({ loadPathPermissions, getSettingsBranchRoot }),
      branchContext,
      '/repo',
      { type: 'authenticated', userId: 'u1', groups: [] },
    )

    for (let i = 0; i < 5; i++) {
      check(unsafeAsPhysicalPath(`content/pages/foo-${i}.md`), 'read')
      check(unsafeAsPhysicalPath(`content/pages/foo-${i}.md`), 'edit')
    }

    expect(loadPathPermissions).toHaveBeenCalledTimes(1)
    expect(loadPathPermissions).toHaveBeenCalledWith('/repo', 'dev')
    expect(getSettingsBranchRoot).toHaveBeenCalledTimes(1)
  })

  it('returns the same result as checkContentAccess for the same inputs', async () => {
    const user = { type: 'authenticated' as const, userId: 'u1', groups: [] }
    const path = unsafeAsPhysicalPath('content/admin/secret.md')

    const single = await createCheckContentAccess(deps())(
      branchContext,
      '/repo',
      path,
      user,
      'edit',
    )
    const check = await createContentAccessChecker(deps(), branchContext, '/repo', user)

    expect(check(path, 'edit')).toEqual(single)
  })

  it('throws when a separate settings branch is required but getSettingsBranchRoot is missing', async () => {
    await expect(
      createContentAccessChecker(
        deps({ getSettingsBranchRoot: undefined }),
        branchContext,
        '/repo',
        {
          type: 'authenticated',
          userId: 'u1',
          groups: [],
        },
      ),
    ).rejects.toThrow('getSettingsBranchRoot is required')
  })
})
