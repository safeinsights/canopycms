import { describe, expect, it } from 'vitest'

import { checkBranchAccessWithDefault, canPerformWorkflowAction } from './authz'
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

describe('canPerformWorkflowAction', () => {
  const regularUser = { type: 'authenticated' as const, userId: 'user-1', groups: [] }
  const admin = { type: 'authenticated' as const, userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] }
  const reviewer = { type: 'authenticated' as const, userId: 'reviewer-1', groups: [RESERVED_GROUPS.REVIEWERS] }

  describe('branch creator permissions', () => {
    it('allows branch creator to perform workflow actions', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-1', access: {} },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'allow')).toBe(true)
    })

    it('denies non-creator without ACL access', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-2', access: {} },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(false)
    })
  })

  describe('ACL-based permissions', () => {
    it('allows user in allowedUsers ACL', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-2', access: { allowedUsers: ['user-1'] } },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(true)
    })

    it('allows user in allowedGroups ACL', () => {
      const userInGroup = { type: 'authenticated' as const, userId: 'user-1', groups: ['team-a'] }
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-2', access: { allowedGroups: ['team-a'] } },
      }
      expect(canPerformWorkflowAction(context, userInGroup, 'deny')).toBe(true)
    })

    it('denies user not in ACL', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-2', access: { allowedUsers: ['user-3'] } },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(false)
    })
  })

  describe('system branch permissions', () => {
    it('allows any user with general access on system branches', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'canopycms-system', access: {} },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'allow')).toBe(true)
    })

    it('denies user without general access on system branches', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'canopycms-system', access: { allowedUsers: ['user-2'] } },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(false)
    })
  })

  describe('privileged user permissions', () => {
    it('allows admins to perform workflow actions', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-2', access: {} },
      }
      expect(canPerformWorkflowAction(context, admin, 'deny')).toBe(true)
    })

    it('allows reviewers to perform workflow actions', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-2', access: {} },
      }
      expect(canPerformWorkflowAction(context, reviewer, 'deny')).toBe(true)
    })
  })

  describe('combined scenarios', () => {
    it('allows creator who is also in ACL', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-1', access: { allowedUsers: ['user-1', 'user-2'] } },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(true)
    })

    it('denies user who lacks both creator and ACL access', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-2', access: { allowedUsers: ['user-3'] } },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(false)
    })
  })
})
