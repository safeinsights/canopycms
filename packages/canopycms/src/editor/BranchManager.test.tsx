import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BranchManager, getBranchPermissions } from './BranchManager'
import { HOLD_BADGE, SYNC_FAILED_IN_REVIEW_NOTE, syncFailedFallback } from './branch-status'
import type { BranchSummary } from './BranchManager'
import { CanopyCMSProvider } from './theme'
import { BranchesDrawer } from './components/BranchesDrawer'
import { RESERVED_GROUPS } from '../authorization'

const originalMatchMedia = window.matchMedia

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
  }

  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserver as typeof ResizeObserver
  }
})

afterAll(() => {
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderBranchManager = (props: React.ComponentProps<typeof BranchManager>) => {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <CanopyCMSProvider>
        <BranchManager {...props} />
      </CanopyCMSProvider>
    </SWRConfig>,
  )
}

describe('getBranchPermissions', () => {
  it('returns all false when no user provided', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'editing',
      createdBy: 'user1',
    }
    const perms = getBranchPermissions(branch, undefined)
    expect(perms.hasWorkflowAccess).toBe(false)
    expect(perms.canSubmit).toBe(false)
    expect(perms.canWithdraw).toBe(false)
    expect(perms.canDelete).toBe(false)
    expect(perms.canRequestChanges).toBe(false)
  })

  it('grants workflow access to the creator, people given access, reviewers and admins only', () => {
    const branch: BranchSummary = {
      name: 'work',
      status: 'editing',
      createdBy: 'maker',
      access: { users: ['invited'], groups: ['team'] },
      submitBlocked: true,
    }
    const access = (userId: string, groups: string[] = []) =>
      getBranchPermissions(branch, { userId, groups }).hasWorkflowAccess

    expect(access('maker')).toBe(true)
    expect(access('invited')).toBe(true)
    expect(access('member', ['team'])).toBe(true)
    expect(access('rita', [RESERVED_GROUPS.REVIEWERS])).toBe(true)
    expect(access('root', [RESERVED_GROUPS.ADMINS])).toBe(true)
    expect(access('stranger')).toBe(false)
    // Access is separate from whether submitting is blocked right now.
    expect(getBranchPermissions(branch, { userId: 'maker', groups: [] }).canSubmit).toBe(false)
  })

  it('leaves workflow access on a locked-down branch to reviewers and admins alone', () => {
    const branch: BranchSummary = {
      name: 'work',
      status: 'submitted',
      createdBy: 'maker',
      access: { users: ['maker', 'invited'], groups: ['team'], managerOrAdminAllowed: true },
      submitBlocked: true,
    }
    const perms = (userId: string, groups: string[] = []) =>
      getBranchPermissions(branch, { userId, groups })

    expect(perms('maker').hasWorkflowAccess).toBe(false)
    expect(perms('invited').hasWorkflowAccess).toBe(false)
    expect(perms('member', ['team']).canWithdraw).toBe(false)
    expect(perms('rita', [RESERVED_GROUPS.REVIEWERS]).canWithdraw).toBe(true)
    expect(perms('root', [RESERVED_GROUPS.ADMINS]).canWithdraw).toBe(true)
  })

  it('allows creator to submit editing branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'editing',
      createdBy: 'user1',
      // Explicit, because canSubmit now consumes this flag and defaults a
      // MISSING one to blocked -- see the fail-closed test below.
      submitBlocked: false,
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canSubmit).toBe(true)
  })

  it('blocks submit when submitBlocked is absent entirely (fail closed)', () => {
    // The field is optional on BranchSummary, so "the server never told us"
    // is representable -- and it must read as BLOCKED. This branch would have
    // passed the old `status === 'editing' && !isProtected` derivation, and a
    // bare `!branch.submitBlocked` here would let it through too: undefined is
    // falsy. That is the same fail-open shape this change set removes one
    // layer up in useBranchManager, and this test is what stops it coming
    // back at this layer.
    const branch: BranchSummary = {
      name: 'main',
      status: 'editing',
      createdBy: 'user1',
      isProtected: false,
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canSubmit).toBe(false)
  })

  it('allows creator to withdraw submitted branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'user1',
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canWithdraw).toBe(true)
  })

  it('allows creator to withdraw an approved branch', () => {
    // Withdraw is the author's way back from 'approved': the editor offers an
    // author no Request changes, and the submit status gate refuses a
    // non-editing branch.
    const branch: BranchSummary = {
      name: 'main',
      status: 'approved',
      createdBy: 'user1',
      // canSubmit now consumes this server-computed flag directly rather than
      // re-deriving `status === 'editing'` -- a real BranchSummary would carry
      // submitBlocked: true here (status is 'approved', not 'editing').
      submitBlocked: true,
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canWithdraw).toBe(true)
    expect(perms.canSubmit).toBe(false)
  })

  it('offers no withdraw on an archived branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'archived',
      createdBy: 'user1',
      submitBlocked: true,
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canWithdraw).toBe(false)
    expect(perms.canSubmit).toBe(false)
  })

  it('allows admin to delete any branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'editing',
      createdBy: 'other',
    }
    const perms = getBranchPermissions(branch, {
      userId: 'admin',
      groups: [RESERVED_GROUPS.ADMINS],
    })
    expect(perms.canDelete).toBe(true)
  })

  it('blocks delete for submitted branches', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'user1',
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canDelete).toBe(false)
  })

  // CF1/A7: a reviewer has already approved this branch's PR, which is
  // awaiting merge. Deleting it would leave that PR dangling with no
  // signal back to the reviewer -- must be blocked exactly like 'submitted',
  // even for the branch creator (who need not be the reviewer who approved).
  it('blocks delete for approved branches, even for the creator', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'approved',
      createdBy: 'user1',
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canDelete).toBe(false)
  })

  it('blocks delete for approved branches, even for an admin', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'approved',
      createdBy: 'other',
    }
    const perms = getBranchPermissions(branch, {
      userId: 'admin',
      groups: [RESERVED_GROUPS.ADMINS],
    })
    expect(perms.canDelete).toBe(false)
  })

  it('allows reviewer to request changes on submitted branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'other',
    }
    const perms = getBranchPermissions(branch, {
      userId: 'reviewer',
      groups: [RESERVED_GROUPS.REVIEWERS],
    })
    expect(perms.canRequestChanges).toBe(true)
  })

  it('allows withdraw when the PR was closed without merging (recovery path)', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'user1',
      pullRequestState: 'closed',
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canWithdraw).toBe(true)
  })

  it('blocks request changes when the PR was closed without merging', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'other',
      pullRequestState: 'closed',
    }
    const perms = getBranchPermissions(branch, {
      userId: 'reviewer',
      groups: [RESERVED_GROUPS.REVIEWERS],
    })
    expect(perms.canRequestChanges).toBe(false)
  })

  it('offers neither Approve nor Request changes on the protected base branch', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'other',
      isProtected: true,
    }
    const perms = getBranchPermissions(branch, {
      userId: 'reviewer',
      groups: [RESERVED_GROUPS.REVIEWERS],
    })
    expect(perms.canApprove).toBe(false)
    expect(perms.canRequestChanges).toBe(false)
    expect(perms.canWithdraw).toBe(true)
  })

  it('lets a reviewer other than the creator approve a submitted branch, not their own', () => {
    const branch: BranchSummary = { name: 'x', status: 'submitted', createdBy: 'other' }
    const reviewer = { userId: 'reviewer', groups: [RESERVED_GROUPS.REVIEWERS] }
    expect(getBranchPermissions(branch, reviewer).canApprove).toBe(true)
    expect(getBranchPermissions({ ...branch, createdBy: 'reviewer' }, reviewer).canApprove).toBe(
      false,
    )
    expect(getBranchPermissions({ ...branch, status: 'approved' }, reviewer).canApprove).toBe(false)
  })

  it('allows withdraw when pullRequestState is undefined (never polled)', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'user1',
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canWithdraw).toBe(true)
  })

  it('allows withdraw when pullRequestState is open', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'user1',
      pullRequestState: 'open',
    }
    const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
    expect(perms.canWithdraw).toBe(true)
  })

  it('allows request changes when pullRequestState is open', () => {
    const branch: BranchSummary = {
      name: 'main',
      status: 'submitted',
      createdBy: 'other',
      pullRequestState: 'open',
    }
    const perms = getBranchPermissions(branch, {
      userId: 'reviewer',
      groups: [RESERVED_GROUPS.REVIEWERS],
    })
    expect(perms.canRequestChanges).toBe(true)
  })

  describe('canSubmit consumes submitBlocked, not a local re-derivation', () => {
    it('blocks submit when submitBlocked is true even though status/isProtected would have allowed it under the old derivation', () => {
      // The pre-Change-2 formula was `status === 'editing' && !isProtected`.
      // Both of those would say "allow" here (editing, unprotected) -- only
      // the server-computed submitBlocked flag says otherwise. If canSubmit
      // ever regresses to re-deriving from status/isProtected instead of
      // consuming this flag, this is the test that catches it.
      const branch: BranchSummary = {
        name: 'main',
        status: 'editing',
        createdBy: 'user1',
        isProtected: false,
        submitBlocked: true,
      }
      const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
      expect(perms.canSubmit).toBe(false)
    })

    it('allows submit when submitBlocked is false, mirroring an editing unprotected branch', () => {
      const branch: BranchSummary = {
        name: 'main',
        status: 'editing',
        createdBy: 'user1',
        isProtected: false,
        submitBlocked: false,
      }
      const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
      expect(perms.canSubmit).toBe(true)
    })
  })

  describe('protected base branch', () => {
    it('blocks submit even for the creator', () => {
      const branch: BranchSummary = {
        name: 'main',
        status: 'editing',
        createdBy: 'user1',
        isProtected: true,
        // canSubmit reads submitBlocked directly now, not isProtected -- the
        // server sets both together for the base branch (protected-branch.ts),
        // so a real BranchSummary always carries this alongside isProtected.
        submitBlocked: true,
      }
      const perms = getBranchPermissions(branch, { userId: 'user1', groups: [] })
      expect(perms.canSubmit).toBe(false)
    })

    it('blocks delete even for an admin', () => {
      const branch: BranchSummary = {
        name: 'main',
        status: 'editing',
        createdBy: 'user1',
        isProtected: true,
      }
      const perms = getBranchPermissions(branch, {
        userId: 'admin',
        groups: [RESERVED_GROUPS.ADMINS],
      })
      expect(perms.canDelete).toBe(false)
    })

    it('disables the system-branch grant, denying withdraw for a general-access user', () => {
      const branch: BranchSummary = {
        name: 'main',
        status: 'submitted',
        createdBy: 'canopycms-system',
        isProtected: true,
      }
      const perms = getBranchPermissions(branch, { userId: 'random-user', groups: [] })
      expect(perms.canWithdraw).toBe(false)
    })

    it('still allows an admin to withdraw (recovery path)', () => {
      const branch: BranchSummary = {
        name: 'main',
        status: 'submitted',
        createdBy: 'canopycms-system',
        isProtected: true,
      }
      const perms = getBranchPermissions(branch, {
        userId: 'admin',
        groups: [RESERVED_GROUPS.ADMINS],
      })
      expect(perms.canWithdraw).toBe(true)
    })
  })
})

