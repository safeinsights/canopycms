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

// Extract handler for testing
const withdrawHandler = withdrawBranch.handler

const baseContext = createMockBranchContext({
  branchName: 'feature/x',
  status: 'submitted',
  pullRequestNumber: 123,
  pullRequestUrl: 'https://github.com/owner/repo/pull/123',
})

const makeCtx = (allowed = true, githubService?: any) =>
  createMockApiContext({
    branchContext: baseContext,
    allowBranchAccess: allowed,
    services: githubService ? { githubService } : undefined,
  })

describe('branch withdraw api', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue(null)
    const res = await withdrawHandler(ctx, { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: 'missing' })
    expect(res.status).toBe(404)
    expect(res.error).toBe('Branch not found')
  })

  it('returns 403 if access forbidden', async () => {
    const res = await withdrawHandler(makeCtx(false), { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.status).toBe(403)
    expect(res.error).toBe('Forbidden')
  })

  it('returns 400 if branch not submitted', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, status: 'editing' },
    })
    const res = await withdrawHandler(ctx, { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.status).toBe(400)
    expect(res.error).toContain('Only \'submitted\' branches can be withdrawn')
  })

  it('withdraws branch when allowed', async () => {
    const res = await withdrawHandler(makeCtx(true), { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('converts PR to draft if github service available', async () => {
    const convertToDraft = vi.fn().mockResolvedValue(undefined)
    const githubService = { convertToDraft }
    const res = await withdrawHandler(makeCtx(true, githubService), { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(convertToDraft).toHaveBeenCalledWith(123)
  })

  it('handles github service errors gracefully', async () => {
    const consoleSpy = mockConsole()
    const convertToDraft = vi.fn().mockRejectedValue(new Error('API error'))
    const githubService = { convertToDraft }
    const res = await withdrawHandler(makeCtx(true, githubService), { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: 'feature/x' })
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
    const res = await withdrawHandler(ctx, { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(convertToDraft).not.toHaveBeenCalled()
  })
})
