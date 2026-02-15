import { describe, expect, it, vi } from 'vitest'

import { CONTENT_ROUTES } from './content'
import type { ApiContext } from './types'
import { toBranchName, toLogicalPath, toEntrySlug } from '../paths'

// Extract handlers for testing
const readContent = CONTENT_ROUTES.read.handler
const writeContent = CONTENT_ROUTES.write.handler
const renameEntry = CONTENT_ROUTES.renameEntry.handler

vi.mock('../content-store', () => {
  return {
    ContentStore: vi.fn().mockImplementation(() => ({
      resolvePath: vi.fn().mockReturnValue({
        schemaItem: { logicalPath: 'content/posts', type: 'collection' },
        slug: 'hello'
      }),
      resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/hello', absolutePath: '/abs/content/posts/hello' }),
      read: vi.fn().mockResolvedValue({ collection: 'posts', format: 'md', data: {}, body: 'Hello' }),
      write: vi.fn().mockResolvedValue({ collection: 'posts', format: 'md', data: {}, body: 'Hello' }),
      renameEntry: vi.fn().mockResolvedValue({ newPath: 'content/posts/new-slug' }),
    })),
    ContentStoreError: class ContentStoreError extends Error {},
  }
})

const allowedCtx = (): ApiContext => ({
  services: {
    config: { schema: [] } as any,
    schemaRegistry: {},
    schemaCacheRegistry: {
      getSchema: vi.fn().mockResolvedValue({ schema: { collections: [] }, flatSchema: [] }),
      invalidate: vi.fn().mockResolvedValue(undefined),
      clearAll: vi.fn().mockResolvedValue(undefined),
    } as any,
    checkBranchAccess: vi.fn(),
    checkPathAccess: undefined as any,
    checkContentAccess: vi.fn().mockReturnValue({ allowed: true, branch: {}, path: {} }),
    createGitManagerFor: undefined as any,
    bootstrapAdminIds: new Set<string>(),
    registry: undefined as any,
    commitFiles: vi.fn(),
    submitBranch: vi.fn(),
    commitToSettingsBranch: vi.fn().mockResolvedValue({ committed: true, pushed: true }),
    getSettingsBranchRoot: vi.fn().mockResolvedValue('/mock/settings'),
  },
  getBranchContext: vi.fn().mockResolvedValue({
    baseRoot: '/tmp/base',
    branchRoot: '/tmp/base/feature-x',
    branch: { name: 'feature/x', status: 'editing', access: {}, createdBy: 'u1', createdAt: 'now', updatedAt: 'now' },
  }),
})

