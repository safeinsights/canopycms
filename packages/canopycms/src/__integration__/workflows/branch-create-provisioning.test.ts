/**
 * How POST /branches answers each provisioning outcome (branch-provisioning.ts): a name another
 * request published first is a 409 without touching that branch, its own creator's retry gets
 * the branch back, and a name still being set up is a retriable 503.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import type { BranchCreateResponse } from '../../api/branch'
import { setProvisioningTestHooks } from '../../branch-workspace'
import { createApiClient } from '../test-utils/api-client'
import { createMockAuthPlugin, TEST_USERS } from '../test-utils/multi-user'
import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'

describe('POST /branches over provisioning outcomes', () => {
  let workspace: TestWorkspace
  let baseRoot: string

  beforeEach(async () => {
    workspace = await createTestWorkspace()
    baseRoot = path.join(workspace.tmpRoot, '.canopy-dev', 'content-branches')
  })

  afterEach(async () => {
    setProvisioningTestHooks()
    await workspace.cleanup()
  })

  const clientAs = (role: 'editor' | 'reviewer') =>
    createApiClient({ config: workspace.config, authPlugin: createMockAuthPlugin(role) })

  /** Another host publishes `feat` between this request's build and its rename. */
  const competitorPublishesFirst = (createdBy: string) =>
    setProvisioningTestHooks({
      beforePublish: async ({ stagingPath, finalPath }) => {
        await fs.cp(stagingPath, finalPath, { recursive: true })
        const metaPath = path.join(finalPath, '.canopy-meta', 'branch.json')
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
        meta.branch.createdBy = createdBy
        meta.branch.access = { allowedUsers: [createdBy] }
        await fs.writeFile(metaPath, JSON.stringify(meta))
      },
    })

  const readAccess = async () =>
    JSON.parse(
      await fs.readFile(path.join(baseRoot, 'feat', '.canopy-meta', 'branch.json'), 'utf8'),
    ).branch.access

  it('409s when another request published the name first, leaving that branch as it was', async () => {
    competitorPublishesFirst('someone-else')
    const client = await clientAs('editor')

    const res = await client.post('/api/canopycms/branches', {
      branch: 'feat',
      access: { allowedUsers: [TEST_USERS.editor.userId] },
    })

    expect(res.status).toBe(409)
    expect((await res.json<BranchCreateResponse>()).error).toBe(
      'A branch with this name already exists',
    )
    expect(await readAccess()).toEqual({ allowedUsers: ['someone-else'] })
  })

  it('answers its own creator with the branch when that creator published it moments ago', async () => {
    competitorPublishesFirst(TEST_USERS.editor.userId)
    const client = await clientAs('editor')

    const res = await client.post('/api/canopycms/branches', { branch: 'feat' })

    expect(res.status).toBe(200)
    const body = await res.json<BranchCreateResponse>()
    expect(body.data?.branch.createdBy).toBe(TEST_USERS.editor.userId)
  })

  it('answers a repeated create with the same branch for its creator and a 409 for anyone else', async () => {
    const editor = await clientAs('editor')
    const first = await editor.post('/api/canopycms/branches', { branch: 'feat' })
    expect(first.status).toBe(200)
    const created = (await first.json<BranchCreateResponse>()).data?.branch

    const retry = await editor.post('/api/canopycms/branches', { branch: 'feat' })
    expect(retry.status).toBe(200)
    expect((await retry.json<BranchCreateResponse>()).data?.branch.createdAt).toBe(
      created?.createdAt,
    )

    const other = await (
      await clientAs('reviewer')
    ).post('/api/canopycms/branches', {
      branch: 'feat',
    })
    expect(other.status).toBe(409)
  })

  it('503s while the name holds a fresh, unfinished clone', async () => {
    const finalPath = path.join(baseRoot, 'feat')
    await fs.mkdir(baseRoot, { recursive: true })
    await simpleGit().raw([
      'clone',
      '-q',
      '--no-checkout',
      '-b',
      'main',
      workspace.remotePath,
      finalPath,
    ])
    const client = await clientAs('editor')

    const res = await client.post('/api/canopycms/branches', { branch: 'feat' })

    expect(res.status).toBe(503)
    expect((await res.json<BranchCreateResponse>()).error).toBe(
      "Branch 'feat' is still being set up. Try again in a minute.",
    )
  })
})
