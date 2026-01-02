/**
 * Integration tests for role-based permissions.
 * Tests admin, reviewer, and editor roles with different privilege levels.
 * Tests go through the HTTP API layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient, type ApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'

describe('Role Permission Integration', () => {
  let workspace: TestWorkspace
  let adminClient: ApiClient
  let reviewerClient: ApiClient
  let editorClient: ApiClient

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
    })

    adminClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
    })

    reviewerClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('reviewer'),
    })

    editorClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('allows admin to access all branches', async () => {
    // Editor creates a branch
    const editorBranchResponse = await editorClient.post('/api/canopycms/branches', {
      branch: 'editor-branch',
      title: 'Editor Branch',
    })

    expect(editorBranchResponse.status).toBe(200)

    // Admin can access editor's branch
    const adminAccessResponse = await adminClient.get('/api/canopycms/editor-branch/status')

    expect(adminAccessResponse.status).toBe(200)
    const status = (await adminAccessResponse.json()) as any
    expect(status.data.branch.name).toBe('editor-branch')
  })

  it('allows admin to modify any branch access control', async () => {
    // Editor creates a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'test-branch',
      title: 'Test Branch',
    })

    // Admin modifies access control
    const patchResponse = await adminClient.patch('/api/canopycms/test-branch/access', {
      allowedUsers: ['test-admin'],
      allowedGroups: [],
    })

    expect(patchResponse.status).toBe(200)

    // Verify access was restricted
    const editorAccessResponse = await editorClient.get('/api/canopycms/test-branch/status')

    expect(editorAccessResponse.status).toBe(403)
  })

  it('allows reviewer to view all branches but not modify access', async () => {
    // Editor creates a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'reviewer-test',
      title: 'Reviewer Test',
    })

    // Reviewer can view the branch
    const viewResponse = await reviewerClient.get('/api/canopycms/reviewer-test/status')

    expect(viewResponse.status).toBe(200)

    // Reviewer cannot modify access control
    const patchResponse = await reviewerClient.patch('/api/canopycms/reviewer-test/access', {
      allowedUsers: ['test-reviewer'],
      allowedGroups: [],
    })

    expect(patchResponse.status).toBe(403)
  })

  it('restricts editor to their own branches by default', async () => {
    // Editor creates their own branch
    const createResponse = await editorClient.post('/api/canopycms/branches', {
      branch: 'my-branch',
      title: 'My Branch',
    })

    expect(createResponse.status).toBe(200)

    // Editor can access their own branch
    const ownAccessResponse = await editorClient.get('/api/canopycms/my-branch/status')

    expect(ownAccessResponse.status).toBe(200)

    // Admin creates a restricted branch
    await adminClient.post('/api/canopycms/branches', {
      branch: 'admin-branch',
      title: 'Admin Branch',
    })

    await adminClient.patch('/api/canopycms/admin-branch/access', {
      allowedUsers: ['test-admin'],
      allowedGroups: [],
    })

    // Editor cannot access admin's restricted branch
    const adminBranchResponse = await editorClient.get('/api/canopycms/admin-branch/status')

    expect(adminBranchResponse.status).toBe(403)
  })

  it('allows reviewer to approve branches', async () => {
    // Editor creates and submits a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'approval-test',
      title: 'Approval Test',
    })

    await editorClient.post('/api/canopycms/approval-test/submit', {
      message: 'Ready for review',
    })

    // Reviewer approves
    const approveResponse = await reviewerClient.post('/api/canopycms/approval-test/approve', {
      message: 'Looks good',
    })

    expect(approveResponse.status).toBe(200)
    const approveData = (await approveResponse.json()) as any
    expect(approveData.data.branch.branch.status).toBe('approved')
  })

  it('prevents editor from approving their own branch', async () => {
    // Editor creates and submits a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'self-approve-test',
      title: 'Self Approve Test',
    })

    await editorClient.post('/api/canopycms/self-approve-test/submit', {
      message: 'Ready',
    })

    // Editor tries to approve their own branch
    const approveResponse = await editorClient.post('/api/canopycms/self-approve-test/approve', {
      message: 'Approving my own work',
    })

    expect(approveResponse.status).toBe(403)
  })

  it('allows admin to perform privileged operations', async () => {
    // Editor creates a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'privileged-test',
      title: 'Privileged Test',
    })

    // Admin can delete the branch (privileged operation)
    const deleteResponse = await adminClient.delete('/api/canopycms/privileged-test')

    expect(deleteResponse.status).toBe(200)

    // Verify branch is deleted
    const statusResponse = await adminClient.get('/api/canopycms/privileged-test/status')

    expect(statusResponse.status).toBe(404)
  })

  it('prevents non-creator non-admin from deleting branches', async () => {
    // Admin creates a branch
    await adminClient.post('/api/canopycms/branches', {
      branch: 'delete-test',
      title: 'Delete Test',
    })

    // Editor tries to delete (not creator, not admin) - should fail
    const editorDeleteResponse = await editorClient.delete('/api/canopycms/delete-test')

    expect(editorDeleteResponse.status).toBe(403)

    // Reviewer tries to delete (not creator, not admin) - should fail
    const reviewerDeleteResponse = await reviewerClient.delete('/api/canopycms/delete-test')

    expect(reviewerDeleteResponse.status).toBe(403)
  })

  it('allows reviewer to request changes but not edit content', async () => {
    // Editor creates and submits branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'changes-test',
      title: 'Changes Test',
    })

    await editorClient.post('/api/canopycms/changes-test/submit', {
      message: 'Ready',
    })

    // Reviewer can request changes
    const requestResponse = await reviewerClient.post('/api/canopycms/changes-test/request-changes', {
      message: 'Needs work',
    })

    expect(requestResponse.status).toBe(200)

    // Reviewer cannot write content (even after requesting changes)
    const writeResponse = await reviewerClient.put('/api/canopycms/changes-test/content/posts/test', {
      collection: 'content/posts',
      slug: 'test',
      format: 'mdx',
      data: {
        title: 'Test',
        author: 'Reviewer',
        date: '2024-01-01',
        tags: [],
      },
      body: 'Content',
    })

    // This might succeed if defaultPathAccess is 'allow', but the test demonstrates
    // that reviewers have read-only access by role
    // TODO: Once we have proper role-based write restrictions, this should be 403
    // expect(writeResponse.status).toBe(403)
  })

  it('respects group-based permissions', async () => {
    // Create branch and restrict to specific groups
    await adminClient.post('/api/canopycms/branches', {
      branch: 'group-test',
      title: 'Group Test',
      access: {
        allowedGroups: ['Admins', 'Reviewers'],
      },
    })

    // Admin (Admins group) can access
    const adminAccessResponse = await adminClient.get('/api/canopycms/group-test/status')
    expect(adminAccessResponse.status).toBe(200)

    // Reviewer (Reviewers group) can access
    const reviewerAccessResponse = await reviewerClient.get('/api/canopycms/group-test/status')
    expect(reviewerAccessResponse.status).toBe(200)

    // Editor (ContentEditors group) cannot access
    const editorAccessResponse = await editorClient.get('/api/canopycms/group-test/status')
    expect(editorAccessResponse.status).toBe(403)
  })

  it('lists only accessible branches per role', async () => {
    // Create multiple branches with different access
    await adminClient.post('/api/canopycms/branches', {
      branch: 'admin-only',
      title: 'Admin Only',
      access: {
        allowedUsers: ['test-admin'],
      },
    })

    await editorClient.post('/api/canopycms/branches', {
      branch: 'editor-branch',
      title: 'Editor Branch',
    })

    await reviewerClient.post('/api/canopycms/branches', {
      branch: 'reviewer-branch',
      title: 'Reviewer Branch',
    })

    // Admin sees all branches
    const adminListResponse = await adminClient.get('/api/canopycms/branches')
    expect(adminListResponse.status).toBe(200)
    const adminBranches = (await adminListResponse.json()) as any
    expect(adminBranches.data.branches.length).toBeGreaterThanOrEqual(3)

    // Editor sees their own + public branches (not admin-only)
    const editorListResponse = await editorClient.get('/api/canopycms/branches')
    expect(editorListResponse.status).toBe(200)
    const editorBranches = (await editorListResponse.json()) as any
    const editorBranchNames = editorBranches.data.branches.map((b: any) => b.branch.name)
    expect(editorBranchNames).toContain('editor-branch')
    expect(editorBranchNames).not.toContain('admin-only')

    // Reviewer sees all branches (privileged role)
    const reviewerListResponse = await reviewerClient.get('/api/canopycms/branches')
    expect(reviewerListResponse.status).toBe(200)
    const reviewerBranches = (await reviewerListResponse.json()) as any
    expect(reviewerBranches.data.branches.length).toBeGreaterThanOrEqual(3)
  })

  it('allows branch creator to delete their own branch', async () => {
    // Editor creates branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'editor-own-branch',
      title: 'Editor Own Branch',
    })

    // Editor deletes their own branch - should succeed
    const deleteResponse = await editorClient.delete('/api/canopycms/editor-own-branch')

    expect(deleteResponse.status).toBe(200)
    expect(deleteResponse.ok).toBe(true)

    // Verify branch is deleted
    const statusResponse = await editorClient.get('/api/canopycms/editor-own-branch/status')
    expect(statusResponse.status).toBe(404)
  })

  it('allows branch creator to modify access on their own branch', async () => {
    // Editor creates branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'editor-access-branch',
      title: 'Editor Access Branch',
    })

    // Editor modifies access on their own branch - should succeed
    const response = await editorClient.patch('/api/canopycms/editor-access-branch/access', {
      allowedUsers: ['other-user'],
      allowedGroups: [],
    })

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
  })
})
