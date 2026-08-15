import { describe, expect, it } from 'vitest'

import { checkBranchAccessWithDefault, canPerformWorkflowAction, RESERVED_GROUPS } from '../'
import type { BranchContext } from '../../types'
import { ANONYMOUS_USER } from '../../user'

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
    const res = checkBranchAccessWithDefault(baseContext, {
      type: 'authenticated',
      userId: 'u',
      groups: [RESERVED_GROUPS.ADMINS],
    })
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('privileged')
  })

  it('allows Reviewers', () => {
    const res = checkBranchAccessWithDefault(baseContext, {
      type: 'authenticated',
      userId: 'u',
      groups: [RESERVED_GROUPS.REVIEWERS],
    })
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('privileged')
  })

  it('denies when no ACLs are set (default deny)', () => {
    const res = checkBranchAccessWithDefault(baseContext, {
      type: 'authenticated',
      userId: 'u',
      groups: [],
    })
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('no_acl')
  })

  it('honors default allow override', () => {
    const res = checkBranchAccessWithDefault(
      baseContext,
      { type: 'authenticated', userId: 'u', groups: [] },
      'allow',
    )
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('no_acl')
  })

  it('denies when managerOrAdminAllowed set but user is not privileged', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          access: { managerOrAdminAllowed: true },
        },
      },
      { type: 'authenticated', userId: 'u', groups: [] },
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
      { type: 'authenticated', userId: 'user-1', groups: [] },
    )
    expect(res.allowed).toBe(true)
  })

  it('allows matching group', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          access: { allowedGroups: ['group-1'] },
        },
      },
      { type: 'authenticated', userId: 'u', groups: ['group-1'] },
    )
    expect(res.allowed).toBe(true)
  })

  it('denies when allowlists miss', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseContext,
        branch: { ...baseContext.branch, access: { allowedUsers: ['user-2'] } },
      },
      { type: 'authenticated', userId: 'user-1', groups: [] },
    )
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('denied_by_acl')
  })
})

describe('branch access: creator grant', () => {
  const creator = { type: 'authenticated' as const, userId: 'user-1', groups: [] }

  it('allows the creator of a no-ACL branch under default deny', () => {
    const res = checkBranchAccessWithDefault(baseContext, creator, 'deny')
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('creator')
  })

  it('does NOT override an explicit allowlist that omits the creator', () => {
    // This is how an admin locks down a branch someone else created
    // (role-permissions.test.ts covers the end-to-end case). Granting creator
    // ahead of the ACL would make that lockdown silently ineffective.
    const res = checkBranchAccessWithDefault(
      {
        ...baseContext,
        branch: { ...baseContext.branch, access: { allowedUsers: ['user-2'] } },
      },
      creator,
      'deny',
    )
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('denied_by_acl')
  })

  it('still denies the creator when managerOrAdminAllowed locks the branch down', () => {
    const res = checkBranchAccessWithDefault(
      {
        ...baseContext,
        branch: { ...baseContext.branch, access: { managerOrAdminAllowed: true } },
      },
      creator,
      'deny',
    )
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('denied_by_acl')
  })

  it('does not grant a non-creator', () => {
    const res = checkBranchAccessWithDefault(
      baseContext,
      { type: 'authenticated', userId: 'user-2', groups: [] },
      'deny',
    )
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('no_acl')
  })
})

describe('branch access: protected base branch grant', () => {
  // The base branch takes no ACL (updateBranchAccessHandler rejects one) and is
  // createdBy 'canopycms-system', so nobody is its creator. Without this grant
  // it is unreachable under 'deny' with no way to configure around it.
  const baseBranchContext: BranchContext = {
    ...baseContext,
    branch: { ...baseContext.branch, name: 'main', createdBy: 'canopycms-system' },
  }

  it('allows any authenticated user under default deny', () => {
    const res = checkBranchAccessWithDefault(
      baseBranchContext,
      { type: 'authenticated', userId: 'nobody', groups: [] },
      'deny',
      { isProtectedBranch: true },
    )
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('base_branch')
  })

  it('allows anonymous under default deny, so public-read sites can run deny', () => {
    const res = checkBranchAccessWithDefault(baseBranchContext, ANONYMOUS_USER, 'deny', {
      isProtectedBranch: true,
    })
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('base_branch')
  })

  it('does not confer workflow actions on the base branch', () => {
    // The access layer says yes, but Submit/Withdraw must still be denied:
    // isProtectedBranch disables canPerformWorkflowAction's system-branch grant.
    expect(
      canPerformWorkflowAction(
        baseBranchContext,
        { type: 'authenticated', userId: 'nobody', groups: [] },
        'deny',
        { isProtectedBranch: true },
      ),
    ).toBe(false)
  })
})

