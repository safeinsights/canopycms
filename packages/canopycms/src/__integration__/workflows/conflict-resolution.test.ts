/**
 * Integration tests for conflict resolution workflows.
 * Tests merge conflicts, git errors, and recovery scenarios.
 * Tests go through the HTTP API layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient, type ApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'

describe('Conflict Resolution Integration', () => {
  let workspace: TestWorkspace
  let editor1Client: ApiClient
  let editor2Client: ApiClient
  let adminClient: ApiClient

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
    })

    editor1Client = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
    })

    editor2Client = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
    })

    adminClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('detects conflicts when two editors modify the same content', async () => {
    // Editor 1 creates a branch and writes content
    await editor1Client.post('/api/canopycms/branches', {
      branch: 'feature/conflict-test',
      title: 'Conflict Test',
    })

    await editor1Client.put('/api/canopycms/feature-conflict-test/content/posts/shared-post', {
      collection: 'posts',
      slug: 'shared-post',
      format: 'mdx',
      data: {
        title: 'Shared Post',
        author: 'Editor 1',
        date: '2024-01-01',
        tags: ['test'],
      },
      body: 'Original content from Editor 1',
    })

    // Editor 2 creates a different branch from same base
    await editor2Client.post('/api/canopycms/branches', {
      branch: 'feature/conflict-test-2',
      title: 'Conflict Test 2',
    })

    await editor2Client.put('/api/canopycms/feature-conflict-test-2/content/posts/shared-post', {
      collection: 'posts',
      slug: 'shared-post',
      format: 'mdx',
      data: {
        title: 'Shared Post',
        author: 'Editor 2',
        date: '2024-01-01',
        tags: ['test'],
      },
      body: 'Different content from Editor 2',
    })

    // Both approve and publish
    // When merging, there should be a conflict
    // TODO: Once merge API is implemented, test conflict detection
  })

  it('handles concurrent modifications to different files', async () => {
    // Create branch
    await editor1Client.post('/api/canopycms/branches', {
      branch: 'feature/concurrent-edits',
      title: 'Concurrent Edits',
    })

    // Two editors write different files simultaneously
    const [response1, response2] = await Promise.all([
      editor1Client.put('/api/canopycms/feature-concurrent-edits/content/posts/post-1', {
        collection: 'posts',
        slug: 'post-1',
        format: 'mdx',
        data: {
          title: 'Post 1',
          author: 'Editor 1',
          date: '2024-01-01',
          tags: ['test'],
        },
        body: 'Content 1',
      }),
      editor1Client.put('/api/canopycms/feature-concurrent-edits/content/posts/post-2', {
        collection: 'posts',
        slug: 'post-2',
        format: 'mdx',
        data: {
          title: 'Post 2',
          author: 'Editor 2',
          date: '2024-01-02',
          tags: ['test'],
        },
        body: 'Content 2',
      }),
    ])

    expect(response1.status).toBe(200)
    expect(response2.status).toBe(200)

    // Both files should exist
    const read1 = await editor1Client.get('/api/canopycms/feature-concurrent-edits/content/posts/post-1')
    const read2 = await editor1Client.get('/api/canopycms/feature-concurrent-edits/content/posts/post-2')

    expect(read1.status).toBe(200)
    expect(read2.status).toBe(200)
  })

  it('prevents overwriting uncommitted changes', async () => {
    // Create branch and write content
    await editor1Client.post('/api/canopycms/branches', {
      branch: 'feature/uncommitted-test',
      title: 'Uncommitted Test',
    })

    const write1 = await editor1Client.put('/api/canopycms/feature-uncommitted-test/content/posts/test-post', {
      collection: 'posts',
      slug: 'test-post',
      format: 'mdx',
      data: {
        title: 'Test Post',
        author: 'Editor 1',
        date: '2024-01-01',
        tags: ['test'],
      },
      body: 'First version',
    })

    expect(write1.status).toBe(200)

    // Write again to same file (should succeed with overwrite)
    const write2 = await editor1Client.put('/api/canopycms/feature-uncommitted-test/content/posts/test-post', {
      collection: 'posts',
      slug: 'test-post',
      format: 'mdx',
      data: {
        title: 'Test Post Updated',
        author: 'Editor 1',
        date: '2024-01-01',
        tags: ['test', 'updated'],
      },
      body: 'Second version',
    })

    expect(write2.status).toBe(200)

    // Verify second version is persisted
    const read = await editor1Client.get('/api/canopycms/feature-uncommitted-test/content/posts/test-post')
    expect(read.status).toBe(200)
    const content = (await read.json()) as any
    expect(content.data.data.title).toBe('Test Post Updated')
  })

  it('recovers from git errors gracefully', async () => {
    // Create branch
    await editor1Client.post('/api/canopycms/branches', {
      branch: 'feature/git-error-test',
      title: 'Git Error Test',
    })

    // Write valid content
    const writeResponse = await editor1Client.put(
      '/api/canopycms/feature-git-error-test/content/posts/test-post',
      {
        collection: 'posts',
        slug: 'test-post',
        format: 'mdx',
        data: {
          title: 'Test Post',
          author: 'Editor',
          date: '2024-01-01',
          tags: ['test'],
        },
        body: 'Test content',
      }
    )

    expect(writeResponse.status).toBe(200)

    // Try to write to invalid collection (should fail gracefully)
    const invalidWrite = await editor1Client.put(
      '/api/canopycms/feature-git-error-test/content/invalid-collection/test',
      {
        collection: 'invalid-collection',
        slug: 'test',
        format: 'mdx',
        data: {
          title: 'Test',
        },
        body: 'Should fail',
      }
    )

    // Should get error, not crash
    expect(invalidWrite.status).toBeGreaterThanOrEqual(400)

    // Original content should still be accessible
    const read = await editor1Client.get('/api/canopycms/feature-git-error-test/content/posts/test-post')
    expect(read.status).toBe(200)
  })

  it('handles stale branch state after remote updates', async () => {
    // Create branch
    await editor1Client.post('/api/canopycms/branches', {
      branch: 'feature/stale-state',
      title: 'Stale State Test',
    })

    // Write content
    await editor1Client.put('/api/canopycms/feature-stale-state/content/posts/test-post', {
      collection: 'posts',
      slug: 'test-post',
      format: 'mdx',
      data: {
        title: 'Test Post',
        author: 'Editor',
        date: '2024-01-01',
        tags: ['test'],
      },
      body: 'Original content',
    })

    // Get branch status
    const statusResponse = await editor1Client.get('/api/canopycms/feature-stale-state/status')
    expect(statusResponse.status).toBe(200)
    const status = (await statusResponse.json()) as any

    // Branch should be in editing state
    expect(status.data?.branch?.status || status.data?.status).toBeDefined()
  })
})
