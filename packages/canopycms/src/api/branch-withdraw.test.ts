import { describe, expect, it, vi } from 'vitest'

import { withdrawBranch } from './branch-withdraw'
import type { ApiContext } from './types'

vi.mock('../branch-metadata', () => {
  return {
    BranchMetadata: vi.fn().mockImplementation(() => ({
      update: vi.fn().mockResolvedValue(undefined),
    })),
  }
})

const baseState = {
  branch: {
    name: 'feature/x',
    status: 'submitted' as const,
    access: {},
    createdBy: 'u1',
    createdAt: 'now',
    updatedAt: 'now',
  },
  pullRequestNumber: 123,
  pullRequestUrl: 'https://github.com/owner/repo/pull/123',
}

const makeCtx = (allowed = true, githubService?: any): ApiContext => ({
  services: {
    config: { schema: [] } as any,
    checkBranchAccess: vi
      .fn()
      .mockReturnValue({ allowed, reason: allowed ? 'allowed_by_acl' : 'denied_by_acl' }),
    checkContentAccess: vi.fn(),
    githubService,
    bootstrapAdminIds: new Set<string>(),
  },
  getBranchState: vi.fn().mockResolvedValue(baseState),
})

describe('branch withdraw api', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchState = vi.fn().mockResolvedValue(null)
    const res = await withdrawBranch(ctx, { user: { userId: 'u1' } }, { branch: 'missing' })
    expect(res.status).toBe(404)
    expect(res.error).toBe('Branch not found')
  })

  it('returns 403 if access forbidden', async () => {
    const res = await withdrawBranch(
      makeCtx(false),
      { user: { userId: 'u1' } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(403)
    expect(res.error).toBe('Forbidden')
  })

  it('returns 400 if branch not submitted', async () => {
    const ctx = makeCtx()
    ctx.getBranchState = vi.fn().mockResolvedValue({
      ...baseState,
      branch: { ...baseState.branch, status: 'editing' },
    })
    const res = await withdrawBranch(ctx, { user: { userId: 'u1' } }, { branch: 'feature/x' })
    expect(res.status).toBe(400)
    expect(res.error).toContain("Only 'submitted' branches can be withdrawn")
  })

  it('withdraws branch when allowed', async () => {
    const res = await withdrawBranch(
      makeCtx(true),
      { user: { userId: 'u1' } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('converts PR to draft if github service available', async () => {
    const convertToDraft = vi.fn().mockResolvedValue(undefined)
    const githubService = { convertToDraft }
    const res = await withdrawBranch(
      makeCtx(true, githubService),
      { user: { userId: 'u1' } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
    expect(convertToDraft).toHaveBeenCalledWith(123)
  })

  it('handles github service errors gracefully', async () => {
    const convertToDraft = vi.fn().mockRejectedValue(new Error('API error'))
    const githubService = { convertToDraft }
    const res = await withdrawBranch(
      makeCtx(true, githubService),
      { user: { userId: 'u1' } },
      { branch: 'feature/x' },
    )
    // Should still succeed even if GitHub API fails
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('skips PR conversion if no PR number', async () => {
    const convertToDraft = vi.fn()
    const githubService = { convertToDraft }
    const ctx = makeCtx(true, githubService)
    ctx.getBranchState = vi.fn().mockResolvedValue({
      ...baseState,
      pullRequestNumber: undefined,
    })
    const res = await withdrawBranch(ctx, { user: { userId: 'u1' } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(convertToDraft).not.toHaveBeenCalled()
  })
})
