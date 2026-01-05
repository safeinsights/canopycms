/**
 * Integration tests for HTTP-level input validation.
 * Tests Zod schema validation that happens in the handler layer.
 * Tests go through the HTTP API layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient, type ApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { ApiResponse } from '../../api/types'

describe('Input Validation', () => {
  let workspace: TestWorkspace
  let editorClient: ApiClient

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
    })

    editorClient = createApiClient({
      config: workspace.config,
      authPlugin: createMockAuthPlugin('editor'),
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  describe('Branch Creation', () => {
    it('rejects missing branch name', async () => {
      // Try to create branch with empty branch name
      const response = await editorClient.post('/api/canopycms/branches', {
        branch: '',
        title: 'Test Branch',
      })

      expect(response.status).toBe(400)
      expect(response.ok).toBe(false)
      const error = await response.json<ApiResponse>()
      expect(error.error).toBeDefined()
      expect(error.error).toContain('branch')
    })
  })

  describe('Branch Deletion', () => {
    it('returns 404 if branch param missing', async () => {
      // Try to delete with empty branch parameter
      // Note: Router returns 404 when path params are missing (not matched route)
      const response = await editorClient.delete('/api/canopycms/')

      expect(response.status).toBe(404)
      expect(response.ok).toBe(false)
      const error = await response.json<ApiResponse>()
      expect(error.error).toBeDefined()
    })
  })

  describe('Branch Access Update', () => {
    it('returns 404 if branch param missing', async () => {
      // First create a branch
      await editorClient.post('/api/canopycms/branches', {
        branch: 'test-branch',
        title: 'Test Branch',
      })

      // Try to update access with empty branch parameter
      // Note: Router returns 404 when path params are missing (not matched route)
      const response = await editorClient.patch('/api/canopycms//access', {
        allowedUsers: ['user1'],
      })

      expect(response.status).toBe(404)
      expect(response.ok).toBe(false)
      const error = await response.json<ApiResponse>()
      expect(error.error).toBeDefined()
    })
  })

  describe('Comment Creation', () => {
    beforeEach(async () => {
      // Create a test branch for comment tests
      await editorClient.post('/api/canopycms/branches', {
        branch: 'feature/comments',
        title: 'Comments Test',
      })
    })

    it('returns 400 if text is missing', async () => {
      // Try to add comment without text field
      const response = await editorClient.post('/api/canopycms/feature-comments/comments', {
        type: 'field',
        entryId: 'posts/test',
        canopyPath: 'title',
        // Missing: text
      } as any)

      expect(response.status).toBe(400)
      expect(response.ok).toBe(false)
      const error = await response.json<ApiResponse>()
      expect(error.error).toBeDefined()
      expect(error.error).toContain('text')
    })

    it('returns 400 if type is missing', async () => {
      // Try to add comment without type field
      const response = await editorClient.post('/api/canopycms/feature-comments/comments', {
        text: 'This is a test comment',
        entryId: 'posts/test',
        canopyPath: 'title',
        // Missing: type
      } as any)

      expect(response.status).toBe(400)
      expect(response.ok).toBe(false)
      const error = await response.json<ApiResponse>()
      expect(error.error).toBeDefined()
      expect(error.error).toContain('type')
    })
  })

  describe('Additional Validation', () => {
    it('validates comment type enum values', async () => {
      // Create test branch
      await editorClient.post('/api/canopycms/branches', {
        branch: 'feature/enum-test',
        title: 'Enum Test',
      })

      // Try to add comment with invalid type
      const response = await editorClient.post('/api/canopycms/feature-enum-test/comments', {
        text: 'Test comment',
        type: 'invalid-type',
        entryId: 'posts/test',
      } as any)

      expect(response.status).toBe(400)
      expect(response.ok).toBe(false)
      const error = await response.json<ApiResponse>()
      expect(error.error).toBeDefined()
    })

    it('validates required threadId parameter for resolve', async () => {
      // Create test branch
      await editorClient.post('/api/canopycms/branches', {
        branch: 'feature/resolve-test',
        title: 'Resolve Test',
      })

      // Try to resolve with empty threadId
      // Note: Router returns 404 when path params are missing (not matched route)
      const response = await editorClient.post('/api/canopycms/feature-resolve-test/comments//resolve', {})

      expect(response.status).toBe(404)
      expect(response.ok).toBe(false)
    })
  })
})
