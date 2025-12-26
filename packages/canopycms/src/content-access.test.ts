import { describe, expect, it } from 'vitest'

import { createCheckBranchAccess } from './authz'
import { createCheckPathAccess } from './path-permissions'
import { buildPathPermissions } from './path-permissions'
import { defineCanopyTestConfig } from './config-test'
import { createCheckContentAccess } from './content-access'
import { RESERVED_GROUPS } from './reserved-groups'

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

const config = defineCanopyTestConfig({
  schema: [
    {
      type: 'collection',
      name: 'pages',
      path: 'pages',
      format: 'md',
      fields: [{ name: 'title', type: 'string' }],
    },
  ],
  pathPermissions: [{ path: 'content/admin/**', managerOrAdminAllowed: true }],
  defaultBranchAccess: 'deny',
})

const pathRules = buildPathPermissions(config)
const checkPath = createCheckPathAccess(pathRules)
const checkBranch = createCheckBranchAccess(config.defaultBranchAccess ?? 'deny')
const checkContent = createCheckContentAccess({
  checkBranchAccess: checkBranch,
  checkPathAccess: (input) => checkPath(input),
})

describe('checkContentAccess', () => {
  it('denies when branch ACL defaults to deny and no allowlist', () => {
    const res = checkContent(branchState, 'content/pages/foo.md', { userId: 'u1', groups: [] })
    expect(res.allowed).toBe(false)
    expect(res.branch.reason).toBe('no_acl')
  })

  it('allows Reviewer override even if branch default deny', () => {
    const res = checkContent(branchState, 'content/pages/foo.md', {
      userId: 'u1',
      groups: [RESERVED_GROUPS.REVIEWERS],
    })
    expect(res.allowed).toBe(true)
    expect(res.branch.reason).toBe('privileged')
  })

  it('denies path access for regular users hitting admin paths', () => {
    const res = checkContent(branchState, 'content/admin/secret.md', { userId: 'u1', groups: [] })
    expect(res.allowed).toBe(false)
    expect(res.path.allowed).toBe(false)
  })
})
