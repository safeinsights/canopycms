import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiContext, ApiRequest } from './types'
import type { FlatSchemaItem, RootCollectionConfig, FieldConfig } from '../config'
import type { LogicalPath } from '../paths/types'

// Mock the SchemaStore
vi.mock('../schema/schema-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schema/schema-store')>()
  return {
    ...actual,
    SchemaStore: vi.fn().mockImplementation(() => ({
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
    })),
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
import { SchemaStore } from '../schema/schema-store'

describe('Schema API', () => {
  const mockFlatSchema: FlatSchemaItem[] = [
    {
      type: 'collection',
      logicalPath: 'posts' as LogicalPath,
      name: 'posts',
      label: 'Posts',
      entries: [{ name: 'post', format: 'json', fields: [] }],
      order: ['id1', 'id2'],
    },
    {
      type: 'entry-type',
      logicalPath: 'posts/post' as LogicalPath,
      name: 'post',
      parentPath: 'posts' as LogicalPath,
      format: 'json',
      fields: [],
    },
  ]

  const mockSchema: RootCollectionConfig = {
    collections: [
      {
        name: 'posts',
        path: 'posts',
        label: 'Posts',
        entries: [{ name: 'post', format: 'json', fields: [] }],
      },
    ],
  }

  const mockSchemaRegistry: Record<string, readonly FieldConfig[]> = {
    postSchema: [{ name: 'title', type: 'string' }],
  }

  let mockCtx: ApiContext
  let mockReq: ApiRequest

  beforeEach(() => {
    vi.clearAllMocks()

    mockCtx = {
      getBranchContext: vi.fn().mockResolvedValue({
        branchRoot: '/test/branch',
        branchName: 'main',
      }),
      services: {
        config: { schema: mockSchema },
        schema: mockSchema,
        flatSchema: mockFlatSchema,
        schemaRegistry: mockSchemaRegistry,
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
    it('should return full schema, flatSchema, and availableSchemas', async () => {
      const result = await getSchema.handler(mockCtx, mockReq, { branch: 'main' })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.schema).toEqual(mockSchema)
      expect(result.data?.flatSchema).toEqual(mockFlatSchema)
      expect(result.data?.availableSchemas).toEqual(['postSchema'])
    })

    it('should return 404 for non-existent branch', async () => {
      vi.mocked(mockCtx.getBranchContext).mockResolvedValue(null)

      const result = await getSchema.handler(mockCtx, mockReq, { branch: 'nonexistent' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)
    })
  })

  describe('getCollection', () => {
    it('should return collection details', async () => {
      const result = await getCollection.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts',
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
            { name: 'post', format: 'json', fields: 'postSchema', default: true },
            { name: 'page', format: 'mdx', fields: 'pageSchema' },
          ],
        }),
        countEntriesUsingType: vi.fn()
          .mockResolvedValueOnce(3) // post has 3 entries
          .mockResolvedValueOnce(0), // page has 0 entries
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await getCollection.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts',
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.entryTypesWithUsage).toHaveLength(2)
      expect(result.data?.entryTypesWithUsage).toEqual([
        expect.objectContaining({
          name: 'post',
          format: 'json',
          fields: 'postSchema',
          usageCount: 3,
        }),
        expect.objectContaining({
          name: 'page',
          format: 'mdx',
          fields: 'pageSchema',
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
        branch: 'main',
        collectionPath: 'empty',
      })

      expect(result.ok).toBe(true)
      expect(result.data?.collection).toBeDefined()
      expect(result.data?.entryTypesWithUsage).toBeUndefined() // No usage counts for empty collection
    })

    it('should return null for non-existent collection', async () => {
      const result = await getCollection.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'nonexistent',
      })

      expect(result.ok).toBe(true)
      expect(result.data?.collection).toBeNull()
    })

    it('should reject paths with traversal sequences', async () => {
      const result = await getCollection.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: '../admin/secrets',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('traversal')
    })

    it('should reject physical paths (with embedded content IDs)', async () => {
      const result = await getCollection.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts.abc123def456',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('physical path')
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
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await createCollection.handler(
        mockCtx,
        mockReq,
        { branch: 'main' },
        {
          name: 'newcol',
          entries: [{ name: 'item', format: 'json', fields: 'postSchema' }],
        }
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
        { branch: 'main' },
        {
          name: 'newcol',
          entries: [{ name: 'item', format: 'json', fields: 'postSchema' }],
        }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
      expect(result.error).toContain('Admin access required')
    })
  })

  describe('updateCollection', () => {
    it('should update collection when user is admin', async () => {
      const mockStore = {
        updateCollection: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateCollection.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts' },
        { label: 'Updated Posts' }
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
        { branch: 'main', collectionPath: 'posts' },
        { label: 'Updated' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })

    it('should reject paths with traversal sequences', async () => {
      const result = await updateCollection.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts/../admin' },
        { label: 'Hacked' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', async () => {
      const result = await updateCollection.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts.vh2WdhwAFiSL' },
        { label: 'Updated' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('physical path')
    })

    it('should update root collection label with contentRoot path', async () => {
      const mockStore = {
        updateCollection: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateCollection.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'content' },
        { label: 'All Content' }
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.success).toBe(true)
      expect(mockStore.updateCollection).toHaveBeenCalledWith('content', { label: 'All Content' })
    })
  })

  describe('deleteCollection', () => {
    it('should delete collection when user is admin', async () => {
      const mockStore = {
        deleteCollection: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await deleteCollection.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts',
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.success).toBe(true)
    })

    it('should return error when collection is not empty', async () => {
      const mockStore = {
        deleteCollection: vi.fn().mockRejectedValue(new Error('Collection must be empty')),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await deleteCollection.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('Collection must be empty')
    })

    it('should reject paths with traversal sequences', async () => {
      const result = await deleteCollection.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts/../secrets',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', async () => {
      const result = await deleteCollection.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts.abc123def456',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('physical path')
    })
  })

  describe('addEntryType', () => {
    it('should add entry type when user is admin', async () => {
      const mockStore = {
        addEntryType: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await addEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts' },
        { name: 'featured', format: 'mdx', fields: 'postSchema' }
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(201)
      expect(mockStore.addEntryType).toHaveBeenCalled()
    })

    it('should return error for duplicate entry type', async () => {
      const mockStore = {
        addEntryType: vi.fn().mockRejectedValue(new Error('Entry type "post" already exists')),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await addEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts' },
        { name: 'post', format: 'json', fields: 'postSchema' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('already exists')
    })

    it('should reject paths with traversal sequences', async () => {
      const result = await addEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: '../admin' },
        { name: 'entry', format: 'json', fields: 'postSchema' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', async () => {
      const result = await addEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts.tuggGbrydvYr' },
        { name: 'entry', format: 'json', fields: 'postSchema' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('physical path')
    })
  })

  describe('updateEntryType', () => {
    it('should update entry type when user is admin', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesUsingType: vi.fn().mockResolvedValue(0),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts', entryTypeName: 'post' },
        { label: 'Blog Post', maxItems: 100 }
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockStore.updateEntryType).toHaveBeenCalledWith(
        'posts',
        'post',
        expect.objectContaining({ label: 'Blog Post', maxItems: 100 })
      )
    })

    it('should allow label/maxItems updates when entries exist', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesUsingType: vi.fn().mockResolvedValue(5),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts', entryTypeName: 'post' },
        { label: 'Updated Label', maxItems: 10 }
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockStore.updateEntryType).toHaveBeenCalled()
      // Should not check usage count since non-breaking changes
      expect(mockStore.countEntriesUsingType).not.toHaveBeenCalled()
    })

    it('should block format change when entries exist', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesUsingType: vi.fn().mockResolvedValue(3),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts', entryTypeName: 'post' },
        { format: 'mdx' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('Cannot modify schema or format')
      expect(result.error).toContain('3 entries')
      expect(mockStore.countEntriesUsingType).toHaveBeenCalledWith('posts', 'post')
      expect(mockStore.updateEntryType).not.toHaveBeenCalled()
    })

    it('should block fields change when entries exist', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesUsingType: vi.fn().mockResolvedValue(1),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts', entryTypeName: 'post' },
        { fields: 'newSchema' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('Cannot modify schema or format')
      expect(result.error).toContain('1 entry')
      expect(mockStore.countEntriesUsingType).toHaveBeenCalledWith('posts', 'post')
      expect(mockStore.updateEntryType).not.toHaveBeenCalled()
    })

    it('should allow format/fields change when no entries exist', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesUsingType: vi.fn().mockResolvedValue(0),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts', entryTypeName: 'post' },
        { format: 'mdx', fields: 'newSchema' }
      )

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(mockStore.countEntriesUsingType).toHaveBeenCalledWith('posts', 'post')
      expect(mockStore.updateEntryType).toHaveBeenCalled()
    })

    it('should block simultaneous format and fields change when entries exist', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesUsingType: vi.fn().mockResolvedValue(5),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts', entryTypeName: 'post' },
        { format: 'mdx', fields: 'newSchema' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('Cannot modify schema or format')
      expect(result.error).toContain('5 entries')
      expect(mockStore.countEntriesUsingType).toHaveBeenCalledWith('posts', 'post')
      expect(mockStore.updateEntryType).not.toHaveBeenCalled()
    })

    it('should use singular "entry" in error message for count=1', async () => {
      const mockStore = {
        updateEntryType: vi.fn().mockResolvedValue(undefined),
        countEntriesUsingType: vi.fn().mockResolvedValue(1),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts', entryTypeName: 'post' },
        { format: 'mdx' }
      )

      expect(result.ok).toBe(false)
      expect(result.error).toContain('1 entry') // Singular
      expect(result.error).not.toContain('entries') // Not plural
    })

    it('should reject paths with traversal sequences', async () => {
      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts/../../etc', entryTypeName: 'post' },
        { label: 'Hacked' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', async () => {
      const result = await updateEntryType.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'blog.NMNf8r3GHYkP', entryTypeName: 'post' },
        { label: 'Updated' }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('physical path')
    })
  })

  describe('removeEntryType', () => {
    it('should remove entry type when user is admin', async () => {
      const mockStore = {
        removeEntryType: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await removeEntryType.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts',
        entryTypeName: 'featured',
      })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
    })

    it('should return error when removing last entry type', async () => {
      const mockStore = {
        removeEntryType: vi.fn().mockRejectedValue(new Error('Cannot remove last entry type')),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await removeEntryType.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts',
        entryTypeName: 'post',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('Cannot remove last entry type')
    })

    it('should reject paths with traversal sequences', async () => {
      const result = await removeEntryType.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: '..%2F..%2Fpasswd',
        entryTypeName: 'post',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', async () => {
      const result = await removeEntryType.handler(mockCtx, mockReq, {
        branch: 'main',
        collectionPath: 'posts.Xz9kL2mN4pQr',
        entryTypeName: 'post',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('physical path')
    })
  })

  describe('updateOrder', () => {
    it('should update order when user is admin', async () => {
      const mockStore = {
        updateOrder: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(SchemaStore).mockImplementation(() => mockStore as any)

      const result = await updateOrder.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts' },
        { order: ['id3', 'id1', 'id2'] }
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
        { branch: 'main', collectionPath: 'posts' },
        { order: ['id1'] }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    })

    it('should reject paths with traversal sequences', async () => {
      const result = await updateOrder.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'posts/../../../root' },
        { order: ['id1'] }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('traversal')
    })

    it('should reject physical paths', async () => {
      const result = await updateOrder.handler(
        mockCtx,
        mockReq,
        { branch: 'main', collectionPath: 'articles.Y7hJ3kLm9nPq' },
        { order: ['id1'] }
      )

      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.error).toContain('physical path')
    })
  })
})
