import { describe, expect, it, vi } from 'vitest'

vi.mock('../comment-store', () => ({
  CommentStore: vi.fn().mockImplementation(() => ({
    listThreads: vi.fn().mockResolvedValue([
      {
        id: 'thread1',
        comments: [
          {
            id: 'c1',
            text: 'Test comment',
            userId: 'u1',
            threadId: 'thread1',
            timestamp: '2024-01-01',
          },
        ],
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
}))

import { COMMENT_ROUTES } from './comments'
import { RESERVED_GROUPS } from '../authorization'
import { createMockApiContext, createMockBranchContext } from '../test-utils'

// Extract handlers for testing
const listComments = COMMENT_ROUTES.list.handler
const addComment = COMMENT_ROUTES.add.handler
const resolveComment = COMMENT_ROUTES.resolve.handler

const baseContext = createMockBranchContext({ branchName: 'feature/x' })

const makeCtx = (allowed = true) =>
  createMockApiContext({
    branchContext: baseContext,
    allowBranchAccess: allowed,
  })

describe('comments api - listComments', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue(null)
    const res = await listComments(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'missing' },
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 if access forbidden', async () => {
    const res = await listComments(
      makeCtx(false),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(403)
  })

  it('lists comments when allowed', async () => {
    const res = await listComments(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.threads).toHaveLength(1)
  })
})

describe('comments api - addComment', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue(null)
    const res = await addComment(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'missing' },
      { text: 'test', type: 'field', entryId: 'posts/hello', canopyPath: 'title' },
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 if access forbidden', async () => {
    const res = await addComment(
      makeCtx(false),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      { text: 'test', type: 'field', entryId: 'posts/hello', canopyPath: 'title' },
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 if canopyPath missing for field comment', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      { text: 'test', type: 'field', entryId: 'posts/hello' } as any,
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain('canopyPath required')
  })

  it('returns 400 if entryId missing for field comment', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      { text: 'test', type: 'field', canopyPath: 'title' } as any,
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain('entryId required')
  })

  it('returns 400 if entryId missing for entry comment', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      { text: 'test', type: 'entry' } as any,
    )
    expect(res.status).toBe(400)
    expect(res.error).toContain('entryId required')
  })

  it('adds field comment when allowed', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      { text: 'Great work!', type: 'field', entryId: 'posts/hello', canopyPath: 'title' },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.threadId).toBe('thread1')
    expect(res.data?.commentId).toBe('c1')
  })

  it('adds entry comment when allowed', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      { text: 'Entry feedback', type: 'entry', entryId: 'posts/hello' },
    )
    expect(res.ok).toBe(true)
  })

  it('adds branch comment when allowed', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      { text: 'Branch discussion', type: 'branch' },
    )
    expect(res.ok).toBe(true)
  })

  it('accepts optional threadId for replies', async () => {
    const res = await addComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
      {
        text: 'Reply comment',
        threadId: 'existing-thread',
        type: 'field',
        entryId: 'posts/hello',
        canopyPath: 'title',
      },
    )
    expect(res.ok).toBe(true)
  })
})

describe('comments api - resolveComment', () => {
  it('returns 404 if branch not found', async () => {
    const ctx = makeCtx()
    ctx.getBranchContext = vi.fn().mockResolvedValue(null)
    const res = await resolveComment(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'missing', threadId: 'thread1' },
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 if user is not author, reviewer, or admin', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u2', groups: [] } },
      { branch: 'feature/x', threadId: 'thread1' },
    )
    expect(res.status).toBe(403)
    expect(res.error).toContain('thread author, Reviewers, or Admins')
  })

  it('allows thread author to resolve', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x', threadId: 'thread1' },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.resolved).toBe(true)
  })

  it('allows admin to resolve', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u2', groups: [RESERVED_GROUPS.ADMINS] } },
      { branch: 'feature/x', threadId: 'thread1' },
    )
    expect(res.ok).toBe(true)
  })

  it('allows reviewer to resolve', async () => {
    const res = await resolveComment(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u2', groups: [RESERVED_GROUPS.REVIEWERS] } },
      { branch: 'feature/x', threadId: 'thread1' },
    )
    expect(res.ok).toBe(true)
  })
})
