import { describe, expect, it, vi } from 'vitest'
import { listComments, addComment, resolveComment } from './comments'
import type { ApiContext } from './types'
import { RESERVED_GROUPS } from '../reserved-groups'

vi.mock('../comment-store', () => {
  return {
    CommentStore: vi.fn().mockImplementation(() => ({
      listThreads: vi.fn().mockResolvedValue([
        {
          id: 'thread1',
          comments: [{ id: 'c1', text: 'Test comment', userId: 'u1', threadId: 'thread1', timestamp: '2024-01-01' }],
          resolved: false,
          type: 'field',
          entryId: 'posts/hello',
          canopyPath: 'title',
          authorId: 'u1',
          createdAt: '2024-01-01',
        },
      ]),
      addComment: vi.fn().mockResolvedValue({ threadId: 'thread1', commentId: 'c1' }),
      getThread: vi.fn().mockResolvedValue({
        id: 'thread1',
        comments: [],
        resolved: false,
        type: 'field',
        entryId: 'posts/hello',
        canopyPath: 'title',
        authorId: 'u1',
        createdAt: '2024-01-01',
      }),
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
    const res = await listComments(makeCtx(false), { user: { userId: 'u1' } }, { branch: 'feature/x' })
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
      { user: { userId: 'u1' }, body: { text: 'test', type: 'field', entryId: 'posts/hello', canopyPath: 'title' } },
      { branch: 'missing' }
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 if access forbidden', async () => {
    const res = await addComment(
      makeCtx(false),
      { user: { userId: 'u1' }, body: { text: 'test', type: 'field', entryId: 'posts/hello', canopyPath: 'title' } },
      { branch: 'feature/x' }
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 if text is missing', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { userId: 'u1' }, body: { type: 'field' } as any },
      { branch: 'feature/x' }
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain('text is required')
  })

  it('returns 400 if type is missing', async () => {
    const res = await addComment(makeCtx(), { user: { userId: 'u1' }, body: { text: 'test' } as any }, { branch: 'feature/x' })
    expect(res.status).toBe(400)
    expect(res.error).toContain('type is required')
  })

  it('returns 400 if canopyPath missing for field comment', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { userId: 'u1' }, body: { text: 'test', type: 'field', entryId: 'posts/hello' } as any },
      { branch: 'feature/x' }
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain('canopyPath required')
  })

  it('returns 400 if entryId missing for field comment', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { userId: 'u1' }, body: { text: 'test', type: 'field', canopyPath: 'title' } as any },
      { branch: 'feature/x' }
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain('entryId required')
  })

  it('returns 400 if entryId missing for entry comment', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { userId: 'u1' }, body: { text: 'test', type: 'entry' } as any },
      { branch: 'feature/x' }
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain('entryId required')
  })

  it('adds field comment when allowed', async () => {
    const res = await addComment(
      makeCtx(),
      {
        user: { userId: 'u1' },
        body: { text: 'Great work!', type: 'field', entryId: 'posts/hello', canopyPath: 'title' },
      },
      { branch: 'feature/x' }
    )
    expect(res.ok).toBe(true)
    expect(res.data?.threadId).toBe('thread1')
    expect(res.data?.commentId).toBe('c1')
  })

  it('adds entry comment when allowed', async () => {
    const res = await addComment(
      makeCtx(),
      {
        user: { userId: 'u1' },
        body: { text: 'Entry feedback', type: 'entry', entryId: 'posts/hello' },
      },
      { branch: 'feature/x' }
    )
    expect(res.ok).toBe(true)
  })

  it('adds branch comment when allowed', async () => {
    const res = await addComment(
      makeCtx(),
      {
        user: { userId: 'u1' },
        body: { text: 'Branch discussion', type: 'branch' },
      },
      { branch: 'feature/x' }
    )
    expect(res.ok).toBe(true)
  })

  it('accepts optional threadId for replies', async () => {
    const res = await addComment(
      makeCtx(),
      {
        user: { userId: 'u1' },
        body: {
          text: 'Reply comment',
          threadId: 'existing-thread',
          type: 'field',
          entryId: 'posts/hello',
          canopyPath: 'title',
        },
      },
      { branch: 'feature/x' }
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
      { user: { userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'missing', threadId: 'thread1' }
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 if user is not author, reviewer, or admin', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { userId: 'u2', groups: [] } },
      { branch: 'feature/x', threadId: 'thread1' }
    )
    expect(res.status).toBe(403)
    expect(res.error).toContain('thread author, Reviewers, or Admins')
  })

  it('allows thread author to resolve', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { userId: 'u1', groups: [] } },
      { branch: 'feature/x', threadId: 'thread1' }
    )
    expect(res.ok).toBe(true)
    expect(res.data?.resolved).toBe(true)
  })

  it('allows admin to resolve', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { userId: 'u2', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x', threadId: 'thread1' }
    )
    expect(res.ok).toBe(true)
  })

  it('allows reviewer to resolve', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { userId: 'u2', groups: [RESERVED_GROUPS.REVIEWERS] } },
      { branch: 'feature/x', threadId: 'thread1' }
    )
    expect(res.ok).toBe(true)
  })
})
