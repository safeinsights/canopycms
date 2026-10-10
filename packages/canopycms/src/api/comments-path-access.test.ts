import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PathPermission } from '../config'
import { CommentStore } from '../comment-store'
import { createCheckBranchAccess, RESERVED_GROUPS } from '../authorization'
import { createTestContentAccess, unsafeAsPermissionPath } from '../authorization/test-utils'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { unsafeAsBranchName, unsafeAsLogicalPath } from '../paths/test-utils'
import type { CanopyUser } from '../user'
import type { ApiContext } from './types'
import { COMMENT_ROUTES } from './comments'

const SECRET_ENTRY = 'content/secret/plan'
const OPEN_ENTRY = 'content/posts/hello'

// Only the `insiders` group may read under content/secret; everything else defaults to allow.
const rules: PathPermission[] = [
  {
    path: unsafeAsPermissionPath('content/secret/**'),
    read: { allowedGroups: ['insiders'] },
  },
]

const editor: CanopyUser = { type: 'authenticated', userId: 'editor1', groups: [] }
const admin: CanopyUser = {
  type: 'authenticated',
  userId: 'admin1',
  groups: [RESERVED_GROUPS.ADMINS],
}

const branch = unsafeAsBranchName('feature/x')

let root: string
let store: CommentStore
let ctx: ApiContext
let threadIds: { secretField: string; secretEntry: string; open: string; branch: string }

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-comments-acl-'))
  store = new CommentStore(root)
  const author = 'author1'
  const secretField = await store.addComment({
    userId: author,
    text: 'secret field note',
    type: 'field',
    entryPath: SECRET_ENTRY,
    canopyPath: 'title',
  })
  const secretEntry = await store.addComment({
    userId: author,
    text: 'secret entry note',
    type: 'entry',
    entryPath: SECRET_ENTRY,
  })
  const open = await store.addComment({
    userId: author,
    text: 'open entry note',
    type: 'entry',
    entryPath: OPEN_ENTRY,
  })
  const branchThread = await store.addComment({
    userId: author,
    text: 'branch note',
    type: 'branch',
  })
  threadIds = {
    secretField: secretField.threadId,
    secretEntry: secretEntry.threadId,
    open: open.threadId,
    branch: branchThread.threadId,
  }

  const checkBranchAccess = createCheckBranchAccess('allow')
  const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
    checkBranchAccess,
    loadPathPermissions: vi.fn().mockResolvedValue(rules),
    defaultPathAccess: 'allow',
    mode: 'dev',
    getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
  })
  ctx = createMockApiContext({
    services: {
      checkBranchAccess,
      checkContentAccess,
      createContentAccessChecker: vi.fn(createContentAccessChecker),
    },
    branchContext: createMockBranchContext({
      branchName: 'feature/x',
      baseRoot: root,
      branchRoot: root,
      createdBy: 'author1',
    }),
  })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const list = (user: CanopyUser) => COMMENT_ROUTES.list.handler(ctx, { user }, { branch })
const resolve = (user: CanopyUser, threadId: string) =>
  COMMENT_ROUTES.resolve.handler(ctx, { user }, { branch, threadId })
const add = (user: CanopyUser, body: Parameters<typeof COMMENT_ROUTES.add.handler>[3]) =>
  COMMENT_ROUTES.add.handler(ctx, { user }, { branch }, body)

