import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthPlugin } from '../auth/plugin'
import type { UserSearchResult } from '../auth/types'
import { RESERVED_GROUPS } from '../authorization'
import type { BranchRegistry } from '../branch-registry'
import type { CanopyConfig } from '../config'
import { SYSTEM_USER_ID } from '../system-users'
import { createMockApiContext, createMockBranchContext, createMockRegistry } from '../test-utils'
import type { CanopyUser } from '../user'
import { listBranchesHandler } from './branch'
import type { ApiContext } from './types'

const editor: CanopyUser = { type: 'authenticated', userId: 'editor1', groups: ['writers'] }
const admin: CanopyUser = {
  type: 'authenticated',
  userId: 'admin1',
  groups: [RESERVED_GROUPS.ADMINS],
}

/** Every directory record carries an email, so a leak would show in the response. */
const directoryUser = (id: string): UserSearchResult => ({
  id,
  name: `Name of ${id}`,
  email: `${id}@example.test`,
  ...(id === 'editor1' ? { avatarUrl: 'https://avatars.example.test/editor1.png' } : {}),
})

const createAuthPlugin = (getUsersMetadata: AuthPlugin['getUsersMetadata']): AuthPlugin => ({
  authenticate: async () => ({ success: false }),
  searchUsers: async () => [],
  getUserMetadata: async (id) => directoryUser(id),
  getUsersMetadata,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

// editor1 sees its own branch, one shared with it by user, one shared with its group, and the
// protected base branch; never the hidden one or its ACL users.
const registry = createMockRegistry([
  createMockBranchContext({ branchName: 'main', createdBy: SYSTEM_USER_ID }),
  createMockBranchContext({ branchName: 'feature/own', createdBy: 'editor1' }),
  createMockBranchContext({
    branchName: 'feature/shared-user',
    createdBy: 'user-sharer',
    access: { allowedUsers: ['editor1', 'acl-colleague'] },
  }),
  createMockBranchContext({
    branchName: 'feature/shared-group',
    createdBy: 'group-sharer',
    access: { allowedGroups: ['writers'] },
  }),
  createMockBranchContext({
    branchName: 'feature/hidden',
    createdBy: 'hidden-owner',
    access: { allowedUsers: ['hidden-colleague'] },
  }),
  createMockBranchContext({ branchName: 'feature/gone', createdBy: 'unknown-user' }),
])

let ctx: ApiContext
let getUsersMetadata: ReturnType<typeof vi.fn<NonNullable<AuthPlugin['getUsersMetadata']>>>

const buildContext = (authPlugin: AuthPlugin | undefined): ApiContext =>
  createMockApiContext({
    services: {
      registry: registry as unknown as BranchRegistry,
      config: { defaultBaseBranch: 'main', mode: 'prod' } as unknown as CanopyConfig,
    },
    authPlugin,
  })

beforeEach(() => {
  getUsersMetadata = vi.fn(async (ids: string[]) =>
    ids.filter((id) => id !== 'unknown-user').map(directoryUser),
  )
  ctx = buildContext(createAuthPlugin(getUsersMetadata))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const list = (user: CanopyUser) => listBranchesHandler(ctx, { user })
const userIds = (res: Awaited<ReturnType<typeof list>>) =>
  (res.data?.users ?? []).map((u) => u.id).sort()

describe('branch list names the owners of the branches it lists', () => {
  it("names the owner of each branch the requester can see, but no branch's ACL users", async () => {
    const res = await list(editor)

    expect(res.ok).toBe(true)
    expect(res.data?.branches.map((b) => b.name).sort()).toEqual([
      'feature/own',
      'feature/shared-group',
      'feature/shared-user',
      'main',
    ])
    expect(userIds(res)).toEqual(['editor1', 'group-sharer', 'user-sharer'])
    expect(res.data?.users).toContainEqual({
      id: 'editor1',
      name: 'Name of editor1',
      avatarUrl: 'https://avatars.example.test/editor1.png',
    })
    expect(res.data?.users).toContainEqual({ id: 'user-sharer', name: 'Name of user-sharer' })
  })

  it('never looks up or returns the owner or ACL users of a branch the requester cannot see', async () => {
    const res = await list(editor)

    const asked = getUsersMetadata.mock.calls.flatMap(([ids]) => ids)
    for (const hidden of ['hidden-owner', 'hidden-colleague', 'acl-colleague']) {
      expect(asked).not.toContain(hidden)
      expect(userIds(res)).not.toContain(hidden)
    }
  })

  it('names the owner of every branch for a requester who sees them all', async () => {
    const res = await list(admin)

    expect(userIds(res)).toEqual(['editor1', 'group-sharer', 'hidden-owner', 'user-sharer'])
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
      expect(JSON.stringify(res.data?.users)).not.toContain('@example.test')
      expect(JSON.stringify(res.data?.users)).not.toContain('email')
    }
  })

  it('leaves bots to the editor and omits ids the directory does not know', async () => {
    const res = await list(admin)

    const asked = getUsersMetadata.mock.calls.flatMap(([ids]) => ids)
    expect(asked).not.toContain(SYSTEM_USER_ID)
    expect(asked).toContain('unknown-user')
    expect(userIds(res)).not.toContain('unknown-user')
  })

  it('still lists the branches when the lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getUsersMetadata.mockRejectedValue(new Error('directory down'))

    const res = await list(editor)

    expect(res.ok).toBe(true)
    expect(res.data?.branches).toHaveLength(4)
    expect(res.data?.users).toEqual([])
  })

  it('lists the branches with no names when no auth plugin is configured', async () => {
    ctx = buildContext(undefined)

    const res = await list(editor)

    expect(res.ok).toBe(true)
    expect(res.data?.branches).toHaveLength(4)
    expect(res.data?.users).toEqual([])
  })
})
