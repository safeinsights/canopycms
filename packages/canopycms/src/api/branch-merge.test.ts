import { describe, it, expect, vi, beforeEach } from 'vitest'
import { markAsMerged } from './branch-merge'
import type { ApiContext, ApiRequest } from './types'
import type { BranchName } from '../paths/types'
import { RESERVED_GROUPS } from '../authorization'
import { mockConsole } from '../test-utils/console-spy.js'

// Extract handler for testing
const markAsMergedHandler = markAsMerged.handler

// Shared mock `save` so tests can inspect what markAsMerged actually wrote,
// created via vi.hoisted since vi.mock factories can't close over ordinary
// module-scope variables (hoisting).
const { mockSave } = vi.hoisted(() => ({ mockSave: vi.fn().mockResolvedValue(undefined) }))

vi.mock('../branch-metadata', async () => {
  // buildMergedBranchUpdate is a pure helper (no fs/git access) that the
  // handler imports from this module -- spread the real module so it stays
  // defined instead of undefined, while BranchMetadataFileManager/
  // getBranchMetadataFileManager stay mocked to avoid touching the filesystem.
  const actual = await vi.importActual<typeof import('../branch-metadata')>('../branch-metadata')
  return {
    ...actual,
    BranchMetadataFileManager: vi.fn().mockImplementation(() => ({
      save: mockSave,
    })),
    getBranchMetadataFileManager: vi.fn().mockImplementation(() => ({
      save: mockSave,
    })),
  }
})

describe('branch merge api - markAsMerged', () => {
  let ctx: ApiContext
  let req: ApiRequest
  let mockGithubService: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockGithubService = {
      getPullRequest: vi.fn().mockResolvedValue({ merged: true }),
    }

    ctx = {
      services: {
        checkBranchAccess: vi.fn().mockResolvedValue({ allowed: true }),
        githubService: mockGithubService,
      } as any,
      getBranchContext: vi.fn().mockResolvedValue({
        baseRoot: '/test',
        branchRoot: '/test/feature-x',
        branch: {
          name: 'feature/x',
          status: 'submitted',
          createdBy: 'user1',
          updatedAt: new Date().toISOString(),
          pullRequestNumber: 42,
        },
      }),
    } as any

    req = {
      user: { userId: 'admin1', groups: [RESERVED_GROUPS.ADMINS] },
      body: {},
    } as any
  })

  it('marks a submitted branch as archived after PR is merged', async () => {
    const result = await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.data?.branch.status).toBe('archived')
  })

  it('verifies PR is merged on GitHub before marking', async () => {
    await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    expect(mockGithubService.getPullRequest).toHaveBeenCalledWith(42)
  })

  it('saves via buildMergedBranchUpdate: status archived, pullRequestState merged, mergedAt is a string', async () => {
    await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    expect(mockSave).toHaveBeenCalledWith({
      branch: expect.objectContaining({
        name: 'feature/x',
        status: 'archived',
        pullRequestState: 'merged',
        mergedAt: expect.any(String),
      }),
    })
  })

  it('returns 404 if branch not found', async () => {
    ctx.getBranchContext = vi.fn().mockResolvedValue(null)

    const result = await markAsMergedHandler(ctx, req, {
      branch: 'nonexistent' as BranchName,
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
    expect(result.error).toContain('not found')
  })

  it('returns 403 if user lacks admin access', async () => {
    req.user.groups = [] // Not an admin

    const result = await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
    expect(result.error).toContain('Admin access required')
  })

  it('marks an approved branch as archived (manual fallback reaches everything the merge-poll does)', async () => {
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      baseRoot: '/test',
      branchRoot: '/test/feature-x',
      branch: {
        name: 'feature/x',
        status: 'approved',
        createdBy: 'user1',
        updatedAt: new Date().toISOString(),
        pullRequestNumber: 42,
      },
    })

    const result = await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.data?.branch.status).toBe('archived')
  })

  it('returns 400 if branch is not submitted or approved', async () => {
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      baseRoot: '/test',
      branchRoot: '/test/feature-x',
      branch: {
        name: 'feature/x',
        status: 'editing',
        createdBy: 'user1',
        updatedAt: new Date().toISOString(),
      },
    })

    const result = await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(result.error).toContain('status is "editing"')
    expect(result.error).toContain('"submitted" or "approved"')
  })

  it('returns 400 if branch has no PR', async () => {
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      baseRoot: '/test',
      branchRoot: '/test/feature-x',
      branch: {
        name: 'feature/x',
        status: 'submitted',
        createdBy: 'user1',
        updatedAt: new Date().toISOString(),
      },
    })

    const result = await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(result.error).toContain('no pull request')
  })

  it('returns 400 if PR is not merged on GitHub', async () => {
    mockGithubService.getPullRequest = vi.fn().mockResolvedValue({ merged: false })

    const result = await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(result.error).toContain('not merged on GitHub')
  })

  it('handles github service errors gracefully', async () => {
    const consoleSpy = mockConsole()
    mockGithubService.getPullRequest = vi.fn().mockRejectedValue(new Error('API error'))

    const result = await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    // Should still succeed (manual override allowed)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(consoleSpy).toHaveErrored('Failed to verify PR merge status')
    consoleSpy.restore()
  })

  it('works without github service (manual mode)', async () => {
    ctx.services.githubService = undefined

    const result = await markAsMergedHandler(ctx, req, { branch: 'feature/x' as BranchName })

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })
})
