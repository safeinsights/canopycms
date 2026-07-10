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
          schemaItem: {
            logicalPath: 'content/posts',
            type: 'collection',
            entries: [{ name: 'post', format: 'json', schema: [], schemaRef: 'postSchema' }],
          },
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
        documentExists: vi.fn().mockResolvedValue(false),
        countEntriesOfType: vi.fn().mockResolvedValue(0),
      }
    }),
    ContentStoreError: class ContentStoreError extends Error {},
    ContentConflictError: class ContentConflictError extends Error {},
    getDefaultEntryType: (entries: Array<{ default?: boolean }> | undefined) =>
      entries && entries.length > 0 ? entries.find((e) => e.default) || entries[0] : undefined,
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
      documentExists: vi.fn().mockResolvedValue(true),
      countEntriesOfType: vi.fn().mockResolvedValue(0),
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
          documentExists: vi.fn().mockResolvedValue(false),
          countEntriesOfType: vi.fn().mockResolvedValue(0),
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

  describe('payload size bounds (API-M1)', () => {
    const params = { branch: 'main', path: 'content/posts/hello' }

    it('rejects an oversized markdown body', () => {
      const oversized = 'a'.repeat(2_000_001)
      const result = CONTENT_ROUTES.write.validate({
        params,
        body: { format: 'md', body: oversized },
      })
      expect(result.ok).toBe(false)
    })

    it('accepts a body right at the size limit', () => {
      const atLimit = 'a'.repeat(2_000_000)
      const result = CONTENT_ROUTES.write.validate({
        params,
        body: { format: 'md', body: atLimit },
      })
      expect(result.ok).toBe(true)
    })

    it('rejects oversized structured data', () => {
      const bigValue = 'x'.repeat(2_100_000)
      const result = CONTENT_ROUTES.write.validate({
        params,
        body: { format: 'json', data: { field: bigValue } },
      })
      expect(result.ok).toBe(false)
    })

    it('rejects oversized data on the validate-references endpoint too', () => {
      const bigValue = 'x'.repeat(2_100_000)
      const result = CONTENT_ROUTES.validateReferences.validate({
        params,
        body: { data: { field: bigValue } },
      })
      expect(result.ok).toBe(false)
    })
  })

  // ==========================================================================
  // Write-boundary schema validation (COMPOUND-2) + maxItems (SCH-H3)
  // ==========================================================================
  describe('write boundary schema validation', () => {
    const writeReq = { user: { type: 'authenticated' as const, userId: 'u1', groups: [] } }
    const writeParams = {
      branch: unsafeAsBranchName('feature/x'),
      path: unsafeAsLogicalPath('posts/hello'),
    }

    const AUTHOR_ID = '5NVkkrB1MJUv' // exists in the mocked id index when listed in knownIds
    const DANGLING_ID = 'Dang1ingRef2' // valid format, never in the index

    const postSchema = [
      { name: 'title', type: 'string', required: true },
      { name: 'author', type: 'reference', required: true },
      {
        name: 'blocks',
        type: 'block',
        templates: [
          {
            name: 'quote',
            fields: [
              { name: 'text', type: 'string', required: true },
              { name: 'source', type: 'reference' },
            ],
          },
        ],
      },
    ]

    /** Install a one-shot ContentStore mock with a real post schema. */
    const mockStoreOnce = async (opts: {
      exists?: boolean
      count?: number
      knownIds?: string[]
      maxItems?: number
    }) => {
      const { ContentStore } = await import('../content-store')
      const writeSpy = vi
        .fn()
        .mockResolvedValue({ collection: 'content/posts', format: 'json', data: {} })
      const findById = vi.fn((id: string) =>
        (opts.knownIds ?? []).includes(id)
          ? {
              type: 'entry',
              relativePath: `authors.q52DCVPuH4ga/author.alice.${id}.json`,
              collection: 'content/authors',
              slug: 'alice',
            }
          : null,
      )
      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return {
          resolvePath: vi.fn().mockReturnValue({
            schemaItem: {
              logicalPath: 'content/posts',
              type: 'collection',
              entries: [
                {
                  name: 'post',
                  format: 'json',
                  schema: postSchema,
                  default: true,
                  ...(opts.maxItems !== undefined ? { maxItems: opts.maxItems } : {}),
                },
              ],
            },
            slug: 'hello',
          }),
          resolveDocumentPath: vi.fn().mockResolvedValue({ relativePath: 'content/posts/hello' }),
          documentExists: vi.fn().mockResolvedValue(opts.exists ?? true),
          countEntriesOfType: vi.fn().mockResolvedValue(opts.count ?? 0),
          idIndex: vi.fn().mockResolvedValue({ findById }),
          write: writeSpy,
        } as any
      })
      return { writeSpy }
    }

    it('rejects a save missing a required field with a per-field error', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: { author: AUTHOR_ID },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(res.fieldErrors).toEqual([{ fieldPath: 'title', message: 'This field is required' }])
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('rejects a save with a wrong-typed field', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: { title: 42, author: AUTHOR_ID },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(res.fieldErrors).toEqual([{ fieldPath: 'title', message: 'Expected text' }])
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('rejects a save with an empty required reference', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: { title: 'Hello', author: '' },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(res.fieldErrors).toEqual([{ fieldPath: 'author', message: 'This field is required' }])
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('rejects a save with a dangling (nonexistent) reference', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: { title: 'Hello', author: DANGLING_ID },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(res.fieldErrors).toEqual([
        { fieldPath: 'author', message: 'Referenced entry does not exist' },
      ])
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('saves a valid entry', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: { title: 'Hello', author: AUTHOR_ID },
      })
      expect(res.ok).toBe(true)
      expect(writeSpy).toHaveBeenCalled()
    })

    it('accepts a resolved reference object carried over from a read', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: { title: 'Hello', author: { id: AUTHOR_ID, slug: 'alice', name: 'Alice' } },
      })
      expect(res.ok).toBe(true)
      expect(writeSpy).toHaveBeenCalled()
    })

    it('rejects a block-nested missing required field (D1 traversal + D4 validation)', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: {
          title: 'Hello',
          author: AUTHOR_ID,
          blocks: [{ template: 'quote', value: { text: '' } }],
        },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(res.fieldErrors).toEqual([
        { fieldPath: 'blocks[0].text', message: 'This field is required' },
      ])
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('rejects a block-nested dangling reference', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: {
          title: 'Hello',
          author: AUTHOR_ID,
          blocks: [{ template: 'quote', value: { text: 'quoted', source: DANGLING_ID } }],
        },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(res.fieldErrors).toEqual([
        { fieldPath: 'blocks[0].source', message: 'Referenced entry does not exist' },
      ])
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('allows the editor create scaffold (new entry, completely empty payload)', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ exists: false })
      const res = await writeContent(
        ctx,
        writeReq,
        { ...writeParams, entryType: 'post' },
        { format: 'json', data: {} },
      )
      expect(res.ok).toBe(true)
      expect(writeSpy).toHaveBeenCalled()
    })

    it('validates a create that carries data (no scaffold bypass)', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ exists: false })
      const res = await writeContent(
        ctx,
        writeReq,
        { ...writeParams, entryType: 'post' },
        { format: 'json', data: { title: '' } },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('rejects a create that would exceed maxItems (SCH-H3)', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({
        exists: false,
        maxItems: 1,
        count: 1,
        knownIds: [AUTHOR_ID],
      })
      const res = await writeContent(
        ctx,
        writeReq,
        { ...writeParams, entryType: 'post' },
        { format: 'json', data: {} },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(res.error).toContain('allows at most 1 entry')
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('allows a create within the maxItems cap', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ exists: false, maxItems: 1, count: 0 })
      const res = await writeContent(
        ctx,
        writeReq,
        { ...writeParams, entryType: 'post' },
        { format: 'json', data: {} },
      )
      expect(res.ok).toBe(true)
      expect(writeSpy).toHaveBeenCalled()
    })

    it('does not apply maxItems to edits of an existing entry', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({
        exists: true,
        maxItems: 1,
        count: 1,
        knownIds: [AUTHOR_ID],
      })
      const res = await writeContent(
        ctx,
        writeReq,
        { ...writeParams, entryType: 'post' },
        { format: 'json', data: { title: 'Hello', author: AUTHOR_ID } },
      )
      expect(res.ok).toBe(true)
      expect(writeSpy).toHaveBeenCalled()
    })

    it('returns 400 for an unknown entryType param', async () => {
      const ctx = allowedCtx()
      await mockStoreOnce({})
      const res = await writeContent(
        ctx,
        writeReq,
        { ...writeParams, entryType: 'nope' },
        { format: 'json', data: { title: 'Hello', author: AUTHOR_ID } },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
    })
  })
})
