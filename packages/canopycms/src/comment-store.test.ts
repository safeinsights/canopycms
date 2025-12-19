import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { CommentStore } from './comment-store'

describe('CommentStore', () => {
  let tmpDir: string
  let store: CommentStore

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-store-test-'))
    store = new CommentStore(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('loads empty structure when file does not exist', async () => {
    const data = await store.load()
    expect(data.schemaVersion).toBe(1)
    expect(data.threads).toEqual({})
  })

  it('creates new field comment thread', async () => {
    const result = await store.addComment({
      userId: 'user1',
      text: 'First comment',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    expect(result.threadId).toBeTruthy()
    expect(result.commentId).toBeTruthy()

    const threads = await store.listThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].comments).toHaveLength(1)
    expect(threads[0].comments[0].text).toBe('First comment')
    expect(threads[0].comments[0].userId).toBe('user1')
    expect(threads[0].type).toBe('field')
    expect(threads[0].entryId).toBe('posts/hello')
    expect(threads[0].canopyPath).toBe('title')
    expect(threads[0].authorId).toBe('user1')
    expect(threads[0].createdAt).toBeTruthy()
  })

  it('creates entry-level comment thread', async () => {
    const result = await store.addComment({
      userId: 'user1',
      text: 'Entry comment',
      type: 'entry',
      entryId: 'posts/hello',
    })

    const thread = await store.getThread(result.threadId)
    expect(thread?.type).toBe('entry')
    expect(thread?.entryId).toBe('posts/hello')
    expect(thread?.canopyPath).toBeUndefined()
  })

  it('creates branch-level comment thread', async () => {
    const result = await store.addComment({
      userId: 'user1',
      text: 'Branch discussion',
      type: 'branch',
    })

    const thread = await store.getThread(result.threadId)
    expect(thread?.type).toBe('branch')
    expect(thread?.entryId).toBeUndefined()
    expect(thread?.canopyPath).toBeUndefined()
  })

  it('adds comment to existing thread', async () => {
    const first = await store.addComment({
      userId: 'user1',
      text: 'First comment',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    const second = await store.addComment({
      userId: 'user2',
      text: 'Reply',
      type: 'field',
      threadId: first.threadId,
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    expect(second.threadId).toBe(first.threadId)

    const thread = await store.getThread(first.threadId)
    expect(thread?.comments).toHaveLength(2)
    expect(thread?.comments[1].text).toBe('Reply')
    expect(thread?.comments[1].userId).toBe('user2')
  })

  it('resolves thread with userId', async () => {
    const result = await store.addComment({
      userId: 'user1',
      text: 'Comment',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    await store.resolveThread(result.threadId, 'reviewer1')

    const thread = await store.getThread(result.threadId)
    expect(thread?.resolved).toBe(true)
    expect(thread?.resolvedBy).toBe('reviewer1')
    expect(thread?.resolvedAt).toBeTruthy()
  })

  it('filters resolved threads when requested', async () => {
    const unresolved = await store.addComment({
      userId: 'user1',
      text: 'Unresolved',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    const resolved = await store.addComment({
      userId: 'user2',
      text: 'Resolved',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'description',
    })

    await store.resolveThread(resolved.threadId, 'user2')

    const allThreads = await store.listThreads({ includeResolved: true })
    expect(allThreads).toHaveLength(2)

    const unresolvedOnly = await store.listThreads({ includeResolved: false })
    expect(unresolvedOnly).toHaveLength(1)
    expect(unresolvedOnly[0].id).toBe(unresolved.threadId)
  })

  it('gets threads for specific field', async () => {
    await store.addComment({
      userId: 'user1',
      text: 'Title comment',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    await store.addComment({
      userId: 'user2',
      text: 'Description comment',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'description',
    })

    const titleThreads = await store.getThreadsForField('posts/hello', 'title')
    expect(titleThreads).toHaveLength(1)
    expect(titleThreads[0].comments[0].text).toBe('Title comment')
  })

  it('gets threads for specific entry', async () => {
    await store.addComment({
      userId: 'user1',
      text: 'Entry comment 1',
      type: 'entry',
      entryId: 'posts/hello',
    })

    await store.addComment({
      userId: 'user2',
      text: 'Entry comment 2',
      type: 'entry',
      entryId: 'posts/hello',
    })

    await store.addComment({
      userId: 'user3',
      text: 'Different entry',
      type: 'entry',
      entryId: 'posts/world',
    })

    const entryThreads = await store.getThreadsForEntry('posts/hello')
    expect(entryThreads).toHaveLength(2)
  })

  it('gets branch-level threads', async () => {
    await store.addComment({
      userId: 'user1',
      text: 'Branch comment 1',
      type: 'branch',
    })

    await store.addComment({
      userId: 'user2',
      text: 'Branch comment 2',
      type: 'branch',
    })

    await store.addComment({
      userId: 'user3',
      text: 'Field comment',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    const branchThreads = await store.getBranchThreads()
    expect(branchThreads).toHaveLength(2)
  })

  it('sorts threads by createdAt timestamp', async () => {
    // Add threads with slight delays to ensure different timestamps
    await store.addComment({
      userId: 'user1',
      text: 'Second thread',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    // Small delay
    await new Promise((resolve) => setTimeout(resolve, 10))

    await store.addComment({
      userId: 'user2',
      text: 'Third thread',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    const threads = await store.getThreadsForField('posts/hello', 'title')
    expect(threads).toHaveLength(2)
    expect(threads[0].comments[0].text).toBe('Second thread')
    expect(threads[1].comments[0].text).toBe('Third thread')
  })

  it('deletes thread', async () => {
    const result = await store.addComment({
      userId: 'user1',
      text: 'To delete',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    const deleted = await store.deleteThread(result.threadId)
    expect(deleted).toBe(true)

    const thread = await store.getThread(result.threadId)
    expect(thread).toBeNull()
  })

  it('returns false when resolving non-existent thread', async () => {
    const result = await store.resolveThread('non-existent', 'user1')
    expect(result).toBe(false)
  })

  it('returns false when deleting non-existent thread', async () => {
    const result = await store.deleteThread('non-existent')
    expect(result).toBe(false)
  })

  it('persists data to file', async () => {
    await store.addComment({
      userId: 'user1',
      text: 'Persisted',
      type: 'field',
      entryId: 'posts/hello',
      canopyPath: 'title',
    })

    // Create new store instance pointing to same directory
    const newStore = new CommentStore(tmpDir)
    const threads = await newStore.listThreads()

    expect(threads).toHaveLength(1)
    expect(threads[0].comments[0].text).toBe('Persisted')
  })
})