describe('content api', () => {
  it('forbids when access denied', async () => {
    const ctx: ApiContext = {
      services: {
        config: { schema: [] } as any,
                schemaRegistry: {},
        schemaCacheRegistry: {
          getSchema: vi.fn().mockResolvedValue({ schema: { collections: [] }, flatSchema: [] }),
          invalidate: vi.fn().mockResolvedValue(undefined),
          clearAll: vi.fn().mockResolvedValue(undefined),
        } as any,
        checkBranchAccess: vi.fn(),
        checkPathAccess: undefined as any,
        checkContentAccess: vi.fn().mockReturnValue({ allowed: false, branch: {}, path: {} }),
        createGitManagerFor: undefined as any,
        bootstrapAdminIds: new Set<string>(),
        registry: undefined as any,
        commitFiles: vi.fn(),
        submitBranch: vi.fn(),
        commitToSettingsBranch: vi.fn().mockResolvedValue({ committed: true, pushed: true }),
        getSettingsBranchRoot: vi.fn().mockResolvedValue('/tmp/settings'),
      },
      getBranchContext: vi.fn().mockResolvedValue({
        baseRoot: '/tmp/base',
        branchRoot: '/tmp/base/feature-x',
        branch: { name: 'feature/x', status: 'editing', access: {}, createdBy: 'u1', createdAt: 'now', updatedAt: 'now' },
      }),
    }
    const res = await readContent(ctx, { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: toBranchName('feature/x'), path: toLogicalPath('posts/hello') })
    expect(res.status).toBe(403)
    expect(res.ok).toBe(false)
  })

  it('reads content when allowed', async () => {
    const ctx = allowedCtx()
    const res = await readContent(ctx, { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: toBranchName('feature/x'), path: toLogicalPath('posts/hello') })
    expect(res.ok).toBe(true)
  })

  it('writes content with correct format handling', async () => {
    const ctx = allowedCtx()
    const res = await writeContent(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: toBranchName('feature/x'), path: toLogicalPath('posts/hello') },
      { format: 'json', data: { title: 'hi' } }
    )
    expect(res.ok).toBe(true)
  })

  describe('renameEntry', () => {
    it('renames entry when allowed', async () => {
      const ctx = allowedCtx()
      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: toBranchName('feature/x'), path: toLogicalPath('posts/old-slug') },
        { newSlug: toEntrySlug('new-slug') }
      )
      expect(res.ok).toBe(true)
      if (res.ok && res.data) {
        expect(res.data.newPath).toBe('content/posts/new-slug')
      }
    })

    it('forbids rename when access denied', async () => {
      const ctx: ApiContext = {
        services: {
          config: { schema: [] } as any,
                      schemaRegistry: {},
          schemaCacheRegistry: {
            getSchema: vi.fn().mockResolvedValue({ schema: { collections: [] }, flatSchema: [] }),
            invalidate: vi.fn().mockResolvedValue(undefined),
            clearAll: vi.fn().mockResolvedValue(undefined),
          } as any,
          checkBranchAccess: vi.fn(),
          checkPathAccess: undefined as any,
          checkContentAccess: vi.fn().mockReturnValue({ allowed: false, branch: {}, path: {} }),
          createGitManagerFor: undefined as any,
          bootstrapAdminIds: new Set<string>(),
          registry: undefined as any,
          commitFiles: vi.fn(),
          submitBranch: vi.fn(),
          commitToSettingsBranch: vi.fn().mockResolvedValue({ committed: true, pushed: true }),
          getSettingsBranchRoot: vi.fn().mockResolvedValue('/tmp/settings'),
        },
        getBranchContext: vi.fn().mockResolvedValue({
          baseRoot: '/tmp/base',
          branchRoot: '/tmp/base/feature-x',
          branch: { name: 'feature/x', status: 'editing', access: {}, createdBy: 'u1', createdAt: 'now', updatedAt: 'now' },
        }),
      }
      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: toBranchName('feature/x'), path: toLogicalPath('posts/old-slug') },
        { newSlug: toEntrySlug('new-slug') }
      )
      expect(res.status).toBe(403)
      expect(res.ok).toBe(false)
    })

    it('returns 404 when branch not found', async () => {
      const ctx: ApiContext = {
        services: {
          config: { schema: [] } as any,
                      schemaRegistry: {},
          schemaCacheRegistry: {
            getSchema: vi.fn().mockResolvedValue({ schema: { collections: [] }, flatSchema: [] }),
            invalidate: vi.fn().mockResolvedValue(undefined),
            clearAll: vi.fn().mockResolvedValue(undefined),
          } as any,
          checkBranchAccess: vi.fn(),
          checkPathAccess: undefined as any,
          checkContentAccess: vi.fn().mockReturnValue({ allowed: true, branch: {}, path: {} }),
          createGitManagerFor: undefined as any,
          bootstrapAdminIds: new Set<string>(),
          registry: undefined as any,
          commitFiles: vi.fn(),
          submitBranch: vi.fn(),
          commitToSettingsBranch: vi.fn().mockResolvedValue({ committed: true, pushed: true }),
          getSettingsBranchRoot: vi.fn().mockResolvedValue('/tmp/settings'),
        },
        getBranchContext: vi.fn().mockResolvedValue(null),
      }
      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: toBranchName('nonexistent'), path: toLogicalPath('posts/old-slug') },
        { newSlug: toEntrySlug('new-slug') }
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
          slug: 'nonexistent'
        }),
        resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/nonexistent' }),
        renameEntry: vi.fn().mockRejectedValue(new ContentStoreError('Entry not found: nonexistent')),
      }

      vi.mocked(ContentStore).mockImplementationOnce(() => mockStore as any)

      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: toBranchName('feature/x'), path: toLogicalPath('posts/nonexistent') },
        { newSlug: toEntrySlug('new-slug') }
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
          slug: 'old-slug'
        }),
        resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/old-slug' }),
        renameEntry: vi.fn().mockRejectedValue(new ContentStoreError('Entry with slug "existing-slug" already exists in collection "content/posts"')),
      }

      vi.mocked(ContentStore).mockImplementationOnce(() => mockStore as any)

      const res = await renameEntry(
        ctx,
        { user: { type: 'authenticated', userId: 'u1', groups: [] } },
        { branch: toBranchName('feature/x'), path: toLogicalPath('posts/old-slug') },
        { newSlug: toEntrySlug('existing-slug') }
      )
      expect(res.status).toBe(400)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toContain('already exists')
      }
    })
  })
})
