/**
 * Integration tests for the review workflow.
 * Tests submission, review comments, request changes, and approval.
 * Tests go through the HTTP API layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { BranchResponse } from '../../api/branch'
import type {
  CommentsResponse,
  AddCommentResponse,
  ResolveCommentResponse,
} from '../../api/comments'

describe('Review Workflow Integration', () => {
  let workspace: TestWorkspace
  let editorClient: Awaited<ReturnType<typeof createApiClient>>
  let reviewerClient: Awaited<ReturnType<typeof createApiClient>>
  let adminClient: Awaited<ReturnType<typeof createApiClient>>

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
    })

    editorClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
      schema: BLOG_SCHEMA,
    })

    reviewerClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('reviewer'),
      schema: BLOG_SCHEMA,
    })

    adminClient = await createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('admin'),
      schema: BLOG_SCHEMA,
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('completes full review cycle: submit → review → request changes → resubmit → approve', async () => {
    // STEP 1: Editor creates branch
    const createResponse = await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/review-test',
      title: 'Test Review Workflow',
    })

    expect(createResponse.status).toBe(200)
    const createData = await createResponse.json<BranchResponse>()
    expect(createData.data?.branch.status).toBe('editing')

    // STEP 2: Editor writes content (will fail due to collection bug)
    await editorClient.put('/api/canopycms/feature-review-test/content/posts/test-post', {
      collection: 'content/posts',
      slug: 'test-post',
      format: 'mdx',
      data: {
        title: 'Test Post',
        author: 'Test Editor',
        date: '2024-01-01',
        tags: ['test'],
      },
      body: 'This needs review',
    })

    // STEP 3: Editor submits for review
    const submitResponse = await editorClient.post('/api/canopycms/feature-review-test/submit', {
      message: 'Ready for review',
    })

    expect(submitResponse.status).toBe(200)
    const submitData = await submitResponse.json<BranchResponse>()
    expect(submitData.data?.branch.status).toBe('submitted')

    // STEP 4: Reviewer adds comment
    const commentResponse = await reviewerClient.post(
      '/api/canopycms/feature-review-test/comments',
      {
        text: 'Please add more details to the introduction',
        type: 'entry',
        entryPath: 'content/posts/test-post',
      },
    )

    expect(commentResponse.status).toBe(200)

    // STEP 5: Reviewer requests changes
    const requestChangesResponse = await reviewerClient.post(
      '/api/canopycms/feature-review-test/request-changes',
      {
        message: 'Needs more details',
      },
    )

    expect(requestChangesResponse.status).toBe(200)
    const requestChangesData = await requestChangesResponse.json<BranchResponse>()
    expect(requestChangesData.data?.branch.status).toBe('editing')

    // STEP 6: Editor updates content and resubmits
    await editorClient.put('/api/canopycms/feature-review-test/content/posts/test-post', {
      collection: 'content/posts',
      slug: 'test-post',
      format: 'mdx',
      data: {
        title: 'Test Post',
        author: 'Test Editor',
        date: '2024-01-01',
        tags: ['test'],
      },
      body: 'This needs review. Added more details as requested.',
    })

    const resubmitResponse = await editorClient.post('/api/canopycms/feature-review-test/submit', {
      message: 'Updated with more details',
    })

    expect(resubmitResponse.status).toBe(200)

    // STEP 7: Reviewer approves
    const approveResponse = await reviewerClient.post(
      '/api/canopycms/feature-review-test/approve',
      {
        message: 'Looks good!',
      },
    )

    expect(approveResponse.status).toBe(200)
    const approveData = await approveResponse.json<BranchResponse>()
    expect(approveData.data?.branch.status).toBe('approved')
  })

  it('allows multiple reviewers to comment', async () => {
    // Create and submit branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/multi-reviewer',
      title: 'Multi Reviewer Test',
    })

    await editorClient.post('/api/canopycms/feature-multi-reviewer/submit', {
      message: 'Ready for review',
    })

    // Both reviewer and admin add comments concurrently
    // (CommentStore now handles concurrency with optimistic locking)
    const [reviewerComment, adminComment] = await Promise.all([
      reviewerClient.post('/api/canopycms/feature-multi-reviewer/comments', {
        text: 'Reviewer comment',
        type: 'branch',
      }),
      adminClient.post('/api/canopycms/feature-multi-reviewer/comments', {
        text: 'Admin comment',
        type: 'branch',
      }),
    ])

    expect(reviewerComment.status).toBe(200)
    expect(adminComment.status).toBe(200)

    // List all comments
    const listResponse = await reviewerClient.get('/api/canopycms/feature-multi-reviewer/comments')

    expect(listResponse.status).toBe(200)
    const listData = await listResponse.json<CommentsResponse>()
    expect(listData.data?.threads.length).toBeGreaterThanOrEqual(2)
  })

  it('enforces reviewer permissions', async () => {
    // Editor creates and submits branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/permission-test',
      title: 'Permission Test',
    })

    await editorClient.post('/api/canopycms/feature-permission-test/submit', {
      message: 'Ready',
    })

    // Editor (not a reviewer) tries to approve - should fail
    const approveResponse = await editorClient.post(
      '/api/canopycms/feature-permission-test/approve',
      {
        message: 'Approving my own work',
      },
    )

    expect(approveResponse.status).toBe(403)
  })

  it('supports comment threads and resolution', async () => {
    // Create and submit branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/comment-threads',
      title: 'Comment Threads Test',
    })

    await editorClient.post('/api/canopycms/feature-comment-threads/submit', {
      message: 'Ready',
    })

    // Reviewer adds a comment
    const commentResponse = await reviewerClient.post(
      '/api/canopycms/feature-comment-threads/comments',
      {
        text: 'This needs fixing',
        type: 'branch',
      },
    )

    expect(commentResponse.status).toBe(200)
    const commentData = await commentResponse.json<AddCommentResponse>()
    const threadId = commentData.data?.threadId

    // Reviewer resolves the comment thread
    const resolveResponse = await reviewerClient.post(
      `/api/canopycms/feature-comment-threads/comments/${threadId}/resolve`,
      {},
    )

    expect(resolveResponse.status).toBe(200)
    const resolveData = await resolveResponse.json<ResolveCommentResponse>()
    expect(resolveData.data?.resolved).toBe(true)
  })

  it('allows withdrawal from review', async () => {
    // Create and submit branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/withdraw-test',
      title: 'Withdraw Test',
    })

    const submitResponse = await editorClient.post('/api/canopycms/feature-withdraw-test/submit', {
      message: 'Ready',
    })

    expect(submitResponse.status).toBe(200)

    // Editor withdraws submission
    const withdrawResponse = await editorClient.post(
      '/api/canopycms/feature-withdraw-test/withdraw',
      {},
    )

    expect(withdrawResponse.status).toBe(200)
    const withdrawData = await withdrawResponse.json<BranchResponse>()
    expect(withdrawData.data?.branch.status).toBe('editing')
  })
})
