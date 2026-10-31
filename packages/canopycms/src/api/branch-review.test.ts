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

// The status on disk, which a concurrent request can change after the guard read the branch.
const disk: { status: string | undefined; submitUnfinished?: boolean } = { status: 'submitted' }

// `saveIf` decides against the disk status, as the real one does inside its lock.
const mockSaveIf = vi.fn(
  async (
    update: unknown,
    onlyIf: (
      existing: { branch: { status?: string; submitUnfinished?: boolean } } | null,
    ) => boolean,
  ) =>
    onlyIf({ branch: { status: disk.status, submitUnfinished: disk.submitUnfinished } })
      ? mockMetadataSave(update)
      : null,
)

const { mockSyncPrComments } = vi.hoisted(() => ({
  mockSyncPrComments: vi.fn<(...args: unknown[]) => Promise<void>>(),
}))
vi.mock('./pr-comment-sync', () => ({ syncPrComments: mockSyncPrComments }))

vi.mock('../branch-metadata', () => ({
  BranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataSave,
    saveIf: mockSaveIf,
  })),
  getBranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataSave,
    saveIf: mockSaveIf,
  })),
}))

beforeEach(() => {
  disk.status = 'submitted'
  disk.submitUnfinished = undefined
  mockSyncPrComments.mockReset()
  mockSyncPrComments.mockResolvedValue(undefined)
})

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
    ['editing', "This branch is no longer in review: it's back with its editor."],
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
    disk.status = 'approved'
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, status: 'approved' },
    })
    const res = await requestChangesHandler(ctx, admin, { branch: 'feature/x' as BranchName }, {})
    expect(res.ok).toBe(true)
    expect(mockMetadataSave).toHaveBeenLastCalledWith({
      branch: expect.objectContaining({ name: 'feature/x', status: 'editing' }),
    })
  })

  it('records who requested changes, then shows it on the pull request', async () => {
    mockMetadataSave.mockClear()
    const ctx = makeCtx()
    const res = await requestChangesHandler(
      ctx,
      {
        user: {
          type: 'authenticated',
          userId: 'rev1',
          name: 'Rae <b>Viewer</b>',
          email: 'rae@example.com',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'feature/x' as BranchName },
      {},
    )
    expect(res.ok).toBe(true)
    expect(mockMetadataSave).toHaveBeenCalledTimes(1)
    const saved = mockMetadataSave.mock.calls[0]![0].branch
    expect(saved).toEqual({
      name: 'feature/x',
      status: 'editing',
      review: {
        state: 'changes-requested',
        by: { userId: 'rev1', name: 'Rae bViewer/b' },
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      },
    })
    expect(JSON.stringify(res.data?.branch)).not.toContain('rev1')
    expect(res.data?.branch).not.toHaveProperty('review')
    expect(mockSyncPrComments).toHaveBeenCalledTimes(1)
    expect(mockSyncPrComments).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ branchRoot: baseContext.branchRoot }),
    )
  })

  it('always records the reviewer, so a new verdict replaces an old approval', async () => {
    mockMetadataSave.mockClear()
    await requestChangesHandler(
      makeCtx(),
      {
        user: { type: 'authenticated', userId: 'rev2', groups: [RESERVED_GROUPS.REVIEWERS] },
      },
      { branch: 'feature/x' as BranchName },
      {},
    )
    expect(mockMetadataSave.mock.calls[0]![0].branch.review).toEqual({
      state: 'changes-requested',
      by: { userId: 'rev2' },
      at: expect.any(String),
    })
  })

  it('syncs the pull request body only after the review is saved', async () => {
    const order: string[] = []
    mockMetadataSave.mockImplementationOnce(async () => {
      order.push('save')
      return { branch: { ...baseContext.branch, status: 'editing' } }
    })
    mockSyncPrComments.mockImplementationOnce(async () => {
      order.push('sync')
    })
    await requestChangesHandler(makeCtx(), admin, { branch: 'feature/x' as BranchName }, {})
    expect(order).toEqual(['save', 'sync'])
  })

  describe('a status that changed after the guard read the branch', () => {
    it.each([
      ['editing', "This branch is no longer in review: it's back with its editor."],
      ['archived', "This branch is archived, so changes can't be requested."],
      [undefined, "This branch's status can't be read, so changes can't be requested."],
    ])('answers 409 for %s, writing nothing and leaving no note', async (status, error) => {
      const branchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-review-race-'))
      try {
        disk.status = status
        mockMetadataSave.mockClear()
        const ctx = makeCtx()
        ctx.getBranchContext = vi.fn().mockResolvedValue({ ...baseContext, branchRoot })
        const res = await requestChangesHandler(
          ctx,
          admin,
          { branch: 'feature/x' as BranchName },
          { note: 'Fix the intro.' },
        )
        expect(res.status).toBe(409)
        expect(res.error).toBe(error)
        expect(mockMetadataSave).not.toHaveBeenCalled()
        expect(mockSyncPrComments).not.toHaveBeenCalled()
        expect(Object.keys((await new CommentStore(branchRoot).load()).threads)).toHaveLength(0)
      } finally {
        await fs.rm(branchRoot, { recursive: true, force: true })
      }
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
        // The review block still changes, so the body is synced once all the same.
        expect(mockSyncPrComments).toHaveBeenCalledTimes(1)
      },
    )

    it("updates the pull request's comment summary once the note is saved", async () => {
      mockSyncPrComments.mockImplementationOnce(async () => {
        const { threads } = await new CommentStore(branchRoot).load()
        expect(Object.values(threads)).toHaveLength(1)
      })
      const res = await run({ note: 'Fix the intro.' })
      expect(res.ok).toBe(true)
      expect(mockSyncPrComments).toHaveBeenCalledTimes(1)
      // The branch as the status write left it, so a PR number recorded meanwhile is seen.
      expect(mockSyncPrComments.mock.calls[0]?.[1]).toMatchObject({
        branchRoot,
        branch: { status: 'editing' },
      })
    })

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

    it('syncs the pull request body after the note is saved, so one update carries both', async () => {
      const order: string[] = []
      mockMetadataSave.mockImplementationOnce(async () => {
        order.push('status')
        return { branch: { ...baseContext.branch, status: 'editing' } }
      })
      vi.spyOn(CommentStore.prototype, 'addComment').mockImplementation(async () => {
        order.push('comment')
        return { threadId: 't', commentId: 'c' }
      })
      mockSyncPrComments.mockImplementationOnce(async () => {
        order.push('sync')
      })
      await run({ note: 'x' })
      expect(order).toEqual(['status', 'comment', 'sync'])
    })

    it('syncs even when the note cannot be saved', async () => {
      const consoleSpy = mockConsole()
      vi.spyOn(CommentStore.prototype, 'addComment').mockRejectedValue(new Error('disk full'))
      await run({ note: 'x' })
      expect(mockSyncPrComments).toHaveBeenCalledTimes(1)
      consoleSpy.restore()
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
    ['editing', "This branch is no longer in review: it's back with its editor."],
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

  describe('while a submit is unfinished', () => {
    const reviewer = {
      user: { type: 'authenticated' as const, userId: 'r', groups: [RESERVED_GROUPS.REVIEWERS] },
    }

    it('refuses as a conflict, naming the reason and the way forward', async () => {
      disk.submitUnfinished = true
      mockMetadataSave.mockClear()

      const res = await approveBranchHandler(makeCtx(), reviewer, {
        branch: 'feature/x' as BranchName,
      })

      expect(res.status).toBe(409)
      expect(res.error).toContain("last submit didn't finish")
      expect(res.error).toContain('Ask an admin to retry the submit.')
      expect(mockMetadataSave).not.toHaveBeenCalled()
    })

    it('tells an admin where the retry is', async () => {
      disk.submitUnfinished = true

      const res = await approveBranchHandler(makeCtx(), admin, {
        branch: 'feature/x' as BranchName,
      })

      expect(res.status).toBe(409)
      expect(res.error).toContain('the "Tasks" tab in "System health"')
    })

    it('says a branch that has left review has left, whatever it still owes', async () => {
      disk.status = 'editing'
      disk.submitUnfinished = true

      const res = await approveBranchHandler(makeCtx(), admin, {
        branch: 'feature/x' as BranchName,
      })

      expect(res.status).toBe(409)
      expect(res.error).not.toContain("didn't finish")
    })
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
      branch: {
        name: 'feature/x',
        status: 'approved',
        review: {
          state: 'approved',
          by: { userId: 'rev1' },
          at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
        },
      },
    })
  })

  it('records the approver by cleaned name, never sends it to the client, and syncs the PR body', async () => {
    mockMetadataSave.mockClear()
    const ctx = makeCtx()
    const res = await approveBranchHandler(
      ctx,
      {
        user: {
          type: 'authenticated',
          userId: 'rev1',
          name: 'Rae\nViewer',
          email: 'rae@example.com',
          groups: [RESERVED_GROUPS.ADMINS],
        },
      },
      { branch: 'feature/x' as BranchName },
    )
    expect(res.status).toBe(200)
    expect(mockMetadataSave.mock.calls[0]![0].branch.review).toEqual({
      state: 'approved',
      by: { userId: 'rev1', name: 'Rae Viewer' },
      at: expect.any(String),
    })
    expect(res.data?.branch).not.toHaveProperty('review')
    expect(JSON.stringify(res.data)).not.toContain('rae@example.com')
    expect(mockSyncPrComments).toHaveBeenCalledTimes(1)
    expect(mockSyncPrComments).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ branchRoot: baseContext.branchRoot }),
    )
  })

  it('syncs against the branch the save returned, which can carry a PR the guard did not see', async () => {
    // On the queued path the worker can record the PR's number after the guard has read the branch.
    mockMetadataSave.mockImplementationOnce(async () => ({
      branch: { ...baseContext.branch, status: 'approved', pullRequestNumber: 456 },
    }))
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue({
      ...baseContext,
      branch: { ...baseContext.branch, pullRequestNumber: undefined },
    })
    const res = await approveBranchHandler(ctx, admin, { branch: 'feature/x' as BranchName })
    expect(res.status).toBe(200)
    expect(mockSyncPrComments.mock.calls[0]?.[1]).toMatchObject({
      branch: { status: 'approved', pullRequestNumber: 456 },
    })
  })

  it.each([
    ['editing', "This branch is no longer in review: it's back with its editor."],
    ['approved', 'This branch is already approved.'],
    [undefined, "This branch's status can't be read, so it can't be approved."],
  ])('answers 409, writing nothing, when the status on disk became %s', async (status, error) => {
    disk.status = status
    mockMetadataSave.mockClear()
    const res = await approveBranchHandler(makeCtx(), admin, { branch: 'feature/x' as BranchName })
    expect(res.status).toBe(409)
    expect(res.error).toBe(error)
    expect(mockMetadataSave).not.toHaveBeenCalled()
    expect(mockSyncPrComments).not.toHaveBeenCalled()
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