describe('comment threads honour path read rules', () => {
  it('hides threads on a read-denied entry from a non-admin, keeping branch threads', async () => {
    const res = await list(editor)

    expect(res.ok).toBe(true)
    expect(res.data?.threads.map((t) => t.id).sort()).toEqual(
      [threadIds.open, threadIds.branch].sort(),
    )
    expect(JSON.stringify(res.data)).not.toContain('secret')
  })

  it('builds one access checker per list request, not one per thread', async () => {
    await list(editor)

    expect(ctx.services.createContentAccessChecker).toHaveBeenCalledTimes(1)
  })

  it('shows an admin every thread, including those on a read-denied entry', async () => {
    const res = await list(admin)

    expect(res.data?.threads).toHaveLength(4)
  })

  it('answers a direct read of a hidden thread as missing, but not a branch thread', async () => {
    const hidden = await resolve(editor, threadIds.secretEntry)
    expect(hidden.status).toBe(404)
    expect((await store.getThread(threadIds.secretEntry))?.resolved).toBe(false)

    const branchLevel = await resolve(
      { ...editor, groups: [RESERVED_GROUPS.REVIEWERS] },
      threadIds.branch,
    )
    expect(branchLevel.ok).toBe(true)
  })

  it('lets an admin resolve a thread on a read-denied entry', async () => {
    const res = await resolve(admin, threadIds.secretField)

    expect(res.ok).toBe(true)
  })

  it('refuses a new thread on a read-denied entry', async () => {
    const res = await add(editor, {
      text: 'sneaky',
      type: 'entry',
      entryPath: unsafeAsLogicalPath(SECRET_ENTRY),
    })

    expect(res.status).toBe(403)
    expect(await store.listThreads()).toHaveLength(4)
  })

  it('refuses a reply to a hidden thread even when the body names a readable entry', async () => {
    const res = await add(editor, {
      text: 'sneaky reply',
      threadId: threadIds.secretField,
      type: 'entry',
      entryPath: unsafeAsLogicalPath(OPEN_ENTRY),
    })

    expect(res.status).toBe(404)
    expect((await store.getThread(threadIds.secretField))?.comments).toHaveLength(1)
  })

  it('refuses a reply naming a thread that does not exist', async () => {
    const res = await add(editor, { text: 'reply', threadId: 'no-such-thread', type: 'branch' })

    expect(res.status).toBe(404)
    expect(await store.getThread('no-such-thread')).toBeNull()
  })

  it('accepts comments on readable entries and branch threads', async () => {
    const reply = await add(editor, {
      text: 'reply',
      threadId: threadIds.open,
      type: 'entry',
      entryPath: unsafeAsLogicalPath(OPEN_ENTRY),
    })
    const branchComment = await add(editor, {
      text: 'branch reply',
      threadId: threadIds.branch,
      type: 'branch',
    })
    const adminOnSecret = await add(admin, {
      text: 'admin note',
      type: 'entry',
      entryPath: unsafeAsLogicalPath(SECRET_ENTRY),
    })

    expect([reply.status, branchComment.status, adminOnSecret.status]).toEqual([201, 201, 201])
  })

  it('refuses a new thread whose entry path aliases a read-denied entry', async () => {
    for (const alias of [
      'content/./secret/plan',
      'content//secret/plan',
      'content/secret/./plan',
    ]) {
      const validated = COMMENT_ROUTES.add.validate({
        params: { branch },
        body: { text: 'sneaky', type: 'entry', entryPath: alias },
      })
      expect(validated.ok, alias).toBe(false)

      // The handler refuses it too, for a caller that skips the route's validation.
      const res = await add(editor, {
        text: 'sneaky',
        type: 'entry',
        entryPath: unsafeAsLogicalPath(alias),
      })
      expect(res.status, alias).toBe(403)
    }
    expect(await store.listThreads()).toHaveLength(4)
  })

  it('gates a branch-typed comment that names a read-denied entry by that entry', async () => {
    const res = await add(editor, {
      text: 'sneaky',
      type: 'branch',
      entryPath: unsafeAsLogicalPath(SECRET_ENTRY),
    })

    expect(res.status).toBe(403)
  })

  it('lets an admin reply to a thread on a read-denied entry', async () => {
    const res = await add(admin, {
      text: 'admin reply',
      threadId: threadIds.secretEntry,
      type: 'entry',
      entryPath: unsafeAsLogicalPath(SECRET_ENTRY),
    })

    expect(res.status).toBe(201)
  })

  it('never resolves to an inherited property for a thread id like __proto__', async () => {
    const reviewer = { ...editor, groups: [RESERVED_GROUPS.REVIEWERS] }
    for (const threadId of ['__proto__', 'constructor', 'toString']) {
      expect((await resolve(reviewer, threadId)).status, threadId).toBe(404)
      expect((await add(reviewer, { text: 'x', threadId, type: 'branch' })).status, threadId).toBe(
        404,
      )
    }
    expect(Object.prototype).not.toHaveProperty('resolved')
  })

  it('hides a thread whose stored entry path is not canonical', async () => {
    const data = await store.load()
    data.threads[threadIds.open].entryPath = 'content/./posts/hello'
    await fs.writeFile(path.join(root, '.canopy-meta', 'comments.json'), JSON.stringify(data))

    const res = await list(admin)

    expect(res.data?.threads.map((t) => t.id)).not.toContain(threadIds.open)
  })

  it('hides a thread whose stored entry path is not a logical path', async () => {
    const data = await store.load()
    data.threads[threadIds.open].entryPath = '../escape'
    await fs.writeFile(path.join(root, '.canopy-meta', 'comments.json'), JSON.stringify(data))

    const res = await list(editor)

    expect(res.data?.threads.map((t) => t.id)).toEqual([threadIds.branch])
  })
})
