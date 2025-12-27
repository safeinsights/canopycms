import { describe, expect, it, vi } from 'vitest'

import { requestChanges, approveBranch } from './branch-review'
import type { ApiContext } from './types'
import { RESERVED_GROUPS } from '../reserved-groups'

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

const makeCtx = (githubService?: any): ApiContext => ({
  services: {
    config: { schema: [] } as any,
    checkBranchAccess: vi.fn(),
    checkContentAccess: vi.fn(),
    githubService,
    bootstrapAdminIds: new Set<string>(),
  },
  getBranchState: vi.fn().mockResolvedValue(baseState),
})

describe('branch review api - requestChanges', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchState = vi.fn().mockResolvedValue(null)
    const res = await requestChanges(ctx, { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } }, { branch: 'missing' })
    expect(res.status).toBe(404)
    expect(res.error).toBe('Branch not found')
  })

  it('returns 403 if user not admin/reviewer', async () => {
    const res = await requestChanges(
      makeCtx(),
      { user: { userId: 'u1', groups: [] } },
      { branch: 'feature/x' }
    )
    expect(res.status).toBe(403)
    expect(res.error).toContain('Only Admins and Reviewers can request changes')
  })

  it('returns 400 if branch not submitted', async () => {
    const ctx = makeCtx()
    ctx.getBranchState = vi.fn().mockResolvedValue({
      ...baseState,
      branch: { ...baseState.branch, status: 'editing' },
    })
    const res = await requestChanges(ctx, { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } }, { branch: 'feature/x' })
    expect(res.status).toBe(400)
    expect(res.error).toContain('Only \'submitted\' branches can have changes requested')
  })

  it('requests changes when allowed (admin)', async () => {
    const res = await requestChanges(makeCtx(), { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('requests changes when allowed (reviewer)', async () => {
    const res = await requestChanges(
      makeCtx(),
      { user: { userId: 'u1', groups: [RESERVED_GROUPS.REVIEWERS] } },
      { branch: 'feature/x' }
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('converts PR to draft if github service available', async () => {
    const convertToDraft = vi.fn().mockResolvedValue(undefined)
    const githubService = { convertToDraft }
    const res = await requestChanges(
      makeCtx(githubService),
      { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' }
    )
    expect(res.ok).toBe(true)
    expect(convertToDraft).toHaveBeenCalledWith(123)
  })

  it('handles github service errors gracefully', async () => {
    const convertToDraft = vi.fn().mockRejectedValue(new Error('API error'))
    const githubService = { convertToDraft }
    const res = await requestChanges(
      makeCtx(githubService),
      { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' }
    )
    // Should still succeed even if GitHub API fails
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('skips PR conversion if no PR number', async () => {
    const convertToDraft = vi.fn()
    const githubService = { convertToDraft }
    const ctx = makeCtx(githubService)
    ctx.getBranchState = vi.fn().mockResolvedValue({
      ...baseState,
      pullRequestNumber: undefined,
    })
    const res = await requestChanges(ctx, { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(convertToDraft).not.toHaveBeenCalled()
  })

  it('accepts optional comment parameter', async () => {
    const res = await requestChanges(
      makeCtx(),
      { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] }, body: { comment: 'Please fix the typo' } },
      { branch: 'feature/x' }
    )
    expect(res.ok).toBe(true)
  })
})

describe('branch review api - approveBranch', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchState = vi.fn().mockResolvedValue(null)
    const res = await approveBranch(ctx, { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } }, { branch: 'missing' })
    expect(res.status).toBe(404)
    expect(res.error).toBe('Branch not found')
  })

  it('returns 403 if user not admin/reviewer', async () => {
    const res = await approveBranch(makeCtx(), { user: { userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.status).toBe(403)
    expect(res.error).toContain('Only Admins and Reviewers can approve branches')
  })

  it('returns 400 if branch not submitted', async () => {
    const ctx = makeCtx()
    ctx.getBranchState = vi.fn().mockResolvedValue({
      ...baseState,
      branch: { ...baseState.branch, status: 'editing' },
    })
    const res = await approveBranch(ctx, { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } }, { branch: 'feature/x' })
    expect(res.status).toBe(400)
    expect(res.error).toContain('Only \'submitted\' branches can be approved')
  })

  it('approves branch when allowed (admin)', async () => {
    const res = await approveBranch(makeCtx(), { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('approves branch when allowed (reviewer)', async () => {
    const res = await approveBranch(
      makeCtx(),
      { user: { userId: 'u1', groups: [RESERVED_GROUPS.REVIEWERS] } },
      { branch: 'feature/x' }
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })
})
