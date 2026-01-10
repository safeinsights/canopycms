import { describe, expect, it, vi } from 'vitest'

const mockMetadataSave = vi.fn().mockResolvedValue({
  schemaVersion: 1,
  branch: {
    name: 'feature/x',
    status: 'editing',
    access: {},
    createdBy: 'u1',
    createdAt: 'now',
    updatedAt: 'now',
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

import { requestChanges, approveBranch } from './branch-review'
import { RESERVED_GROUPS } from '../reserved-groups'
import { mockConsole, createMockApiContext, createMockBranchContext } from '../test-utils'

// Extract handlers for testing
const requestChangesHandler = requestChanges.handler
const approveBranchHandler = approveBranch.handler

const baseContext = createMockBranchContext({
  branchName: 'feature/x',
  status: 'submitted',
  pullRequestNumber: 123,
  pullRequestUrl: 'https://github.com/owner/repo/pull/123',
})

const makeCtx = (githubService?: any) =>
  createMockApiContext({
    branchContext: baseContext,
    services: githubService ? { githubService } : undefined,
  })

describe('branch review api - requestChanges', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue(null)
    const res = await requestChangesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'missing' },
      {},
    )
    expect(res.status).toBe(404)
    expect(res.error).toBe('Branch not found')
  })

  it('returns 403 if user not admin/reviewer', async () => {
    const res = await requestChangesHandler(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      {},
    )
    expect(res.status).toBe(403)
    expect(res.error).toContain('Only Admins and Reviewers can request changes')
  })

  it('returns 400 if branch not submitted', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, status: 'editing' },
    })
    const res = await requestChangesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
      {},
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain("Only 'submitted' branches can have changes requested")
  })

  it('requests changes when allowed (admin)', async () => {
    const res = await requestChangesHandler(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
      {},
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('requests changes when allowed (reviewer)', async () => {
    const res = await requestChangesHandler(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.REVIEWERS] } },
      { branch: 'feature/x' },
      {},
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('converts PR to draft if github service available', async () => {
    const convertToDraft = vi.fn().mockResolvedValue(undefined)
    const githubService = { convertToDraft }
    const res = await requestChangesHandler(
      makeCtx(githubService),
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
      {},
    )
    expect(res.ok).toBe(true)
    expect(convertToDraft).toHaveBeenCalledWith(123)
  })

  it('handles github service errors gracefully', async () => {
    const consoleSpy = mockConsole()
    const convertToDraft = vi.fn().mockRejectedValue(new Error('API error'))
    const githubService = { convertToDraft }
    const res = await requestChangesHandler(
      makeCtx(githubService),
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
      {},
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
    const ctx = makeCtx(githubService)
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, pullRequestNumber: undefined },
    })
    const res = await requestChangesHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
      {},
    )
    expect(res.ok).toBe(true)
    expect(convertToDraft).not.toHaveBeenCalled()
  })

  it('accepts optional comment parameter', async () => {
    const res = await requestChangesHandler(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
      { comment: 'Please fix the typo' },
    )
    expect(res.ok).toBe(true)
  })
})

describe('branch review api - approveBranch', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue(null)
    const res = await approveBranchHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'missing' },
    )
    expect(res.status).toBe(404)
    expect(res.error).toBe('Branch not found')
  })

  it('returns 403 if user not admin/reviewer', async () => {
    const res = await approveBranchHandler(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(403)
    expect(res.error).toContain('Only Admins and Reviewers can approve branches')
  })

  it('returns 400 if branch not submitted', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, status: 'editing' },
    })
    const res = await approveBranchHandler(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain("Only 'submitted' branches can be approved")
  })

  it('approves branch when allowed (admin)', async () => {
    const res = await approveBranchHandler(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('approves branch when allowed (reviewer)', async () => {
    const res = await approveBranchHandler(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.REVIEWERS] } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })
})
