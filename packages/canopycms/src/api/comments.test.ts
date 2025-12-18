import { describe, expect, it, vi } from 'vitest'
import { listComments, addComment, resolveComment } from './comments'
import type { ApiContext } from './types'

vi.mock('../comment-store', () => {
  return {
    CommentStore: vi.fn().mockImplementation(() => ({
      listThreads: vi.fn().mockResolvedValue([
        {
          id: 'thread1',
          comments: [{ id: 'c1', text: 'Test comment', userId: 'u1' }],
          resolved: false,
        },
      ]),
      addComment: vi.fn().mockResolvedValue({ threadId: 'thread1', commentId: 'c1' }),
      resolveThread: vi.fn().mockResolvedValue(true),
    })),
  }
})

const baseState = {
  branch: {
    name: 'feature/x',
    status: 'editing' as const,
    access: {},
    createdBy: 'u1',
    createdAt: 'now',
    updatedAt: 'now',
  },
}

const makeCtx = (allowed = true): ApiContext => ({
  services: {
    config: { schema: [], mode: 'local-simple' } as any,
    checkBranchAccess: vi.fn().mockReturnValue({ allowed, reason: allowed ? 'allowed' : 'denied' }),
    checkContentAccess: vi.fn(),
  },
  getBranchState: vi.fn().mockResolvedValue(baseState),
})

describe('comments api - listComments', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchState = vi.fn().mockResolvedValue(null)
    const res = await listComments(ctx, { user: { userId: 'u1' } }, { branch: 'missing' })
    expect(res.status).toBe(404)
  })

  it('returns 403 if access forbidden', async () => {
    const res = await listComments(
      makeCtx(false),
      { user: { userId: 'u1' } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(403)
  })

  it('lists comments when allowed', async () => {
    const res = await listComments(makeCtx(), { user: { userId: 'u1' } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(res.data?.threads).toHaveLength(1)
  })
})

describe('comments api - addComment', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchState = vi.fn().mockResolvedValue(null)
    const res = await addComment(
      ctx,
      { user: { userId: 'u1' }, body: { text: 'test' } },
      { branch: 'missing' },
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 if access forbidden', async () => {
    const res = await addComment(
      makeCtx(false),
      { user: { userId: 'u1' }, body: { text: 'test' } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 if text is missing', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { userId: 'u1' }, body: {} as any },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain('text is required')
  })

  it('adds comment when allowed', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { userId: 'u1' }, body: { text: 'Great work!' } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.threadId).toBe('thread1')
    expect(res.data?.commentId).toBe('c1')
  })

  it('accepts optional metadata', async () => {
    const res = await addComment(
      makeCtx(),
      {
        user: { userId: 'u1' },
        body: {
          text: 'Line comment',
          threadId: 'existing-thread',
          filePath: 'src/test.ts',
          lineNumber: 42,
          type: 'review' as const,
        },
      },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
  })
})

describe('comments api - resolveComment', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchState = vi.fn().mockResolvedValue(null)
    const res = await resolveComment(
      ctx,
      { user: { userId: 'u1', role: 'admin' } },
      { branch: 'missing', threadId: 'thread1' },
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 if user not admin/manager', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { userId: 'u1', role: 'editor' } },
      { branch: 'feature/x', threadId: 'thread1' },
    )
    expect(res.status).toBe(403)
    expect(res.error).toContain('Only admins and managers')
  })

  it('resolves thread when allowed (admin)', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { userId: 'u1', role: 'admin' } },
      { branch: 'feature/x', threadId: 'thread1' },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.resolved).toBe(true)
  })

  it('resolves thread when allowed (manager)', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { userId: 'u1', role: 'manager' } },
      { branch: 'feature/x', threadId: 'thread1' },
    )
    expect(res.ok).toBe(true)
  })
})
