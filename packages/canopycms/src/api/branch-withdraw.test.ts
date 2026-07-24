import { describe, expect, it, vi } from 'vitest'
import type { BranchName } from '../paths/types'

const mockMetadataSave = vi.fn().mockResolvedValue({
  schemaVersion: 1,
  branch: {
    name: 'feature/x',
    status: 'editing',
    access: {},
    createdBy: 'u1',
    createdAt: 'now',
    updatedAt: 'now',
    pullRequestNumber: 123,
    pullRequestUrl: 'https://github.com/owner/repo/pull/123',
  },
})

vi.mock('../branch-metadata', () => ({
  BranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataSave,
  })),
  getBranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataSave,
  })),
}))

import { withdrawBranch } from './branch-withdraw'
import { mockConsole, createMockApiContext, createMockBranchContext } from '../test-utils'
import { RESERVED_GROUPS } from '../authorization'

// Extract handler for testing
const withdrawHandler = withdrawBranch.handler

const baseContext = createMockBranchContext({
  branchName: 'feature/x',
  status: 'submitted',
  pullRequestNumber: 123,
  pullRequestUrl: 'https://github.com/owner/repo/pull/123',
  createdBy: 'u1',
})

const makeCtx = (allowed = true, githubService?: any) =>
  createMockApiContext({
    branchContext: baseContext,
    allowBranchAccess: allowed,
    services: {
      ...(githubService && { githubService }),
      config: { defaultBranchAccess: 'allow' } as any,
    },
  })

describe('branch withdraw api', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue(null)
    const res = await withdrawHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'missing' as BranchName },
    )
    expect(res.status).toBe(404)
    expect(res.error).toBe('Branch not found')
  })

  it('returns 403 if access forbidden', async () => {
    // User 'u2' is not the creator (u1) and has no ACL access
    const res = await withdrawHandler(
      makeCtx(false),
      { user: { type: 'authenticated', userId: 'u2', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.status).toBe(403)
    expect(res.error).toContain(
      'Only the branch creator or users with explicit branch access can withdraw this branch',
    )
  })

  it('returns 400 if branch not submitted', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, status: 'editing' },
    })
    const res = await withdrawHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain("Only 'submitted' branches can be withdrawn")
  })

  it('withdraws branch when allowed', async () => {
    const res = await withdrawHandler(
      makeCtx(true),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('converts PR to draft if github service available', async () => {
    const convertToDraft = vi.fn().mockResolvedValue(undefined)
    const githubService = { convertToDraft }
    const res = await withdrawHandler(
      makeCtx(true, githubService),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    expect(convertToDraft).toHaveBeenCalledWith(123)
  })

  it('handles github service errors gracefully', async () => {
    const consoleSpy = mockConsole()
    const convertToDraft = vi.fn().mockRejectedValue(new Error('API error'))
    const githubService = { convertToDraft }
    const res = await withdrawHandler(
      makeCtx(true, githubService),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    // Should still succeed even if GitHub API fails
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(consoleSpy).toHaveErrored('Failed to convert PR to draft')
    consoleSpy.restore()
  })

  it('skips PR conversion if no PR number', async () => {
    const convertToDraft = vi.fn()
    const githubService = { convertToDraft }
    const ctx = makeCtx(true, githubService)
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, pullRequestNumber: undefined },
    })
    const res = await withdrawHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    expect(convertToDraft).not.toHaveBeenCalled()
  })

  it('skips PR-to-draft conversion when the PR was closed without merging', async () => {
    // A closed PR can't be converted to draft; withdraw is the recovery
    // path and must succeed without attempting the conversion.
    const convertToDraft = vi.fn().mockResolvedValue(undefined)
    const githubService = { convertToDraft }
    const ctx = makeCtx(true, githubService)
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, pullRequestState: 'closed' },
    })
    const res = await withdrawHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(convertToDraft).not.toHaveBeenCalled()
    // The dead PR's metadata is dropped so the editing branch shows no stale PR chip
    expect(mockMetadataSave).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: expect.objectContaining({
          status: 'editing',
          pullRequestState: undefined,
          pullRequestNumber: undefined,
          pullRequestUrl: undefined,
        }),
      }),
    )
  })

  it('keeps PR metadata when withdrawing an open PR (converted to draft, still live)', async () => {
    const convertToDraft = vi.fn().mockResolvedValue(undefined)
    const githubService = { convertToDraft }
    const ctx = makeCtx(true, githubService)
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, pullRequestState: 'open' },
    })
    const res = await withdrawHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    const saveArg = mockMetadataSave.mock.calls.at(-1)?.[0] as {
      branch: Record<string, unknown>
    }
    expect(saveArg.branch.status).toBe('editing')
    expect('pullRequestState' in saveArg.branch).toBe(false)
    expect('pullRequestNumber' in saveArg.branch).toBe(false)
    expect('pullRequestUrl' in saveArg.branch).toBe(false)
  })

  it('still converts the PR to draft when pullRequestState is open', async () => {
    const convertToDraft = vi.fn().mockResolvedValue(undefined)
    const githubService = { convertToDraft }
    const ctx = makeCtx(true, githubService)
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, pullRequestState: 'open' },
    })
    const res = await withdrawHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    expect(convertToDraft).toHaveBeenCalledWith(123)
  })

  it('still converts the PR to draft when pullRequestState is undefined', async () => {
    const convertToDraft = vi.fn().mockResolvedValue(undefined)
    const githubService = { convertToDraft }
    const res = await withdrawHandler(
      makeCtx(true, githubService),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    expect(convertToDraft).toHaveBeenCalledWith(123)
  })

  describe('protected base branch (recovery path)', () => {
    // The base branch is auto-provisioned with createdBy: 'canopycms-system',
    // which would normally grant withdraw to anyone with general branch
    // access via the system-branch clause -- isProtectedBranch disables that
    // grant, restricting withdraw to creator/ACL/privileged users. Withdraw
    // itself stays reachable (unlike submit) as the deliberate recovery path
    // for a protected branch wrongly stuck in 'submitted'.
    const protectedContext = createMockBranchContext({
      branchName: 'main',
      status: 'submitted',
      pullRequestNumber: 123,
      pullRequestUrl: 'https://github.com/owner/repo/pull/123',
      createdBy: 'canopycms-system',
    })

    const makeProtectedCtx = () =>
      createMockApiContext({
        branchContext: protectedContext,
        allowBranchAccess: true,
        services: {
          config: { defaultBranchAccess: 'allow', mode: 'prod', defaultBaseBranch: 'main' } as any,
        },
      })

    it('restricts withdraw on the protected base branch to privileged/creator/ACL users', async () => {
      const res = await withdrawHandler(
        makeProtectedCtx(),
        { user: { type: 'authenticated', userId: 'random-user', groups: [] } },
        { branch: 'main' as BranchName },
      )
      expect(res.status).toBe(403)
    })

    it('still allows an admin to withdraw the protected base branch (recovery)', async () => {
      const res = await withdrawHandler(
        makeProtectedCtx(),
        { user: { type: 'authenticated', userId: 'admin-1', groups: [RESERVED_GROUPS.ADMINS] } },
        { branch: 'main' as BranchName },
      )
      expect(res.ok).toBe(true)
    })
  })
})
