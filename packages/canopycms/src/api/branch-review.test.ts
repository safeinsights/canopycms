import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { RESERVED_GROUPS } from '../authorization'
import { CommentStore } from '../comment-store'
import { mockConsole, createMockApiContext, createMockBranchContext } from '../test-utils'

// Extract handlers for testing
const requestChangesHandler = requestChanges.handler
const approveBranchHandler = approveBranch.handler

// The creator is not one of the test reviewers, because the creator cannot approve.
const baseContext = createMockBranchContext({
  branchName: 'feature/x',
  createdBy: 'creator',
  status: 'submitted',
  pullRequestNumber: 123,
  pullRequestUrl: 'https://github.com/owner/repo/pull/123',
})

const admin = {
  user: { type: 'authenticated' as const, userId: 'rev1', groups: [RESERVED_GROUPS.ADMINS] },
}

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
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'missing' as BranchName },
      {},
    )
    expect(res.status).toBe(404)
    expect(res.error).toBe('Branch not found')
  })

  it('returns 403 if user not admin/reviewer', async () => {
    const res = await requestChangesHandler(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
      {},
    )
    expect(res.status).toBe(403)
    expect(res.error).toContain('Reviewer access required')
  })

  it.each([
    ['editing', 'This branch is no longer in review. Its editor has it back for editing.'],
    ['archived', "This branch is archived, so changes can't be requested."],
  ])('answers 409 for a branch that is %s', async (status, error) => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, status },
    })
    const res = await requestChangesHandler(
      ctx,
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'feature/x' as BranchName },
      {},
    )
    expect(res.status).toBe(409)
    expect(res.error).toBe(error)
  })

  it('requests changes when allowed (admin)', async () => {
    const res = await requestChangesHandler(
      makeCtx(),
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'feature/x' as BranchName },
      {},
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(res.data?.branch).toMatchObject({
      status: 'editing',
      writeBlocked: false,
      submitBlocked: false,
    })
  })

  it('requests changes when allowed (reviewer)', async () => {
    const res = await requestChangesHandler(
      makeCtx(),
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.REVIEWERS],
        },
      },
      { branch: 'feature/x' as BranchName },
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
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'feature/x' as BranchName },
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
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'feature/x' as BranchName },
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
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'feature/x' as BranchName },
      {},
    )
    expect(res.ok).toBe(true)
    expect(convertToDraft).not.toHaveBeenCalled()
  })

  it('requests changes on an approved branch', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, status: 'approved' },
    })
    const res = await requestChangesHandler(ctx, admin, { branch: 'feature/x' as BranchName }, {})
    expect(res.ok).toBe(true)
    expect(mockMetadataSave).toHaveBeenLastCalledWith({
      branch: { name: 'feature/x', status: 'editing' },
    })
  })

  describe('note', () => {
    let branchRoot: string
    const run = (body: { note?: string } | undefined, branchStatus = 'submitted') => {
      const ctx = makeCtx()
      ctx.getBranchContext = vi.fn().mockResolvedValue({
        ...baseContext,
        branchRoot,
        branch: { ...baseContext.branch, status: branchStatus },
      })
      // The handler receives the body as the endpoint's schema leaves it.
      const parsed = requestChanges.validate({ params: { branch: 'feature/x' }, body })
      if (!parsed.ok) throw new Error(parsed.error)
      return requestChangesHandler(
        ctx,
        admin,
        { branch: 'feature/x' as BranchName },
        parsed.body as { note?: string } | undefined,
      )
    }

    beforeEach(async () => {
      branchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-review-'))
    })
    afterEach(async () => {
      vi.restoreAllMocks()
      await fs.rm(branchRoot, { recursive: true, force: true })
    })

    it('saves a note as a branch-level thread', async () => {
      const res = await run({ note: '  Please fix the intro.  ' })
      expect(res.ok).toBe(true)
      expect(res.data).not.toHaveProperty('warning')
      const { threads } = await new CommentStore(branchRoot).load()
      const [thread] = Object.values(threads)
      expect(Object.values(threads)).toHaveLength(1)
      expect(thread.type).toBe('branch')
      expect(thread.comments).toHaveLength(1)
      expect(thread.comments[0].text).toBe('Changes requested: Please fix the intro.')
      expect(thread.comments[0].userId).toBe('rev1')
    })

    it.each([undefined, {}, { note: '' }, { note: '  \n ' }])(
      'writes no thread for an absent or empty note (%j)',
      async (body) => {
        const res = await run(body)
        expect(res.ok).toBe(true)
        const { threads } = await new CommentStore(branchRoot).load()
        expect(Object.keys(threads)).toHaveLength(0)
      },
    )

    it('rejects a note over 2,000 characters at the endpoint boundary, after trimming', () => {
      const validate = (note: string) =>
        requestChanges.validate({ params: { branch: 'feature/x' }, body: { note } })
      expect(validate('x'.repeat(2000)).ok).toBe(true)
      expect(validate(`  ${'x'.repeat(2000)}  `).ok).toBe(true)
      expect(validate('x'.repeat(2001)).ok).toBe(false)
    })

    it('saves the note after the status change', async () => {
      const order: string[] = []
      mockMetadataSave.mockImplementationOnce(async () => {
        order.push('status')
        return { branch: { ...baseContext.branch, status: 'editing' } }
      })
      vi.spyOn(CommentStore.prototype, 'addComment').mockImplementation(async () => {
        order.push('comment')
        return { threadId: 't', commentId: 'c' }
      })
      await run({ note: 'x' })
      expect(order).toEqual(['status', 'comment'])
    })

    it('still succeeds, with a warning, when the note cannot be saved', async () => {
      const consoleSpy = mockConsole()
      vi.spyOn(CommentStore.prototype, 'addComment').mockRejectedValue(new Error('disk full'))
      const res = await run({ note: 'x' })
      expect(res.ok).toBe(true)
      expect(res.status).toBe(200)
      expect(res.data?.branch).toBeDefined()
      expect(res.data?.warning).toBe("Changes were requested, but your note couldn't be saved.")
      expect(consoleSpy).toHaveErrored('disk full')
      consoleSpy.restore()
    })
  })
})

