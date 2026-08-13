import { describe, expect, it, vi } from 'vitest'
import type { BranchName } from '../paths/types'
import type { BranchContext, BranchStatus } from '../types'

const mockMetadataUpdate = vi.fn().mockResolvedValue({
  schemaVersion: 1,
  branch: {
    name: 'feature/x',
    status: 'submitted',
    access: {},
    createdBy: 'u1',
    createdAt: 'now',
    updatedAt: 'now',
  },
})

vi.mock('../branch-metadata', () => ({
  BranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataUpdate,
  })),
  getBranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataUpdate,
  })),
}))

// Spy on canPerformWorkflowAction (delegating to the real implementation) so
// tests can assert the handler threads `{ isProtectedBranch }` through to it,
// without needing to reach the (guard-blocked) protected-branch case itself.
const canPerformWorkflowActionSpy = vi.fn()
vi.mock('../authorization', async (importOriginal) => {
  const original = await importOriginal<typeof import('../authorization')>()
  return {
    ...original,
    canPerformWorkflowAction: (...args: Parameters<typeof original.canPerformWorkflowAction>) => {
      canPerformWorkflowActionSpy(...args)
      return original.canPerformWorkflowAction(...args)
    },
  }
})

import { WORKFLOW_ROUTES } from './branch-status'
import {
  createMockApiContext,
  createMockBranchContext,
  createMockGitManager,
  mockConsole,
} from '../test-utils'

// Extract handlers for testing
const getBranchStatus = WORKFLOW_ROUTES.getStatus.handler
const submitBranchForMerge = WORKFLOW_ROUTES.submit.handler

const baseContext = createMockBranchContext({
  branchName: 'feature/x',
  createdBy: 'u1',
})

const makeCtx = (allowed = true) => {
  const mockGit = createMockGitManager()
  mockGit.status.mockResolvedValue({
    files: [{ path: 'content/home.json' } as any],
    ahead: 0,
    behind: 0,
    current: 'feature/x',
  })

  return createMockApiContext({
    branchContext: baseContext,
    allowBranchAccess: allowed,
    services: {
      createGitManagerFor: vi.fn().mockReturnValue(mockGit),
      config: { defaultBranchAccess: 'allow' } as any,
    },
  })
}

