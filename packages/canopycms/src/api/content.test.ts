import { describe, expect, it, vi } from 'vitest'

import { CONTENT_ROUTES } from './content'
import type { ApiContext } from './types'
import { unsafeAsBranchName, unsafeAsLogicalPath, unsafeAsSlug } from '../paths/test-utils'
import { createMockApiContext } from '../test-utils'

// Extract handlers for testing
const readContent = CONTENT_ROUTES.read.handler
const writeContent = CONTENT_ROUTES.write.handler
const renameEntry = CONTENT_ROUTES.renameEntry.handler

vi.mock('../content-store', () => {
  return {
    ContentStore: vi.fn().mockImplementation(function () {
      return {
        resolvePath: vi.fn().mockReturnValue({
          schemaItem: { logicalPath: 'content/posts', type: 'collection' },
          slug: 'hello',
        }),
        resolveDocumentPath: vi.fn().mockReturnValue({
          relativePath: 'content/posts/hello',
          absolutePath: '/abs/content/posts/hello',
        }),
        read: vi.fn().mockResolvedValue({
          collection: 'posts',
          format: 'md',
          data: {},
          body: 'Hello',
        }),
        write: vi.fn().mockResolvedValue({
          collection: 'posts',
          format: 'md',
          data: {},
          body: 'Hello',
        }),
        renameEntry: vi.fn().mockResolvedValue({ newPath: 'content/posts/new-slug' }),
        idIndex: vi.fn().mockResolvedValue({ findById: vi.fn().mockReturnValue(null) }),
      }
    }),
    ContentStoreError: class ContentStoreError extends Error {},
    ContentConflictError: class ContentConflictError extends Error {},
  }
})

const mockFlatSchema = [
  {
    type: 'collection',
    logicalPath: 'content/posts',
    name: 'posts',
    label: 'Posts',
    contentId: 'a1b2c3d4e5f6',
    entries: [{ name: 'post', format: 'json', schema: [], schemaRef: 'postSchema' }],
  },
]

// Branch context the content handlers resolve via getBranchContext — carries the
// flatSchema they read. Access control is mocked separately via allowContentAccess.
const branchContextWithSchema = {
  baseRoot: '/tmp/base',
  branchRoot: '/tmp/base/feature-x',
  flatSchema: mockFlatSchema,
  branch: {
    name: 'feature/x',
    status: 'editing',
    access: {},
    createdBy: 'u1',
    createdAt: 'now',
    updatedAt: 'now',
  },
}

const allowedCtx = (): ApiContext =>
  createMockApiContext({
    allowContentAccess: true,
    getBranchContext: vi.fn().mockResolvedValue(branchContextWithSchema),
  })

