/**
 * End-to-end regression test for the internal-groups read/write split
 * (August 2026 baseline review, finding 3).
 *
 * Before the fix: `PUT /groups/internal` wrote to the settings workspace
 * (via `mutateGroupsFile`), but every read of effective privileges
 * (`http/handler.ts`, and separately `canopycms-next`'s `context-wrapper.ts`)
 * loaded internal groups from the BASE BRANCH content clone instead — a
 * location nothing in the product ever wrote groups.json into. A group
 * grant/revoke via the API therefore returned 200 but never actually changed
 * what any subsequent request saw as the caller's effective groups, and
 * custom groups could never be matched by a path/branch ACL. These tests
 * exercise the real HTTP handler (not the loader in isolation) so the seam
 * between "write" and "read" is what's actually under test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createApiClient } from '../test-utils/api-client'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { mockConsole } from '../../test-utils/console-spy'
import type { AuthPlugin } from '../../auth/plugin'
import type { AuthenticationResult } from '../../auth/types'
import type { UserInfoResponse } from '../../api/user'
import type { InternalGroupsResponse } from '../../api/groups'

/** Auth plugin for a single persona with a fixed userId and no external groups. */
function createPersonaAuthPlugin(userId: string): AuthPlugin {
  return {
    async authenticate(_context: unknown): Promise<AuthenticationResult> {
      return { success: true, user: { userId, externalGroups: [] } }
    },
    async searchUsers() {
      return []
    },
    async getUserMetadata() {
      return null
    },
    async getGroupMetadata() {
      return null
    },
    async listGroups() {
      return []
    },
    async searchExternalGroups() {
      return []
    },
  }
}

describe('Internal groups: effective privileges (end-to-end)', () => {
  let workspace: TestWorkspace
  let adminClient: Awaited<ReturnType<typeof createApiClient>>

  beforeEach(async () => {
    mockConsole()
    // No `internalGroups` seed here — 'test-admin' is a bootstrap admin via
    // the CANOPY_BOOTSTRAP_ADMIN_IDS test env (vitest.config.ts), so the
    // admin client's own privilege doesn't depend on the fixture under test.
    workspace = await createTestWorkspace({ schema: { collections: [] } })
    adminClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it("a grant via PUT /groups/internal takes effect on the target user's next request, and a revoke removes it", async () => {
    const targetClient = await createApiClient({
      config: workspace.config,
      authPlugin: createPersonaAuthPlugin('test-newadmin'),
    })

    // Before any grant: plain authenticated user, no Admins membership.
    const before = await targetClient.get('/api/canopycms/whoami')
    const beforeData = await before.json<UserInfoResponse>()
    expect(beforeData.data?.groups).not.toContain('Admins')

    // Grant Admins to test-newadmin via the real API.
    const grantRes = await adminClient.put('/api/canopycms/groups/internal', {
      groups: [{ id: 'Admins', name: 'Admins', members: ['test-admin', 'test-newadmin'] }],
    })
    expect(grantRes.status).toBe(200)

    const afterGrant = await targetClient.get('/api/canopycms/whoami')
    const afterGrantData = await afterGrant.json<UserInfoResponse>()
    expect(afterGrantData.data?.groups).toContain('Admins')

    // Revoke it again via the API (test-admin, a bootstrap admin, stays as
    // the sole remaining admin so the "can't remove last admin" guard
    // doesn't reject this).
    const revokeRes = await adminClient.put('/api/canopycms/groups/internal', {
      groups: [{ id: 'Admins', name: 'Admins', members: ['test-admin'] }],
    })
    expect(revokeRes.status).toBe(200)

    const afterRevoke = await targetClient.get('/api/canopycms/whoami')
    const afterRevokeData = await afterRevoke.json<UserInfoResponse>()
    expect(afterRevokeData.data?.groups).not.toContain('Admins')
  })

  it('a group created via the API is matched by a branch ACL targeting it', async () => {
    const createRes = await adminClient.post('/api/canopycms/branches', {
      branch: 'acl-test-branch',
      title: 'ACL Test Branch',
    })
    expect(createRes.status).toBe(200)

    // Create a brand-new internal group via the API — the server generates
    // its ID, so it isn't known up front.
    const putRes = await adminClient.put('/api/canopycms/groups/internal', {
      groups: [{ id: '', name: 'SpecialEditors', members: ['test-specialist'] }],
    })
    expect(putRes.status).toBe(200)

    const getRes = await adminClient.get('/api/canopycms/groups/internal')
    const getData = await getRes.json<InternalGroupsResponse>()
    const specialGroup = getData.data?.groups.find((g) => g.name === 'SpecialEditors')
    expect(specialGroup).toBeDefined()
    const groupId = specialGroup?.id
    expect(groupId).toBeTruthy()

    // Restrict the branch to that group.
    const accessRes = await adminClient.patch('/api/canopycms/acl-test-branch/access', {
      allowedGroups: [groupId],
    })
    expect(accessRes.status).toBe(200)

    // A member of the group can access the branch...
    const memberClient = await createApiClient({
      config: workspace.config,
      authPlugin: createPersonaAuthPlugin('test-specialist'),
    })
    const memberStatus = await memberClient.get('/api/canopycms/acl-test-branch/status')
    expect(memberStatus.status).toBe(200)

    // ...but a non-member is denied.
    const outsiderClient = await createApiClient({
      config: workspace.config,
      authPlugin: createPersonaAuthPlugin('test-outsider'),
    })
    const outsiderStatus = await outsiderClient.get('/api/canopycms/acl-test-branch/status')
    expect(outsiderStatus.status).toBe(403)
  })

  it('fails loudly rather than silently serving no groups when the settings workspace is unavailable', async () => {
    // Breaks ONLY settings-workspace resolution (base-branch content
    // provisioning still uses the real, working remote) so this exercises
    // resolveCanopyUser's fail-loud contract specifically, not the
    // pre-existing base-branch-provisioning-failure path.
    const brokenClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      getSettingsBranchRoot: async () => {
        throw new Error('settings workspace unavailable (test)')
      },
    })

    const res = await brokenClient.get('/api/canopycms/whoami')

    // Must NOT be a 200 with an empty/degraded group list — that would be a
    // silent authorization change ("no groups" reads as "no privileges").
    expect(res.status).not.toBe(200)
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})
