import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { loadCollectionMetaFiles, resolveCollectionReferences } from './schema'
import type { FieldConfig } from './config'

describe('schema-meta-loader', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('loadCollectionMetaFiles', () => {
    it('should load root collection meta file', async () => {
      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir, { recursive: true })
      await fs.writeFile(
        path.join(contentDir, '.collection.json'),
        JSON.stringify({
          entries: [
            {
              name: 'home',
              label: 'Home',
              format: 'json',
              schema: 'homeSchema',
            },
          ],
          order: [],
        }),
      )

      const result = await loadCollectionMetaFiles(contentDir)

      expect(result.root).toEqual({
        entries: [
          {
            name: 'home',
            label: 'Home',
            format: 'json',
            schema: 'homeSchema',
          },
        ],
        order: [],
      })
      expect(result.collections).toEqual([])
    })

    it('should load collection meta files from subdirectories', async () => {
      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir, { recursive: true })
      await fs.writeFile(
        path.join(contentDir, '.collection.json'),
        JSON.stringify({ entries: [], order: [] }),
      )

      const postsDir = path.join(contentDir, 'posts')
      await fs.mkdir(postsDir, { recursive: true })
      await fs.writeFile(
        path.join(postsDir, '.collection.json'),
        JSON.stringify({
          name: 'posts',
          label: 'Posts',
          entries: [
            {
              name: 'post',
              format: 'mdx',
              schema: 'postSchema',
            },
          ],
          order: [],
        }),
      )

      const authorsDir = path.join(contentDir, 'authors')
      await fs.mkdir(authorsDir, { recursive: true })
      await fs.writeFile(
        path.join(authorsDir, '.collection.json'),
        JSON.stringify({
          name: 'authors',
          label: 'Authors',
          entries: [
            {
              name: 'author',
              format: 'json',
              schema: 'authorSchema',
            },
          ],
          order: [],
        }),
      )

      const result = await loadCollectionMetaFiles(contentDir)

      expect(result.root).toEqual({ entries: [], order: [] })
      expect(result.collections).toHaveLength(2)
      expect(result.collections).toContainEqual({
        name: 'posts',
        label: 'Posts',
        entries: [
          {
            name: 'post',
            format: 'mdx',
            schema: 'postSchema',
          },
        ],
        order: [],
        path: 'posts',
      })
      expect(result.collections).toContainEqual({
        name: 'authors',
        label: 'Authors',
        entries: [
          {
            name: 'author',
            format: 'json',
            schema: 'authorSchema',
          },
        ],
        order: [],
        path: 'authors',
      })
    })

    it('should return null root if no root meta file exists', async () => {
      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir, { recursive: true })

      const postsDir = path.join(contentDir, 'posts')
      await fs.mkdir(postsDir, { recursive: true })
      await fs.writeFile(
        path.join(postsDir, '.collection.json'),
        JSON.stringify({
          name: 'posts',
          label: 'Posts',
          entries: [
            {
              name: 'post',
              format: 'mdx',
              schema: 'postSchema',
            },
          ],
          order: [],
        }),
      )

      const result = await loadCollectionMetaFiles(contentDir)

      expect(result.root).toBeNull()
      expect(result.collections).toHaveLength(1)
    })

    it('should handle empty content directory', async () => {
      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir, { recursive: true })

      const result = await loadCollectionMetaFiles(contentDir)

      expect(result.root).toBeNull()
      expect(result.collections).toEqual([])
    })

    it('should throw error if root file has invalid JSON', async () => {
      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir, { recursive: true })
      await fs.writeFile(path.join(contentDir, '.collection.json'), 'invalid json')

      await expect(loadCollectionMetaFiles(contentDir)).rejects.toThrow(
        'Invalid root .collection.json',
      )
    })

    it('should throw error if root file fails Zod validation', async () => {
      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir, { recursive: true })
      await fs.writeFile(
        path.join(contentDir, '.collection.json'),
        JSON.stringify({ entries: 'not an array' }),
      )

      await expect(loadCollectionMetaFiles(contentDir)).rejects.toThrow(
        'Invalid root .collection.json',
      )
    })
  })

  describe('resolveCollectionReferences', () => {
    const mockSchemaRegistry = {
      homeSchema: [
        { name: 'title', label: 'Title', type: 'string' as const, required: true },
        { name: 'description', label: 'Description', type: 'textarea' as const },
      ],
      postSchema: [
        { name: 'title', label: 'Title', type: 'string' as const, required: true },
        { name: 'content', label: 'Content', type: 'markdown' as const },
      ],
      authorSchema: [
        { name: 'name', label: 'Name', type: 'string' as const, required: true },
        { name: 'bio', label: 'Bio', type: 'textarea' as const },
      ],
    } satisfies Record<string, readonly FieldConfig[]>

    it('should resolve schema references in collections with entries array', () => {
      const metaFiles = {
        root: null,
        collections: [
          {
            name: 'pages',
            label: 'Pages',
            entries: [
              {
                name: 'page',
                format: 'json' as const,
                schema: 'homeSchema',
              },
            ],
            order: [],
            path: 'pages',
          },
        ],
      }

      const result = resolveCollectionReferences(metaFiles, mockSchemaRegistry)

      expect(result.collections).toHaveLength(1)
      expect(result.collections![0].entries?.[0]?.schema).toEqual(mockSchemaRegistry.homeSchema)
    })

    it('should resolve schema references in collections', () => {
      const metaFiles = {
        root: null,
        collections: [
          {
            name: 'posts',
            label: 'Posts',
            entries: [
              {
                name: 'post',
                format: 'mdx' as const,
                schema: 'postSchema',
              },
            ],
            order: [],
            path: 'posts',
          },
          {
            name: 'authors',
            label: 'Authors',
            entries: [
              {
                name: 'author',
                format: 'json' as const,
                schema: 'authorSchema',
              },
            ],
            order: [],
            path: 'authors',
          },
        ],
      }

      const result = resolveCollectionReferences(metaFiles, mockSchemaRegistry)

      expect(result.collections).toHaveLength(2)
      expect(result.collections![0].entries?.[0]?.schema).toEqual(mockSchemaRegistry.postSchema)
      expect(result.collections![1].entries?.[0]?.schema).toEqual(mockSchemaRegistry.authorSchema)
    })

    it('should throw error if schema reference not found', () => {
      const metaFiles = {
        root: null,
        collections: [
          {
            name: 'pages',
            label: 'Pages',
            path: 'pages',
            entries: [
              {
                name: 'page',
                format: 'json' as const,
                schema: 'nonexistentSchema',
              },
            ],
            order: [],
          },
        ],
      }

      expect(() => {
        resolveCollectionReferences(metaFiles, mockSchemaRegistry)
      }).toThrow('Schema reference "nonexistentSchema"')
    })

    it('should handle multiple collections', () => {
      const metaFiles = {
        root: null,
        collections: [
          {
            name: 'pages',
            label: 'Pages',
            path: 'pages',
            entries: [
              {
                name: 'page',
                format: 'json' as const,
                schema: 'homeSchema',
              },
            ],
            order: [],
          },
          {
            name: 'posts',
            label: 'Posts',
            entries: [
              {
                name: 'post',
                format: 'mdx' as const,
                schema: 'postSchema',
              },
            ],
            order: [],
            path: 'posts',
          },
        ],
      }

      const result = resolveCollectionReferences(metaFiles, mockSchemaRegistry)

      expect(result.collections).toHaveLength(2)
      expect(result.collections![0].entries?.[0]?.schema).toEqual(mockSchemaRegistry.homeSchema)
      expect(result.collections![1].entries?.[0]?.schema).toEqual(mockSchemaRegistry.postSchema)
    })

    it('should preserve other collection properties', () => {
      const metaFiles = {
        root: null,
        collections: [
          {
            name: 'posts',
            label: 'Posts',
            entries: [
              {
                name: 'post',
                format: 'mdx' as const,
                schema: 'postSchema',
              },
            ],
            order: [],
            path: 'custom-path',
          },
        ],
      }

      const result = resolveCollectionReferences(metaFiles, mockSchemaRegistry)

      expect(result.collections![0]).toMatchObject({
        name: 'posts',
        label: 'Posts',
        path: 'custom-path',
      })
      expect(result.collections![0].entries?.[0]?.schema).toEqual(mockSchemaRegistry.postSchema)
    })

    it('should return empty object when no meta files', () => {
      const metaFiles = {
        root: null,
        collections: [],
      }

      const result = resolveCollectionReferences(metaFiles, mockSchemaRegistry)

      expect(result.collections).toBeUndefined()
    })
  })
})
