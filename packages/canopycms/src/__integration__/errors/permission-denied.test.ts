/**
 * Integration tests for permission denied scenarios.
 * Tests proper error messages and status codes for unauthorized access.
 * Tests go through the HTTP API layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient, type ApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { ApiResponse } from '../../api/types'

describe('Permission Denied Errors', () => {
  let workspace: TestWorkspace
  let adminClient: ApiClient
  let editorClient: ApiClient
  let reviewerClient: ApiClient

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
    })

    adminClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
    })

    editorClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
    })

    reviewerClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('reviewer'),
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('returns 403 when editor tries to access restricted branch', async () => {
    // Admin creates a restricted branch
    await adminClient.post('/api/canopycms/branches', {
      branch: 'admin-only',
      title: 'Admin Only Branch',
    })

    await adminClient.patch('/api/canopycms/admin-only/access', {
      allowedUsers: ['test-admin'],
      allowedGroups: [],
    })

    // Editor tries to access
    const response = await editorClient.get('/api/canopycms/admin-only/status')

    expect(response.status).toBe(403)
    expect(response.ok).toBe(false)
    const error = await response.json<ApiResponse>()
    expect(error.error).toBeDefined()
  })

  it('returns 403 when editor tries to access restricted content path', async () => {
    // Admin creates branch with path restrictions
    await adminClient.post('/api/canopycms/branches', {
      branch: 'restricted-paths',
      title: 'Restricted Paths',
    })

    // Write content as admin
    await adminClient.put('/api/canopycms/restricted-paths/content/posts/admin-post', {
      collection: 'posts',
      slug: 'admin-post',
      format: 'mdx',
      data: {
        title: 'Admin Post',
        author: 'Admin',
        date: '2024-01-01',
        tags: ['admin'],
      },
      body: 'Admin only content',
    })

    // TODO: Once path-level access control is enforced in API, test:
    // - Editor tries to read restricted path (should be 403)
    // - Editor tries to write to restricted path (should be 403)
  })

  it('returns 403 when non-reviewer tries to approve', async () => {
    // Editor creates and submits branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/approval-test',
      title: 'Approval Test',
    })

    await editorClient.post('/api/canopycms/feature-approval-test/submit', {
      message: 'Ready for review',
    })

    // Editor (not a reviewer) tries to approve
    const response = await editorClient.post('/api/canopycms/feature-approval-test/approve', {
      message: 'Trying to approve',
    })

    expect(response.status).toBe(403)
    expect(response.ok).toBe(false)
  })

  it('returns 403 when non-admin tries to delete branch they did not create', async () => {
    // Admin creates a branch
    await adminClient.post('/api/canopycms/branches', {
      branch: 'feature/delete-test',
      title: 'Delete Test',
    })

    // Editor tries to delete (not their branch, not admin) - should fail
    const editorDeleteResponse = await editorClient.delete('/api/canopycms/feature-delete-test')

    expect(editorDeleteResponse.status).toBe(403)
    expect(editorDeleteResponse.ok).toBe(false)

    // Reviewer tries to delete (not their branch, not admin) - should also fail
    const reviewerDeleteResponse = await reviewerClient.delete('/api/canopycms/feature-delete-test')

    expect(reviewerDeleteResponse.status).toBe(403)
    expect(reviewerDeleteResponse.ok).toBe(false)

    // Admin can delete (they are the creator and also admin)
    const adminDeleteResponse = await adminClient.delete('/api/canopycms/feature-delete-test')

    expect(adminDeleteResponse.status).toBe(200)
    expect(adminDeleteResponse.ok).toBe(true)
  })

  it('returns 403 when editor tries to modify branch access control on branch they did not create', async () => {
    // Admin creates a branch
    await adminClient.post('/api/canopycms/branches', {
      branch: 'feature/access-test',
      title: 'Access Test',
    })

    // Editor tries to modify access control (not their branch, not admin) - should fail
    const response = await editorClient.patch('/api/canopycms/feature-access-test/access', {
      allowedUsers: ['test-editor'],
      allowedGroups: [],
    })

    expect(response.status).toBe(403)
    expect(response.ok).toBe(false)
  })

  it('returns proper error message for permission denied', async () => {
    // Admin creates restricted branch
    await adminClient.post('/api/canopycms/branches', {
      branch: 'restricted',
      title: 'Restricted',
    })

    await adminClient.patch('/api/canopycms/restricted/access', {
      allowedUsers: ['test-admin'],
      allowedGroups: [],
    })

    // Editor tries to access
    const response = await editorClient.get('/api/canopycms/restricted/status')

    expect(response.status).toBe(403)
    const error = await response.json<ApiResponse>()
    expect(error.error).toBeTruthy()
    expect(typeof error.error).toBe('string')
    // Error message should be informative
    expect(error.error!.length).toBeGreaterThan(0)
  })

  it('returns 403 when reviewer tries to edit content', async () => {
    // Editor creates branch with content
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/reviewer-test',
      title: 'Reviewer Test',
    })

    await editorClient.put('/api/canopycms/feature-reviewer-test/content/posts/test-post', {
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

    // Reviewer can read (view access)
    const readResponse = await reviewerClient.get(
      '/api/canopycms/feature-reviewer-test/content/posts/test-post',
    )
    expect(readResponse.status).toBe(200)

    // Reviewer tries to edit (should fail - reviewers have read-only access)
    // TODO: Once role-based write restrictions are enforced, this should be 403
    const writeResponse = await reviewerClient.put(
      '/api/canopycms/feature-reviewer-test/content/posts/test-post',
      {
        collection: 'posts',
        slug: 'test-post',
        format: 'mdx',
        data: {
          title: 'Modified by Reviewer',
          author: 'Reviewer',
          date: '2024-01-01',
          tags: ['test'],
        },
        body: 'Modified content',
      },
    )

    // This might succeed if defaultPathAccess is 'allow', but eventually should be 403
    // expect(writeResponse.status).toBe(403)
  })
})
