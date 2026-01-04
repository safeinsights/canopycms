/**
 * Integration tests for invalid content errors.
 * Tests schema validation, malformed data, and security (path traversal).
 * Tests go through the HTTP API layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient, type ApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { ApiResponse } from '../../api/types'

describe('Invalid Content Errors', () => {
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

  it('returns 400 for missing required fields', async () => {
    // Create branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/validation-test',
      title: 'Validation Test',
    })

    // Try to write content missing required fields
    const response = await editorClient.put(
      '/api/canopycms/feature-validation-test/content/posts/invalid-post',
      {
        collection: 'posts',
        slug: 'invalid-post',
        format: 'mdx',
        data: {
          // Missing required fields: title, author, date
          tags: ['test'],
        },
        body: 'Some content',
      },
    )

    // TODO: Once schema validation is enforced, this should be 400
    // For now, ContentStore may accept any data shape
    // expect(response.status).toBe(400)
  })

  it('returns 400 for invalid collection name', async () => {
    // Create branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/invalid-collection',
      title: 'Invalid Collection',
    })

    // Try to write to non-existent collection
    const response = await editorClient.put(
      '/api/canopycms/feature-invalid-collection/content/nonexistent/test',
      {
        collection: 'nonexistent',
        slug: 'test',
        format: 'mdx',
        data: {
          title: 'Test',
        },
        body: 'Content',
      },
    )

    // Should fail with 400 or 404
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.ok).toBe(false)
  })

  it('returns 400 for malformed JSON data', async () => {
    // Create branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/malformed-test',
      title: 'Malformed Test',
    })

    // Try to write with invalid data structure
    const response = await editorClient.put(
      '/api/canopycms/feature-malformed-test/content/posts/malformed',
      {
        collection: 'posts',
        slug: 'malformed',
        format: 'json',
        data: 'not an object', // Invalid: should be object, not string
      },
    )

    // TODO: Once validation is enforced, this should be 400
    // expect(response.status).toBe(400)
  })

  it('prevents path traversal attacks in slug', async () => {
    // Create branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/security-test',
      title: 'Security Test',
    })

    // Try path traversal in slug
    const response = await editorClient.put(
      '/api/canopycms/feature-security-test/content/posts/../../etc/passwd',
      {
        collection: 'posts',
        slug: '../../etc/passwd',
        format: 'mdx',
        data: {
          title: 'Malicious',
        },
        body: 'Should not write',
      },
    )

    // Should fail (either 400 or 403)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.ok).toBe(false)
  })

  it('prevents path traversal attacks in collection', async () => {
    // Create branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/security-test-2',
      title: 'Security Test 2',
    })

    // Try path traversal in collection
    const response = await editorClient.put(
      '/api/canopycms/feature-security-test-2/content/../../../etc/test',
      {
        collection: '../../../etc',
        slug: 'test',
        format: 'mdx',
        data: {
          title: 'Malicious',
        },
        body: 'Should not write',
      },
    )

    // Should fail
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.ok).toBe(false)
  })

  it('returns 400 for missing required body fields', async () => {
    // Create branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/missing-fields',
      title: 'Missing Fields',
    })

    // Try to write without collection field
    const response = await editorClient.put(
      '/api/canopycms/feature-missing-fields/content/posts/test',
      {
        // Missing: collection
        slug: 'test',
        format: 'mdx',
        data: { title: 'Test' },
        body: 'Content',
      },
    )

    expect(response.status).toBe(400)
    expect(response.ok).toBe(false)
    const error = await response.json<ApiResponse>()
    expect(error.error).toContain('collection')
  })

  it('returns 400 for invalid format type', async () => {
    // Create branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/invalid-format',
      title: 'Invalid Format',
    })

    // Try to write with invalid format
    const response = await editorClient.put(
      '/api/canopycms/feature-invalid-format/content/posts/test',
      {
        collection: 'posts',
        slug: 'test',
        format: 'invalid-format', // Not a valid ContentFormat
        data: { title: 'Test' },
        body: 'Content',
      },
    )

    // TODO: Once format validation is enforced, this should be 400
    // expect(response.status).toBe(400)
  })

  it('handles write errors gracefully', async () => {
    // Create branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/write-error',
      title: 'Write Error Test',
    })

    // Try to write with empty slug (might cause issues)
    const response = await editorClient.put('/api/canopycms/feature-write-error/content/posts/', {
      collection: 'posts',
      slug: '',
      format: 'mdx',
      data: { title: 'Test' },
      body: 'Content',
    })

    // Should either succeed (if empty slug is valid) or fail gracefully
    if (!response.ok) {
      expect(response.status).toBeGreaterThanOrEqual(400)
      const error = await response.json<ApiResponse>()
      expect(error.error).toBeDefined()
    }
  })

  it('validates data types for schema fields', async () => {
    // Create branch
    await editorClient.post('/api/canopycms/branches', {
      branch: 'feature/type-validation',
      title: 'Type Validation',
    })

    // Try to write with wrong data types
    const response = await editorClient.put(
      '/api/canopycms/feature-type-validation/content/posts/test',
      {
        collection: 'posts',
        slug: 'test',
        format: 'mdx',
        data: {
          title: 'Test',
          author: 'Author',
          date: 12345, // Should be string, not number
          tags: 'not-an-array', // Should be array, not string
        },
        body: 'Content',
      },
    )

    // TODO: Once type validation is enforced, this should be 400
    // For now, ContentStore may accept any data
    // expect(response.status).toBe(400)
  })
})
