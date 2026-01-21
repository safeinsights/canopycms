import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SchemaStore } from './schema-store'
import type { FieldConfig } from '../config'
import type { LogicalPath } from '../paths/types'

describe('SchemaStore', () => {
  let tempDir: string
  let contentRoot: string
  let schemaRegistry: Record<string, readonly FieldConfig[]>
  let store: SchemaStore

  const toLogicalPath = (p: string): LogicalPath => p as LogicalPath

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-schema-store-test-'))
    contentRoot = path.join(tempDir, 'content')
    await fs.mkdir(contentRoot, { recursive: true })

    schemaRegistry = {
      postSchema: [
        { name: 'title', type: 'string', required: true },
        { name: 'body', type: 'markdown' },
      ],
      pageSchema: [
        { name: 'title', type: 'string', required: true },
        { name: 'content', type: 'rich-text' },
      ],
      authorSchema: [
        { name: 'name', type: 'string', required: true },
        { name: 'bio', type: 'string' },
      ],
    }

    store = new SchemaStore(contentRoot, schemaRegistry)
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('validateSchemaReference', () => {
    it('should return true for valid schema reference', () => {
      expect(store.validateSchemaReference('postSchema')).toBe(true)
      expect(store.validateSchemaReference('pageSchema')).toBe(true)
    })

    it('should return false for invalid schema reference', () => {
      expect(store.validateSchemaReference('nonExistentSchema')).toBe(false)
      expect(store.validateSchemaReference('')).toBe(false)
    })
  })

  describe('createCollection', () => {
    it('should create a new collection with entry types', async () => {
      const result = await store.createCollection({
        name: 'posts',
        label: 'Blog Posts',
        entries: [
          { name: 'post', format: 'mdx', fields: 'postSchema', default: true },
        ],
      })

      expect(result.collectionPath).toBe('posts')
      expect(result.contentId).toHaveLength(12)

      // Verify directory was created
      const dirs = await fs.readdir(contentRoot)
      expect(dirs.length).toBe(1)
      expect(dirs[0]).toMatch(/^posts\.[a-zA-Z0-9]{12}$/)

      // Verify .collection.json was created
      const metaPath = path.join(contentRoot, dirs[0], '.collection.json')
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
      expect(meta.name).toBe('posts')
      expect(meta.label).toBe('Blog Posts')
      expect(meta.entries).toHaveLength(1)
      expect(meta.entries[0].name).toBe('post')
      expect(meta.entries[0].format).toBe('mdx')
      expect(meta.entries[0].fields).toBe('postSchema')
    })

    it('should create nested collection under parent', async () => {
      // First create parent
      const parentResult = await store.createCollection({
        name: 'docs',
        entries: [{ name: 'doc', format: 'mdx', fields: 'pageSchema' }],
      })

      // Then create child
      const childResult = await store.createCollection({
        name: 'api',
        parentPath: toLogicalPath('docs'),
        entries: [{ name: 'api-doc', format: 'mdx', fields: 'pageSchema' }],
      })

      expect(childResult.collectionPath).toBe('docs/api')

      // Verify nested directory structure
      const parentDirs = await fs.readdir(contentRoot)
      const parentDir = parentDirs.find(d => d.startsWith('docs.'))
      const childDirs = await fs.readdir(path.join(contentRoot, parentDir!))
      expect(childDirs.some(d => d.startsWith('api.'))).toBe(true)
    })

    it('should reject invalid schema reference', async () => {
      await expect(
        store.createCollection({
          name: 'posts',
          entries: [{ name: 'post', format: 'json', fields: 'invalidSchema' }],
        })
      ).rejects.toThrow('Schema reference "invalidSchema" not found')
    })

    it('should reject collection with no entry types', async () => {
      await expect(
        store.createCollection({
          name: 'posts',
          entries: [],
        })
      ).rejects.toThrow('at least one entry type')
    })

    it('should reject invalid input', async () => {
      await expect(
        store.createCollection({
          name: '',
          entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
        })
      ).rejects.toThrow()
    })
  })

  describe('readCollectionMeta', () => {
    it('should read existing collection meta', async () => {
      // Create a collection first
      await store.createCollection({
        name: 'posts',
        label: 'Posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      const meta = await store.readCollectionMeta(toLogicalPath('posts'))
      expect(meta).not.toBeNull()
      expect(meta!.name).toBe('posts')
      expect(meta!.label).toBe('Posts')
    })

    it('should return null for non-existent collection', async () => {
      const meta = await store.readCollectionMeta(toLogicalPath('nonexistent'))
      expect(meta).toBeNull()
    })
  })

  describe('updateCollection', () => {
    it('should update collection name and label', async () => {
      await store.createCollection({
        name: 'posts',
        label: 'Posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await store.updateCollection(toLogicalPath('posts'), {
        name: 'articles',
        label: 'Blog Articles',
      })

      const meta = await store.readCollectionMeta(toLogicalPath('posts'))
      expect(meta!.name).toBe('articles')
      expect(meta!.label).toBe('Blog Articles')
    })

    it('should update collection order', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      const order = ['abc123def456', 'ghi789jkl012']
      await store.updateCollection(toLogicalPath('posts'), { order })

      const meta = await store.readCollectionMeta(toLogicalPath('posts'))
      expect(meta!.order).toEqual(order)
    })

    it('should throw for non-existent collection', async () => {
      await expect(
        store.updateCollection(toLogicalPath('nonexistent'), { label: 'Test' })
      ).rejects.toThrow('Collection not found')
    })
  })

  describe('deleteCollection', () => {
    it('should delete empty collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await store.deleteCollection(toLogicalPath('posts'))

      // Verify directory was removed
      const dirs = await fs.readdir(contentRoot)
      expect(dirs.length).toBe(0)
    })

    it('should throw when trying to delete non-empty collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      // Add a content file
      const dirs = await fs.readdir(contentRoot)
      const collectionDir = path.join(contentRoot, dirs[0])
      await fs.writeFile(
        path.join(collectionDir, 'post.test.abc123def456.json'),
        JSON.stringify({ title: 'Test' })
      )

      await expect(store.deleteCollection(toLogicalPath('posts'))).rejects.toThrow(
        'Collection must be empty'
      )
    })

    it('should throw for non-existent collection', async () => {
      await expect(store.deleteCollection(toLogicalPath('nonexistent'))).rejects.toThrow(
        'Collection not found'
      )
    })
  })

  describe('isCollectionEmpty', () => {
    it('should return true for empty collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      const isEmpty = await store.isCollectionEmpty(toLogicalPath('posts'))
      expect(isEmpty).toBe(true)
    })

    it('should return false for non-empty collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      // Add a content file
      const dirs = await fs.readdir(contentRoot)
      const collectionDir = path.join(contentRoot, dirs[0])
      await fs.writeFile(
        path.join(collectionDir, 'post.test.abc123def456.json'),
        JSON.stringify({ title: 'Test' })
      )

      const isEmpty = await store.isCollectionEmpty(toLogicalPath('posts'))
      expect(isEmpty).toBe(false)
    })

    it('should return true for non-existent collection', async () => {
      const isEmpty = await store.isCollectionEmpty(toLogicalPath('nonexistent'))
      expect(isEmpty).toBe(true)
    })
  })

  describe('addEntryType', () => {
    it('should add entry type to existing collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await store.addEntryType(toLogicalPath('posts'), {
        name: 'featured-post',
        label: 'Featured Post',
        format: 'mdx',
        fields: 'postSchema',
        default: false,
      })

      const meta = await store.readCollectionMeta(toLogicalPath('posts'))
      expect(meta!.entries).toHaveLength(2)
      expect(meta!.entries![1].name).toBe('featured-post')
      expect(meta!.entries![1].format).toBe('mdx')
    })

    it('should reject duplicate entry type name', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await expect(
        store.addEntryType(toLogicalPath('posts'), {
          name: 'post', // duplicate
          format: 'mdx',
          fields: 'postSchema',
        })
      ).rejects.toThrow('already exists')
    })

    it('should reject invalid schema reference', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await expect(
        store.addEntryType(toLogicalPath('posts'), {
          name: 'page',
          format: 'json',
          fields: 'invalidSchema',
        })
      ).rejects.toThrow('Schema reference "invalidSchema" not found')
    })
  })

  describe('updateEntryType', () => {
    it('should update entry type properties', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', fields: 'postSchema', label: 'Post' },
        ],
      })

      await store.updateEntryType(toLogicalPath('posts'), 'post', {
        label: 'Blog Post',
        format: 'mdx',
        maxItems: 10,
      })

      const meta = await store.readCollectionMeta(toLogicalPath('posts'))
      expect(meta!.entries![0].label).toBe('Blog Post')
      expect(meta!.entries![0].format).toBe('mdx')
      expect(meta!.entries![0].maxItems).toBe(10)
    })

    it('should allow updating schema reference', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await store.updateEntryType(toLogicalPath('posts'), 'post', {
        fields: 'pageSchema',
      })

      const meta = await store.readCollectionMeta(toLogicalPath('posts'))
      expect(meta!.entries![0].fields).toBe('pageSchema')
    })

    it('should reject invalid schema reference', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await expect(
        store.updateEntryType(toLogicalPath('posts'), 'post', {
          fields: 'invalidSchema',
        })
      ).rejects.toThrow('Schema reference "invalidSchema" not found')
    })

    it('should throw for non-existent entry type', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await expect(
        store.updateEntryType(toLogicalPath('posts'), 'nonexistent', {
          label: 'Test',
        })
      ).rejects.toThrow('Entry type "nonexistent" not found')
    })
  })

  describe('removeEntryType', () => {
    it('should remove entry type from collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', fields: 'postSchema' },
          { name: 'featured', format: 'mdx', fields: 'postSchema' },
        ],
      })

      await store.removeEntryType(toLogicalPath('posts'), 'featured')

      const meta = await store.readCollectionMeta(toLogicalPath('posts'))
      expect(meta!.entries).toHaveLength(1)
      expect(meta!.entries![0].name).toBe('post')
    })

    it('should throw when trying to remove last entry type', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await expect(
        store.removeEntryType(toLogicalPath('posts'), 'post')
      ).rejects.toThrow('Cannot remove last entry type')
    })

    it('should throw for non-existent entry type', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', fields: 'postSchema' },
          { name: 'page', format: 'json', fields: 'pageSchema' },
        ],
      })

      await expect(
        store.removeEntryType(toLogicalPath('posts'), 'nonexistent')
      ).rejects.toThrow('Entry type "nonexistent" not found')
    })
  })

  describe('updateOrder', () => {
    it('should update order array for collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      const order = ['id1', 'id2', 'id3']
      await store.updateOrder(toLogicalPath('posts'), order)

      const meta = await store.readCollectionMeta(toLogicalPath('posts'))
      expect(meta!.order).toEqual(order)
    })

    it('should update root collection order', async () => {
      // Create root .collection.json first
      await fs.writeFile(
        path.join(contentRoot, '.collection.json'),
        JSON.stringify({
          entries: [{ name: 'home', format: 'json', fields: 'pageSchema' }],
        })
      )

      const order = ['rootId1', 'rootId2']
      await store.updateOrder(toLogicalPath(''), order)

      const rootMeta = await store.readRootCollectionMeta()
      expect(rootMeta!.order).toEqual(order)
    })

    it('should create root meta if it does not exist', async () => {
      const order = ['rootId1']
      await store.updateOrder(toLogicalPath(''), order)

      const rootMeta = await store.readRootCollectionMeta()
      expect(rootMeta!.order).toEqual(order)
    })
  })

  describe('readRootCollectionMeta', () => {
    it('should read root collection meta', async () => {
      await fs.writeFile(
        path.join(contentRoot, '.collection.json'),
        JSON.stringify({
          entries: [{ name: 'home', format: 'json', fields: 'pageSchema' }],
          order: ['abc123'],
        })
      )

      const meta = await store.readRootCollectionMeta()
      expect(meta).not.toBeNull()
      expect(meta!.entries).toHaveLength(1)
      expect(meta!.order).toEqual(['abc123'])
    })

    it('should return null when root meta does not exist', async () => {
      const meta = await store.readRootCollectionMeta()
      expect(meta).toBeNull()
    })
  })
})
