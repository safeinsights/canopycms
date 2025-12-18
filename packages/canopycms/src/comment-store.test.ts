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

  it('creates new thread when adding first comment', async () => {
    const result = await store.addComment({
      userId: 'user1',
      text: 'First comment',
      type: 'discussion',
    })

    expect(result.threadId).toBeTruthy()
    expect(result.commentId).toBeTruthy()

    const threads = await store.listThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].comments).toHaveLength(1)
    expect(threads[0].comments[0].text).toBe('First comment')
    expect(threads[0].comments[0].userId).toBe('user1')
  })

  it('adds comment to existing thread', async () => {
    const first = await store.addComment({
      userId: 'user1',
      text: 'First comment',
    })

    const second = await store.addComment({
      userId: 'user2',
      text: 'Reply',
      threadId: first.threadId,
    })

    expect(second.threadId).toBe(first.threadId)

    const thread = await store.getThread(first.threadId)
    expect(thread?.comments).toHaveLength(2)
    expect(thread?.comments[1].text).toBe('Reply')
  })

  it('resolves thread and all comments', async () => {
    const result = await store.addComment({
      userId: 'user1',
      text: 'Comment',
    })

    await store.resolveThread(result.threadId)

    const thread = await store.getThread(result.threadId)
    expect(thread?.resolved).toBe(true)
    expect(thread?.comments[0].resolved).toBe(true)
  })

  it('filters resolved threads when requested', async () => {
    const unresolved = await store.addComment({
      userId: 'user1',
      text: 'Unresolved',
    })

    const resolved = await store.addComment({
      userId: 'user2',
      text: 'Resolved',
    })

    await store.resolveThread(resolved.threadId)

    const allThreads = await store.listThreads({ includeResolved: true })
    expect(allThreads).toHaveLength(2)

    const unresolvedOnly = await store.listThreads({ includeResolved: false })
    expect(unresolvedOnly).toHaveLength(1)
    expect(unresolvedOnly[0].id).toBe(unresolved.threadId)
  })

  it('stores file path and line number metadata', async () => {
    const result = await store.addComment({
      userId: 'user1',
      text: 'Line comment',
      filePath: 'src/test.ts',
      lineNumber: 42,
      type: 'review',
    })

    const thread = await store.getThread(result.threadId)
    expect(thread?.filePath).toBe('src/test.ts')
    expect(thread?.lineRange).toEqual({ start: 42, end: 42 })
    expect(thread?.comments[0].lineNumber).toBe(42)
    expect(thread?.comments[0].type).toBe('review')
  })

  it('deletes thread', async () => {
    const result = await store.addComment({
      userId: 'user1',
      text: 'To delete',
    })

    const deleted = await store.deleteThread(result.threadId)
    expect(deleted).toBe(true)

    const thread = await store.getThread(result.threadId)
    expect(thread).toBeNull()
  })

  it('returns false when resolving non-existent thread', async () => {
    const result = await store.resolveThread('non-existent')
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
    })

    // Create new store instance pointing to same directory
    const newStore = new CommentStore(tmpDir)
    const threads = await newStore.listThreads()

    expect(threads).toHaveLength(1)
    expect(threads[0].comments[0].text).toBe('Persisted')
  })
})
