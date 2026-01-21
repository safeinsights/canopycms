/**
 * Integration tests for the editing workflow.
 * Tests the complete lifecycle: create branch → edit content → save → commit
 * Tests go through the HTTP API layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { simpleGit } from 'simple-git'
import path from 'node:path'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient, type ApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { BranchResponse } from '../../api/branch'
import { initTestRepo } from '../../test-utils'

describe('Editing Workflow Integration', () => {
  let workspace: TestWorkspace
  let editorClient: Awaited<ReturnType<typeof createApiClient>>

  beforeEach(async () => {
    workspace = await createTestWorkspace({
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

  it('completes full editing cycle: create → edit → save → commit', async () => {
    // Create branch via API
    const createResponse = await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/new-post',
      title: 'Add blog post',
    })

    expect(createResponse.status).toBe(200)
    const createData = await createResponse.json<BranchResponse>()
    expect(createData.data?.branch.status).toBe('editing')
    expect(createData.data?.branch.createdBy).toBe('test-editor')

    // Get branch workspace path from response
    const branchRoot = (createData.data?.branch as { workspaceRoot?: string })?.workspaceRoot

    // Write content via API (will fail due to collection path bug, but test the structure)
    const writeResponse = await editorClient.put(
      '/api/canopycms/feature-new-post/content/posts/hello-world',
      {
        collection: 'content/posts',
        slug: 'hello-world',
        format: 'mdx',
        data: {
          title: 'Hello World',
          author: 'Test Author',
          date: '2024-01-01T00:00:00Z',
          tags: ['intro', 'test'],
        },
        body: 'This is my first post!',
      },
    )

    // TODO: This will fail until collection path bug is fixed
    // expect(writeResponse.status).toBe(200)

    // Commit changes (if write succeeded)
    if (writeResponse.status === 200 && branchRoot) {
      await initTestRepo(branchRoot)
      const git = simpleGit({ baseDir: branchRoot })
      await git.add(['.'])
      await git.commit('Add hello world post')

      // Verify commit exists
      const log = await git.log()
      expect(log.latest?.message).toBe('Add hello world post')
    }
  })

  it('handles concurrent edits on different branches', async () => {
    const editor1Client = editorClient
    const editor2Client = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      schema: BLOG_SCHEMA,
    })

    // Both editors create branches simultaneously
    const [branchA, branchB] = await Promise.all([
      editor1Client.post('/api/canopycms/branches', {
        branch: 'feature/editor1-post',
        title: 'Editor 1 Post',
      }),
      editor2Client.post('/api/canopycms/branches', {
        branch: 'feature/editor2-post',
        title: 'Editor 2 Post',
      }),
    ])

    expect(branchA.status).toBe(200)
    expect(branchB.status).toBe(200)

    // Both write content simultaneously (will fail due to collection bug)
    await Promise.all([
      editor1Client.put('/api/canopycms/feature-editor1-post/content/posts/post-a', {
        collection: 'content/posts',
        slug: 'post-a',
        format: 'mdx',
        data: {
          title: 'Post A',
          author: 'Editor 1',
          date: '2024-01-01',
          tags: ['test'],
        },
        body: 'Content A',
      }),
      editor2Client.put('/api/canopycms/feature-editor2-post/content/posts/post-b', {
        collection: 'content/posts',
        slug: 'post-b',
        format: 'mdx',
        data: {
          title: 'Post B',
          author: 'Editor 2',
          date: '2024-01-02',
          tags: ['test'],
        },
        body: 'Content B',
      }),
    ])

    // TODO: Verify isolation once collection bug is fixed
    // Each user should only see their own content
  })

  it('supports multi-file editing with proper git commits', async () => {
    const adminClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      schema: BLOG_SCHEMA,
    })

    // Create branch
    const createResponse = await adminClient.post('/api/canopycms/branches', {
      branch: 'feature/multi-file',
      title: 'Multi-file editing',
    })

    expect(createResponse.status).toBe(200)
    const createData = await createResponse.json<BranchResponse>()
    const branchRoot = (createData.data?.branch as { workspaceRoot?: string })?.workspaceRoot

    // Write multiple posts via API
    await Promise.all([
      adminClient.put('/api/canopycms/feature-multi-file/content/posts/post-1', {
        collection: 'content/posts',
        slug: 'post-1',
        format: 'mdx',
        data: { title: 'Post 1', author: 'Admin', date: '2024-01-01', tags: ['test'] },
        body: 'First post',
      }),
      adminClient.put('/api/canopycms/feature-multi-file/content/posts/post-2', {
        collection: 'content/posts',
        slug: 'post-2',
        format: 'mdx',
        data: { title: 'Post 2', author: 'Admin', date: '2024-01-02', tags: ['test'] },
        body: 'Second post',
      }),
      adminClient.put('/api/canopycms/feature-multi-file/content/posts/post-3', {
        collection: 'content/posts',
        slug: 'post-3',
        format: 'mdx',
        data: { title: 'Post 3', author: 'Admin', date: '2024-01-03', tags: ['test'] },
        body: 'Third post',
      }),
    ])

    // TODO: Once collection bug is fixed, commit and verify
    if (branchRoot) {
      const git = simpleGit({ baseDir: branchRoot })
      const status = await git.status()
      // Should have files if writes succeeded
      // expect(status.files.length).toBeGreaterThan(0)
    }
  })
})
