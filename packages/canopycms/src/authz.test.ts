import { describe, expect, it } from 'vitest'

import { checkBranchAccessWithDefault } from './authz'
import type { BranchState } from './types'

const baseState: BranchState = {
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
  it('allows admin/manager', () => {
    const res = checkBranchAccessWithDefault(baseState, { userId: 'u', role: 'manager' })
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('admin_or_manager')
  })

  it('denies when no ACLs are set (default deny)', () => {
    const res = checkBranchAccessWithDefault(baseState, { userId: 'u', role: 'editor' })
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('no_acl')
  })

  it('honors default allow override', () => {
    const res = checkBranchAccessWithDefault(baseState, { userId: 'u', role: 'editor' }, 'allow')
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('no_acl')
  })

  it('denies when managerOrAdminAllowed set but user is editor', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseState,
        branch: { ...baseState.branch, access: { managerOrAdminAllowed: true } },
      },
      { userId: 'u', role: 'editor' }
    )
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('denied_by_acl')
  })

  it('allows matching user', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseState,
        branch: { ...baseState.branch, access: { allowedUsers: ['user-1'] } },
      },
      { userId: 'user-1', role: 'editor' }
    )
    expect(res.allowed).toBe(true)
  })

  it('allows matching group', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseState,
        branch: { ...baseState.branch, access: { allowedGroups: ['group-1'] } },
      },
      { userId: 'u', groups: ['group-1'], role: 'editor' }
    )
    expect(res.allowed).toBe(true)
  })

  it('denies when allowlists miss', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseState,
        branch: { ...baseState.branch, access: { allowedUsers: ['user-2'] } },
      },
      { userId: 'user-1', role: 'editor' }
    )
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('denied_by_acl')
  })
})
