import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PathPermission } from '../config'
import type { AuthPlugin } from '../auth/plugin'
import type { UserSearchResult } from '../auth/types'
import { CommentStore } from '../comment-store'
import { createCheckBranchAccess, RESERVED_GROUPS } from '../authorization'
import { createTestContentAccess, unsafeAsPermissionPath } from '../authorization/test-utils'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { unsafeAsBranchName } from '../paths/test-utils'
import { SYSTEM_USER_ID } from '../system-users'
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

/** Every directory record carries an email, so a leak would show in the response. */
const directoryUser = (id: string): UserSearchResult => ({
  id,
  name: `Name of ${id}`,
  email: `${id}@example.test`,
  ...(id === 'open-author' ? { avatarUrl: 'https://avatars.example.test/open-author.png' } : {}),
})

const createAuthPlugin = (getUsersMetadata: AuthPlugin['getUsersMetadata']): AuthPlugin => ({
  authenticate: async () => ({ success: false }),
  searchUsers: async () => [],
  getUserMetadata: async (id) => directoryUser(id),
  getUsersMetadata,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

let root: string
let ctx: ApiContext
let getUsersMetadata: ReturnType<typeof vi.fn<NonNullable<AuthPlugin['getUsersMetadata']>>>

const buildContext = (authPlugin: AuthPlugin | undefined): ApiContext => {
  const checkBranchAccess = createCheckBranchAccess('allow')
  const { checkContentAccess, createContentAccessChecker } = createTestContentAccess({
    checkBranchAccess,
    loadPathPermissions: vi.fn().mockResolvedValue(rules),
    defaultPathAccess: 'allow',
    mode: 'dev',
    getSettingsBranchRoot: () => Promise.resolve('/mock/settings'),
  })
  return createMockApiContext({
    services: { checkBranchAccess, checkContentAccess, createContentAccessChecker },
    branchContext: createMockBranchContext({
      branchName: 'feature/x',
      baseRoot: root,
      branchRoot: root,
      createdBy: 'open-author',
    }),
    authPlugin,
  })
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-comments-users-'))
  const store = new CommentStore(root)

  const secret = await store.addComment({
    userId: 'secret-author',
    text: 'secret entry note',
    type: 'entry',
    entryPath: SECRET_ENTRY,
  })
  await store.addReply({ userId: 'secret-replier', text: 'reply', threadId: secret.threadId })
  await store.resolveThread(secret.threadId, 'secret-resolver')

  const open = await store.addComment({
    userId: 'open-author',
    text: 'open entry note',
    type: 'entry',
    entryPath: OPEN_ENTRY,
  })
  await store.addReply({ userId: 'open-replier', text: 'reply', threadId: open.threadId })
  await store.resolveThread(open.threadId, 'open-resolver')

  await store.addComment({ userId: SYSTEM_USER_ID, text: 'bot note', type: 'branch' })
  await store.addComment({ userId: 'unknown-user', text: 'gone', type: 'branch' })

  getUsersMetadata = vi.fn(async (ids: string[]) =>
    ids.filter((id) => id !== 'unknown-user').map(directoryUser),
  )
  ctx = buildContext(createAuthPlugin(getUsersMetadata))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

const list = (user: CanopyUser) => COMMENT_ROUTES.list.handler(ctx, { user }, { branch })
const userIds = (res: Awaited<ReturnType<typeof list>>) =>
  (res.data?.users ?? []).map((u) => u.id).sort()

describe('comment list names the people in its threads', () => {
  it('names the author, repliers and resolver of every thread the requester can read', async () => {
    const res = await list(editor)

    expect(res.ok).toBe(true)
    expect(userIds(res)).toEqual(['open-author', 'open-replier', 'open-resolver'])
    expect(res.data?.users).toContainEqual({
      id: 'open-author',
      name: 'Name of open-author',
      avatarUrl: 'https://avatars.example.test/open-author.png',
    })
    expect(res.data?.users).toContainEqual({ id: 'open-replier', name: 'Name of open-replier' })
  })

  it('never looks up or returns anyone known only from a thread the requester cannot read', async () => {
    const res = await list(editor)

    const asked = getUsersMetadata.mock.calls.flatMap(([ids]) => ids)
    for (const hidden of ['secret-author', 'secret-replier', 'secret-resolver']) {
      expect(asked).not.toContain(hidden)
      expect(JSON.stringify(res.data)).not.toContain(hidden)
    }
  })

  it('names the people on read-denied threads for a requester who can read them', async () => {
    const res = await list(admin)

    expect(userIds(res)).toEqual([
      'open-author',
      'open-replier',
      'open-resolver',
      'secret-author',
      'secret-replier',
      'secret-resolver',
    ])
  })

  it('never carries an email, for any requester', async () => {
    for (const user of [editor, admin]) {
      const res = await list(user)
      expect(res.data?.users.length).toBeGreaterThan(0)
      for (const profile of res.data?.users ?? []) {
        expect(Object.keys(profile).sort()).toEqual(
          'avatarUrl' in profile ? ['avatarUrl', 'id', 'name'] : ['id', 'name'],
        )
      }
      expect(JSON.stringify(res.data)).not.toContain('@example.test')
      expect(JSON.stringify(res.data)).not.toContain('email')
    }
  })

  it('leaves bots to the editor and omits ids the directory does not know', async () => {
    const res = await list(admin)

    const asked = getUsersMetadata.mock.calls.flatMap(([ids]) => ids)
    expect(asked).not.toContain(SYSTEM_USER_ID)
    expect(asked).toContain('unknown-user')
    expect(userIds(res)).not.toContain('unknown-user')
  })

  it('still lists the threads when the lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getUsersMetadata.mockRejectedValue(new Error('directory down'))

    const res = await list(editor)

    expect(res.ok).toBe(true)
    expect(res.data?.threads).toHaveLength(3)
    expect(res.data?.users).toEqual([])
  })

  it('lists the threads with no names when no auth plugin is configured', async () => {
    ctx = buildContext(undefined)

    const res = await list(editor)

    expect(res.ok).toBe(true)
    expect(res.data?.threads).toHaveLength(3)
    expect(res.data?.users).toEqual([])
  })
})