describe('content api', () => {
  it('forbids when access denied', async () => {
    const ctx = createMockApiContext({
      allowContentAccess: false,
      getBranchContext: vi.fn().mockResolvedValue(branchContextWithSchema),
    })
    const res = await readContent(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('feature/x'),
        path: unsafeAsLogicalPath('posts/hello'),
      },
    )
    expect(res.status).toBe(403)
    expect(res.ok).toBe(false)
  })

  it('reads content when allowed', async () => {
    const ctx = allowedCtx()
    const res = await readContent(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('feature/x'),
        path: unsafeAsLogicalPath('posts/hello'),
      },
    )
    expect(res.ok).toBe(true)
  })

  it('writes content with correct format handling', async () => {
    const ctx = allowedCtx()
    const res = await writeContent(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('feature/x'),
        path: unsafeAsLogicalPath('posts/hello'),
      },
      { format: 'json', data: { title: 'hi' } },
    )
    expect(res.ok).toBe(true)
  })

  it('returns 409 when store.write throws ContentConflictError', async () => {
    const ctx = allowedCtx()
    const { ContentStore, ContentConflictError } = await import('../content-store')

    const mockStore = {
      resolvePath: vi.fn().mockReturnValue({
        schemaItem: { logicalPath: 'content/posts', type: 'collection', entries: [] },
        slug: 'hello',
      }),
      resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/hello' }),
      write: vi.fn().mockRejectedValue(new ContentConflictError()),
      idIndex: vi.fn().mockResolvedValue({ findById: vi.fn().mockReturnValue(null) }),
    }
    vi.mocked(ContentStore).mockImplementationOnce(function () {
      return mockStore as any
    })

    const res = await writeContent(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: unsafeAsBranchName('feature/x'), path: unsafeAsLogicalPath('posts/hello') },
      { format: 'json', data: { title: 'hi' }, expectedVersion: 999 },
    )
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
  })

  describe('validateEntry hook', () => {
    const writeReq = { user: { type: 'authenticated' as const, userId: 'u1', groups: [] } }
    const writeParams = {
      branch: unsafeAsBranchName('feature/x'),
      path: unsafeAsLogicalPath('posts/hello'),
    }

    it('passes the expected input to the hook', async () => {
      const ctx = allowedCtx()
      const hook = vi.fn().mockResolvedValue([])
      ctx.services.config.validateEntry = hook

      const res = await writeContent(
        ctx,
        writeReq,
        { ...writeParams, entryType: 'post' },
        {
          format: 'mdx',
          data: { title: 'hi' },
          body: '# Hello',
        },
      )
      expect(res.ok).toBe(true)
      expect(hook).toHaveBeenCalledWith({
        entryPath: 'content/posts/hello',
        branch: 'feature/x',
        entryType: 'post',
        format: 'mdx',
        data: { title: 'hi' },
        body: '# Hello',
      })
    })

    it('rejects the save with 422 before writing when the hook returns errors', async () => {
      const ctx = allowedCtx()
      ctx.services.config.validateEntry = () => [
        { level: 'error', message: 'MDX failed to compile', fieldPath: 'body' },
      ]
      const { ContentStore } = await import('../content-store')
      const writeSpy = vi.fn()
      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return {
          resolvePath: vi.fn().mockReturnValue({
            schemaItem: { logicalPath: 'content/posts', type: 'collection', entries: [] },
            slug: 'hello',
          }),
          resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/hello' }),
          write: writeSpy,
          idIndex: vi.fn().mockResolvedValue({ findById: vi.fn().mockReturnValue(null) }),
        } as any
      })

      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'mdx',
        data: {},
        body: '# {broken',
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(res.error).toContain('body: MDX failed to compile')
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('returns warning issues alongside a successful save', async () => {
      const ctx = allowedCtx()
      ctx.services.config.validateEntry = () => [
        { level: 'warning', message: 'Heading levels skip from h1 to h3' },
      ]

      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: { title: 'hi' },
      })
      expect(res.ok).toBe(true)
      expect(res.data?.validationWarnings).toEqual([
        { level: 'warning', message: 'Heading levels skip from h1 to h3' },
      ])
    })

    it('returns 500 when the hook itself throws', async () => {
      const ctx = allowedCtx()
      ctx.services.config.validateEntry = () => {
        throw new Error('boom')
      }

      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: {},
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(500)
      expect(res.error).toContain('validateEntry hook failed: boom')
    })
  })

  describe('renameEntry', () => {
    it('renames entry when allowed', async () => {
      const ctx = allowedCtx()
      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        {
          branch: unsafeAsBranchName('feature/x'),
          path: unsafeAsLogicalPath('posts/old-slug'),
        },
        { newSlug: unsafeAsSlug('new-slug') },
      )
      expect(res.ok).toBe(true)
      if (res.ok && res.data) {
        expect(res.data.newPath).toBe('content/posts/new-slug')
      }
    })

    it('forbids rename when access denied', async () => {
      const ctx = createMockApiContext({
        allowContentAccess: false,
        getBranchContext: vi.fn().mockResolvedValue(branchContextWithSchema),
      })
      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        {
          branch: unsafeAsBranchName('feature/x'),
          path: unsafeAsLogicalPath('posts/old-slug'),
        },
        { newSlug: unsafeAsSlug('new-slug') },
      )
      expect(res.status).toBe(403)
      expect(res.ok).toBe(false)
    })

    it('returns 404 when branch not found', async () => {
      const ctx = createMockApiContext({ branchContext: null })
      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        {
          branch: unsafeAsBranchName('nonexistent'),
          path: unsafeAsLogicalPath('posts/old-slug'),
        },
        { newSlug: unsafeAsSlug('new-slug') },
      )
      expect(res.status).toBe(404)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toBe('Branch not found')
      }
    })

    it('returns 400 when entry not found', async () => {
      const ctx = allowedCtx()
      const { ContentStore, ContentStoreError } = await import('../content-store')

      // Override the mock for this test
      const mockStore = {
        resolvePath: vi.fn().mockReturnValue({
          schemaItem: { logicalPath: 'content/posts', type: 'collection' },
          slug: 'nonexistent',
        }),
        resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/nonexistent' }),
        renameEntry: vi
          .fn()
          .mockRejectedValue(new ContentStoreError('Entry not found: nonexistent', 'NOT_FOUND')),
      }

      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return mockStore as any
      })

      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        {
          branch: unsafeAsBranchName('feature/x'),
          path: unsafeAsLogicalPath('posts/nonexistent'),
        },
        { newSlug: unsafeAsSlug('new-slug') },
      )
      expect(res.status).toBe(400)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toContain('Entry not found')
      }
    })

    it('returns 400 when slug already exists', async () => {
      const ctx = allowedCtx()
      const { ContentStore, ContentStoreError } = await import('../content-store')

      // Override the mock for this test
      const mockStore = {
        resolvePath: vi.fn().mockReturnValue({
          schemaItem: { logicalPath: 'content/posts', type: 'collection' },
          slug: 'old-slug',
        }),
        resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/old-slug' }),
        renameEntry: vi
          .fn()
          .mockRejectedValue(
            new ContentStoreError(
              'Entry with slug "existing-slug" already exists in collection "content/posts"',
              'VALIDATION',
            ),
          ),
      }

      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return mockStore as any
      })

      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        {
          branch: unsafeAsBranchName('feature/x'),
          path: unsafeAsLogicalPath('posts/old-slug'),
        },
        { newSlug: unsafeAsSlug('existing-slug') },
      )
      expect(res.status).toBe(400)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toContain('already exists')
      }
    })
  })
})
