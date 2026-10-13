/**
 * A new field thread inside list items names each item on its path by key, one per list index
 * (`CommentThread.itemKeys`); a reply, an entry thread and a field thread outside any list name
 * none. Runs against a real `CommentStore`, so the thread that lands is the one read back.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommentStore } from '../comment-store'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { unsafeAsBranchName, unsafeAsLogicalPath } from '../paths/test-utils'
import { COMMENT_ROUTES } from './comments'

type AddCommentBody = Parameters<typeof COMMENT_ROUTES.add.handler>[3]

const ENTRY = unsafeAsLogicalPath('content/posts/hello')
const branch = unsafeAsBranchName('feature/x')
const user = { type: 'authenticated' as const, userId: 'u1', groups: [] as string[] }

let root: string
let store: CommentStore

const makeCtx = () =>
  createMockApiContext({
    allowBranchAccess: true,
    branchContext: createMockBranchContext({
      branchName: 'feature/x',
      baseRoot: root,
      branchRoot: root,
    }),
  })
const add = (body: AddCommentBody) =>
  COMMENT_ROUTES.add.handler(makeCtx(), { user }, { branch }, body)
const field = (canopyPath: string, itemKeys?: string[], extra: Partial<AddCommentBody> = {}) => ({
  text: 'Note',
  type: 'field' as const,
  entryPath: ENTRY,
  canopyPath,
  ...(itemKeys ? { itemKeys } : {}),
  ...extra,
})

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-comments-keys-'))
  store = new CommentStore(root)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('adding a field thread inside list items', () => {
  it('refuses a thread on team[1].name that names no item', async () => {
    const res = await add(field('team[1].name'))

    expect(res.status).toBe(400)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('itemKeys')
    expect(await store.listThreads()).toEqual([])
  })

  it('refuses the wrong number of items, too few or too many', async () => {
    expect((await add(field('team[1].links[0].href', ['k-team']))).status).toBe(400)
    expect((await add(field('team[1].name', ['k-team', 'k-extra']))).status).toBe(400)
    expect((await add(field('team[1].name', []))).status).toBe(400)
    expect(await store.listThreads()).toEqual([])
  })

  it('counts a dotted index as a list index too', async () => {
    expect((await add(field('team.1.name'))).status).toBe(400)
    expect((await add(field('team.1.name', ['k-team']))).status).toBe(201)
  })

  it('refuses an invalid key at the route boundary', () => {
    const invalid = ['', '__proto__', 'a'.repeat(65), 'has space', '-lead']
    for (const key of invalid) {
      const res = COMMENT_ROUTES.add.validate({
        params: { branch },
        body: field('team[1].name', [key]),
      })
      expect(res.ok, key).toBe(false)
    }
    const nonString = COMMENT_ROUTES.add.validate({
      params: { branch },
      body: { ...field('team[1].name'), itemKeys: [5] },
    })
    expect(nonString.ok).toBe(false)
    const ok = COMMENT_ROUTES.add.validate({
      params: { branch },
      body: field('team[1].name', ['k-team']),
    })
    expect(ok.ok).toBe(true)
  })

  it('stores a thread with one valid key per index, and reads it back with them', async () => {
    const res = await add(field('team[1].links[0].href', ['k-team', 'k-link']))

    expect(res.status).toBe(201)
    const threads = await store.listThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe(res.data?.threadId)
    expect(threads[0].itemKeys).toEqual(['k-team', 'k-link'])
    expect(threads[0].canopyPath).toBe('team[1].links[0].href')
    // `onRemovedItem` is display-only: it is never stored.
    expect(threads[0]).not.toHaveProperty('onRemovedItem')
  })

  it('needs no key for a field outside any list, and stores none', async () => {
    const res = await add(field('title'))

    expect(res.status).toBe(201)
    const [thread] = await store.listThreads()
    expect(thread.itemKeys).toBeUndefined()
    expect(thread).not.toHaveProperty('itemKeys')
  })

  it('refuses a key for a field outside any list', async () => {
    expect((await add(field('title', ['k-team']))).status).toBe(400)
  })

  it('lets a reply carry none, however deep the thread it answers, and refuses one that does', async () => {
    const created = await add(field('team[1].name', ['k-team']))
    const threadId = created.data!.threadId

    const reply = await add(field('team[1].name', undefined, { threadId, text: 'Reply' }))
    const keyedReply = await add(
      field('team[1].name', ['k-team'], { threadId, text: 'Reply with keys' }),
    )

    expect(reply.status).toBe(201)
    expect(reply.data?.threadId).toBe(threadId)
    expect(keyedReply.status).toBe(400)
    const [thread] = await store.listThreads()
    expect(thread.comments.map((c) => c.text)).toEqual(['Note', 'Reply'])
    expect(thread.itemKeys).toEqual(['k-team'])
  })

  it('refuses itemKeys on an entry thread and on a branch thread', async () => {
    const entry = await add({
      text: 'Entry note',
      type: 'entry',
      entryPath: ENTRY,
      itemKeys: ['k-team'],
    })
    const branchThread = await add({ text: 'Branch note', type: 'branch', itemKeys: ['k-team'] })

    expect(entry.status).toBe(400)
    expect(branchThread.status).toBe(400)
    expect(await store.listThreads()).toEqual([])
  })

  it('takes an entry thread and a branch thread with none', async () => {
    expect((await add({ text: 'Entry note', type: 'entry', entryPath: ENTRY })).status).toBe(201)
    expect((await add({ text: 'Branch note', type: 'branch' })).status).toBe(201)
  })
})
