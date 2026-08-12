import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { FlatSchemaItem, FieldConfig } from '../config'
import type { ContentId, LogicalPath } from '../paths/types'

// Mock the SchemaOps
vi.mock('../schema/schema-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schema/schema-store')>()
  return {
    ...actual,
    SchemaOps: vi.fn().mockImplementation(function () {
      return {
        createCollection: vi.fn(),
        updateCollection: vi.fn(),
        deleteCollection: vi.fn(),
        addEntryType: vi.fn(),
        updateEntryType: vi.fn(),
        removeEntryType: vi.fn(),
        updateOrder: vi.fn(),
        isCollectionEmpty: vi.fn(),
        countEntriesUsingType: vi.fn(),
        readCollectionMeta: vi.fn(),
      }
    }),
  }
})

// Import handlers after mock
import {
  getSchema,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  addEntryType,
  updateEntryType,
  removeEntryType,
  updateOrder,
} from './schema'
import { SchemaOps, SchemaStoreBusyError } from '../schema/schema-store'
import { unsafeAsBranchName, unsafeAsLogicalPath } from '../paths/test-utils'

describe('Schema API', () => {
  const mockFlatSchema: FlatSchemaItem[] = [
    {
      type: 'collection',
      logicalPath: 'posts' as LogicalPath,
      name: 'posts',
      label: 'Posts',
      contentId: 'a1b2c3d4e5f6' as ContentId,
      entries: [{ name: 'post', format: 'json', schema: [], schemaRef: 'postSchema' }],
      order: ['id1', 'id2'],
    },
    {
      type: 'entry-type',
      logicalPath: 'posts/post' as LogicalPath,
      name: 'post',
      parentPath: 'posts' as LogicalPath,
      format: 'json',
      schema: [],
      schemaRef: 'postSchema',
    },
  ]

  const mockEntrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
    postSchema: [{ name: 'title', type: 'string' }],
  }

  let mockCtx: ApiContext
  let mockReq: ApiRequest

  beforeEach(() => {
    vi.clearAllMocks()

    mockCtx = {
      getBranchContext: vi.fn().mockResolvedValue({
        branchRoot: '/test/branch',
        baseRoot: '/test',
        branch: {
          name: 'main',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: 'now',
          updatedAt: 'now',
        },
        flatSchema: mockFlatSchema,
      }),
      services: {
        // mode omitted (not 'prod') -- the 'writableBranch' guard's readOnly
        // check is therefore always false here, matching these admin-only
        // schema-mutation tests' intent (protection isn't under test).
        config: { defaultBaseBranch: 'main' },
        entrySchemaRegistry: mockEntrySchemaRegistry,
        checkBranchAccess: vi.fn().mockReturnValue({ allowed: true }),
        checkContentAccess: vi.fn().mockResolvedValue({ allowed: true }),
      },
    } as unknown as ApiContext

    mockReq = {
      user: {
        id: 'user1',
        groups: ['Admins'],
      },
    } as unknown as ApiRequest
  })

  describe('getSchema', () => {
    it('should return wire flatSchema and entrySchemas dict', async () => {
      const result = await getSchema.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)

      // FlatSchema should be wire format (schemaRef, no resolved schema on entry-type items)
      expect(result.data?.flatSchema).toEqual([
        {
          type: 'collection',
          logicalPath: 'posts',
          name: 'posts',
          label: 'Posts',
          contentId: 'a1b2c3d4e5f6',
          entries: [{ name: 'post', format: 'json', schemaRef: 'postSchema' }],
          order: ['id1', 'id2'],
        },
        {
          type: 'entry-type',
          logicalPath: 'posts/post',
          name: 'post',
          parentPath: 'posts',
          format: 'json',
          schemaRef: 'postSchema',
        },
      ])

      // entrySchemas should be the full registry
      expect(result.data?.entrySchemas).toEqual({
        postSchema: [{ name: 'title', type: 'string' }],
      })
    })

    it('should not embed nested collection subtrees in flat collection items', async () => {
      // flattenSchema keeps the nested config on in-memory items; the wire format
      // must drop it — children are linked via parentPath, not embedded subtrees.
      const guideEntry = {
        name: 'guide',
        format: 'json' as const,
        schema: [],
        schemaRef: 'postSchema',
      }
      const nestedFlatSchema: FlatSchemaItem[] = [
        {
          type: 'collection',
          logicalPath: 'docs' as LogicalPath,
          name: 'docs',
          entries: [{ name: 'post', format: 'json', schema: [], schemaRef: 'postSchema' }],
          collections: [{ name: 'guides', path: 'guides', entries: [guideEntry] }],
          order: ['id1'],
        },
        {
          type: 'collection',
          logicalPath: 'docs/guides' as LogicalPath,
          name: 'guides',
          parentPath: 'docs' as LogicalPath,
          entries: [guideEntry],
        },
      ]
      vi.mocked(mockCtx.getBranchContext).mockResolvedValue({
        branchRoot: '/test/branch',
        branchName: 'main',
        flatSchema: nestedFlatSchema,
      } as unknown as Awaited<ReturnType<ApiContext['getBranchContext']>>)

      const result = await getSchema.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
      })

      expect(result.ok).toBe(true)
      const items = result.data?.flatSchema ?? []

      const parent = items.find((i) => i.logicalPath === 'docs')
      expect(parent).toBeDefined()
      expect(parent).not.toHaveProperty('collections')
      // entries and order stay embedded — consumers use them
      expect(parent).toMatchObject({ order: ['id1'] })
      expect(parent && 'entries' in parent && parent.entries).toHaveLength(1)

      // The child still arrives as its own flat item, linked via parentPath
      const child = items.find((i) => i.logicalPath === 'docs/guides')
      expect(child).toMatchObject({ type: 'collection', name: 'guides', parentPath: 'docs' })
    })

    it('should return 404 for non-existent branch', async () => {
      vi.mocked(mockCtx.getBranchContext).mockResolvedValue(null)

      const result = await getSchema.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('nonexistent'),
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)
    })

    it('should strip resolvedSchema from entrySchemas at all nesting levels', async () => {
      const authorFields = [{ name: 'name', type: 'string' }] as const

      const ctx = {
        ...mockCtx,
        services: {
          ...mockCtx.services,
          entrySchemaRegistry: {
            postSchema: [
              // Top-level reference with resolvedSchema
              {
                name: 'author',
                type: 'reference',
                collections: ['authors'],
                resolvedSchema: authorFields,
              },
              // Nested inside object
              {
                name: 'meta',
                type: 'object',
                fields: [
                  {
                    name: 'reviewer',
                    type: 'reference',
                    collections: ['authors'],
                    resolvedSchema: authorFields,
                  },
                ],
              },
              // Nested inside block template
              {
                name: 'blocks',
                type: 'block',
                templates: [
                  {
                    name: 'quote',
                    fields: [
                      {
                        name: 'source',
                        type: 'reference',
                        collections: ['authors'],
                        resolvedSchema: authorFields,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      } as unknown as ApiContext

      const result = await getSchema.handler(ctx, mockReq, {
        branch: unsafeAsBranchName('main'),
      })

      expect(result.ok).toBe(true)
      const schemas = result.data?.entrySchemas as Record<string, unknown[]>
      const fields = schemas.postSchema

      // Top-level: no resolvedSchema
      expect(fields[0]).not.toHaveProperty('resolvedSchema')
      // Nested in object: no resolvedSchema
      const objectField = fields[1] as { fields: Record<string, unknown>[] }
      expect(objectField.fields[0]).not.toHaveProperty('resolvedSchema')
      // Nested in block template: no resolvedSchema
      const blockField = fields[2] as { templates: Array<{ fields: Record<string, unknown>[] }> }
      expect(blockField.templates[0].fields[0]).not.toHaveProperty('resolvedSchema')
    })
  })

  describe('getCollection', () => {
    it('should return collection details', async () => {
      const result = await getCollection.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('posts'),
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.collection).toMatchObject({
        name: 'posts',
        label: 'Posts',
        path: 'posts',
      })
    })

    it('should include entry types with usage counts', async () => {
      const mockStore = {
        readCollectionMeta: vi.fn().mockResolvedValue({
          name: 'posts',
          label: 'Posts',
          entries: [
            {
              name: 'post',
              format: 'json',
              schema: 'postSchema',
              default: true,
            },
            { name: 'page', format: 'mdx', schema: 'pageSchema' },
          ],
        }),
        countEntriesUsingType: vi
          .fn()
          .mockResolvedValueOnce(3) // post has 3 entries
          .mockResolvedValueOnce(0), // page has 0 entries
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await getCollection.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('posts'),
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.entryTypesWithUsage).toHaveLength(2)
      expect(result.data?.entryTypesWithUsage).toEqual([
        expect.objectContaining({
          name: 'post',
          format: 'json',
          schemaRef: 'postSchema',
          usageCount: 3,
        }),
        expect.objectContaining({
          name: 'page',
          format: 'mdx',
          schemaRef: 'pageSchema',
          usageCount: 0,
        }),
      ])
      expect(mockStore.countEntriesUsingType).toHaveBeenCalledTimes(2)
      expect(mockStore.countEntriesUsingType).toHaveBeenCalledWith('posts', 'post')
      expect(mockStore.countEntriesUsingType).toHaveBeenCalledWith('posts', 'page')
    })

    it('should not include usage counts when collection has no entries', async () => {
      // Test collection without entry types (edge case)
      const mockFlatSchemaWithoutEntries: FlatSchemaItem[] = [
        {
          type: 'collection',
          logicalPath: 'empty' as LogicalPath,
          name: 'empty',
          label: 'Empty',
          entries: [], // No entry types
        },
      ]

      const customCtx = {
        ...mockCtx,
        services: {
          ...mockCtx.services,
          flatSchema: mockFlatSchemaWithoutEntries,
        },
      }

      const result = await getCollection.handler(customCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('empty'),
      })

      expect(result.ok).toBe(true)
      expect(result.data?.collection).toBeDefined()
      expect(result.data?.entryTypesWithUsage).toBeUndefined() // No usage counts for empty collection
    })

    it('should return null for non-existent collection', async () => {
      const result = await getCollection.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('nonexistent'),
      })

      expect(result.ok).toBe(true)
      expect(result.data?.collection).toBeNull()
    })

    it('should reject paths with traversal sequences', () => {
      const result = getCollection.validate({
        params: { branch: 'main', collectionPath: '../admin/secrets' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('traversal')
    })

    it('should reject physical paths (with embedded content IDs)', () => {
      const result = getCollection.validate({
        params: { branch: 'main', collectionPath: 'posts.abc123def456' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('physical path')
    })
  })

  describe('createCollection', () => {
    it('should create collection when user is admin', async () => {
      const mockStore = {
        createCollection: vi.fn().mockResolvedValue({
          collectionPath: 'newcol' as LogicalPath,
          contentId: 'abc123def456',
        }),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await createCollection.handler(
        mockCtx,
        mockReq,
        { branch: unsafeAsBranchName('main') },
        {
          name: 'newcol',
          entries: [{ name: 'item', format: 'json', schema: 'postSchema' }],
        },
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(201)
      expect(result.data?.collectionPath).toBe('newcol')
      expect(mockStore.createCollection).toHaveBeenCalled()
    })

    it('should return 403 for non-admin users', async () => {
      mockReq.user.groups = ['Editors']

      const result = await createCollection.handler(
        mockCtx,
        mockReq,
        { branch: unsafeAsBranchName('main') },
        {
          name: 'newcol',
          entries: [{ name: 'item', format: 'json', schema: 'postSchema' }],
        },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toContain('Admin access required')
    })

    it('should return 409 when the store reports the schema is busy', async () => {
      const mockStore = {
        createCollection: vi.fn().mockRejectedValue(new SchemaStoreBusyError()),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await createCollection.handler(
        mockCtx,
        mockReq,
        { branch: unsafeAsBranchName('main') },
        {
          name: 'newcol',
          entries: [{ name: 'item', format: 'json', schema: 'postSchema' }],
        },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })
  })

  describe('updateCollection', () => {
    it('should update collection when user is admin', async () => {
      const mockStore = {
        updateCollection: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await updateCollection.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
        },
        { label: 'Updated Posts' },
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.success).toBe(true)
      expect(mockStore.updateCollection).toHaveBeenCalled()
    })

    it('should return 403 for non-admin users', async () => {
      mockReq.user.groups = []

      const result = await updateCollection.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
        },
        { label: 'Updated' },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })

    it('should reject paths with traversal sequences', () => {
      const result = updateCollection.validate({
        params: { branch: 'main', collectionPath: 'posts/../admin' },
        body: { label: 'Hacked' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', () => {
      const result = updateCollection.validate({
        params: { branch: 'main', collectionPath: 'posts.vh2WdhwAFiSL' },
        body: { label: 'Updated' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('physical path')
    })

    it('should update root collection label with contentRoot path', async () => {
      const mockStore = {
        updateCollection: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await updateCollection.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('content'),
        },
        { label: 'All Content' },
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.success).toBe(true)
      expect(mockStore.updateCollection).toHaveBeenCalledWith('content', {
        label: 'All Content',
      })
    })

    it('should return 409 when the store reports the schema is busy', async () => {
      const mockStore = {
        updateCollection: vi.fn().mockRejectedValue(new SchemaStoreBusyError()),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await updateCollection.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
        },
        { label: 'Updated Posts' },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })
  })

  describe('deleteCollection', () => {
    it('should delete collection when user is admin', async () => {
      const mockStore = {
        deleteCollection: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await deleteCollection.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('posts'),
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.success).toBe(true)
    })

    it('should return error when collection is not empty', async () => {
      const mockStore = {
        deleteCollection: vi.fn().mockRejectedValue(new Error('Collection must be empty')),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await deleteCollection.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('posts'),
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('Collection must be empty')
    })

    it('should return 409 when the store reports the schema is busy', async () => {
      const mockStore = {
        deleteCollection: vi.fn().mockRejectedValue(new SchemaStoreBusyError()),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await deleteCollection.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('posts'),
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('should reject paths with traversal sequences', () => {
      const result = deleteCollection.validate({
        params: { branch: 'main', collectionPath: 'posts/../secrets' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', () => {
      const result = deleteCollection.validate({
        params: { branch: 'main', collectionPath: 'posts.abc123def456' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('physical path')
    })
  })

  describe('addEntryType', () => {
    it('should add entry type when user is admin', async () => {
      const mockStore = {
        addEntryType: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await addEntryType.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
        },
        { name: 'featured', format: 'mdx', schema: 'postSchema' },
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(201)
      expect(mockStore.addEntryType).toHaveBeenCalled()
    })

    it('should return error for duplicate entry type', async () => {
      const mockStore = {
        addEntryType: vi.fn().mockRejectedValue(new Error('Entry type "post" already exists')),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await addEntryType.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
        },
        { name: 'post', format: 'json', schema: 'postSchema' },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('already exists')
    })

    it('should return 409 when the store reports the schema is busy', async () => {
      const mockStore = {
        addEntryType: vi.fn().mockRejectedValue(new SchemaStoreBusyError()),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await addEntryType.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
        },
        { name: 'featured', format: 'mdx', schema: 'postSchema' },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('should reject paths with traversal sequences', () => {
      const result = addEntryType.validate({
        params: { branch: 'main', collectionPath: '../admin' },
        body: { name: 'entry', format: 'json', schema: 'postSchema' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', () => {
      const result = addEntryType.validate({
        params: { branch: 'main', collectionPath: 'posts.tuggGbrydvYr' },
        body: { name: 'entry', format: 'json', schema: 'postSchema' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('physical path')
    })
  })

  describe('updateEntryType', () => {
    it('should update entry type when user is admin', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
          entryTypeName: 'post',
        },
        { label: 'Blog Post', maxItems: 100 },
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockStore.updateEntryType).toHaveBeenCalledWith(
        'posts',
        'post',
        expect.objectContaining({ label: 'Blog Post', maxItems: 100 }),
      )
    })

    // The breaking-change usage guard (blocking format/schema changes while
    // entries still use this type) used to be pre-checked HERE in the
    // handler via a separate countEntriesUsingType call. It now lives inside
    // SchemaOps.updateEntryType itself (schema-store.ts's
    // updateEntryTypeInner, under the same schema lock that guards the
    // write — see its doc comment for why: the old handler-side check left a
    // TOCTOU window). That guard's own behavior — blocking breaking changes
    // with usage, allowing them without, allowing non-breaking changes
    // regardless — is now covered directly in schema-store.test.ts. These
    // handler tests just pin that the handler forwards the store's
    // rejection/success unchanged and no longer pre-checks usage itself.
    it('should surface the store rejecting a breaking change as a 400 with the message intact', async () => {
      const mockStore = {
        updateEntryType: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'Cannot modify schema or format for entry type with existing entries. 3 entries currently use this type.',
            ),
          ),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
          entryTypeName: 'post',
        },
        { format: 'mdx' },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('Cannot modify schema or format')
      expect(result.error).toContain('3 entries')
      expect(mockStore.updateEntryType).toHaveBeenCalledWith(
        'posts',
        'post',
        expect.objectContaining({ format: 'mdx' }),
      )
    })

    it('should allow a format/schema change the store reports no conflict for', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
          entryTypeName: 'post',
        },
        { format: 'mdx', schema: 'newSchema' },
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockStore.updateEntryType).toHaveBeenCalled()
    })

    it('should return 409 when the store reports the schema is busy', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockRejectedValue(new SchemaStoreBusyError()),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
          entryTypeName: 'post',
        },
        { label: 'Blog Post' },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('should reject paths with traversal sequences', () => {
      const result = updateEntryType.validate({
        params: {
          branch: 'main',
          collectionPath: 'posts/../../etc',
          entryTypeName: 'post',
        },
        body: { label: 'Hacked' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', () => {
      const result = updateEntryType.validate({
        params: {
          branch: 'main',
          collectionPath: 'blog.NMNf8r3GHYkP',
          entryTypeName: 'post',
        },
        body: { label: 'Updated' },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('physical path')
    })
  })

  describe('removeEntryType', () => {
    it('should remove entry type when user is admin', async () => {
      const mockStore = {
        removeEntryType: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await removeEntryType.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('posts'),
        entryTypeName: 'featured',
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
    })

    it('should return error when removing last entry type', async () => {
      const mockStore = {
        removeEntryType: vi.fn().mockRejectedValue(new Error('Cannot remove last entry type')),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await removeEntryType.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('posts'),
        entryTypeName: 'post',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('Cannot remove last entry type')
    })

    it('should return 409 when the store reports the schema is busy', async () => {
      const mockStore = {
        removeEntryType: vi.fn().mockRejectedValue(new SchemaStoreBusyError()),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await removeEntryType.handler(mockCtx, mockReq, {
        branch: unsafeAsBranchName('main'),
        collectionPath: unsafeAsLogicalPath('posts'),
        entryTypeName: 'post',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('should reject paths with traversal sequences', () => {
      const result = removeEntryType.validate({
        params: {
          branch: 'main',
          collectionPath: '..%2F..%2Fpasswd',
          entryTypeName: 'post',
        },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', () => {
      const result = removeEntryType.validate({
        params: {
          branch: 'main',
          collectionPath: 'posts.Xz9kL2mN4pQr',
          entryTypeName: 'post',
        },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('physical path')
    })
  })

  describe('updateOrder', () => {
    it('should update order when user is admin', async () => {
      const mockStore = {
        updateOrder: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await updateOrder.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
        },
        { order: ['id3', 'id1', 'id2'] },
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockStore.updateOrder).toHaveBeenCalledWith('posts', ['id3', 'id1', 'id2'])
    })

    it('should return 403 for non-admin users', async () => {
      mockReq.user.groups = ['Reviewers']

      const result = await updateOrder.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
        },
        { order: ['id1'] },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })

    it('should return 409 when the store reports the schema is busy', async () => {
      const mockStore = {
        updateOrder: vi.fn().mockRejectedValue(new SchemaStoreBusyError()),
      }
      vi.mocked(SchemaOps).mockImplementation(function () {
        return mockStore as any
      })

      const result = await updateOrder.handler(
        mockCtx,
        mockReq,
        {
          branch: unsafeAsBranchName('main'),
          collectionPath: unsafeAsLogicalPath('posts'),
        },
        { order: ['id1'] },
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })

    it('should reject paths with traversal sequences', () => {
      const result = updateOrder.validate({
        params: { branch: 'main', collectionPath: 'posts/../../../root' },
        body: { order: ['id1'] },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', () => {
      const result = updateOrder.validate({
        params: { branch: 'main', collectionPath: 'articles.Y7hJ3kLm9nPq' },
        body: { order: ['id1'] },
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('physical path')
    })
  })

  // Regression: getSchemaOps used to hardcode the literal 'content', so every
  // schema mutation operated on the wrong directory for an adopter who
  // configured a different contentRoot -- while the rest of the CMS correctly
  // honored the config, making it a confusing partial failure.
  describe('contentRoot configuration', () => {
    const runCreateCollection = async (contentRoot?: string) => {
      mockCtx.services.config = {
        ...mockCtx.services.config,
        ...(contentRoot === undefined ? {} : { contentRoot }),
      } as typeof mockCtx.services.config

      vi.mocked(SchemaOps).mockImplementation(function () {
        return {
          createCollection: vi.fn().mockResolvedValue({
            collectionPath: 'newcol' as LogicalPath,
            contentId: 'abc123def456',
          }),
        } as any
      })

      const result = await createCollection.handler(
        mockCtx,
        mockReq,
        { branch: unsafeAsBranchName('main') },
        { name: 'newcol', entries: [{ name: 'item', format: 'json', schema: 'postSchema' }] },
      )
      expect(result.ok).toBe(true)
      return vi.mocked(SchemaOps).mock.calls[0]
    }

    it('builds the SchemaOps content root from config.contentRoot', async () => {
      const call = await runCreateCollection('cms-content')
      expect(call[0]).toBe('/test/branch/cms-content')
    })

    it('falls back to "content" when contentRoot is unset', async () => {
      const call = await runCreateCollection(undefined)
      expect(call[0]).toBe('/test/branch/content')
    })

    // A multi-segment contentRoot is documented as valid (config/helpers.ts).
    // SchemaOps used to derive its branchRoot as dirname(contentRoot), which
    // lands one level too deep for these -- putting the schema lock and
    // .canopy-meta in the wrong directory -- so the branch root is now passed
    // explicitly.
    it('passes branchRoot explicitly so a multi-segment contentRoot still resolves', async () => {
      const call = await runCreateCollection('cms/content')
      expect(call[0]).toBe('/test/branch/cms/content')
      expect(call[3]).toBe('/test/branch')
    })
  })
})
