/**
 * Integration tests for HTTP-level input validation.
 * Tests Zod schema validation that happens in the handler layer.
 * Tests go through the HTTP API layer.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient } from '../test-utils/api-client'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import type { ApiResponse } from '../../api/types'

describe('Input Validation', () => {
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
        entryPath: 'posts/test',
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
        entryPath: 'posts/test',
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
        entryPath: 'posts/test',
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
      const response = await editorClient.post(
        '/api/canopycms/feature-resolve-test/comments//resolve',
        {},
      )

      expect(response.status).toBe(404)
      expect(response.ok).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Slug routability at the write boundary
  //
  // Drives the real HTTP write path (no mocked ContentStore): the request goes
  // through logicalPathSchema -> parseApiPath -> ContentStore.resolvePath ->
  // buildPaths -> the file on disk. `parseSlug` is NOT on that chain by itself,
  // which is why a create used to be accepted with a slug the build guard
  // (static/index.ts's assertRoutableSlugs) later fails the whole build over.
  // -------------------------------------------------------------------------
  describe('Content Slug Routability', () => {
    const BRANCH = 'slug-guard'

    const postBody = (title: string) => ({
      format: 'mdx' as const,
      data: { title },
      body: 'Body text.',
    })

    /** Absolute path of the branch clone's posts collection directory. */
    const findPostsDir = async (): Promise<string> => {
      const contentDir = path.join(
        workspace.tmpRoot,
        '.canopy-dev',
        'content-branches',
        BRANCH,
        'content',
      )
      // `posts` when the collection has no content ID yet, `posts.{id}` once it does.
      const names = await fs.readdir(contentDir)
      const dir = names.find((name) => name === 'posts' || name.startsWith('posts.'))
      if (!dir) throw new Error(`No posts collection directory in ${contentDir}: ${names}`)
      return path.join(contentDir, dir)
    }

    beforeEach(async () => {
      const created = await editorClient.post('/api/canopycms/branches', {
        branch: BRANCH,
        title: 'Slug guard',
      })
      expect(created.status).toBe(200)
    })

    it('refuses to create an entry whose slug cannot resolve back through a URL', async () => {
      const response = await editorClient.put(
        `/api/canopycms/${BRANCH}/content/posts/my_post`,
        postBody('My Post'),
      )

      expect(response.status).toBe(400)
      expect(response.ok).toBe(false)
      const error = await response.json<ApiResponse>()
      expect(error.error).toMatch(/lowercase letters, numbers, and hyphens/)

      // Refused, not written-then-reported: nothing landed on disk.
      const read = await editorClient.get(`/api/canopycms/${BRANCH}/content/posts/my_post`)
      expect(read.status).toBe(404)
    })

    it('creates an entry whose slug is routable', async () => {
      const response = await editorClient.put(
        `/api/canopycms/${BRANCH}/content/posts/my-post`,
        postBody('My Post'),
      )

      expect(response.status).toBe(200)
      expect(response.ok).toBe(true)
    })

    it('still saves an entry that already has a non-conforming slug on disk', async () => {
      // Content that predates the guard, or arrived by git/import/hand-authoring.
      // The write-time rule is scoped to CREATES precisely so this stays editable —
      // locking the author out of an entry they need to rename would turn a red
      // build into an unfixable one.
      const created = await editorClient.put(
        `/api/canopycms/${BRANCH}/content/posts/legacy-post`,
        postBody('Legacy Post'),
      )
      expect(created.status).toBe(200)

      const postsDir = await findPostsDir()
      const filename = (await fs.readdir(postsDir)).find((name) => name.includes('.legacy-post.'))
      if (!filename) throw new Error(`No legacy-post entry in ${postsDir}`)
      await fs.rename(
        path.join(postsDir, filename),
        path.join(postsDir, filename.replace('.legacy-post.', '.legacy_post.')),
      )

      const saved = await editorClient.put(
        `/api/canopycms/${BRANCH}/content/posts/legacy_post`,
        postBody('Legacy Post, edited'),
      )
      expect(saved.status).toBe(200)
      expect(saved.ok).toBe(true)
    })

    it('lets a rename move a non-conforming slug back to a routable one', async () => {
      const created = await editorClient.put(
        `/api/canopycms/${BRANCH}/content/posts/rescue-me`,
        postBody('Rescue Me'),
      )
      expect(created.status).toBe(200)

      const postsDir = await findPostsDir()
      const filename = (await fs.readdir(postsDir)).find((name) => name.includes('.rescue-me.'))
      if (!filename) throw new Error(`No rescue-me entry in ${postsDir}`)
      await fs.rename(
        path.join(postsDir, filename),
        path.join(postsDir, filename.replace('.rescue-me.', '.rescue_me.')),
      )

      // The escape hatch out of an unroutable slug: address the entry by the
      // slug it actually has, rename it to one that resolves.
      const renamed = await editorClient.patch(
        `/api/canopycms/${BRANCH}/rename-entry/content/posts/rescue_me`,
        { newSlug: 'rescued' },
      )
      expect(renamed.status).toBe(200)
      expect(renamed.ok).toBe(true)

      const read = await editorClient.get(`/api/canopycms/${BRANCH}/content/posts/rescued`)
      expect(read.status).toBe(200)
    })
  })
})