describe('branch review api - approveBranch', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue(null)
    const res = await approveBranchHandler(
      ctx,
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'missing' as BranchName },
    )
    expect(res.status).toBe(404)
    expect(res.error).toBe('Branch not found')
  })

  it('returns 403 if user not admin/reviewer', async () => {
    const res = await approveBranchHandler(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.status).toBe(403)
    expect(res.error).toContain('Reviewer access required')
  })

  it.each([
    ['editing', 'This branch is no longer in review. Its editor has it back for editing.'],
    ['approved', 'This branch is already approved.'],
    ['archived', "This branch is archived, so it can't be approved."],
  ])('answers 409 for a branch that is %s', async (status, error) => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, status },
    })
    const res = await approveBranchHandler(
      ctx,
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.status).toBe(409)
    expect(res.error).toBe(error)
  })

  it('approves branch when allowed (admin)', async () => {
    const res = await approveBranchHandler(
      makeCtx(),
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it('approves branch when allowed (reviewer)', async () => {
    const res = await approveBranchHandler(
      makeCtx(),
      {
        user: {
          type: 'authenticated',
          userId: 'u1',
          groups: [RESERVED_GROUPS.REVIEWERS],
        },
      },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
  })

  it("refuses the branch's creator", async () => {
    const res = await approveBranchHandler(
      makeCtx(),
      {
        user: { type: 'authenticated', userId: 'creator', groups: [RESERVED_GROUPS.ADMINS] },
      },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.status).toBe(403)
    expect(res.error).toBe(
      "You can't approve a branch you created. Ask another reviewer to approve it.",
    )
  })

  it('saves status approved for another reviewer', async () => {
    mockMetadataSave.mockClear()
    const res = await approveBranchHandler(makeCtx(), admin, { branch: 'feature/x' as BranchName })
    expect(res.status).toBe(200)
    expect(mockMetadataSave).toHaveBeenCalledWith({
      branch: { name: 'feature/x', status: 'approved' },
    })
  })

  it('refuses the protected base branch', async () => {
    mockMetadataSave.mockClear()
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, name: 'main' },
    })
    const res = await approveBranchHandler(ctx, admin, { branch: 'main' as BranchName })
    expect(res.status).toBe(400)
    expect(res.error).toBe("The base branch can't be approved.")
    expect(mockMetadataSave).not.toHaveBeenCalled()
  })

  it('refuses when the pull request was closed', async () => {
    mockMetadataSave.mockClear()
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, pullRequestState: 'closed' },
    })
    const res = await approveBranchHandler(ctx, admin, { branch: 'feature/x' as BranchName })
    expect(res.status).toBe(400)
    expect(res.error).toContain('pull request was closed')
    expect(mockMetadataSave).not.toHaveBeenCalled()
  })
})
