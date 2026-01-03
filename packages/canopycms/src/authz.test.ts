import { describe, expect, it } from 'vitest'

import { checkBranchAccessWithDefault } from './authz'
import type { BranchContext } from './types'
import { RESERVED_GROUPS } from './reserved-groups'

const baseContext: BranchContext = {
  baseRoot: '/tmp/base',
  branchRoot: '/tmp/base/feature-x',
  branch: {
    name: 'feature/x',
    status: 'editing',
    access: {},
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
}

describe('branch access', () => {
  it('allows Admins', () => {
    const res = checkBranchAccessWithDefault(baseContext, { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.ADMINS] })
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('privileged')
  })

  it('allows Reviewers', () => {
    const res = checkBranchAccessWithDefault(baseContext, { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.REVIEWERS] })
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('privileged')
  })

  it('denies when no ACLs are set (default deny)', () => {
    const res = checkBranchAccessWithDefault(baseContext, { type: 'authenticated', userId: 'u', groups: [] })
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('no_acl')
  })

  it('honors default allow override', () => {
    const res = checkBranchAccessWithDefault(baseContext, { type: 'authenticated', userId: 'u', groups: [] }, 'allow')
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('no_acl')
  })

  it('denies when managerOrAdminAllowed set but user is not privileged', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseContext,
        branch: { ...baseContext.branch, access: { managerOrAdminAllowed: true } },
      },
      { type: 'authenticated', userId: 'u', groups: [] }
    )
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('denied_by_acl')
  })

  it('allows matching user', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseContext,
        branch: { ...baseContext.branch, access: { allowedUsers: ['user-1'] } },
      },
      { type: 'authenticated', userId: 'user-1', groups: [] }
    )
    expect(res.allowed).toBe(true)
  })

  it('allows matching group', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseContext,
        branch: { ...baseContext.branch, access: { allowedGroups: ['group-1'] } },
      },
      { type: 'authenticated', userId: 'u', groups: ['group-1'] }
    )
    expect(res.allowed).toBe(true)
  })

  it('denies when allowlists miss', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseContext,
        branch: { ...baseContext.branch, access: { allowedUsers: ['user-2'] } },
      },
      { type: 'authenticated', userId: 'user-1', groups: [] }
    )
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('denied_by_acl')
  })
})
