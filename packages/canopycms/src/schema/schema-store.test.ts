import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SchemaOps } from './schema-store'
import type { FieldConfig } from '../config'
import { unsafeAsLogicalPath } from '../paths/test-utils'

describe('SchemaOps', () => {
  let tempDir: string
  let contentRoot: string
  let schemaRegistry: Record<string, readonly FieldConfig[]>
  let store: SchemaOps

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

    store = new SchemaOps(contentRoot, schemaRegistry)
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
        entries: [{ name: 'post', format: 'mdx', fields: 'postSchema', default: true }],
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
        parentPath: unsafeAsLogicalPath('docs'),
        entries: [{ name: 'api-doc', format: 'mdx', fields: 'pageSchema' }],
      })

      expect(childResult.collectionPath).toBe('docs/api')

      // Verify nested directory structure
      const parentDirs = await fs.readdir(contentRoot)
      const parentDir = parentDirs.find((d) => d.startsWith('docs.'))
      const childDirs = await fs.readdir(path.join(contentRoot, parentDir!))
      expect(childDirs.some((d) => d.startsWith('api.'))).toBe(true)
    })

    it('should reject invalid schema reference', async () => {
      await expect(
        store.createCollection({
          name: 'posts',
          entries: [{ name: 'post', format: 'json', fields: 'invalidSchema' }],
        }),
      ).rejects.toThrow('Schema reference "invalidSchema" not found')
    })

    it('should reject collection with no entry types', async () => {
      await expect(
        store.createCollection({
          name: 'posts',
          entries: [],
        }),
      ).rejects.toThrow('at least one entry type')
    })

    it('should reject invalid input', async () => {
      await expect(
        store.createCollection({
          name: '',
          entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
        }),
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

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta).not.toBeNull()
      expect(meta!.name).toBe('posts')
      expect(meta!.label).toBe('Posts')
    })

    it('should return null for non-existent collection', async () => {
      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('nonexistent'))
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

      await store.updateCollection(unsafeAsLogicalPath('posts'), {
        name: 'articles',
        label: 'Blog Articles',
      })

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.name).toBe('articles')
      expect(meta!.label).toBe('Blog Articles')
    })

    it('should update collection order', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      const order = ['abc123def456', 'ghi789jkl012']
      await store.updateCollection(unsafeAsLogicalPath('posts'), { order })

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.order).toEqual(order)
    })

    it('should throw for non-existent collection', async () => {
      await expect(
        store.updateCollection(unsafeAsLogicalPath('nonexistent'), { label: 'Test' }),
      ).rejects.toThrow('Collection not found')
    })

    it('should rename collection directory when slug changes', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      // Rename slug from "posts" to "blog"
      await store.updateCollection(unsafeAsLogicalPath('posts'), { slug: 'blog' })

      // Verify old directory no longer exists
      const oldDirName = `posts.${result.contentId}`
      await expect(fs.access(path.join(contentRoot, oldDirName))).rejects.toThrow()

      // Verify new directory exists with same content ID
      const newDirName = `blog.${result.contentId}`
      const newDirPath = path.join(contentRoot, newDirName)
      await fs.access(newDirPath) // Should not throw

      // Verify meta file still exists and is correct
      const meta = JSON.parse(await fs.readFile(path.join(newDirPath, '.collection.json'), 'utf-8'))
      expect(meta.name).toBe('posts') // Name unchanged (unless also updated)
    })

    it('should update both name and slug together', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      // Update both name (metadata) and slug (directory)
      await store.updateCollection(unsafeAsLogicalPath('posts'), { name: 'articles', slug: 'blog' })

      // Verify directory was renamed
      const newDirName = `blog.${result.contentId}`
      const newDirPath = path.join(contentRoot, newDirName)
      await fs.access(newDirPath)

      // Verify name was updated in meta
      const meta = JSON.parse(await fs.readFile(path.join(newDirPath, '.collection.json'), 'utf-8'))
      expect(meta.name).toBe('articles')
    })

    it('should throw when slug already exists', async () => {
      // Create two collections
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })
      await store.createCollection({
        name: 'articles',
        entries: [{ name: 'article', format: 'json', fields: 'pageSchema' }],
      })

      // Try to rename posts to use articles' slug
      await expect(
        store.updateCollection(unsafeAsLogicalPath('posts'), { slug: 'articles' }),
      ).rejects.toThrow('already exists')
    })

    it('should validate slug format', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      // Invalid slug (uppercase)
      await expect(
        store.updateCollection(unsafeAsLogicalPath('posts'), { slug: 'Blog-Posts' }),
      ).rejects.toThrow('must start with a letter')

      // Invalid slug (starts with number)
      await expect(
        store.updateCollection(unsafeAsLogicalPath('posts'), { slug: '2024-posts' }),
      ).rejects.toThrow('must start with a letter')
    })

    it('should not rename if slug is same as current', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      // Update with same slug - should not error or rename
      await store.updateCollection(unsafeAsLogicalPath('posts'), { slug: 'posts' })

      // Verify directory still exists with same name
      const dirName = `posts.${result.contentId}`
      await fs.access(path.join(contentRoot, dirName))
    })
  })

  describe('deleteCollection', () => {
    it('should delete empty collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await store.deleteCollection(unsafeAsLogicalPath('posts'))

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
        JSON.stringify({ title: 'Test' }),
      )

      await expect(store.deleteCollection(unsafeAsLogicalPath('posts'))).rejects.toThrow(
        'Collection must be empty',
      )
    })

    it('should throw for non-existent collection', async () => {
      await expect(store.deleteCollection(unsafeAsLogicalPath('nonexistent'))).rejects.toThrow(
        'Collection not found',
      )
    })
  })

  describe('isCollectionEmpty', () => {
    it('should return true for empty collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      const isEmpty = await store.isCollectionEmpty(unsafeAsLogicalPath('posts'))
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
        JSON.stringify({ title: 'Test' }),
      )

      const isEmpty = await store.isCollectionEmpty(unsafeAsLogicalPath('posts'))
      expect(isEmpty).toBe(false)
    })

    it('should return false for collection with child collections', async () => {
      // Create parent collection
      await store.createCollection({
        name: 'docs',
        entries: [{ name: 'doc', format: 'md', fields: 'postSchema' }],
      })

      // Create child collection inside it
      const docsPath = unsafeAsLogicalPath('docs')
      await store.createCollection({
        name: 'guides',
        parentPath: docsPath,
        entries: [{ name: 'guide', format: 'md', fields: 'postSchema' }],
      })

      // Parent has no files but has a child collection — not empty
      const isEmpty = await store.isCollectionEmpty(docsPath)
      expect(isEmpty).toBe(false)
    })

    it('should return true for collection with non-collection directories', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      // Add a plain directory (no .collection.json)
      const dirs = await fs.readdir(contentRoot)
      const collectionDir = path.join(contentRoot, dirs[0])
      await fs.mkdir(path.join(collectionDir, 'assets'), { recursive: true })

      const isEmpty = await store.isCollectionEmpty(unsafeAsLogicalPath('posts'))
      expect(isEmpty).toBe(true)
    })

    it('should return true for non-existent collection', async () => {
      const isEmpty = await store.isCollectionEmpty(unsafeAsLogicalPath('nonexistent'))
      expect(isEmpty).toBe(true)
    })
  })

  describe('addEntryType', () => {
    it('should add entry type to existing collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await store.addEntryType(unsafeAsLogicalPath('posts'), {
        name: 'featured-post',
        label: 'Featured Post',
        format: 'mdx',
        fields: 'postSchema',
        default: false,
      })

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
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
        store.addEntryType(unsafeAsLogicalPath('posts'), {
          name: 'post', // duplicate
          format: 'mdx',
          fields: 'postSchema',
        }),
      ).rejects.toThrow('already exists')
    })

    it('should reject invalid schema reference', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await expect(
        store.addEntryType(unsafeAsLogicalPath('posts'), {
          name: 'page',
          format: 'json',
          fields: 'invalidSchema',
        }),
      ).rejects.toThrow('Schema reference "invalidSchema" not found')
    })
  })

  describe('updateEntryType', () => {
    it('should update entry type properties', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema', label: 'Post' }],
      })

      await store.updateEntryType(unsafeAsLogicalPath('posts'), 'post', {
        label: 'Blog Post',
        format: 'mdx',
        maxItems: 10,
      })

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.entries![0].label).toBe('Blog Post')
      expect(meta!.entries![0].format).toBe('mdx')
      expect(meta!.entries![0].maxItems).toBe(10)
    })

    it('should allow updating schema reference', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await store.updateEntryType(unsafeAsLogicalPath('posts'), 'post', {
        fields: 'pageSchema',
      })

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.entries![0].fields).toBe('pageSchema')
    })

    it('should reject invalid schema reference', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await expect(
        store.updateEntryType(unsafeAsLogicalPath('posts'), 'post', {
          fields: 'invalidSchema',
        }),
      ).rejects.toThrow('Schema reference "invalidSchema" not found')
    })

    it('should throw for non-existent entry type', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await expect(
        store.updateEntryType(unsafeAsLogicalPath('posts'), 'nonexistent', {
          label: 'Test',
        }),
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

      await store.removeEntryType(unsafeAsLogicalPath('posts'), 'featured')

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.entries).toHaveLength(1)
      expect(meta!.entries![0].name).toBe('post')
    })

    it('should throw when trying to remove last entry type', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      await expect(store.removeEntryType(unsafeAsLogicalPath('posts'), 'post')).rejects.toThrow(
        'Cannot remove last entry type',
      )
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
        store.removeEntryType(unsafeAsLogicalPath('posts'), 'nonexistent'),
      ).rejects.toThrow('Entry type "nonexistent" not found')
    })

    it('should throw when entry type still has entries using it', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', fields: 'postSchema' },
          { name: 'featured', format: 'json', fields: 'postSchema' },
        ],
      })

      // Create an entry using the 'post' entry type
      const dirs = await fs.readdir(contentRoot)
      const collectionDir = path.join(contentRoot, dirs[0])
      await fs.writeFile(
        path.join(collectionDir, 'post.hello.abc123def456.json'),
        JSON.stringify({ title: 'Hello' }),
      )

      await expect(store.removeEntryType(unsafeAsLogicalPath('posts'), 'post')).rejects.toThrow(
        'Cannot remove entry type "post": 1 entry still uses it',
      )
    })

    it('should allow removing entry type with no entries using it', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', fields: 'postSchema' },
          { name: 'featured', format: 'json', fields: 'postSchema' },
        ],
      })

      // Create an entry using 'post' but NOT 'featured'
      const dirs = await fs.readdir(contentRoot)
      const collectionDir = path.join(contentRoot, dirs[0])
      await fs.writeFile(
        path.join(collectionDir, 'post.hello.abc123def456.json'),
        JSON.stringify({ title: 'Hello' }),
      )

      // Should succeed — 'featured' has no entries
      await store.removeEntryType(unsafeAsLogicalPath('posts'), 'featured')
      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.entries).toHaveLength(1)
      expect(meta!.entries![0].name).toBe('post')
    })
  })

  describe('countEntriesUsingType', () => {
    it('should count entries with matching entry type', async () => {
      // Create collection
      const result = await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', fields: 'postSchema' },
          { name: 'page', format: 'json', fields: 'pageSchema' },
        ],
      })

      // Create some entry files with valid IDs (base58-like: no 0, l, I, O)
      const collectionPath = path.join(contentRoot, `posts.${result.contentId}`)
      await fs.writeFile(
        path.join(collectionPath, 'post.first.abc123def456.json'),
        JSON.stringify({ title: 'First Post' }),
      )
      await fs.writeFile(
        path.join(collectionPath, 'post.second.xyz789uvw123.json'),
        JSON.stringify({ title: 'Second Post' }),
      )
      await fs.writeFile(
        path.join(collectionPath, 'page.about.pqr345stu678.json'),
        JSON.stringify({ title: 'About Page' }),
      )

      const postCount = await store.countEntriesUsingType(unsafeAsLogicalPath('posts'), 'post')
      const pageCount = await store.countEntriesUsingType(unsafeAsLogicalPath('posts'), 'page')

      expect(postCount).toBe(2)
      expect(pageCount).toBe(1)
    })

    it('should return 0 for entry type with no entries', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', fields: 'postSchema' },
          { name: 'draft', format: 'json', fields: 'postSchema' },
        ],
      })

      // Create only post entries, no drafts
      const collectionPath = path.join(contentRoot, `posts.${result.contentId}`)
      await fs.writeFile(
        path.join(collectionPath, 'post.first.abc123def456.json'),
        JSON.stringify({ title: 'First Post' }),
      )

      const draftCount = await store.countEntriesUsingType(unsafeAsLogicalPath('posts'), 'draft')
      expect(draftCount).toBe(0)
    })

    it('should return 0 for non-existent collection', async () => {
      const count = await store.countEntriesUsingType(unsafeAsLogicalPath('nonexistent'), 'post')
      expect(count).toBe(0)
    })

    it('should ignore files without valid IDs', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      const collectionPath = path.join(contentRoot, `posts.${result.contentId}`)

      // Valid entry (base58-like ID: no 0, l, I, O)
      await fs.writeFile(
        path.join(collectionPath, 'post.valid.abc123def456.json'),
        JSON.stringify({ title: 'Valid' }),
      )

      // Invalid: ID too short
      await fs.writeFile(
        path.join(collectionPath, 'post.invalid.abc123.json'),
        JSON.stringify({ title: 'Invalid ID' }),
      )

      // Invalid: no ID
      await fs.writeFile(
        path.join(collectionPath, 'post.noid.json'),
        JSON.stringify({ title: 'No ID' }),
      )

      const count = await store.countEntriesUsingType(unsafeAsLogicalPath('posts'), 'post')
      expect(count).toBe(1) // Only the valid one
    })

    it('should ignore hidden files and directories', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      const collectionPath = path.join(contentRoot, `posts.${result.contentId}`)

      // Valid entry (base58-like ID: no 0, l, I, O)
      await fs.writeFile(
        path.join(collectionPath, 'post.valid.abc123def456.json'),
        JSON.stringify({ title: 'Valid' }),
      )

      // Hidden file (should be ignored)
      await fs.writeFile(
        path.join(collectionPath, '.post.hidden.xyz789uvw123.json'),
        JSON.stringify({ title: 'Hidden' }),
      )

      // Collection meta (should be ignored)
      await fs.writeFile(
        path.join(collectionPath, '.collection.json'),
        JSON.stringify({ name: 'posts' }),
      )

      const count = await store.countEntriesUsingType(unsafeAsLogicalPath('posts'), 'post')
      expect(count).toBe(1) // Only the visible one
    })

    it('should only count files with matching entry type prefix', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', fields: 'postSchema' },
          { name: 'page', format: 'json', fields: 'pageSchema' },
        ],
      })

      const collectionPath = path.join(contentRoot, `posts.${result.contentId}`)

      // Mix of post and page entries
      await fs.writeFile(
        path.join(collectionPath, 'post.first.abc123def456.json'),
        JSON.stringify({ title: 'Post 1' }),
      )
      await fs.writeFile(
        path.join(collectionPath, 'page.about.xyz789uvw012.json'),
        JSON.stringify({ title: 'About' }),
      )
      await fs.writeFile(
        path.join(collectionPath, 'post.second.pqr345stu678.json'),
        JSON.stringify({ title: 'Post 2' }),
      )

      const postCount = await store.countEntriesUsingType(unsafeAsLogicalPath('posts'), 'post')
      expect(postCount).toBe(2) // Should not include the page entry
    })
  })

  describe('updateOrder', () => {
    it('should update order array for collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', fields: 'postSchema' }],
      })

      const order = ['id1', 'id2', 'id3']
      await store.updateOrder(unsafeAsLogicalPath('posts'), order)

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.order).toEqual(order)
    })

    it('should update root collection order', async () => {
      // Create root .collection.json first
      await fs.writeFile(
        path.join(contentRoot, '.collection.json'),
        JSON.stringify({
          entries: [{ name: 'home', format: 'json', fields: 'pageSchema' }],
          order: [],
        }),
      )

      const order = ['rootId1', 'rootId2']
      await store.updateOrder(unsafeAsLogicalPath('content'), order)

      const rootMeta = await store.readRootCollectionMeta()
      expect(rootMeta!.order).toEqual(order)
    })

    it('should create root meta if it does not exist', async () => {
      const order = ['rootId1']
      await store.updateOrder(unsafeAsLogicalPath('content'), order)

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
        }),
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