describe('canPerformWorkflowAction', () => {
  const regularUser = {
    type: 'authenticated' as const,
    userId: 'user-1',
    groups: [],
  }
  const admin = {
    type: 'authenticated' as const,
    userId: 'admin-1',
    groups: [RESERVED_GROUPS.ADMINS],
  }
  const reviewer = {
    type: 'authenticated' as const,
    userId: 'reviewer-1',
    groups: [RESERVED_GROUPS.REVIEWERS],
  }

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

    it('allows the creator of a no-ACL branch under default deny', () => {
      // The reachable case behind the client/server divergence: the create form
      // sends no ACL, so under 'deny' the creator saw an enabled Submit and a 403.
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-1', access: {} },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(true)
    })
  })

  describe('ACL-based permissions', () => {
    it('allows user in allowedUsers ACL', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'user-2',
          access: { allowedUsers: ['user-1'] },
        },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(true)
    })

    it('allows user in allowedGroups ACL', () => {
      const userInGroup = {
        type: 'authenticated' as const,
        userId: 'user-1',
        groups: ['team-a'],
      }
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'user-2',
          access: { allowedGroups: ['team-a'] },
        },
      }
      expect(canPerformWorkflowAction(context, userInGroup, 'deny')).toBe(true)
    })

    it('denies user not in ACL', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'user-2',
          access: { allowedUsers: ['user-3'] },
        },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(false)
    })
  })

  describe('system branch permissions', () => {
    it('allows any user with general access on system branches', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'canopycms-system',
          access: {},
        },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'allow')).toBe(true)
    })

    it('denies user without general access on system branches', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'canopycms-system',
          access: { allowedUsers: ['user-2'] },
        },
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

  describe('isProtectedBranch option', () => {
    it('disables the system-branch grant, denying general access on a protected branch', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'canopycms-system',
          access: {},
        },
      }
      expect(
        canPerformWorkflowAction(context, regularUser, 'allow', { isProtectedBranch: true }),
      ).toBe(false)
    })

    it('still allows admins on a protected system branch', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'canopycms-system',
          access: {},
        },
      }
      expect(canPerformWorkflowAction(context, admin, 'allow', { isProtectedBranch: true })).toBe(
        true,
      )
    })

    it('still allows the branch creator on a protected branch', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-1', access: {} },
      }
      expect(
        canPerformWorkflowAction(context, regularUser, 'allow', { isProtectedBranch: true }),
      ).toBe(true)
    })

    it('still allows ACL-listed users on a protected branch', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'user-2',
          access: { allowedUsers: ['user-1'] },
        },
      }
      expect(
        canPerformWorkflowAction(context, regularUser, 'deny', { isProtectedBranch: true }),
      ).toBe(true)
    })

    it('does not affect non-system branches', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: { ...baseContext.branch, createdBy: 'user-2', access: {} },
      }
      expect(
        canPerformWorkflowAction(context, regularUser, 'deny', { isProtectedBranch: true }),
      ).toBe(false)
    })
  })

  describe('combined scenarios', () => {
    it('allows creator who is also in ACL', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'user-1',
          access: { allowedUsers: ['user-1', 'user-2'] },
        },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(true)
    })

    it('denies user who lacks both creator and ACL access', () => {
      const context: BranchContext = {
        ...baseContext,
        branch: {
          ...baseContext.branch,
          createdBy: 'user-2',
          access: { allowedUsers: ['user-3'] },
        },
      }
      expect(canPerformWorkflowAction(context, regularUser, 'deny')).toBe(false)
    })
  })
})
