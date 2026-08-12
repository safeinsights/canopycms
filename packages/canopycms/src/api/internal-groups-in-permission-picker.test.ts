/**
 * Round-trip proof that a group created through the groups API is reachable
 * from the Permission Manager's group picker.
 *
 * These two features compose at enforcement time -- `authResultToCanopyUser`
 * (user.ts) flattens internal and external groups into one `user.groups` list
 * and `checkPathPermission` matches `allowedGroups` against it by ID -- but the
 * picker used to be fed from `authPlugin.listGroups()` alone, so an internally
 * created group simply never appeared as an option. The only way to grant one a
 * path permission was hand-editing permissions.json.
 *
 * Unlike the per-handler suites in groups.test.ts / permissions.test.ts, this
 * file wires BOTH handlers to a single in-memory groups file so the assertion
 * covers the whole chain: create via `groups.updateInternal`, then read back
 * through `permissions.listGroups`. `createMockSettingsMutation` is stateless
 * (it captures a payload but never makes it readable again), so the shared
 * store below is written here rather than reused from test-utils.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { GroupsFile, InternalGroup } from '../authorization'
import type { CanopyUserId, CanopyGroupId } from '../types'
import type { AuthPlugin } from '../auth/plugin'
import type { PermissionGroupOption } from '../auth/types'
import { RESERVED_GROUPS } from '../authorization'
import { createMockApiContext, createMockBranchContext, createMockGitManager } from '../test-utils'

// Only the groups file I/O is mocked; deriveInternalGroups and the reserved
// group helpers stay real, since they are exactly what both handlers run.
vi.mock('../authorization', async (importOriginal) => {
  const { vi } = await import('vitest')
  const original = await importOriginal<typeof import('../authorization')>()
  return {
    ...original,
    loadGroupsFile: vi.fn(),
    mutateGroupsFile: vi.fn(),
  }
})

import { GROUP_ROUTES } from './groups'
import { PERMISSION_ROUTES } from './permissions'
import * as authorization from '../authorization'

const updateInternalGroups = GROUP_ROUTES.updateInternal.handler
const listGroups = PERMISSION_ROUTES.listGroups.handler

/**
 * A single groups.json standing in for the settings workspace, shared by the
 * write handler and the read handler so the round trip is real rather than
 * two independently stubbed responses.
 */
function createSharedGroupsStore() {
  let file: GroupsFile | null = null

  vi.mocked(authorization.loadGroupsFile).mockImplementation(async () => file)

  vi.mocked(authorization.mutateGroupsFile).mockImplementation(
    async (
      _root: string,
      _mode: Parameters<typeof authorization.mutateGroupsFile>[1],
      mutate: Parameters<typeof authorization.mutateGroupsFile>[2],
    ) => {
      const version = file?.version ?? 0
      const payload = mutate(file, version)
      if (payload === null) return null
      file = { ...(payload as unknown as GroupsFile), version: version + 1 }
      return { version: version + 1, writeId: 'test-write-id' }
    },
  )

  return { read: () => file }
}

/**
 * Create an internal group the way the Group Manager does: submit the FULL
 * groups array -- the existing derived groups plus the addition, whose empty ID
 * the handler fills in. Submitting the new group alone would drop the reserved
 * Admins group and trip updateInternalGroups' last-admin guard.
 */
async function createInternalGroup(
  ctx: ApiContext,
  store: ReturnType<typeof createSharedGroupsStore>,
  group: Omit<InternalGroup, 'id'>,
) {
  const existing = authorization.deriveInternalGroups(store.read()?.groups ?? [], BOOTSTRAP_ADMINS)

  return updateInternalGroups(ctx, { user: ADMIN }, {
    groups: [...existing, { ...group, id: '' as CanopyGroupId }],
  } as never)
}

const ADMIN_ID = 'admin-1' as CanopyUserId

const ADMIN: ApiRequest<undefined>['user'] = {
  type: 'authenticated',
  userId: ADMIN_ID,
  groups: [RESERVED_GROUPS.ADMINS as CanopyGroupId],
}

