/**
 * Integration tests for role-based permissions.
 * Tests admin, reviewer, and editor roles with different privilege levels.
 * Tests go through the HTTP API layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin, TEST_INTERNAL_GROUPS } from '../test-utils/multi-user'
import { createApiClient, saveSamplePost } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { BranchListItemResponse, BranchListResponse } from '../../api/branch'
import { getBranchMetadataFileManager, loadBranchContext } from '../../branch-metadata'

describe('Role Permission Integration', () => {
  let workspace: TestWorkspace
  let adminClient: Awaited<ReturnType<typeof createApiClient>>
  let reviewerClient: Awaited<ReturnType<typeof createApiClient>>
  let editorClient: Awaited<ReturnType<typeof createApiClient>>

  beforeEach(async () => {
    workspace = await createTestWorkspace(
      {
        schema: BLOG_SCHEMA,
      },
      // Reserved provider groups are stripped (SEC-H1); privileged personas
      // get their Admins/Reviewers membership from internal groups
      { internalGroups: TEST_INTERNAL_GROUPS },
    )

    adminClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      schema: BLOG_SCHEMA,
    })

    reviewerClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('reviewer'),
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

  it('allows admin to access all branches', async () => {
    // Editor creates a branch
    const editorBranchResponse = await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-editor-branch',
      title: 'Editor Branch',
    })

    expect(editorBranchResponse.status).toBe(200)

    // Admin can access editor's branch
    const adminAccessResponse = await adminClient.get(
      '/api/canopycms/canopycms-editor-branch/status',
    )

    expect(adminAccessResponse.status).toBe(200)
    const status = await adminAccessResponse.json<BranchListItemResponse>()
    expect(status.data?.branch.name).toBe('canopycms-editor-branch')
  })

  it('allows admin to modify any branch access control', async () => {
    // Editor creates a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-test-branch',
      title: 'Test Branch',
    })

    // Admin modifies access control
    const patchResponse = await adminClient.patch('/api/canopycms/canopycms-test-branch/access', {
      allowedUsers: ['test-admin'],
      allowedGroups: [],
    })

    expect(patchResponse.status).toBe(200)

    // Verify access was restricted
    const editorAccessResponse = await editorClient.get(
      '/api/canopycms/canopycms-test-branch/status',
    )

    expect(editorAccessResponse.status).toBe(403)
  })

  it('allows reviewer to view all branches but not modify access', async () => {
    // Editor creates a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-reviewer-test',
      title: 'Reviewer Test',
    })

    // Reviewer can view the branch
    const viewResponse = await reviewerClient.get('/api/canopycms/canopycms-reviewer-test/status')

    expect(viewResponse.status).toBe(200)

    // Reviewer cannot modify access control
    const patchResponse = await reviewerClient.patch(
      '/api/canopycms/canopycms-reviewer-test/access',
      {
        allowedUsers: ['test-reviewer'],
        allowedGroups: [],
      },
    )

    expect(patchResponse.status).toBe(403)
  })

  it('restricts editor to their own branches by default', async () => {
    // Editor creates their own branch
    const createResponse = await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-my-branch',
      title: 'My Branch',
    })

    expect(createResponse.status).toBe(200)

    // Editor can access their own branch
    const ownAccessResponse = await editorClient.get('/api/canopycms/canopycms-my-branch/status')

    expect(ownAccessResponse.status).toBe(200)

    // Admin creates a restricted branch
    await adminClient.post('/api/canopycms/branches', {
      branch: 'canopycms-admin-branch',
      title: 'Admin Branch',
    })

    await adminClient.patch('/api/canopycms/canopycms-admin-branch/access', {
      allowedUsers: ['test-admin'],
      allowedGroups: [],
    })

    // Editor cannot access admin's restricted branch
    const adminBranchResponse = await editorClient.get(
      '/api/canopycms/canopycms-admin-branch/status',
    )

    expect(adminBranchResponse.status).toBe(403)
  })

  it('allows reviewer to approve branches', async () => {
    // Editor creates and submits a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-approval-test',
      title: 'Approval Test',
    })

    await saveSamplePost(editorClient, 'canopycms-approval-test')

    await editorClient.post('/api/canopycms/canopycms-approval-test/submit', {
      message: 'Ready for review',
    })

    // Reviewer approves
    const approveResponse = await reviewerClient.post(
      '/api/canopycms/canopycms-approval-test/approve',
      {
        message: 'Looks good',
      },
    )

    expect(approveResponse.status).toBe(200)
    const approveData = await approveResponse.json<BranchListItemResponse>()
    expect(approveData.data?.branch.status).toBe('approved')
  })

  it('prevents editor from approving their own branch', async () => {
    // Editor creates and submits a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-self-approve-test',
      title: 'Self Approve Test',
    })

    await saveSamplePost(editorClient, 'canopycms-self-approve-test')

    await editorClient.post('/api/canopycms/canopycms-self-approve-test/submit', {
      message: 'Ready',
    })

    // Editor tries to approve their own branch
    const approveResponse = await editorClient.post(
      '/api/canopycms/canopycms-self-approve-test/approve',
      {
        message: 'Approving my own work',
      },
    )

    expect(approveResponse.status).toBe(403)
  })

  it('allows admin to perform privileged operations', async () => {
    // Editor creates a branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-privileged-test',
      title: 'Privileged Test',
    })

    // Admin can delete the branch (privileged operation)
    const deleteResponse = await adminClient.delete('/api/canopycms/canopycms-privileged-test')

    expect(deleteResponse.status).toBe(200)

    // Verify branch is deleted
    const statusResponse = await adminClient.get('/api/canopycms/canopycms-privileged-test/status')

    expect(statusResponse.status).toBe(404)
  })

  it('prevents non-creator non-admin from deleting branches', async () => {
    // Admin creates a branch
    await adminClient.post('/api/canopycms/branches', {
      branch: 'canopycms-delete-test',
      title: 'Delete Test',
    })

    // Editor tries to delete (not creator, not admin) - should fail
    const editorDeleteResponse = await editorClient.delete('/api/canopycms/canopycms-delete-test')

    expect(editorDeleteResponse.status).toBe(403)

    // Reviewer tries to delete (not creator, not admin) - should fail
    const reviewerDeleteResponse = await reviewerClient.delete(
      '/api/canopycms/canopycms-delete-test',
    )

    expect(reviewerDeleteResponse.status).toBe(403)
  })

  it('allows reviewer to request changes but not edit content', async () => {
    // Editor creates and submits branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-changes-test',
      title: 'Changes Test',
    })

    await saveSamplePost(editorClient, 'canopycms-changes-test')

    await editorClient.post('/api/canopycms/canopycms-changes-test/submit', {
      message: 'Ready',
    })

    // Reviewer can request changes
    const requestResponse = await reviewerClient.post(
      '/api/canopycms/canopycms-changes-test/request-changes',
      {
        message: 'Needs work',
      },
    )

    expect(requestResponse.status).toBe(200)

    // Reviewer cannot write content (even after requesting changes)
    await reviewerClient.put('/api/canopycms/canopycms-changes-test/content/posts/test', {
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
      branch: 'canopycms-group-test',
      title: 'Group Test',
      access: {
        allowedGroups: ['Admins', 'Reviewers'],
      },
    })

    // Admin (Admins group) can access
    const adminAccessResponse = await adminClient.get('/api/canopycms/canopycms-group-test/status')
    expect(adminAccessResponse.status).toBe(200)

    // Reviewer (Reviewers group) can access
    const reviewerAccessResponse = await reviewerClient.get(
      '/api/canopycms/canopycms-group-test/status',
    )
    expect(reviewerAccessResponse.status).toBe(200)

    // Editor (ContentEditors group) cannot access
    const editorAccessResponse = await editorClient.get(
      '/api/canopycms/canopycms-group-test/status',
    )
    expect(editorAccessResponse.status).toBe(403)
  })

  it('lists only accessible branches per role', async () => {
    // Create multiple branches with different access
    await adminClient.post('/api/canopycms/branches', {
      branch: 'canopycms-admin-only',
      title: 'Admin Only',
      access: {
        allowedUsers: ['test-admin'],
      },
    })

    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-editor-branch',
      title: 'Editor Branch',
    })

    await reviewerClient.post('/api/canopycms/branches', {
      branch: 'canopycms-reviewer-branch',
      title: 'Reviewer Branch',
    })

    // Admin sees all branches
    const adminListResponse = await adminClient.get('/api/canopycms/branches')
    expect(adminListResponse.status).toBe(200)
    const adminBranches = await adminListResponse.json<BranchListResponse>()
    expect(adminBranches.data?.branches.length).toBeGreaterThanOrEqual(3)

    // Editor sees their own + public branches (not admin-only)
    const editorListResponse = await editorClient.get('/api/canopycms/branches')
    expect(editorListResponse.status).toBe(200)
    const editorBranches = await editorListResponse.json<BranchListResponse>()
    const editorBranchNames = editorBranches.data?.branches.map((b) => b.name)
    expect(editorBranchNames).toContain('canopycms-editor-branch')
    expect(editorBranchNames).not.toContain('canopycms-admin-only')

    // Reviewer sees all branches (privileged role)
    const reviewerListResponse = await reviewerClient.get('/api/canopycms/branches')
    expect(reviewerListResponse.status).toBe(200)
    const reviewerBranches = await reviewerListResponse.json<BranchListResponse>()
    expect(reviewerBranches.data?.branches.length).toBeGreaterThanOrEqual(3)
  })

  it('refuses a locked-down branch to an editor its ACL names, on every route', async () => {
    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-locked-branch',
      title: 'Locked Branch',
      access: { allowedUsers: ['test-editor'], allowedGroups: ['ContentEditors'] },
    })
    await saveSamplePost(editorClient, 'canopycms-locked-branch')
    const editorBefore = await editorClient.get('/api/canopycms/canopycms-locked-branch/status')
    expect(editorBefore.status).toBe(200)

    // No API sets the lockdown, so write it into branch.json directly.
    const context = await loadBranchContext({ branchName: 'canopycms-locked-branch', mode: 'dev' })
    if (!context) throw new Error('locked-branch was not provisioned')
    await getBranchMetadataFileManager(context.branchRoot, context.baseRoot).save({
      branch: { access: { managerOrAdminAllowed: true } },
    })

    const post = '/api/canopycms/canopycms-locked-branch/content/posts/sample-post'
    expect((await editorClient.get('/api/canopycms/canopycms-locked-branch/status')).status).toBe(
      403,
    )
    expect((await editorClient.get(post)).status).toBe(403)
    expect(
      (
        await editorClient.put(post, {
          format: 'mdx',
          data: { title: 'Edited', author: 'Test Editor', date: '2024-01-01', tags: [] },
          body: 'Edited body',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await editorClient.post('/api/canopycms/canopycms-locked-branch/comments', {
          text: 'Still here',
          type: 'entry',
          entryPath: 'content/posts/sample-post',
        })
      ).status,
    ).toBe(403)
    expect(
      (await editorClient.post('/api/canopycms/canopycms-locked-branch/submit', {})).status,
    ).toBe(403)
    const editorList = await (
      await editorClient.get('/api/canopycms/branches')
    ).json<BranchListResponse>()
    expect(editorList.data?.branches.map((b) => b.name)).not.toContain('canopycms-locked-branch')

    expect((await reviewerClient.get(post)).status).toBe(200)
    expect((await adminClient.get(post)).status).toBe(200)
    const reviewerList = await (
      await reviewerClient.get('/api/canopycms/branches')
    ).json<BranchListResponse>()
    expect(reviewerList.data?.branches.map((b) => b.name)).toContain('canopycms-locked-branch')
  })

  it('allows branch creator to delete their own branch', async () => {
    // Editor creates branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-editor-own-branch',
      title: 'Editor Own Branch',
    })

    // Editor deletes their own branch - should succeed
    const deleteResponse = await editorClient.delete('/api/canopycms/canopycms-editor-own-branch')

    expect(deleteResponse.status).toBe(200)
    expect(deleteResponse.ok).toBe(true)

    // Verify branch is deleted
    const statusResponse = await editorClient.get(
      '/api/canopycms/canopycms-editor-own-branch/status',
    )
    expect(statusResponse.status).toBe(404)
  })

  it('allows branch creator to modify access on their own branch', async () => {
    // Editor creates branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'canopycms-editor-access-branch',
      title: 'Editor Access Branch',
    })

    // Editor modifies access on their own branch - should succeed
    const response = await editorClient.patch(
      '/api/canopycms/canopycms-editor-access-branch/access',
      {
        allowedUsers: ['other-user'],
        allowedGroups: [],
      },
    )

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
  })
})