describe('branch status api', () => {
  it('gets status', async () => {
    const res = await getBranchStatus(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch.name).toBe('feature/x')
  })

  it('denies submit when access forbidden', async () => {
    // User 'u2' is not the creator (u1) and has no ACL access
    const res = await submitBranchForMerge(
      makeCtx(false),
      { user: { type: 'authenticated', userId: 'u2', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.status).toBe(403)
  })

  it('submits branch when allowed', async () => {
    const res = await submitBranchForMerge(
      makeCtx(true),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
  })

  it('rejects submit on the base branch (protected -- submittableBranch guard, prod)', async () => {
    const baseBranchContext = createMockBranchContext({ branchName: 'main', createdBy: 'u1' })
    const ctx = createMockApiContext({
      branchContext: baseBranchContext,
      allowBranchAccess: true,
      services: {
        config: { defaultBranchAccess: 'allow', mode: 'prod', defaultBaseBranch: 'main' } as any,
      },
    })

    // WORKFLOW_ROUTES.submit.handler is the guard-wrapped handler (guards:
    // ['branch', 'submittableBranch']) -- this exercises the guard, not just
    // the raw handler.
    const res = await submitBranchForMerge(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'main' as BranchName },
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.error).toBe(
      'The base branch cannot be submitted for review. Create a branch and submit that instead.',
    )
  })

  it('rejects submit on the base branch in dev too (submit blocked in both modes)', async () => {
    const baseBranchContext = createMockBranchContext({ branchName: 'main', createdBy: 'u1' })
    const ctx = createMockApiContext({
      branchContext: baseBranchContext,
      allowBranchAccess: true,
      services: {
        config: { defaultBranchAccess: 'allow', mode: 'dev', defaultBaseBranch: 'main' } as any,
      },
    })

    const res = await submitBranchForMerge(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'main' as BranchName },
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
  })

  it('passes isProtectedBranch into canPerformWorkflowAction', async () => {
    // The 'submittableBranch' guard already refuses the protected base branch
    // outright, so the handler only ever runs with isProtectedBranch: false
    // in practice -- this asserts the handler computes and threads it through
    // (defense-in-depth); authorization/__tests__/branch.test.ts covers the
    // isProtectedBranch: true effect on canPerformWorkflowAction directly.
    canPerformWorkflowActionSpy.mockClear()

    const res = await submitBranchForMerge(
      makeCtx(true),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )

    expect(res.ok).toBe(true)
    expect(canPerformWorkflowActionSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { isProtectedBranch: false },
    )
  })

  it('clears rebaseFailure on submit (PR-W2 M2)', async () => {
    mockMetadataUpdate.mockClear()

    const res = await submitBranchForMerge(
      makeCtx(true),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )

    expect(res.ok).toBe(true)
    expect(mockMetadataUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: expect.objectContaining({ rebaseFailure: undefined }),
      }),
    )
  })

  it('sanitizes credentials and absolute paths when the push fails (API-H2)', async () => {
    // The push-failure path logs by design; swallow (and assert) it so the
    // sanitized error doesn't clutter the test reporter.
    const consoleSpy = mockConsole()
    const ctx = makeCtx(true)
    ctx.services.submitBranch = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `push failed to https://x-access-token:ghp_leak123@github.com/org/repo.git ` +
            `from /mnt/efs/workspace/feature-x`,
        ),
      )

    const res = await submitBranchForMerge(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
    expect(res.error).not.toContain('ghp_leak123')
    expect(res.error).not.toContain('/mnt/efs')
    expect(res.error).toContain('***@github.com')
    expect(consoleSpy).toHaveErrored('Failed to push branch changes')
    consoleSpy.restore()
  })

  it('returns 409 with actionable guidance on a non-fast-forward push rejection', async () => {
    const consoleSpy = mockConsole()
    const ctx = makeCtx(true)
    // Real git push-rejection text (--porcelain form, captured from an actual
    // diverging push between two clones of a shared bare repo -- see
    // utils/git.test.ts for how it was generated), not an invented string.
    ctx.services.submitBranch = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'To /tmp/canopy-test/github.git\n' +
            '!\trefs/heads/feature/x:refs/heads/feature/x\t[rejected] (fetch first)\n' +
            'Done\n' +
            'Pushing to /tmp/canopy-test/github.git\n' +
            "error: failed to push some refs to '/tmp/canopy-test/github.git'\n" +
            'hint: Updates were rejected because the remote contains work that you do not\n' +
            'hint: have locally. This is usually caused by another repository pushing to\n' +
            'hint: the same ref. If you want to integrate the remote changes, use\n' +
            "hint: 'git pull' before pushing again.\n",
        ),
      )

    const res = await submitBranchForMerge(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(res.error).toContain('feature/x')
    // States the observable fact and names no cause. This push targets the
    // deployment's OWN local origin, which a foreign deployment cannot reach,
    // so blaming one was actively misleading -- and it must never advise a
    // rename: a branch that reaches this point has usually been submitted
    // before, so a rename can orphan an open PR.
    expect(res.error).toContain('diverged')
    expect(res.error).not.toContain('another CanopyCMS deployment')
    expect(res.error).not.toMatch(/rename/i)
    // No raw git output (branch/ref internals, hint text) leaks to the client.
    expect(res.error).not.toContain('rejected')
    expect(res.error).not.toContain('/tmp/canopy-test')
    consoleSpy.restore()
  })

  it('keeps the existing 500 path for an unrelated (non-rejection) push failure', async () => {
    const consoleSpy = mockConsole()
    const ctx = makeCtx(true)
    ctx.services.submitBranch = vi.fn().mockRejectedValue(new Error('socket hang up'))

    const res = await submitBranchForMerge(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )

    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
    expect(res.error).toContain('Failed to push branch changes')
    consoleSpy.restore()
  })

  // ==========================================================================
  // Submit status gate
  // ==========================================================================

  describe('submit status gate', () => {
    // Build a context pinned to an arbitrary workflow status, keeping a handle
    // on the injected services so the tests can assert the submit path was
    // abandoned BEFORE it did any work -- a 400 that still pushed and stamped
    // metadata would be no fix at all.
    const makeStatusCtx = (status: BranchStatus | undefined) => {
      const mockGit = createMockGitManager()
      mockGit.status.mockResolvedValue({
        files: [{ path: 'content/home.json' } as any],
        ahead: 0,
        behind: 0,
        current: 'feature/x',
      })

      // Override branch.status after construction rather than through the
      // helper's option: createMockBranchContext coerces an explicit
      // `undefined` back to 'editing' (`options.status ?? 'editing'`), which
      // would make the fail-closed case below silently untestable.
      const built = createMockBranchContext({ branchName: 'feature/x', createdBy: 'u1' })
      const branchContext = {
        ...built,
        branch: { ...built.branch, status },
      } as BranchContext

      const ctx = createMockApiContext({
        branchContext,
        allowBranchAccess: true,
        services: {
          createGitManagerFor: vi.fn().mockReturnValue(mockGit),
          config: { defaultBranchAccess: 'allow' } as any,
        },
      })
      ctx.services.submitBranch = vi.fn()
      return { ctx, mockGit }
    }

    const submitAs = (ctx: ReturnType<typeof makeStatusCtx>['ctx']) =>
      submitBranchForMerge(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: 'feature/x' as BranchName },
      )

    it.each([
      [
        'archived',
        "Cannot submit branch with status 'archived'. Only 'editing' branches can be submitted.",
      ],
      [
        'approved',
        "Cannot submit branch with status 'approved'. Only 'editing' branches can be submitted.",
      ],
      [
        'submitted',
        "Cannot submit branch with status 'submitted'. Only 'editing' branches can be submitted.",
      ],
    ] as const)('rejects submit on a %s branch', async (status, expectedError) => {
      mockMetadataUpdate.mockClear()
      const { ctx } = makeStatusCtx(status)

      const res = await submitAs(ctx)

      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      expect(res.error).toBe(expectedError)

      // Nothing may have happened: no commit/push, and above all no status
      // re-stamp. Re-submitting an archived (merged) branch previously flipped
      // it back to 'submitted' and fired syncSubmitPr at an already-merged PR.
      expect(ctx.services.submitBranch).not.toHaveBeenCalled()
      expect(mockMetadataUpdate).not.toHaveBeenCalled()
    })

    it('fails closed when the status is unreadable', async () => {
      // branch.json is read with a bare JSON.parse (no schema validation), so a
      // damaged or hand-repaired file can yield status: undefined at runtime --
      // the same condition getBranchWriteProtection refuses writes for.
      mockMetadataUpdate.mockClear()
      const { ctx } = makeStatusCtx(undefined)

      const res = await submitAs(ctx)

      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      expect(res.error).toContain('no readable workflow status')
      expect(ctx.services.submitBranch).not.toHaveBeenCalled()
      expect(mockMetadataUpdate).not.toHaveBeenCalled()
    })

    it('still allows submit on an editing branch', async () => {
      const { ctx } = makeStatusCtx('editing')

      const res = await submitAs(ctx)

      expect(res.ok).toBe(true)
      expect(ctx.services.submitBranch).toHaveBeenCalled()
    })
  })
})