const BOOTSTRAP_ADMINS = new Set<string>([ADMIN_ID])

describe('internal groups are reachable from the permission picker', () => {
  let mockContext: ApiContext
  let store: ReturnType<typeof createSharedGroupsStore>
  let mockAuthPlugin: AuthPlugin

  beforeEach(() => {
    vi.clearAllMocks()
    store = createSharedGroupsStore()

    mockAuthPlugin = {
      authenticate: vi.fn(),
      searchUsers: vi.fn(),
      getUserMetadata: vi.fn(),
      getGroupMetadata: vi.fn(),
      // The auth provider knows nothing about Canopy's internal groups.
      listGroups: vi.fn().mockResolvedValue([{ id: 'team-a' as CanopyGroupId, name: 'Team A' }]),
    }

    mockContext = createMockApiContext({
      services: {
        config: {
          defaultBaseBranch: 'main',
          mode: 'dev',
          gitBotAuthorName: 'Canopy Bot',
          gitBotAuthorEmail: 'bot@example.com',
          sourceRoot: '/test/workspace',
        } as never,
        createGitManagerFor: vi.fn(() => createMockGitManager()) as never,
        bootstrapAdminIds: BOOTSTRAP_ADMINS,
      },
      branchContext: createMockBranchContext({
        branchName: 'main',
        branchRoot: '/test/main',
      }),
      authPlugin: mockAuthPlugin,
    })
  })

  it('offers a group created via the groups API as a picker option', async () => {
    // 1. An admin creates an internal group in the Group Manager. Its ID is
    //    left empty so the handler generates one, exactly as the UI does.
    const writeResult = await createInternalGroup(mockContext, store, {
      name: 'Docs Team',
      description: 'Owns the docs tree',
      members: ['editor-1' as CanopyUserId],
    })
    expect(writeResult.ok).toBe(true)

    const persisted = store.read()?.groups.find((g) => g.name === 'Docs Team')
    expect(persisted).toBeDefined()
    expect(persisted?.id).toBeTruthy()

    // 2. The Permission Manager opens and fills its picker from listGroups.
    const listResult = await listGroups(mockContext, { user: ADMIN })
    expect(listResult.ok).toBe(true)

    const options = (listResult.data as { groups: PermissionGroupOption[] }).groups
    const option = options.find((g) => g.id === persisted?.id)

    // This is the assertion the bug failed: before the merge, listGroups
    // returned only the auth plugin's groups and this was undefined.
    expect(option).toEqual({
      id: persisted?.id,
      name: 'Docs Team',
      description: 'Owns the docs tree',
      source: 'internal',
    })

    // The external universe is still offered alongside it.
    expect(options).toContainEqual({ id: 'team-a', name: 'Team A', source: 'external' })
  })

  it('never exposes internal group membership through the picker', async () => {
    await createInternalGroup(mockContext, store, {
      name: 'Docs Team',
      members: ['editor-1' as CanopyUserId, 'editor-2' as CanopyUserId],
    })

    const listResult = await listGroups(mockContext, { user: ADMIN })
    const options = (listResult.data as { groups: PermissionGroupOption[] }).groups

    // listGroups is `privileged` (admin OR reviewer) while groups.getInternal
    // is admin-only, so member identities and counts must not ride along.
    for (const option of options) {
      expect(option).not.toHaveProperty('members')
      expect(option).not.toHaveProperty('memberCount')
    }
  })

  it('offers the reserved groups as targets even before any group is created', async () => {
    const listResult = await listGroups(mockContext, { user: ADMIN })
    const options = (listResult.data as { groups: PermissionGroupOption[] }).groups

    // deriveInternalGroups synthesizes these when groups.json is absent, so a
    // fresh install can still grant Admins/Reviewers a path permission.
    expect(options.map((g) => g.id)).toEqual(
      expect.arrayContaining([RESERVED_GROUPS.ADMINS, RESERVED_GROUPS.REVIEWERS]),
    )
  })
})
