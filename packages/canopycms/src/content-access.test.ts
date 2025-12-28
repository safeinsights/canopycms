import { describe, expect, it, vi } from 'vitest'

import { createCheckBranchAccess } from './authz'
import { createCheckContentAccess } from './content-access'
import { RESERVED_GROUPS } from './reserved-groups'
import type { PathPermission } from './config'

const branchState = {
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
const pathRules: PathPermission[] = [{ path: 'content/admin/**', managerOrAdminAllowed: true }]

describe('checkContentAccess', () => {
  it('denies when branch ACL defaults to deny and no allowlist', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue(pathRules)
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('deny'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
    })

    const res = await checkContent(branchState, '/repo', 'content/pages/foo.md', { userId: 'u1', groups: [] })

    expect(mockLoadPermissions).toHaveBeenCalledWith('/repo')
    expect(res.allowed).toBe(false)
    expect(res.branch.reason).toBe('no_acl')
  })

  it('allows Reviewer override even if branch default deny', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue(pathRules)
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('deny'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
    })

    const res = await checkContent(branchState, '/repo', 'content/pages/foo.md', {
      userId: 'u1',
      groups: [RESERVED_GROUPS.REVIEWERS],
    })

    expect(res.allowed).toBe(true)
    expect(res.branch.reason).toBe('privileged')
  })

  it('denies path access for regular users hitting admin paths', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue(pathRules)
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('allow'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'allow',
    })

    const res = await checkContent(branchState, '/repo', 'content/admin/secret.md', { userId: 'u1', groups: [] })

    expect(res.allowed).toBe(false)
    expect(res.path.allowed).toBe(false)
  })

  it('respects defaultPathAccess when no rule matches', async () => {
    const mockLoadPermissions = vi.fn().mockResolvedValue([])
    const checkContent = createCheckContentAccess({
      checkBranchAccess: createCheckBranchAccess('allow'),
      loadPathPermissions: mockLoadPermissions,
      defaultPathAccess: 'deny',
    })

    const res = await checkContent(branchState, '/repo', 'content/open/page.md', { userId: 'u1', groups: [] })

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
    })

    const res = await checkContent(branchState, '/repo', 'content/open/page.md', { userId: 'u1', groups: [] })

    expect(res.allowed).toBe(true)
    expect(res.path.allowed).toBe(true)
    expect(res.path.reason).toBe('no_rule_match')
  })
})
