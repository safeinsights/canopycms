/**
 * API-level integration tests for editing workflows.
 * These tests go through the HTTP API layer, not calling core code directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient, type ApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { BranchResponse, BranchListResponse } from '../../api/branch'
import type { EntriesResponse } from '../../api/entries'
import type { ApiResponse } from '../../api/types'

describe('API Editing Workflow Integration', () => {
  let workspace: TestWorkspace
  let adminClient: ApiClient
  let editorClient: ApiClient

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
    })

    // Create API clients for different users
    adminClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
    })

    editorClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('completes full editing cycle through API: create → edit → save', async () => {
    // STEP 1: Create branch via API
    const createResponse = await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/new-post',
      title: 'Add new blog post',
    })

    expect(createResponse.status).toBe(200)
    expect(createResponse.ok).toBe(true)
    const createData = await createResponse.json<BranchResponse>()
    expect(createData.data?.branch.name).toBe('feature-new-post')
    expect(createData.data?.branch.status).toBe('editing')

    // STEP 2: Write content via API (path-based routing)
    const writeResponse = await editorClient.put(
      '/api/canopycms/feature-new-post/content/posts/hello-world',
      {
        format: 'mdx',
        data: {
          title: 'Hello World',
          author: 'Test Author',
          date: '2024-01-01T00:00:00Z',
          tags: ['intro', 'test'],
        },
        body: 'This is my first post!',
      }
    )

    if (writeResponse.status !== 200) {
      console.error('Write content failed:', await writeResponse.json())
    }
    expect(writeResponse.status).toBe(200)
    expect(writeResponse.ok).toBe(true)

    // STEP 3: Read content back via API to verify
    const readResponse = await editorClient.get('/api/canopycms/feature-new-post/content/posts/hello-world')

    if (readResponse.status !== 200) {
      console.error('Read content failed:', await readResponse.json())
    }
    expect(readResponse.status).toBe(200)
    expect(readResponse.ok).toBe(true)
    const content = await readResponse.json<ApiResponse<{ format: string; data: Record<string, unknown>; body?: string }>>()
    // content.data is the ContentDocument: { format, data: {...frontmatter}, body, ... }
    expect(content.data?.data.title).toBe('Hello World')
    expect(content.data?.body?.trim()).toBe('This is my first post!')

    // STEP 4: List entries via API
    const entriesResponse = await editorClient.get('/api/canopycms/feature-new-post/entries')

    expect(entriesResponse.status).toBe(200)
    const entries = await entriesResponse.json<EntriesResponse>()
    expect(entries.data?.entries).toBeDefined()
    expect(entries.data?.entries.length).toBeGreaterThan(0)

    // STEP 5: Get branch status via API
    const statusResponse = await editorClient.get('/api/canopycms/feature-new-post/status')

    expect(statusResponse.status).toBe(200)
    const status = await statusResponse.json<BranchResponse>()
    expect(status.data?.branch.status).toBe('editing')
  })

  it('enforces permissions at API level', async () => {
    // STEP 1: Admin creates a branch
    const createResponse = await adminClient.post('/api/canopycms/branches', {
      branch: 'admin-only-branch',
      title: 'Admin Only',
    })

    expect(createResponse.status).toBe(200)

    // STEP 2: Admin restricts branch access
    const patchResponse = await adminClient.patch('/api/canopycms/admin-only-branch/access', {
      allowedUsers: ['test-admin'],
      allowedGroups: [],
      managerOrAdminAllowed: true,
    })

    expect(patchResponse.status).toBe(200)

    // STEP 3: Regular editor tries to access - should be denied
    const editorAccessResponse = await editorClient.get('/api/canopycms/admin-only-branch/status')

    expect(editorAccessResponse.status).toBe(403)
    expect(editorAccessResponse.ok).toBe(false)

    // STEP 4: Admin can still access
    const adminAccessResponse = await adminClient.get('/api/canopycms/admin-only-branch/status')

    expect(adminAccessResponse.status).toBe(200)
    expect(adminAccessResponse.ok).toBe(true)
  })

  it('handles concurrent API requests from different users', async () => {
    // Both users create branches simultaneously
    const [adminBranchResponse, editorBranchResponse] = await Promise.all([
      adminClient.post('/api/canopycms/branches', {
        branch: 'admin-feature',
        title: 'Admin Feature',
      }),
      editorClient.post('/api/canopycms/branches', {
        branch: 'editor-feature',
        title: 'Editor Feature',
      }),
    ])

    expect(adminBranchResponse.status).toBe(200)
    expect(editorBranchResponse.status).toBe(200)

    // Both users write content to their own branches (path-based routing)
    const [adminWriteResponse, editorWriteResponse] = await Promise.all([
      adminClient.put('/api/canopycms/admin-feature/content/posts/admin-post', {
        format: 'mdx',
        data: {
          title: 'Admin Post',
          author: 'Admin',
          date: '2024-01-01',
          tags: ['admin'],
        },
        body: 'Admin content',
      }),
      editorClient.put('/api/canopycms/editor-feature/content/posts/editor-post', {
        format: 'mdx',
        data: {
          title: 'Editor Post',
          author: 'Editor',
          date: '2024-01-01',
          tags: ['editor'],
        },
        body: 'Editor content',
      }),
    ])

    expect(adminWriteResponse.status).toBe(200)
    expect(editorWriteResponse.status).toBe(200)

    // Verify each user can read their own content
    const adminReadResponse = await adminClient.get('/api/canopycms/admin-feature/content/posts/admin-post')
    expect(adminReadResponse.status).toBe(200)

    const editorReadResponse = await editorClient.get('/api/canopycms/editor-feature/content/posts/editor-post')
    expect(editorReadResponse.status).toBe(200)

    // Admin restricts their branch to admin-only
    const restrictResponse = await adminClient.patch('/api/canopycms/admin-feature/access', {
      allowedUsers: ['test-admin'],
      allowedGroups: [],
      managerOrAdminAllowed: true,
    })
    expect(restrictResponse.status).toBe(200)

    // Cross-branch access with ACL
    const adminReadEditorResponse = await adminClient.get(
      '/api/canopycms/editor-feature/content/posts/editor-post'
    )
    expect(adminReadEditorResponse.status).toBe(200) // Admin can access everything

    const editorReadAdminResponse = await editorClient.get('/api/canopycms/admin-feature/content/posts/admin-post')
    expect(editorReadAdminResponse.status).toBe(403) // Editor cannot access restricted admin branch
  })

  it('lists branches via API with proper filtering', async () => {
    // Create multiple branches
    await adminClient.post('/api/canopycms/branches', {
      branch: 'public-branch',
      title: 'Public Branch',
    })

    await editorClient.post('/api/canopycms/branches', {
      branch: 'editor-branch',
      title: 'Editor Branch',
    })

    // List branches as admin - should see all
    const adminListResponse = await adminClient.get('/api/canopycms/branches')
    expect(adminListResponse.status).toBe(200)
    const adminBranches = await adminListResponse.json<BranchListResponse>()
    expect(adminBranches.data?.branches.length).toBeGreaterThanOrEqual(2)

    // List branches as editor - should see their own + public
    const editorListResponse = await editorClient.get('/api/canopycms/branches')
    expect(editorListResponse.status).toBe(200)
    const editorBranches = await editorListResponse.json<BranchListResponse>()
    expect(editorBranches.data?.branches.some((b) => b.name === 'editor-branch')).toBe(true)
  })
})
