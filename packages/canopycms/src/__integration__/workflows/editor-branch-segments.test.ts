/**
 * The `/:branch` segment `requestSegments` (editor/branch-names.ts) maps a listed branch to, sent
 * through the real handler and `resolveBranchParam`: it reaches the branch the editor listed,
 * whatever the server would make of the branch's short name on that request. That the editor's
 * hook builds its table from `requestSegments` is pinned by the editor tests.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin, TEST_INTERNAL_GROUPS } from '../test-utils/multi-user'
import { createApiClient } from '../test-utils/api-client'
import { branchRef } from '../test-utils/branch-names'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import { BranchWorkspaceManager, loadBranchContext } from '../../branch-workspace'
import { requestSegments, unlistedSegment } from '../../editor/branch-names'
import type { CanopyConfig } from '../../config'
import type { TestUserRole } from '../test-utils/multi-user'

const SPRING = branchRef('spring')

const samplePost = {
  collection: 'content/posts',
  slug: 'sample-post',
  format: 'mdx',
  data: { title: 'Sample Post', author: 'Test Editor', date: '2024-01-01', tags: ['test'] },
  body: 'Saved through the editor segment table',
} as const

/** A client that sends each branch as the editor does once `listing` holds it. */
async function editorClient(config: CanopyConfig, role: TestUserRole) {
  let segments = new Map<string, string>()
  const client = await createApiClient({
    config,
    authPlugin: createMockAuthPlugin(role),
    schema: BLOG_SCHEMA,
    handlerBranchContext: true,
    branchSegment: (branch) => segments.get(branch) ?? unlistedSegment(branch),
  })
  const loadListing = async () => {
    const listing = await client.branches.list()
    expect(listing.ok).toBe(true)
    const branches = listing.data?.branches ?? []
    segments = requestSegments(branches)
    return branches
  }
  return { client, loadListing }
}

describe('the editor segment of a listed branch', () => {
  let workspace: TestWorkspace

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('saves to the open namespace branch after the dev active branch takes its short name', async () => {
    workspace = await createTestWorkspace({ schema: BLOG_SCHEMA })
    const { client, loadListing } = await editorClient(workspace.config, 'admin')
    expect((await client.branches.create({ branch: 'spring' })).ok).toBe(true)
    expect((await loadListing()).map((b) => b.name)).toContain(SPRING)

    // `git checkout -b spring` in the project: the handler's per-request refresh makes it active.
    const services = client.services
    services.refreshActiveBranch = async () => {
      services.config = { ...services.config, defaultActiveBranch: 'spring' }
    }

    const saved = await client.content.write(
      { branch: SPRING, path: 'posts/sample-post' },
      samplePost,
    )

    expect(saved.ok).toBe(true)
    expect(services.config.defaultActiveBranch).toBe('spring')
    expect(await loadBranchContext({ branchName: 'spring', mode: 'dev' })).toBeNull()
    const read = await client.content.read({ branch: SPRING, path: 'posts/sample-post' })
    expect(read.ok).toBe(true)
    expect(read.data?.body?.trim()).toBe(samplePost.body)
  })

  it('opens and saves an outside branch whose short name a hidden namespace branch takes', async () => {
    workspace = await createTestWorkspace(
      { schema: BLOG_SCHEMA, defaultBranchAccess: 'deny', defaultPathAccess: 'allow' },
      { internalGroups: TEST_INTERNAL_GROUPS },
    )
    const admin = await editorClient(workspace.config, 'admin')
    expect((await admin.client.branches.create({ branch: 'spring' })).ok).toBe(true)
    await new BranchWorkspaceManager(workspace.config).openOrCreateBranch({
      branchName: 'spring',
      mode: 'dev',
      createdBy: 'test-editor',
    })
    const { client, loadListing } = await editorClient(workspace.config, 'editor')

    const listed = await loadListing()

    expect(listed.map((b) => b.name)).toContain('spring')
    expect(listed.map((b) => b.name)).not.toContain(SPRING)
    expect((await client.entries.list({ branch: 'spring' })).status).toBe(200)
    const saved = await client.content.write(
      { branch: 'spring', path: 'posts/sample-post' },
      samplePost,
    )
    expect(saved.status).toBe(200)
    const read = await client.content.read({ branch: 'spring', path: 'posts/sample-post' })
    expect(read.data?.body?.trim()).toBe(samplePost.body)
  })
})