describe('BranchManager', () => {
  // Admin user can do everything
  const adminUser = { userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] }
  // Creator user for testing branch operations
  const creatorUser = { userId: 'user1', groups: [] }
  // Reviews a branch somebody else made
  const reviewerUser = { userId: 'reviewer', groups: [RESERVED_GROUPS.REVIEWERS] }

  const baseBranches: BranchSummary[] = [
    {
      name: 'main',
      status: 'editing',
      createdBy: 'user1',
      updatedAt: '2024-01-01',
      access: { users: ['user1'] },
      // What the server sends for an editing, unprotected branch. Explicit
      // because a missing value now fails closed (see getBranchPermissions).
      submitBlocked: false,
    },
    {
      name: 'feature/test',
      status: 'submitted',
      createdBy: 'user1',
      updatedAt: '2024-01-02',
      access: { users: ['user1'] },
      pullRequestUrl: 'https://github.com/owner/repo/pull/1',
      pullRequestNumber: 1,
      commentCount: 3,
    },
  ]

  const openMenu = async (name: string) => {
    await userEvent.click(screen.getByTestId(`branch-actions-menu-${name}`))
    await screen.findByRole('menu')
  }
  // A blocked item is aria-disabled, not `disabled`: Mantine's Menu skips those in arrow-key order.
  const menuItemBlocked = (testId: string) =>
    screen.getByTestId(testId).getAttribute('aria-disabled') === 'true'

  it('renders branch list', () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })
    expect(screen.getByText('main')).toBeDefined()
    expect(screen.getByText('feature/test')).toBeDefined()
  })

  it('shows the pull request badge', () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })
    expect(screen.getByText(/PR #1/)).toBeDefined()
  })

  it('shows comment count badge when present', () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })
    expect(screen.getByText(/3 comments/)).toBeDefined()
  })

  it('shows closed styling on the PR badge when pullRequestState is closed', () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[1],
        pullRequestState: 'closed',
      },
    ]
    renderBranchManager({ branches, mode: 'prod' })
    expect(screen.getByText(/PR #1 \(closed\)/)).toBeDefined()
  })

  it('does not append (closed) to the PR badge when pullRequestState is open', () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[1],
        pullRequestState: 'open',
      },
    ]
    renderBranchManager({ branches, mode: 'prod' })
    expect(screen.getByText('PR #1')).toBeDefined()
  })

  it('shows a Merged badge for archived branches with mergedAt', () => {
    const branches: BranchSummary[] = [
      {
        name: 'feature/done',
        status: 'archived',
        createdBy: 'user1',
        mergedAt: '2024-02-01T00:00:00.000Z',
      },
    ]
    renderBranchManager({ branches, mode: 'prod' })
    expect(screen.getByText('Merged')).toBeDefined()
  })

  it('does not show a Merged badge for archived branches without mergedAt', () => {
    const branches: BranchSummary[] = [
      {
        name: 'feature/manually-archived',
        status: 'archived',
        createdBy: 'user1',
      },
    ]
    renderBranchManager({ branches, mode: 'prod' })
    expect(screen.queryByText('Merged')).toBeNull()
  })

  it('does not show a Merged badge for non-archived branches with mergedAt', () => {
    const branches: BranchSummary[] = [
      {
        name: 'feature/weird',
        status: 'submitted',
        createdBy: 'user1',
        mergedAt: '2024-02-01T00:00:00.000Z',
      },
    ]
    renderBranchManager({ branches, mode: 'prod' })
    expect(screen.queryByText('Merged')).toBeNull()
  })

  it('shows a red Sync failed badge with a line pointing to System health', async () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[0],
        syncStatus: 'sync-failed',
      },
    ]
    // Non-admin user context -- sync badges are visible to all users, not gated by role.
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })
    const badge = screen.getByTestId('sync-failed-badge-main')
    expect(badge.textContent).toBe('Sync failed')
    expect(badge.style.getPropertyValue('--badge-bg')).toBe('var(--mantine-color-red-light)')
    expect(screen.getByTestId('sync-failed-reason-main').textContent).toBe(
      syncFailedFallback({ isAdmin: false, held: false }),
    )
  })

  it('shows the recorded failure reason on the row instead of the generic line', async () => {
    const reason = 'Push rejected for branch "main": it has moved on GitHub.'
    const branches: BranchSummary[] = [
      { ...baseBranches[0], syncStatus: 'sync-failed', syncFailureReason: reason },
    ]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })

    expect(screen.getByTestId('sync-failed-reason-main').textContent).toBe(reason)
    expect(screen.queryByText(/System health/)).toBeNull()
  })

  describe('a branch held on something a person must do', () => {
    const held = (hold: BranchSummary['hold'], extra: Partial<BranchSummary> = {}) => {
      renderBranchManager({
        branches: [{ ...baseBranches[0], status: 'submitted', hold, ...extra }],
        user: creatorUser,
        mode: 'prod',
      })
      return screen.getByTestId('branch-hold-main').textContent
    }

    it('gives its author the way forward on a conflict', () => {
      expect(held({ kind: 'conflicts' })).toContain('Use "Withdraw from review"')
      expect(screen.getByTestId('held-badge-main').textContent).toBe(HOLD_BADGE.label)
    })

    it('names the base a retargeted pull request now has, and links to it', () => {
      const line = held(
        { kind: 'retargeted', base: 'release/2026' },
        { pullRequestUrl: 'https://github.com/owner/repo/pull/1' },
      )
      expect(line).toContain('release/2026')
      expect(screen.getByRole('link', { name: 'View pull request' })).toBeTruthy()
    })

    it('tells an editor a rewritten branch needs an admin', () => {
      expect(held({ kind: 'rewritten' }, { status: 'editing' })).toContain('Ask an admin')
    })

    it('says nothing for a branch nothing holds', () => {
      renderBranchManager({ branches: baseBranches, user: creatorUser, mode: 'prod' })
      expect(screen.queryByTestId('branch-hold-main')).toBeNull()
      expect(screen.queryByTestId('held-badge-main')).toBeNull()
    })

    it('gives a rewrite one line: its failed sync is the same problem', () => {
      held(
        { kind: 'rewritten' },
        { syncStatus: 'sync-failed', syncFailureReason: 'Nothing was pushed.' },
      )
      expect(screen.queryByTestId('sync-failed-reason-main')).toBeNull()
      expect(screen.getByTestId('sync-failed-badge-main')).toBeTruthy()
    })

    it('leaves a sync failure with no reason to the fact, beside a hold', () => {
      held({ kind: 'conflicts' }, { syncStatus: 'sync-failed', pullRequestNumber: 1 })
      expect(screen.getByTestId('sync-failed-reason-main').textContent).toBe('GitHub sync failed.')
    })

    it('keeps a long unbroken name inside the card', () => {
      held({ kind: 'conflicts' })
      const title = screen.getByText('main')
      expect(title.style.overflowWrap).toBe('anywhere')
    })

    const rewritten: BranchSummary = {
      ...baseBranches[0],
      hold: { kind: 'rewritten' },
      submitBlocked: true,
    }
    const openRewritten = (user: typeof adminUser | typeof creatorUser) =>
      renderBranchManager({ branches: [rewritten], currentBranchName: 'main', user, mode: 'prod' })

    it('moves the workflow action below a hold, which it would squeeze beside the title', () => {
      openRewritten(creatorUser)
      const row = screen.getByTestId('branch-action-row-main')
      expect(within(row).getByTestId('submit-branch-button-main')).toBeTruthy()
    })

    it('points an admin at System health for a blocked submit, and anyone else at an admin', async () => {
      openRewritten(adminUser)
      await userEvent.hover(screen.getByTestId('submit-branch-button-main'))
      expect(await screen.findByText(/until the changes made to it on GitHub/)).toBeTruthy()
      cleanup()

      openRewritten(creatorUser)
      await userEvent.hover(screen.getByTestId('submit-branch-button-main'))
      expect(await screen.findByText(/until an admin sorts out/)).toBeTruthy()
    })

    it('keeps a hold and a separate sync failure to one instruction', () => {
      held(
        { kind: 'conflicts' },
        { syncStatus: 'sync-failed', syncFailureReason: 'Push rejected.', pullRequestNumber: 1 },
      )
      expect(screen.getByTestId('sync-failed-reason-main').textContent).toBe('Push rejected.')
    })
  })

  it('says a failed sync keeps a branch in review from updating, with the way forward', () => {
    const branches: BranchSummary[] = [
      { ...baseBranches[0], status: 'approved', syncStatus: 'sync-failed', pullRequestNumber: 1 },
    ]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })

    expect(screen.getByTestId('sync-failed-reason-main').textContent).toBe(
      `${syncFailedFallback({ isAdmin: false, held: false })} ${SYNC_FAILED_IN_REVIEW_NOTE} Withdraw the branch from review to make changes.`,
    )
  })

  it('names no pull request when a first submit never made one', () => {
    const branches: BranchSummary[] = [
      { ...baseBranches[0], status: 'approved', syncStatus: 'sync-failed' },
    ]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })

    expect(screen.getByTestId('sync-failed-reason-main').textContent).toBe(
      `${syncFailedFallback({ isAdmin: false, held: false })} Withdraw the branch from review to make changes.`,
    )
  })

  it('tells the author to withdraw when the failed branch is still submitted', () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[0],
        status: 'submitted',
        syncStatus: 'sync-failed',
        syncFailureReason: 'Push rejected.',
        pullRequestNumber: 1,
      },
    ]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })

    expect(screen.getByTestId('sync-failed-reason-main').textContent).toBe(
      `Push rejected. ${SYNC_FAILED_IN_REVIEW_NOTE} Withdraw the branch from review to make changes.`,
    )
  })

  it('treats a reviewer the branch was shared with as its editor, as the bar does', () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[0],
        status: 'submitted',
        access: { users: ['reviewer'] },
        hold: { kind: 'conflicts' },
      },
    ]
    renderBranchManager({ branches, user: reviewerUser, mode: 'prod' })

    expect(screen.getByTestId('branch-hold-main').textContent).toContain(
      'Use "Withdraw from review"',
    )
  })

  it('ends a recorded reason before the sentence after it', () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[0],
        status: 'approved',
        syncStatus: 'sync-failed',
        syncFailureReason: 'It has moved on GitHub',
        pullRequestNumber: 1,
      },
    ]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })

    expect(screen.getByTestId('sync-failed-reason-main').textContent).toContain(
      `It has moved on GitHub. ${SYNC_FAILED_IN_REVIEW_NOTE}`,
    )
  })

  it('tells only someone who may withdraw to, on a failed branch in review', () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[0],
        status: 'submitted',
        syncStatus: 'sync-failed',
        syncFailureReason: 'Push rejected.',
        pullRequestNumber: 1,
      },
    ]
    renderBranchManager({ branches, user: reviewerUser, mode: 'prod' })

    expect(screen.getByTestId('sync-failed-reason-main').textContent).not.toContain('Withdraw')
  })

  it('shows a gray Syncing badge with a tooltip when sync is pending', async () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[0],
        syncStatus: 'pending-sync',
      },
    ]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })
    const badge = screen.getByTestId('pending-sync-badge-main')
    expect(badge.textContent).toBe('Syncing…')
    expect(badge.style.getPropertyValue('--badge-bg')).toBe('var(--mantine-color-gray-light)')

    await userEvent.hover(badge)
    expect(await screen.findByText('Changes are on their way to GitHub.')).toBeDefined()
  })

  it('shows an orange Conflicts badge with the conflict count and a tooltip', async () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[0],
        conflictStatus: 'conflicts-detected',
        conflictFiles: ['content/a.md', 'content/b.md'],
      },
    ]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })
    const badge = screen.getByTestId('conflicts-badge-main')
    expect(badge.textContent).toBe('Conflicts (2)')
    expect(badge.style.getPropertyValue('--badge-bg')).toBe('var(--mantine-color-orange-light)')

    // The detail is there for keyboard and screen reader users, as well as on hover.
    const trigger = badge.closest('[tabindex="0"]')
    expect(trigger).not.toBeNull()
    expect(
      document.getElementById(trigger?.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toMatch(/Review the flagged entries/)
  })

  it('omits the count from the Conflicts badge when conflictFiles is empty or absent', () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[0],
        conflictStatus: 'conflicts-detected',
      },
    ]
    renderBranchManager({ branches, mode: 'prod' })
    expect(screen.getByTestId('conflicts-badge-main').textContent).toBe('Conflicts')
  })

  it('shows no sync/conflict badges for a synced, conflict-free branch', () => {
    const branches: BranchSummary[] = [
      {
        ...baseBranches[0],
        syncStatus: 'synced',
        conflictStatus: 'clean',
      },
    ]
    renderBranchManager({ branches, mode: 'prod' })
    expect(screen.queryByTestId('sync-failed-badge-main')).toBeNull()
    expect(screen.queryByTestId('pending-sync-badge-main')).toBeNull()
    expect(screen.queryByTestId('conflicts-badge-main')).toBeNull()
  })

  it('shows no sync/conflict badges when the fields are undefined', () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })
    expect(screen.queryByTestId('sync-failed-badge-main')).toBeNull()
    expect(screen.queryByTestId('pending-sync-badge-main')).toBeNull()
    expect(screen.queryByTestId('conflicts-badge-main')).toBeNull()
  })

  it('keeps Withdraw enabled when the submitted branch PR was closed without merging', async () => {
    const branches: BranchSummary[] = [{ ...baseBranches[1], pullRequestState: 'closed' }]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })
    await openMenu('feature/test')
    expect(menuItemBlocked('withdraw-branch-button-feature/test')).toBe(false)
  })

  it('disables Request changes, saying why, when the submitted branch PR was closed without merging', async () => {
    const branches: BranchSummary[] = [{ ...baseBranches[1], pullRequestState: 'closed' }]
    renderBranchManager({ branches, user: adminUser, mode: 'prod' })
    await openMenu('feature/test')
    expect(menuItemBlocked('request-changes-branch-button-feature/test')).toBe(true)
    expect(menuItemBlocked('approve-branch-button-feature/test')).toBe(true)
    // The reason prints once, under Approve, which comes first.
    const reason =
      'The pull request was closed on GitHub. Use "Withdraw from review", then submit it again to open a new one.'
    expect(
      within(screen.getByTestId('approve-branch-button-feature/test')).getByText(reason),
    ).toBeTruthy()
    expect(screen.getAllByText(reason)).toHaveLength(1)
  })

  it('keeps Withdraw enabled when pullRequestState is undefined', async () => {
    renderBranchManager({ branches: baseBranches, user: creatorUser, mode: 'prod' })
    await openMenu('feature/test')
    expect(menuItemBlocked('withdraw-branch-button-feature/test')).toBe(false)
  })

  it('keeps Request changes enabled when pullRequestState is open', async () => {
    const branches: BranchSummary[] = [{ ...baseBranches[1], pullRequestState: 'open' }]
    renderBranchManager({ branches, user: adminUser, mode: 'prod' })
    await openMenu('feature/test')
    expect(menuItemBlocked('request-changes-branch-button-feature/test')).toBe(false)
  })

  it('calls onSubmit when Submit for review is chosen from the menu of another branch', async () => {
    const onSubmit = vi.fn()
    renderBranchManager({ branches: baseBranches, onSubmit, user: creatorUser, mode: 'prod' })

    await openMenu('main')
    await userEvent.click(screen.getByTestId('submit-branch-button-main'))

    expect(onSubmit).toHaveBeenCalledWith('main')
  })

  it('calls onWithdraw when Withdraw from review is chosen from the menu of another branch', async () => {
    const onWithdraw = vi.fn()
    renderBranchManager({ branches: baseBranches, onWithdraw, user: creatorUser, mode: 'prod' })

    await openMenu('feature/test')
    await userEvent.click(screen.getByTestId('withdraw-branch-button-feature/test'))

    expect(onWithdraw).toHaveBeenCalledWith('feature/test')
  })

  it('shows create branch form when Create button clicked', async () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })

    const createButton = screen.getByRole('button', { name: 'New branch…' })
    await userEvent.click(createButton)

    await waitFor(() => {
      expect(screen.getByLabelText(/branch name/i)).toBeDefined()
    })
  })

  it('calls onCreate with branch details when form submitted', async () => {
    const onCreate = vi.fn()
    renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })

    // Open form
    const createButton = screen.getByRole('button', { name: 'New branch…' })
    await userEvent.click(createButton)

    // Fill form
    const nameInput = await screen.findByLabelText(/branch name/i)
    const titleInput = await screen.findByLabelText(/title/i)
    const descriptionInput = await screen.findByLabelText(/description/i)

    await userEvent.type(nameInput, 'feature/new-feature')
    await userEvent.type(titleInput, 'New Feature')
    await userEvent.type(descriptionInput, 'A great new feature')

    // Submit form
    const submitButton = screen.getByRole('button', {
      name: /^create branch$/i,
    })
    await userEvent.click(submitButton)

    expect(onCreate).toHaveBeenCalledWith({
      name: 'feature/new-feature',
      title: 'New Feature',
      description: 'A great new feature',
    })
  })

  describe('create form while the create is in flight', () => {
    const openAndFill = async (name: string) => {
      await userEvent.click(screen.getByRole('button', { name: 'New branch…' }))
      await userEvent.type(await screen.findByLabelText(/branch name/i), name)
      await userEvent.type(await screen.findByLabelText(/title/i), 'A title')
      await userEvent.type(await screen.findByLabelText(/description/i), 'A description')
    }

    const deferred = () => {
      let resolve: (created: boolean) => void = () => {}
      const promise = new Promise<boolean>((res) => {
        resolve = res
      })
      return { promise, resolve }
    }

    it('shows the submit button as loading and disables the inputs and toggle until the create settles', async () => {
      const pending = deferred()
      const onCreate = vi.fn(() => pending.promise)
      renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })
      await openAndFill('feature/slow')

      const submitButton = screen.getByTestId('create-branch-submit')
      expect(submitButton.getAttribute('data-loading')).toBeNull()

      await userEvent.click(submitButton)

      expect(submitButton.getAttribute('data-loading')).toBe('true')
      expect(submitButton.hasAttribute('disabled')).toBe(true)
      expect(screen.getByTestId('branch-name-input').hasAttribute('disabled')).toBe(true)
      expect(screen.getByTestId('branch-title-input').hasAttribute('disabled')).toBe(true)
      expect(screen.getByTestId('branch-description-textarea').hasAttribute('disabled')).toBe(true)
      expect(screen.getByTestId('create-branch-button').hasAttribute('disabled')).toBe(true)

      await act(async () => {
        pending.resolve(true)
      })

      await waitFor(() => {
        expect(screen.getByTestId('branch-name-input').hasAttribute('disabled')).toBe(false)
      })
      expect(screen.getByTestId('create-branch-button').hasAttribute('disabled')).toBe(false)
    })

    it('calls onCreate once when submit is clicked twice in the same tick', async () => {
      const pending = deferred()
      const onCreate = vi.fn(() => pending.promise)
      renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })
      await openAndFill('feature/slow')

      const submitButton = screen.getByTestId('create-branch-submit')
      act(() => {
        fireEvent.click(submitButton)
        fireEvent.click(submitButton)
      })
      await userEvent.click(submitButton)

      expect(onCreate).toHaveBeenCalledTimes(1)

      await act(async () => {
        pending.resolve(true)
      })
    })

    it('opens on the new-branch form, its name field marked to take focus, when asked to', () => {
      renderBranchManager({ branches: baseBranches, mode: 'prod', startCreating: true })
      expect(screen.getByTestId('create-branch-button').textContent).toBe('Cancel')
      expect(screen.getByTestId('branch-name-input').hasAttribute('data-autofocus')).toBe(true)
    })

    it('opens with the new-branch form closed by default', () => {
      renderBranchManager({ branches: baseBranches, mode: 'prod' })
      expect(screen.getByTestId('create-branch-button').textContent).toBe('New branch…')
      expect(screen.getByTestId('branch-name-input').hasAttribute('data-autofocus')).toBe(false)
    })

    it('resets and closes the form when the create resolves true', async () => {
      const pending = deferred()
      const onCreate = vi.fn(() => pending.promise)
      renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })
      await openAndFill('feature/ok')
      expect(screen.getByTestId('create-branch-button').textContent).toBe('Cancel')

      await userEvent.click(screen.getByTestId('create-branch-submit'))
      // Still open while in flight.
      expect(screen.getByTestId('create-branch-button').textContent).toBe('Cancel')

      await act(async () => {
        pending.resolve(true)
      })

      await waitFor(() => {
        expect(screen.getByTestId('create-branch-button').textContent).toBe('New branch…')
      })
      expect((screen.getByTestId('branch-name-input') as HTMLInputElement).value).toBe('')
      expect((screen.getByTestId('branch-title-input') as HTMLInputElement).value).toBe('')
      expect((screen.getByTestId('branch-description-textarea') as HTMLTextAreaElement).value).toBe(
        '',
      )
    })

    it('shows below the field the short name a typed name creates, and no prefix', async () => {
      renderBranchManager({
        branches: baseBranches,
        onCreate: vi.fn(async () => true),
        mode: 'prod',
      })
      await userEvent.click(screen.getByRole('button', { name: 'New branch…' }))
      const input = await screen.findByLabelText(/branch name/i)

      expect(screen.queryByText(/canopycms-/)).toBeNull()

      await userEvent.type(input, 'spring/update')
      const preview = screen.getByText('Will be named spring-update')
      expect(input.getAttribute('aria-describedby')).toContain(preview.id)
      // After the input, so a preview that wraps never moves the field being typed in.
      expect(input.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(screen.getByTestId('create-branch-submit').hasAttribute('disabled')).toBe(false)
    })

    it('says nothing of a name when sanitizing left what was typed as it was', async () => {
      renderBranchManager({
        branches: baseBranches,
        onCreate: vi.fn(async () => true),
        mode: 'prod',
      })
      await userEvent.click(screen.getByRole('button', { name: 'New branch…' }))
      const input = await screen.findByLabelText(/branch name/i)

      await userEvent.type(input, 'spring-update')
      expect(screen.queryByText(/^Will be named/)).toBeNull()

      await userEvent.clear(input)
      await userEvent.type(input, '@spring')
      expect(screen.getByText('Will be named spring')).toBeTruthy()
    })

    it("shows the server's refusal under the field, keeping the form as typed, until the name changes", async () => {
      const refusal = '"spring" is already the name of another branch. Choose a different name.'
      const onCreate = vi.fn(async () => ({ refusal }))
      renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })
      await userEvent.click(screen.getByRole('button', { name: 'New branch…' }))
      const input = (await screen.findByLabelText(/branch name/i)) as HTMLInputElement
      await userEvent.type(input, 'spring')

      await userEvent.click(screen.getByTestId('create-branch-submit'))

      expect(await screen.findByText(refusal)).toBeTruthy()
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(input.value).toBe('spring')
      // On the field, whose description the error is, so a screen reader reads why.
      await waitFor(() => expect(document.activeElement).toBe(input))

      await userEvent.type(input, '2')
      expect(screen.queryByText(refusal)).toBeNull()
    })

    it('shows a refusal without the name it would have taken', async () => {
      const refusal = '"spring" is already the name of another branch. Choose a different name.'
      renderBranchManager({
        branches: baseBranches,
        onCreate: vi.fn(async () => ({ refusal })),
        mode: 'prod',
      })
      await userEvent.click(screen.getByRole('button', { name: 'New branch…' }))
      const input = await screen.findByLabelText(/branch name/i)
      await userEvent.type(input, '@spring')
      expect(screen.getByText('Will be named spring')).toBeTruthy()

      await userEvent.click(screen.getByTestId('create-branch-submit'))

      expect(await screen.findByText(refusal)).toBeTruthy()
      expect(screen.queryByText('Will be named spring')).toBeNull()
    })

    it.each([
      ['Cancel', async () => userEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
      [
        'a create that then passes',
        async () => {
          await userEvent.click(screen.getByTestId('create-branch-submit'))
          await waitFor(() =>
            expect(screen.getByRole('button', { name: 'New branch…' })).toBeTruthy(),
          )
        },
      ],
    ])('forgets a refusal after %s', async (_after, leave) => {
      const refusal = '"spring" is already the name of another branch. Choose a different name.'
      const onCreate = vi
        .fn<() => Promise<boolean | { refusal: string }>>()
        .mockResolvedValueOnce({ refusal })
        .mockResolvedValue(true)
      renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })
      await userEvent.click(screen.getByRole('button', { name: 'New branch…' }))
      const input = (await screen.findByLabelText(/branch name/i)) as HTMLInputElement
      await userEvent.type(input, 'spring')
      await userEvent.click(screen.getByTestId('create-branch-submit'))
      expect(await screen.findByText(refusal)).toBeTruthy()

      await leave()
      await userEvent.click(screen.getByRole('button', { name: 'New branch…' }))
      if (!input.value) await userEvent.type(input, 'spring')

      expect(input.value).toBe('spring')
      expect(screen.queryByText(refusal)).toBeNull()
    })

    it.each([
      ['spring update', /cannot contain spaces/],
      ['a..b', /cannot contain "\.\."/],
      ['a'.repeat(251), /too long \(max 250 characters\)/],
      ['_', /needs at least one letter \(a–z\) or digit/],
    ])('says why %s cannot be created, and offers no create', async (typed, why) => {
      const onCreate = vi.fn(async () => true)
      renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })
      await userEvent.click(screen.getByRole('button', { name: 'New branch…' }))
      const input = await screen.findByLabelText(/branch name/i)

      await userEvent.click(input)
      await userEvent.paste(typed)

      expect(screen.getByText(why)).toBeTruthy()
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(screen.queryByText(/^Will be named/)).toBeNull()
      expect(screen.getByTestId('create-branch-submit').hasAttribute('disabled')).toBe(true)
      expect(onCreate).not.toHaveBeenCalled()
    })

    it('keeps the form open with the entered values when the create resolves false', async () => {
      const pending = deferred()
      const onCreate = vi.fn(() => pending.promise)
      renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })
      await openAndFill('feature/nope')

      await userEvent.click(screen.getByTestId('create-branch-submit'))
      await act(async () => {
        pending.resolve(false)
      })

      await waitFor(() => {
        expect(screen.getByTestId('branch-name-input').hasAttribute('disabled')).toBe(false)
      })
      expect(screen.getByTestId('create-branch-button').textContent).toBe('Cancel')
      expect((screen.getByTestId('branch-name-input') as HTMLInputElement).value).toBe(
        'feature/nope',
      )
      expect((screen.getByTestId('branch-title-input') as HTMLInputElement).value).toBe('A title')
      expect((screen.getByTestId('branch-description-textarea') as HTMLTextAreaElement).value).toBe(
        'A description',
      )
      expect(screen.getByTestId('create-branch-submit').getAttribute('data-loading')).toBeNull()
    })

    it('does not show the create as in flight while onBeforeCreate is pending', async () => {
      const gate = deferred()
      const onBeforeCreate = vi.fn(() => gate.promise)
      const onCreate = vi.fn(async () => true)
      renderBranchManager({ branches: baseBranches, onBeforeCreate, onCreate, mode: 'prod' })
      await openAndFill('feature/gated')

      const submitButton = screen.getByTestId('create-branch-submit')
      await userEvent.click(submitButton)

      expect(onBeforeCreate).toHaveBeenCalledTimes(1)
      expect(submitButton.getAttribute('data-loading')).toBeNull()
      expect(onCreate).not.toHaveBeenCalled()

      await act(async () => {
        gate.resolve(true)
      })

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledTimes(1)
      })
      expect(onCreate).toHaveBeenCalledWith({
        name: 'feature/gated',
        title: 'A title',
        description: 'A description',
      })
    })

    it('does not call onCreate, and keeps the form as entered, when onBeforeCreate resolves false', async () => {
      const onBeforeCreate = vi.fn(async () => false)
      const onCreate = vi.fn(async () => true)
      renderBranchManager({ branches: baseBranches, onBeforeCreate, onCreate, mode: 'prod' })
      await openAndFill('feature/declined')

      await userEvent.click(screen.getByTestId('create-branch-submit'))

      await waitFor(() => {
        expect(onBeforeCreate).toHaveBeenCalledTimes(1)
      })
      expect(onCreate).not.toHaveBeenCalled()
      expect(screen.getByTestId('create-branch-submit').getAttribute('data-loading')).toBeNull()
      expect(screen.getByTestId('create-branch-button').textContent).toBe('Cancel')
      expect((screen.getByTestId('branch-name-input') as HTMLInputElement).value).toBe(
        'feature/declined',
      )
    })

    it('ignores a second submit while onBeforeCreate is still pending', async () => {
      const gate = deferred()
      const onBeforeCreate = vi.fn(() => gate.promise)
      const onCreate = vi.fn(async () => true)
      renderBranchManager({ branches: baseBranches, onBeforeCreate, onCreate, mode: 'prod' })
      await openAndFill('feature/twice')

      const submitButton = screen.getByTestId('create-branch-submit')
      act(() => {
        fireEvent.click(submitButton)
        fireEvent.click(submitButton)
      })

      expect(onBeforeCreate).toHaveBeenCalledTimes(1)

      await act(async () => {
        gate.resolve(true)
      })
      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledTimes(1)
      })
    })

    it('treats a synchronous onCreate (no promise) as success', async () => {
      const onCreate = vi.fn()
      renderBranchManager({ branches: baseBranches, onCreate, mode: 'prod' })
      await openAndFill('feature/sync')

      await userEvent.click(screen.getByTestId('create-branch-submit'))

      await waitFor(() => {
        expect(screen.getByTestId('create-branch-button').textContent).toBe('New branch…')
      })
      expect((screen.getByTestId('branch-name-input') as HTMLInputElement).value).toBe('')
    })
  })

  it('disables create button when name is empty', async () => {
    renderBranchManager({
      branches: baseBranches,
      onCreate: vi.fn(),
      mode: 'prod',
    })

    // Open form
    const createButton = screen.getByRole('button', { name: 'New branch…' })
    await userEvent.click(createButton)

    // Submit button should be disabled with no name
    const submitButton = await screen.findByRole('button', {
      name: /^create branch$/i,
    })
    expect(submitButton.hasAttribute('disabled')).toBe(true)

    // Type name
    const nameInput = await screen.findByLabelText(/branch name/i)
    await userEvent.type(nameInput, 'test')

    // Submit button should be enabled
    await waitFor(() => {
      expect(submitButton.hasAttribute('disabled')).toBe(false)
    })
  })

  it('shows create form in dev mode (dev supports branching)', () => {
    renderBranchManager({ branches: baseBranches, mode: 'dev' })

    const createButton = screen.queryByRole('button', { name: 'New branch…' })
    expect(createButton).not.toBeNull()
  })

  it('calls onRequestChanges when Request changes is chosen from the menu', async () => {
    const onRequestChanges = vi.fn()
    renderBranchManager({
      branches: baseBranches,
      onRequestChanges,
      user: adminUser,
      mode: 'prod',
    })

    await openMenu('feature/test')
    await userEvent.click(screen.getByTestId('request-changes-branch-button-feature/test'))

    expect(onRequestChanges).toHaveBeenCalledWith('feature/test')
  })

  it('reads "Protected" in the status badge of the protected base branch', () => {
    const branches: BranchSummary[] = [{ ...baseBranches[0], isProtected: true }]
    renderBranchManager({ branches, mode: 'prod' })
    const badge = screen.getByTestId('branch-status-badge-main')
    expect(badge.textContent).toBe('Protected')
    expect(badge.hasAttribute('data-protected')).toBe(true)
    expect(badge.getAttribute('data-status')).toBe('editing')
    expect(screen.queryByText('Editing')).toBeNull()
    expect(screen.queryByTestId('branch-protected-badge-main')).toBeNull()
  })

  it('labels the status badge by presentation and exposes the raw status as data-status', () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })
    const badge = screen.getByTestId('branch-status-badge-feature/test')
    expect(baseBranches[1].status).toBe('submitted')
    expect(badge.textContent).toBe('In review')
    expect(badge.getAttribute('data-status')).toBe('submitted')
  })

  it('reads the workflow status, with no protected marker, for a non-protected branch', () => {
    renderBranchManager({ branches: baseBranches, mode: 'prod' })
    const badge = screen.getByTestId('branch-status-badge-main')
    expect(badge.textContent).toBe('Editing')
    expect(badge.hasAttribute('data-protected')).toBe(false)
  })

  it('leaves Open enabled on the protected branch', () => {
    const branches: BranchSummary[] = [{ ...baseBranches[0], isProtected: true }]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })
    const openButton = screen.getByTestId('switch-to-branch-button-main')
    expect(openButton.hasAttribute('disabled')).toBe(false)
  })

  it('calls onDelete when Delete branch is chosen from the menu', async () => {
    const onDelete = vi.fn()
    renderBranchManager({ branches: baseBranches, onDelete, user: creatorUser, mode: 'prod' })

    await openMenu('main')
    await userEvent.click(screen.getByTestId('delete-branch-button-main'))

    expect(onDelete).toHaveBeenCalledWith('main')
  })

  it('disables Delete for a branch in review, saying to withdraw it first', async () => {
    const branches: BranchSummary[] = [{ ...baseBranches[0], status: 'approved' }]
    renderBranchManager({ branches, user: creatorUser, mode: 'prod' })

    await openMenu('main')
    const item = screen.getByTestId('delete-branch-button-main')
    expect(menuItemBlocked('delete-branch-button-main')).toBe(true)
    expect(
      within(item).getByText(
        'This branch is in review. Withdraw it from review before deleting it.',
      ),
    ).toBeTruthy()
  })

  describe('current branch', () => {
    const cardNames = () =>
      screen
        .getAllByTestId(/^branch-list-item-/)
        .map((card) => card.getAttribute('data-testid')?.replace('branch-list-item-', ''))

    it('lists the current branch first, marked, and without Open', () => {
      renderBranchManager({
        branches: baseBranches,
        currentBranchName: 'feature/test',
        user: creatorUser,
        mode: 'prod',
      })

      expect(cardNames()).toEqual(['feature/test', 'main'])
      const card = screen.getByTestId('branch-list-item-feature/test')
      expect(card.getAttribute('aria-current')).toBe('true')
      expect(card.hasAttribute('data-current')).toBe(true)
      expect(screen.getByTestId('branch-current-badge-feature/test').textContent).toBe('Current')
      expect(screen.queryByTestId('switch-to-branch-button-feature/test')).toBeNull()

      const other = screen.getByTestId('branch-list-item-main')
      expect(other.hasAttribute('aria-current')).toBe(false)
      expect(screen.queryByTestId('branch-current-badge-main')).toBeNull()
      expect(screen.getByTestId('switch-to-branch-button-main').textContent).toBe('Open')
    })

    it('keeps the given order when no branch is current', () => {
      renderBranchManager({ branches: baseBranches, mode: 'prod' })

      expect(cardNames()).toEqual(['main', 'feature/test'])
      expect(screen.queryByTestId('branch-current-badge-main')).toBeNull()
      expect(screen.getByTestId('switch-to-branch-button-main')).toBeTruthy()
    })

    it('calls onSelect from Open on another branch', async () => {
      const onSelect = vi.fn()
      renderBranchManager({
        branches: baseBranches,
        currentBranchName: 'main',
        onSelect,
        mode: 'prod',
      })

      await userEvent.click(screen.getByTestId('switch-to-branch-button-feature/test'))

      expect(onSelect).toHaveBeenCalledWith('feature/test')
    })

    it('offers the current editing branch Submit for review as its primary action', async () => {
      const onSubmit = vi.fn()
      renderBranchManager({
        branches: baseBranches,
        currentBranchName: 'main',
        user: creatorUser,
        onSubmit,
        mode: 'prod',
      })

      const submit = screen.getByTestId('submit-branch-button-main')
      expect(submit.textContent).toBe('Submit for review')
      expect(submit.getAttribute('aria-disabled')).toBeNull()
      await userEvent.click(submit)
      expect(onSubmit).toHaveBeenCalledWith('main')

      // It lives on the card, not also in the menu.
      await openMenu('main')
      expect(screen.getAllByTestId('submit-branch-button-main')).toHaveLength(1)
    })

    it("holds the current branch's workflow action with the reason it's given", async () => {
      const onSubmit = vi.fn()
      renderBranchManager({
        branches: baseBranches,
        currentBranchName: 'main',
        currentWorkflowBlockedReason: 'Wait for Save all to finish.',
        user: creatorUser,
        onSubmit,
        mode: 'prod',
      })

      const submit = screen.getByTestId('submit-branch-button-main')
      expect(submit.getAttribute('aria-disabled')).toBe('true')
      await userEvent.click(submit)
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('offers the current branch in review Withdraw from review as its primary action', async () => {
      const onWithdraw = vi.fn()
      renderBranchManager({
        branches: baseBranches,
        currentBranchName: 'feature/test',
        user: creatorUser,
        onWithdraw,
        mode: 'prod',
      })

      const withdraw = screen.getByTestId('withdraw-branch-button-feature/test')
      expect(withdraw.textContent).toBe('Withdraw from review')
      expect(screen.queryByTestId('submit-branch-button-feature/test')).toBeNull()
      await userEvent.click(withdraw)
      expect(onWithdraw).toHaveBeenCalledWith('feature/test')
    })

    it('offers Withdraw, not Submit, on an approved current branch', () => {
      const branches: BranchSummary[] = [
        { ...baseBranches[0], status: 'approved', submitBlocked: true },
      ]
      renderBranchManager({
        branches,
        currentBranchName: 'main',
        user: creatorUser,
        mode: 'prod',
      })

      expect(screen.getByTestId('withdraw-branch-button-main')).toBeTruthy()
      expect(screen.queryByTestId('submit-branch-button-main')).toBeNull()
    })

    const stranger = { userId: 'stranger', groups: [] as string[] }

    it('shows the primary action disabled, with the reason on hover, when the server blocks a permitted user', async () => {
      const branches: BranchSummary[] = [{ ...baseBranches[0], submitBlocked: true }]
      renderBranchManager({
        branches,
        currentBranchName: 'main',
        user: creatorUser,
        mode: 'prod',
      })

      const submit = screen.getByTestId('submit-branch-button-main')
      expect(submit.getAttribute('aria-disabled')).toBe('true')
      expect(submit.hasAttribute('data-disabled')).toBe(true)

      await userEvent.hover(submit)
      expect(await screen.findByText("This branch can't be submitted right now.")).toBeTruthy()
    })

    it('shows the disabled primary action its reason on keyboard focus too', async () => {
      const branches: BranchSummary[] = [{ ...baseBranches[0], submitBlocked: true }]
      renderBranchManager({
        branches,
        currentBranchName: 'main',
        user: creatorUser,
        mode: 'prod',
      })

      const submit = screen.getByTestId('submit-branch-button-main')
      for (let i = 0; i < 20 && document.activeElement !== submit; i++) await userEvent.tab()
      expect(document.activeElement).toBe(submit)
      expect(await screen.findByText("This branch can't be submitted right now.")).toBeTruthy()
    })

    it('does not act on a click while the primary action is disabled', async () => {
      const onSubmit = vi.fn()
      const branches: BranchSummary[] = [{ ...baseBranches[0], submitBlocked: true }]
      renderBranchManager({
        branches,
        currentBranchName: 'main',
        user: creatorUser,
        onSubmit,
        mode: 'prod',
      })

      await userEvent.click(screen.getByTestId('submit-branch-button-main'))

      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('offers a user without workflow access neither Submit nor Withdraw, anywhere', async () => {
      renderBranchManager({
        branches: baseBranches,
        currentBranchName: 'main',
        user: stranger,
        mode: 'prod',
      })

      // The current branch carries no primary action, and Open is for the other one.
      expect(screen.queryByTestId('submit-branch-button-main')).toBeNull()
      expect(screen.queryByTestId('withdraw-branch-button-main')).toBeNull()
      expect(screen.queryByTestId('withdraw-branch-button-feature/test')).toBeNull()
      // The other branch has a pull request to link, so its menu exists and holds no workflow item.
      await openMenu('feature/test')
      expect(screen.getByTestId('view-pull-request-feature/test')).toBeTruthy()
      expect(screen.queryByTestId('withdraw-branch-button-feature/test')).toBeNull()
      expect(screen.queryByText(/You don't have access/)).toBeNull()
    })

    describe('a reviewer on a branch someone else submitted', () => {
      const reviewer = { userId: 'rita', groups: [RESERVED_GROUPS.REVIEWERS] }

      it('leads with Approve, with Request changes beside it, and keeps Withdraw in the menu', async () => {
        const onApprove = vi.fn()
        const onRequestChanges = vi.fn()
        renderBranchManager({
          branches: baseBranches,
          currentBranchName: 'feature/test',
          user: reviewer,
          onApprove,
          onRequestChanges,
          mode: 'prod',
        })

        const primary = screen.getByTestId('approve-branch-button-feature/test')
        expect(primary.textContent).toBe('Approve')
        expect(primary.closest('[role="menu"]')).toBeNull()
        await userEvent.click(primary)
        expect(onApprove).toHaveBeenCalledWith('feature/test')

        const secondary = screen.getByTestId('request-changes-branch-button-feature/test')
        expect(secondary.closest('[role="menu"]')).toBeNull()
        await userEvent.click(secondary)
        expect(onRequestChanges).toHaveBeenCalledWith('feature/test')

        await openMenu('feature/test')
        expect(screen.getAllByTestId('approve-branch-button-feature/test')).toHaveLength(1)
        expect(screen.getAllByTestId('request-changes-branch-button-feature/test')).toHaveLength(1)
        const withdraw = screen.getByTestId('withdraw-branch-button-feature/test')
        expect(withdraw.closest('[role="menu"]')).not.toBeNull()
      })

      it('falls back to Withdraw as the way forward once the pull request is closed', async () => {
        const branches: BranchSummary[] = [{ ...baseBranches[1], pullRequestState: 'closed' }]
        renderBranchManager({
          branches,
          currentBranchName: 'feature/test',
          user: reviewer,
          mode: 'prod',
        })

        const primary = screen.getByTestId('withdraw-branch-button-feature/test')
        expect(primary.getAttribute('aria-disabled')).toBeNull()
        expect(primary.closest('[role="menu"]')).toBeNull()
        await openMenu('feature/test')
        expect(menuItemBlocked('approve-branch-button-feature/test')).toBe(true)
        expect(menuItemBlocked('request-changes-branch-button-feature/test')).toBe(true)
      })

      it.each<[string, Partial<BranchSummary>]>([
        ['the creator', { createdBy: 'rita', access: {} }],
        ['someone given access by name', { access: { users: ['user1', 'rita'] } }],
        ['someone given access by group', { access: { groups: [RESERVED_GROUPS.REVIEWERS] } }],
      ])('still leads with Withdraw for %s', (_who, overrides) => {
        const branches: BranchSummary[] = [{ ...baseBranches[1], ...overrides }]
        renderBranchManager({
          branches,
          currentBranchName: 'feature/test',
          user: reviewer,
          mode: 'prod',
        })

        const withdraw = screen.getByTestId('withdraw-branch-button-feature/test')
        expect(withdraw.closest('[role="menu"]')).toBeNull()
        expect(withdraw.getAttribute('aria-disabled')).toBeNull()
      })

      it("leaves another branch's Request changes in its menu", async () => {
        renderBranchManager({
          branches: baseBranches,
          currentBranchName: 'main',
          user: reviewer,
          mode: 'prod',
        })

        await openMenu('feature/test')
        expect(
          screen.getByTestId('request-changes-branch-button-feature/test').closest('[role="menu"]'),
        ).not.toBeNull()
      })
    })

    it('offers no primary action on an archived or a protected editing current branch', () => {
      const archived: BranchSummary[] = [{ ...baseBranches[0], status: 'archived' }]
      const { unmount } = renderBranchManager({
        branches: archived,
        currentBranchName: 'main',
        user: creatorUser,
        mode: 'prod',
      })
      expect(screen.getByTestId('branch-current-badge-main')).toBeTruthy()
      expect(screen.queryByTestId('submit-branch-button-main')).toBeNull()
      expect(screen.queryByTestId('withdraw-branch-button-main')).toBeNull()
      unmount()

      const protectedEditing: BranchSummary[] = [
        { ...baseBranches[0], isProtected: true, submitBlocked: true },
      ]
      renderBranchManager({
        branches: protectedEditing,
        currentBranchName: 'main',
        user: creatorUser,
        mode: 'prod',
      })
      expect(screen.getByTestId('branch-current-badge-main')).toBeTruthy()
      expect(screen.queryByTestId('submit-branch-button-main')).toBeNull()
      expect(screen.queryByTestId('withdraw-branch-button-main')).toBeNull()
    })
  })

  describe('actions menu', () => {
    it('labels its trigger with the branch it acts on, by its short name', () => {
      const spring: BranchSummary = {
        ...baseBranches[1],
        name: 'canopycms/prod/spring',
        shortName: 'spring',
      }
      renderBranchManager({
        branches: [...baseBranches, spring],
        user: creatorUser,
        mode: 'prod',
      })

      expect(screen.getByRole('button', { name: 'More actions for main' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'More actions for feature/test' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'More actions for spring' })).toBeTruthy()
    })

    it('shows the workflow action of another branch with the reason it cannot act', async () => {
      const branches: BranchSummary[] = [{ ...baseBranches[0], submitBlocked: true }]
      renderBranchManager({ branches, user: creatorUser, mode: 'prod' })

      await openMenu('main')
      const item = screen.getByTestId('submit-branch-button-main')
      expect(item.textContent).toContain('Submit for review')
      expect(menuItemBlocked('submit-branch-button-main')).toBe(true)
      expect(within(item).getByText("This branch can't be submitted right now.")).toBeTruthy()
    })

    describe('a blocked item', () => {
      const blockedBranches: BranchSummary[] = [{ ...baseBranches[0], submitBlocked: true }]

      it('stays in the arrow-key order and announces itself as disabled', async () => {
        const closed: BranchSummary[] = [{ ...baseBranches[1], pullRequestState: 'closed' }]
        renderBranchManager({ branches: closed, user: adminUser, mode: 'prod' })

        await openMenu('feature/test')
        const blocked = screen.getByTestId('request-changes-branch-button-feature/test')
        expect(blocked.getAttribute('role')).toBe('menuitem')
        expect(blocked.getAttribute('aria-disabled')).toBe('true')
        expect(blocked.hasAttribute('disabled')).toBe(false)
        expect(blocked.hasAttribute('data-disabled')).toBe(false)

        // Approve is the item above it, blocked too; ArrowDown must land on this blocked one.
        const approve = screen.getByTestId('approve-branch-button-feature/test')
        expect(approve.getAttribute('aria-disabled')).toBe('true')
        approve.focus()
        await userEvent.keyboard('{ArrowDown}')
        expect(document.activeElement).toBe(blocked)
        // Withdraw follows, enabled: a blocked item does not end the arrow-key order.
        await userEvent.keyboard('{ArrowDown}')
        expect(document.activeElement).toBe(
          screen.getByTestId('withdraw-branch-button-feature/test'),
        )
      })

      it('does nothing, and leaves the menu open, when chosen', async () => {
        const onSubmit = vi.fn()
        renderBranchManager({
          branches: blockedBranches,
          user: creatorUser,
          onSubmit,
          mode: 'prod',
        })

        await openMenu('main')
        await userEvent.click(screen.getByTestId('submit-branch-button-main'))

        expect(onSubmit).not.toHaveBeenCalled()
        // The trigger reports the menu's own open state at once, before any exit transition.
        expect(screen.getByTestId('branch-actions-menu-main').getAttribute('aria-expanded')).toBe(
          'true',
        )
      })
    })

    it('hides Request changes from someone who is not a reviewer or admin', async () => {
      renderBranchManager({ branches: baseBranches, user: creatorUser, mode: 'prod' })

      await openMenu('feature/test')
      // Withdraw is there, so the menu is open on this branch's items.
      expect(screen.getByTestId('withdraw-branch-button-feature/test')).toBeTruthy()
      expect(screen.queryByTestId('request-changes-branch-button-feature/test')).toBeNull()
    })

    it('shows Request changes to a reviewer on a branch in review', async () => {
      renderBranchManager({
        branches: baseBranches,
        user: { userId: 'rita', groups: [RESERVED_GROUPS.REVIEWERS] },
        mode: 'prod',
      })

      await openMenu('feature/test')
      expect(menuItemBlocked('request-changes-branch-button-feature/test')).toBe(false)
    })

    it('hides Request changes on a branch that is not in review', async () => {
      renderBranchManager({ branches: baseBranches, user: adminUser, mode: 'prod' })

      await openMenu('main')
      // Delete is there, so the menu is open on this branch's items.
      expect(screen.getByTestId('delete-branch-button-main')).toBeTruthy()
      expect(screen.queryByTestId('request-changes-branch-button-main')).toBeNull()
    })

    it('links to the pull request in a new tab', async () => {
      renderBranchManager({ branches: baseBranches, user: creatorUser, mode: 'prod' })

      await openMenu('feature/test')
      const link = screen.getByTestId('view-pull-request-feature/test')
      expect(link.tagName).toBe('A')
      expect(link.textContent).toBe('View pull request #1')
      expect(link.getAttribute('href')).toBe('https://github.com/owner/repo/pull/1')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
      expect(screen.queryByText('View PR')).toBeNull()
    })

    it('hides Delete branch from an editor who did not create the branch', async () => {
      const branches: BranchSummary[] = [{ ...baseBranches[0], access: { users: ['other'] } }]
      renderBranchManager({ branches, user: { userId: 'other', groups: [] }, mode: 'prod' })

      await openMenu('main')
      // The submit item is there, so the menu is open on this branch's items.
      expect(screen.getByTestId('submit-branch-button-main')).toBeTruthy()
      expect(screen.queryByTestId('delete-branch-button-main')).toBeNull()
    })

    it('hides Delete branch on the protected branch, even from an admin', async () => {
      const branches: BranchSummary[] = [
        {
          ...baseBranches[0],
          isProtected: true,
          pullRequestUrl: 'https://github.com/owner/repo/pull/9',
          pullRequestNumber: 9,
        },
      ]
      renderBranchManager({ branches, user: adminUser, mode: 'prod' })

      await openMenu('main')
      expect(screen.getByTestId('view-pull-request-main')).toBeTruthy()
      expect(screen.queryByTestId('delete-branch-button-main')).toBeNull()
    })

    it('renders no trigger when nothing in the menu applies', () => {
      const branches: BranchSummary[] = [{ ...baseBranches[0], isProtected: true }]
      renderBranchManager({ branches, user: adminUser, mode: 'prod' })

      expect(screen.getByTestId('branch-list-item-main')).toBeTruthy()
      expect(screen.queryByTestId('branch-actions-menu-main')).toBeNull()
    })

    it('closes only the menu on Escape, leaving the drawer open', async () => {
      const onClose = vi.fn()
      render(
        <CanopyCMSProvider>
          <BranchesDrawer opened onClose={onClose} confirmOpen={false}>
            <BranchManager branches={baseBranches} user={creatorUser} mode="prod" />
          </BranchesDrawer>
        </CanopyCMSProvider>,
      )

      await openMenu('main')
      expect(screen.getByTestId('delete-branch-button-main')).toBeTruthy()

      await userEvent.keyboard('{Escape}')

      await waitFor(() => expect(screen.queryByTestId('delete-branch-button-main')).toBeNull())
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByTestId('branch-manager')).toBeTruthy()

      // With no menu open, the same key reaches the drawer.
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    })
  })

  describe('naming people', () => {
    const branchThread = {
      id: 'thread-1',
      type: 'branch' as const,
      comments: [
        {
          id: 'c1',
          threadId: 'thread-1',
          userId: 'commenter',
          timestamp: '2024-01-01T00:00:00.000Z',
          text: 'Looks good',
        },
      ],
      resolved: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      authorId: 'commenter',
    }
    const commentProps = {
      comments: [branchThread],
      currentUserId: 'user1',
      onAddComment: vi.fn(async () => {}),
      onResolveThread: vi.fn(async () => {}),
    }

    it('names branch commenters through the comment resolver, without the owner lookup', async () => {
      const onGetCommentUserMetadata = vi.fn(async (id: string) =>
        id === 'commenter' ? { id, name: 'Casey Commenter', email: '' } : null,
      )
      renderBranchManager({
        branches: baseBranches,
        mode: 'prod',
        user: creatorUser,
        ...commentProps,
        onGetCommentUserMetadata,
      })

      expect(await screen.findByText('Casey Commenter')).toBeDefined()
      expect(onGetCommentUserMetadata).not.toHaveBeenCalledWith('user1')
      expect((await screen.findAllByText('Name unavailable')).length).toBeGreaterThan(0)
      expect(screen.queryByText('user1')).toBeNull()
    })

    it('offers no way to start a branch comment, and shows no discussion without threads', () => {
      renderBranchManager({
        branches: baseBranches,
        mode: 'prod',
        user: creatorUser,
        ...commentProps,
        comments: [],
      })

      expect(screen.queryByText('New branch comment')).toBeNull()
      expect(screen.queryByText('Branch discussion')).toBeNull()
    })

    it('still shows the discussion of a branch that has threads', async () => {
      renderBranchManager({
        branches: baseBranches,
        mode: 'prod',
        user: creatorUser,
        ...commentProps,
      })

      expect(await screen.findByText(/^Branch discussion/)).toBeDefined()
      expect(screen.queryByText('New branch comment')).toBeNull()
    })

    it('names owners through the owner lookup only', async () => {
      const onGetUserMetadata = vi.fn(async (id: string) =>
        id === 'user1' ? { id, name: 'Olive Owner', email: 'olive@example.test' } : null,
      )
      const onGetCommentUserMetadata = vi.fn(async () => null)
      renderBranchManager({
        branches: baseBranches,
        mode: 'prod',
        user: adminUser,
        ...commentProps,
        onGetUserMetadata,
        onGetCommentUserMetadata,
      })

      expect((await screen.findAllByText('Olive Owner')).length).toBeGreaterThan(0)
      expect(onGetUserMetadata).not.toHaveBeenCalledWith('commenter')
    })

    it('names owners and access users through the owner resolver', async () => {
      const onGetOwnerMetadata = vi.fn(async (id: string) => ({
        id,
        name: `Named ${id}`,
        email: '',
      }))
      renderBranchManager({
        branches: [
          {
            name: 'feature/shared',
            status: 'editing',
            createdBy: 'owner1',
            access: { users: ['acl-user'] },
          },
        ],
        mode: 'prod',
        user: creatorUser,
        onGetOwnerMetadata,
      })

      expect(await screen.findByText('Named owner1')).toBeDefined()
      expect(onGetOwnerMetadata).toHaveBeenCalledWith('acl-user')
      expect(screen.queryByText('acl-user')).toBeNull()
    })

    it('counts access users nothing can name, never showing them as ids', async () => {
      const { container } = renderBranchManager({
        branches: [
          {
            name: 'feature/shared',
            status: 'editing',
            createdBy: 'owner1',
            access: { users: ['acl-user'] },
          },
        ],
        mode: 'prod',
        user: creatorUser,
      })

      expect(await screen.findByText('Access: 1 person')).toBeDefined()
      expect(await screen.findAllByText('Name unavailable')).toHaveLength(1)
      expect(container.textContent).not.toContain('acl-user')
      expect(container.textContent).not.toContain('owner1')
    })

    it('names the access users it can, then counts the rest with those the server withheld', async () => {
      const onGetOwnerMetadata = vi.fn(async (id: string) =>
        id === 'known' || id === 'owner1' ? { id, name: `Name of ${id}`, email: '' } : null,
      )
      renderBranchManager({
        branches: [
          {
            name: 'feature/shared',
            status: 'editing',
            createdBy: 'owner1',
            access: {
              users: ['known', 'unknown'],
              groups: ['team-a'],
              withheldUsers: 2,
              withheldGroups: 1,
            },
          },
        ],
        mode: 'prod',
        user: creatorUser,
        onGetOwnerMetadata,
      })

      expect(await screen.findByText('Access: Name of known, team-a and 4 others')).toBeDefined()
      expect(screen.queryByText('Name unavailable')).toBeNull()
    })
  })
})

describe('a branch outside the namespace whose name a namespace branch takes as its short name', () => {
  const outside: BranchSummary = {
    name: 'spring',
    shortName: 'spring',
    status: 'editing',
    submitBlocked: false,
  }
  const namespaced: BranchSummary = { ...outside, name: 'canopycms/prod/spring' }
  const reviewerAdmin = {
    userId: 'reviewer',
    groups: [RESERVED_GROUPS.ADMINS, RESERVED_GROUPS.REVIEWERS],
  }

  /** Click `testId`, from the card's "…" menu when the card does not show it. */
  const choose = async (testId: string, name: string) => {
    if (!screen.queryByTestId(testId)) {
      await userEvent.click(screen.getByTestId(`branch-actions-menu-${name}`))
      await screen.findByRole('menu')
    }
    await userEvent.click(screen.getByTestId(testId))
  }

  it.each([
    ['outside', outside, '~spring'],
    ['namespace', namespaced, 'canopycms/prod/spring'],
  ])(
    "hands every action on the %s branch's card a name that opens that branch",
    async (_label, branch, address) => {
      const props = {
        onSelect: vi.fn(),
        onSubmit: vi.fn(),
        onDelete: vi.fn(),
        onWithdraw: vi.fn(),
        onApprove: vi.fn(),
        onRequestChanges: vi.fn(),
      }
      const editing = renderBranchManager({
        branches: [outside, namespaced],
        user: reviewerAdmin,
        mode: 'prod',
        ...props,
      })
      await choose(`switch-to-branch-button-${branch.name}`, branch.name)
      await choose(`submit-branch-button-${branch.name}`, branch.name)
      await choose(`delete-branch-button-${branch.name}`, branch.name)
      editing.unmount()

      const submitted = (b: BranchSummary) => ({ ...b, status: 'submitted', createdBy: 'author' })
      renderBranchManager({
        branches: [submitted(outside), submitted(namespaced)],
        user: reviewerAdmin,
        mode: 'prod',
        ...props,
      })
      await choose(`withdraw-branch-button-${branch.name}`, branch.name)
      await choose(`approve-branch-button-${branch.name}`, branch.name)
      await choose(`request-changes-branch-button-${branch.name}`, branch.name)

      const calls = Object.fromEntries(
        Object.entries(props).map(([prop, handler]) => [prop, handler.mock.calls]),
      )
      expect(calls).toEqual(
        Object.fromEntries(Object.keys(props).map((prop) => [prop, [[address]]])),
      )
    },
  )
})
