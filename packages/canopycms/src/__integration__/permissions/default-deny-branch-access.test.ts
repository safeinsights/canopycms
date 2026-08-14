/**
 * Integration tests for `defaultBranchAccess: 'deny'` -- the value
 * `canopycms init` now scaffolds.
 *
 * These go through the HTTP API as a real non-admin editor, which is the only
 * way to exercise this at all: admins bypass both the branch and path layers,
 * and every other integration suite runs under the permissive
 * 'allow'/'allow' workspace default. The bug class this guards against is
 * "'deny' is not strict, it is broken" -- branch access is ANDed into every
 * content check, so a denial here makes a branch inert rather than read-only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin, TEST_INTERNAL_GROUPS } from '../test-utils/multi-user'
import { createApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { BranchResponse } from '../../api/branch'

describe('defaultBranchAccess: deny', () => {
  let workspace: TestWorkspace
  let adminClient: Awaited<ReturnType<typeof createApiClient>>
  let editorClient: Awaited<ReturnType<typeof createApiClient>>

  beforeEach(async () => {
    workspace = await createTestWorkspace(
      {
        schema: BLOG_SCHEMA,
        // The point of this suite. Path access stays open so that every
        // assertion below isolates the BRANCH layer.
        defaultBranchAccess: 'deny',
        defaultPathAccess: 'allow',
      },
      { internalGroups: TEST_INTERNAL_GROUPS },
    )

    adminClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      schema: BLOG_SCHEMA,
    })

    editorClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
      schema: BLOG_SCHEMA,
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('lets a non-admin editor reach the protected base branch', async () => {
    // The branch every user lands on. It takes no ACL and has no creator, so
    // without the base-branch grant this 403s and a fresh deployment presents
    // every editor with an empty editor and no way to configure around it.
    const res = await editorClient.get('/api/canopycms/main/status')

    expect(res.status).toBe(200)
  })

  it('lets a non-admin editor use a branch they just created', async () => {
    // The create form sends no ACL, so this branch has an empty one.
    const createRes = await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/editor-owned',
      title: 'Editor owned',
    })
    expect(createRes.status).toBe(200)
    const created = await createRes.json<BranchResponse>()
    expect(created.data?.branch.createdBy).toBe('test-editor')

    // Reading the branch must work -- under the old behavior every one of
    // these 403'd on a branch the user had just created themselves.
    const statusRes = await editorClient.get('/api/canopycms/feature-editor-owned/status')
    expect(statusRes.status).toBe(200)

    const writeRes = await editorClient.put(
      '/api/canopycms/feature-editor-owned/content/posts/hello-world',
      {
        collection: 'content/posts',
        slug: 'hello-world',
        format: 'mdx',
        data: {
          title: 'Hello World',
          author: 'Test Author',
          date: '2024-01-01T00:00:00Z',
          tags: ['intro'],
        },
        body: 'Written by the branch creator under default deny.',
      },
    )
    expect(writeRes.status).toBe(200)

    const readRes = await editorClient.get(
      '/api/canopycms/feature-editor-owned/content/posts/hello-world',
    )
    expect(readRes.status).toBe(200)
  })

  it('still denies a non-admin on a branch created by someone else', async () => {
    // 'deny' has to keep meaning something: the creator grant is scoped to the
    // creator, not to "any branch with no ACL".
    const createRes = await adminClient.post('/api/canopycms/branches', {
      branch: 'feature/admin-owned',
      title: 'Admin owned',
    })
    expect(createRes.status).toBe(200)

    const res = await editorClient.get('/api/canopycms/feature-admin-owned/status')
    expect(res.status).toBe(403)
  })

  it('lets the creator submit their own branch, matching what the UI offers', async () => {
    // The client enables Submit for the branch creator unconditionally. Before
    // this, the server ran the branch-access gate first and 403'd -- an enabled
    // button that always failed, for the branch's own creator.
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/submit-me',
      title: 'Submit me',
    })

    const res = await editorClient.post('/api/canopycms/feature-submit-me/submit', {
      title: 'Submit me',
      description: 'Submitted by the branch creator under default deny.',
    })

    expect(res.status).toBe(200)
  })
})
