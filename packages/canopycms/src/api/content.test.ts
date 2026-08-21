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
  // [SYNC-C1] BranchSyncingError really is a ContentConflictError subclass in
  // the module under mock -- keep that relationship here, or the handlers'
  // `instanceof ContentConflictError` guard would not cover it.
  const MockContentConflictError = class ContentConflictError extends Error {}
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
        getExistingEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesOfType: vi.fn().mockResolvedValue(0),
      }
    }),
    ContentStoreError: class ContentStoreError extends Error {},
    ContentConflictError: MockContentConflictError,
    BranchSyncingError: class BranchSyncingError extends MockContentConflictError {},
    // [F1] Same reasoning as BranchSyncingError above: a real
    // ContentConflictError subclass, so the handler's `instanceof` chain
    // behaves here the way it does in production. The constructor mirrors the
    // real one's shape (id + paths -> a message naming the state that needs
    // an administrator) so the handler test can assert on a realistic
    // message; the exact wording is asserted against the real class in
    // content-store.test.ts.
    DuplicateContentIdError: class DuplicateContentIdError extends MockContentConflictError {
      constructor(contentId: string, paths: readonly string[]) {
        super(
          `Content ID ${contentId} is on more than one file (${paths.join(', ')}); ` +
            `an administrator needs to resolve the duplicate on the server.`,
        )
      }
    },
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

  it('forbids writing content on a submitted branch (review lock)', async () => {
    const ctx = createMockApiContext({
      allowContentAccess: true,
      getBranchContext: vi.fn().mockResolvedValue({
        ...branchContextWithSchema,
        branch: { ...branchContextWithSchema.branch, status: 'submitted' },
      }),
    })
    const res = await writeContent(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      {
        branch: unsafeAsBranchName('feature/x'),
        path: unsafeAsLogicalPath('posts/hello'),
      },
      { format: 'json', data: { title: 'hi' } },
    )
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
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
      getExistingEntryType: vi.fn().mockResolvedValue(undefined),
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

  // C2 (August 2026 baseline review): store.write() rejecting with an
  // unrecognized error (ENOSPC, EACCES, a bug) is a genuine server fault,
  // not the client's mistake, and must surface as a 500 - not get flattened
  // to a 400 alongside real client faults (ContentStoreError).
  describe('C2: write error classification', () => {
    it('returns 500 (not 400) when store.write throws an error that is not a known ContentStoreError', async () => {
      const ctx = allowedCtx()
      const { ContentStore } = await import('../content-store')

      const mockStore = {
        resolvePath: vi.fn().mockReturnValue({
          schemaItem: { logicalPath: 'content/posts', type: 'collection', entries: [] },
          slug: 'hello',
        }),
        resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/hello' }),
        write: vi.fn().mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })),
        idIndex: vi.fn().mockResolvedValue({ findById: vi.fn().mockReturnValue(null) }),
        documentExists: vi.fn().mockResolvedValue(true),
        getExistingEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesOfType: vi.fn().mockResolvedValue(0),
      }
      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return mockStore as any
      })

      await expect(
        writeContent(
          ctx,
          { user: { type: 'authenticated', userId: 'u1', groups: [] } },
          { branch: unsafeAsBranchName('feature/x'), path: unsafeAsLogicalPath('posts/hello') },
          { format: 'json', data: { title: 'hi' }, expectedVersion: 1 },
        ),
      ).rejects.toThrow('ENOSPC')
    })

    it('still returns 400 when store.write throws a ContentStoreError (unchanged client-fault behavior)', async () => {
      const ctx = allowedCtx()
      const { ContentStore, ContentStoreError } = await import('../content-store')

      const mockStore = {
        resolvePath: vi.fn().mockReturnValue({
          schemaItem: { logicalPath: 'content/posts', type: 'collection', entries: [] },
          slug: 'hello',
        }),
        resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/hello' }),
        write: vi
          .fn()
          .mockRejectedValue(
            new ContentStoreError('Slugs cannot contain forward slashes', 'VALIDATION'),
          ),
        idIndex: vi.fn().mockResolvedValue({ findById: vi.fn().mockReturnValue(null) }),
        documentExists: vi.fn().mockResolvedValue(true),
        getExistingEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesOfType: vi.fn().mockResolvedValue(0),
      }
      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return mockStore as any
      })

      const res = await writeContent(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('feature/x'), path: unsafeAsLogicalPath('posts/hello') },
        { format: 'json', data: { title: 'hi' }, expectedVersion: 1 },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      if (!res.ok) {
        expect(res.error).toContain('Slugs cannot contain forward slashes')
      }
    })
  })

  // Create-intent guard (August 2026 baseline review, Critical finding): a
  // create (expectedVersion: null) against a slug that already has content
  // must never silently overwrite it.
  describe('create-intent guard (expectedVersion: null)', () => {
    it('returns 409 before validation or store.write when the slug already exists, even with no required fields', async () => {
      const ctx = allowedCtx()
      const { ContentStore } = await import('../content-store')

      const writeSpy = vi.fn()
      const mockStore = {
        resolvePath: vi.fn().mockReturnValue({
          // The destructive arm: an entry type with an EMPTY schema, so a
          // stale required-fields validation would never have caught this.
          schemaItem: {
            logicalPath: 'content/posts',
            type: 'collection',
            entries: [{ name: 'post', format: 'json', schema: [] }],
          },
          slug: 'existing-post',
        }),
        resolveDocumentPath: vi
          .fn()
          .mockReturnValue({ relativePath: 'content/posts/existing-post' }),
        write: writeSpy,
        idIndex: vi.fn().mockResolvedValue({ findById: vi.fn().mockReturnValue(null) }),
        documentExists: vi.fn().mockResolvedValue(true),
        getExistingEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesOfType: vi.fn().mockResolvedValue(0),
      }
      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return mockStore as any
      })

      const res = await writeContent(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        {
          branch: unsafeAsBranchName('feature/x'),
          path: unsafeAsLogicalPath('posts/existing-post'),
        },
        { format: 'json', data: {}, expectedVersion: null },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(409)
      if (!res.ok) {
        expect(res.error).toContain('already exists')
      }
      // The whole point of the fix: the destructive write must never be attempted.
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('returns 409 (not the generic conflict message) when the slug already exists and the entry type HAS required fields', async () => {
      // Guards the previous failure mode: with required fields, the old code
      // returned a 422 ("title: This field is required") that never
      // mentioned the real problem. The create-intent guard must short
      // circuit before validation, regardless of the entry type's fields.
      const ctx = allowedCtx()
      const { ContentStore } = await import('../content-store')

      const writeSpy = vi.fn()
      const mockStore = {
        resolvePath: vi.fn().mockReturnValue({
          schemaItem: {
            logicalPath: 'content/posts',
            type: 'collection',
            entries: [
              {
                name: 'post',
                format: 'json',
                schema: [{ name: 'title', type: 'text', required: true }],
              },
            ],
          },
          slug: 'existing-post',
        }),
        resolveDocumentPath: vi
          .fn()
          .mockReturnValue({ relativePath: 'content/posts/existing-post' }),
        write: writeSpy,
        idIndex: vi.fn().mockResolvedValue({ findById: vi.fn().mockReturnValue(null) }),
        documentExists: vi.fn().mockResolvedValue(true),
        getExistingEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesOfType: vi.fn().mockResolvedValue(0),
      }
      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return mockStore as any
      })

      const res = await writeContent(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        {
          branch: unsafeAsBranchName('feature/x'),
          path: unsafeAsLogicalPath('posts/existing-post'),
        },
        { format: 'json', data: {}, expectedVersion: null },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(409)
      if (!res.ok) {
        expect(res.error).toContain('already exists')
        expect(res.error).not.toContain('required')
      }
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('allows a create-intent write when the slug does not exist yet', async () => {
      const ctx = allowedCtx()
      const res = await writeContent(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('feature/x'), path: unsafeAsLogicalPath('posts/hello') },
        { format: 'json', data: {}, expectedVersion: null },
      )
      expect(res.ok).toBe(true)
    })

    it('returns a slug-collision message (not the generic conflict message) when store.write races into a create-intent conflict', async () => {
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
        // Pre-write check sees no document (the race window), so the early
        // short circuit doesn't fire; store.write's in-lock check is what
        // catches it.
        documentExists: vi.fn().mockResolvedValue(false),
        getExistingEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesOfType: vi.fn().mockResolvedValue(0),
      }
      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return mockStore as any
      })

      const res = await writeContent(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('feature/x'), path: unsafeAsLogicalPath('posts/hello') },
        { format: 'json', data: {}, expectedVersion: null },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(409)
      if (!res.ok) {
        expect(res.error).toContain('already exists')
        expect(res.error).not.toContain('modified by another editor')
      }
    })

    it('[F1] surfaces the duplicate-content-ID refusal instead of the generic conflict message', async () => {
      const ctx = allowedCtx()
      const { ContentStore, DuplicateContentIdError } = await import('../content-store')

      const duplicateError = new DuplicateContentIdError('a1b2c3d4e5f6', [
        'content/posts/post.hello.a1b2c3d4e5f6.json',
        'content/posts/post.other.a1b2c3d4e5f6.json',
      ])
      const mockStore = {
        resolvePath: vi.fn().mockReturnValue({
          schemaItem: { logicalPath: 'content/posts', type: 'collection', entries: [] },
          slug: 'hello',
        }),
        resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/hello' }),
        write: vi.fn().mockRejectedValue(duplicateError),
        idIndex: vi.fn().mockResolvedValue({ findById: vi.fn().mockReturnValue(null) }),
        documentExists: vi.fn().mockResolvedValue(true),
        getExistingEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesOfType: vi.fn().mockResolvedValue(0),
      }
      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return mockStore as unknown as InstanceType<typeof ContentStore>
      })

      const res = await writeContent(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: unsafeAsBranchName('feature/x'), path: unsafeAsLogicalPath('posts/hello') },
        { format: 'json', data: {}, expectedVersion: 123 },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(409)
      if (!res.ok) {
        // The editor must be told what is actually wrong and who fixes it --
        // "reload and retry" is advice that cannot work here.
        expect(res.error).toBe(duplicateError.message)
        expect(res.error).toContain('a1b2c3d4e5f6')
        expect(res.error).toContain('administrator')
        expect(res.error).not.toContain('modified by another editor')
        // Must NOT name an action the editor's admin cannot actually run:
        // no UI triggers repair-content-duplicates.
        expect(res.error).not.toContain('repair-content-duplicates')
      }
    })
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
          getExistingEntryType: vi.fn().mockResolvedValue(undefined),
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

    // C2 (August 2026 baseline review): mirrors the write-path fix above -
    // an unrecognized store.renameEntry() error is a server fault and must
    // surface as a 500, not get flattened to "Rename failed" / 400.
    it('returns 500 (not 400) when store.renameEntry throws an error that is not a known ContentStoreError', async () => {
      const ctx = allowedCtx()
      const { ContentStore } = await import('../content-store')

      const mockStore = {
        resolvePath: vi.fn().mockReturnValue({
          schemaItem: { logicalPath: 'content/posts', type: 'collection' },
          slug: 'old-slug',
        }),
        resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/old-slug' }),
        renameEntry: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
      }
      vi.mocked(ContentStore).mockImplementationOnce(function () {
        return mockStore as any
      })

      await expect(
        renameEntry(
          ctx,
          { user: { type: 'authenticated', userId: 'u1', groups: [] } },
          {
            branch: unsafeAsBranchName('feature/x'),
            path: unsafeAsLogicalPath('posts/old-slug'),
          },
          { newSlug: unsafeAsSlug('new-slug') },
        ),
      ).rejects.toThrow('EACCES')
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

    // A second, non-default entry type sharing the 'posts' collection — used
    // to prove validation resolves the entry's REAL on-disk type rather than
    // params.entryType / the default (post-review M2).
    const settingsSchema = [{ name: 'siteName', type: 'string', required: true }]

    /** Install a one-shot ContentStore mock with a real post schema. */
    const mockStoreOnce = async (opts: {
      exists?: boolean
      count?: number
      knownIds?: string[]
      maxItems?: number
      /** On-disk entry type of the existing entry (only meaningful when exists !== false). Defaults to 'post'. */
      existingEntryType?: string
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
      const exists = opts.exists ?? true
      const existingEntryType = exists ? (opts.existingEntryType ?? 'post') : undefined
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
                { name: 'settings', format: 'json', schema: settingsSchema },
              ],
            },
            slug: 'hello',
          }),
          resolveDocumentPath: vi.fn().mockResolvedValue({ relativePath: 'content/posts/hello' }),
          documentExists: vi.fn().mockResolvedValue(exists),
          getExistingEntryType: vi.fn().mockResolvedValue(existingEntryType),
          countEntriesOfType: vi.fn().mockResolvedValue(opts.count ?? 0),
          idIndex: vi.fn().mockResolvedValue({ findById }),
          write: writeSpy,
        } as any
      })
      return { writeSpy }
    }

    it('persists reference fields as bare IDs when the editor posts resolved objects', async () => {
      // The editor's own GET reads through `store.read()`, whose `resolveReferences` defaults
      // to TRUE, so its form state holds fully resolved objects and a save posts them straight
      // back. Unnormalized, that blob landed in the content file verbatim — and since
      // resolution only re-resolves a `typeof value === 'string'`, every later read passed the
      // frozen snapshot through, permanently severing the reference from its target.
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: {
          title: 'Hello',
          // Exactly what `buildResolvedReference` returns, including an embedded body.
          author: {
            name: 'Alice',
            body: 'THE WHOLE TARGET DOCUMENT',
            id: AUTHOR_ID,
            slug: 'alice',
            collection: 'content/authors',
            urlPath: '/authors/alice',
          },
        },
      })

      expect(res.ok).toBe(true)
      expect(writeSpy).toHaveBeenCalledTimes(1)
      expect(writeSpy.mock.calls[0][2].data.author).toBe(AUTHOR_ID)
    })

    it('normalizes a resolved reference nested inside a block template', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: {
          title: 'Hello',
          author: AUTHOR_ID,
          blocks: [
            {
              template: 'quote',
              value: {
                text: 'Quoted',
                source: { name: 'Alice', id: AUTHOR_ID, slug: 'alice', urlPath: '/authors/alice' },
              },
            },
          ],
        },
      })

      expect(res.ok).toBe(true)
      const written = writeSpy.mock.calls[0][2].data as Record<string, unknown>
      const blocks = written.blocks as Array<{ value: { source: unknown } }>
      expect(blocks[0].value.source).toBe(AUTHOR_ID)
    })

    it('leaves an already-bare reference ID untouched (normalization is idempotent)', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ knownIds: [AUTHOR_ID] })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: { title: 'Hello', author: AUTHOR_ID },
      })

      expect(res.ok).toBe(true)
      expect(writeSpy.mock.calls[0][2].data.author).toBe(AUTHOR_ID)
    })

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

    // ---------------------------------------------------------------------
    // Existing entry type resolution (post-review M2): ContentStore.write
    // preserves an existing entry's on-disk type regardless of what's
    // requested, so validation must resolve the SAME type before writing —
    // otherwise a direct API caller could bypass required-field validation
    // for the entry's real schema, or have a valid payload wrongly rejected.
    // ---------------------------------------------------------------------

    it('validates an existing non-default-type entry against its real type when entryType is omitted', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ existingEntryType: 'settings' })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: {}, // missing required 'siteName' for the settings schema
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
      expect(res.fieldErrors).toEqual([
        { fieldPath: 'siteName', message: 'This field is required' },
      ])
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('accepts a valid payload for an existing non-default-type entry when entryType is omitted', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ existingEntryType: 'settings' })
      const res = await writeContent(ctx, writeReq, writeParams, {
        format: 'json',
        data: { siteName: 'My Site' },
      })
      expect(res.ok).toBe(true)
      expect(writeSpy).toHaveBeenCalled()
    })

    it('rejects a conflicting entryType param against an existing entry with 409', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ existingEntryType: 'settings' })
      const res = await writeContent(
        ctx,
        writeReq,
        { ...writeParams, entryType: 'post' },
        { format: 'json', data: { siteName: 'My Site' } },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(409)
      expect(res.error).toContain('settings')
      expect(res.error).toContain('post')
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('does not conflict when entryType matches the existing entry (editor path unchanged)', async () => {
      const ctx = allowedCtx()
      const { writeSpy } = await mockStoreOnce({ existingEntryType: 'settings' })
      const res = await writeContent(
        ctx,
        writeReq,
        { ...writeParams, entryType: 'settings' },
        { format: 'json', data: { siteName: 'My Site' } },
      )
      expect(res.ok).toBe(true)
      expect(writeSpy).toHaveBeenCalled()
    })
  })
})
