import { describe, expect, it, vi } from 'vitest'
import type { BranchName } from '../paths/types'

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
import { createMockApiContext, createMockBranchContext, createMockGitManager } from '../test-utils'

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
  })
})
