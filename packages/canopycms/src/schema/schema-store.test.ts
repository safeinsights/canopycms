import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SchemaOps, SchemaStoreBusyError, createCollectionInputSchema } from './schema-store'
import type { CreateCollectionInput } from './schema-store'
import type { FieldConfig } from '../config'
import type { LogicalPath } from '../paths/types'
import { unsafeAsLogicalPath } from '../paths/test-utils'
import { BranchSchemaCache, SCHEMA_GENERATION_RESOURCE } from '../branch-schema-cache'
import { resourceGenerationPath } from '../resource-generation'
import { createMockServices } from '../test-utils'
import { withOccFileLock } from '../utils/occ-json-write'

/**
 * Test subclass gating the FIRST readCollectionMeta call behind a
 * manually-resolved deferred, to deterministically simulate a mutation whose
 * read has started (and is now parked INSIDE the schema lock) while a second
 * mutation on another SchemaOps instance queues behind it. Mirrors the gated-
 * hook pattern used by branch-registry.test.ts's BlockingRegistry and
 * content-store.test.ts's BlockingContentStore (see docs/concurrency.md's
 * testing conventions).
 */
class GatedSchemaOps extends SchemaOps {
  public readCallCount = 0
  private resolveGate!: () => void
  private gate: Promise<void> = new Promise((resolve) => {
    this.resolveGate = resolve
  })
  private resolveParked!: () => void
  /** Resolves once the first readCollectionMeta call has started and is now parked on the gate. */
  public parked: Promise<void> = new Promise((resolve) => {
    this.resolveParked = resolve
  })

  /** Release the parked read so the mutation can proceed. */
  release(): void {
    this.resolveGate()
  }

  override async readCollectionMeta(collectionPath: LogicalPath) {
    this.readCallCount++
    if (this.readCallCount === 1) {
      this.resolveParked()
      await this.gate
    }
    return super.readCollectionMeta(collectionPath)
  }
}

/** Shape of a raw `.collection.json` as read directly off disk, bypassing SchemaOps. */
interface RawCollectionJson {
  name?: string
  label?: string
  entries?: Array<{ name: string; label?: string; format: string; schema: string }>
  order?: string[]
}

/**
 * Read a collection's `.collection.json` straight off the filesystem by
 * locating its `{slug}.{id}` directory under `dir` and parsing the file
 * directly -- deliberately NOT via `store.readCollectionMeta()`, so that
 * asserting the effect of one SchemaOps method never depends on the
 * correctness of another (readCollectionMeta is itself one of the methods
 * under test below).
 */
async function readCollectionJsonByDirPrefix(
  dir: string,
  slugPrefix: string,
): Promise<RawCollectionJson> {
  const entries = await fs.readdir(dir)
  const dirName = entries.find((d) => d.startsWith(`${slugPrefix}.`))
  if (!dirName) {
    throw new Error(`No directory starting with "${slugPrefix}." found in ${dir}`)
  }
  const raw = await fs.readFile(path.join(dir, dirName, '.collection.json'), 'utf-8')
  return JSON.parse(raw) as RawCollectionJson
}

/**
 * One row per public SchemaOps method that `normalizeCollectionPath`
 * normalizes (see schema-store.ts). Each `run` drives the method with the
 * content-root-prefixed path the editor actually sends and asserts the
 * method both succeeded AND produced its intended effect -- read straight
 * off disk (or via a return value / a different, unrelated read) rather
 * than merely asserting "did not throw" (the vacuous-test shape PR #211
 * removed elsewhere). Runs against a shared "posts" collection with two
 * entry types ("post", "page") created by the enclosing describe's
 * `beforeEach`.
 */
interface PrefixedPathCase {
  method: string
  run: (store: SchemaOps, contentRoot: string) => Promise<void>
}

const prefixedPathCases: PrefixedPathCase[] = [
  {
    method: 'readCollectionMeta',
    run: async (store) => {
      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('content/posts'))
      expect(meta?.name).toBe('posts')
      expect(meta?.entries?.map((e) => e.name)).toEqual(['post', 'page'])
    },
  },
  {
    method: 'isCollectionEmpty',
    run: async (store, contentRoot) => {
      await expect(store.isCollectionEmpty(unsafeAsLogicalPath('content/posts'))).resolves.toBe(
        true,
      )
      // Drop a content file directly onto disk (SchemaOps never writes
      // content files itself) so the "not empty" branch is genuinely
      // exercised, not just the vacuously-true empty case.
      const dirName = (await fs.readdir(contentRoot)).find((d) => d.startsWith('posts.'))!
      await fs.writeFile(path.join(contentRoot, dirName, 'dummy.txt'), 'x')
      await expect(store.isCollectionEmpty(unsafeAsLogicalPath('content/posts'))).resolves.toBe(
        false,
      )
    },
  },
  {
    method: 'updateCollection',
    run: async (store, contentRoot) => {
      await store.updateCollection(unsafeAsLogicalPath('content/posts'), { label: 'Posts!' })
      const json = await readCollectionJsonByDirPrefix(contentRoot, 'posts')
      expect(json.label).toBe('Posts!')
    },
  },
  {
    method: 'deleteCollection',
    run: async (store, contentRoot) => {
      await store.deleteCollection(unsafeAsLogicalPath('content/posts'))
      const dirs = await fs.readdir(contentRoot)
      expect(dirs.some((d) => d.startsWith('posts.'))).toBe(false)
    },
  },
  {
    method: 'addEntryType',
    run: async (store, contentRoot) => {
      await store.addEntryType(unsafeAsLogicalPath('content/posts'), {
        name: 'gallery',
        format: 'json',
        schema: 'postSchema',
      })
      const json = await readCollectionJsonByDirPrefix(contentRoot, 'posts')
      expect(json.entries?.map((e) => e.name)).toEqual(['post', 'page', 'gallery'])
    },
  },
  {
    method: 'updateEntryType',
    run: async (store, contentRoot) => {
      await store.updateEntryType(unsafeAsLogicalPath('content/posts'), 'page', { label: 'Page' })
      const json = await readCollectionJsonByDirPrefix(contentRoot, 'posts')
      expect(json.entries?.find((e) => e.name === 'page')?.label).toBe('Page')
    },
  },
  {
    method: 'removeEntryType',
    run: async (store, contentRoot) => {
      await store.removeEntryType(unsafeAsLogicalPath('content/posts'), 'page')
      const json = await readCollectionJsonByDirPrefix(contentRoot, 'posts')
      expect(json.entries?.map((e) => e.name)).toEqual(['post'])
    },
  },
  {
    method: 'countEntriesUsingType',
    run: async (store, contentRoot) => {
      const dirName = (await fs.readdir(contentRoot)).find((d) => d.startsWith('posts.'))!
      // Filename pattern: {type}.{slug}.{id}.{ext} -- id must be a valid
      // 12-char Base58 id for countEntriesUsingType to count it.
      await fs.writeFile(path.join(contentRoot, dirName, `post.hello.${'a'.repeat(12)}.json`), '{}')
      await expect(
        store.countEntriesUsingType(unsafeAsLogicalPath('content/posts'), 'post'),
      ).resolves.toBe(1)
    },
  },
  {
    method: 'updateOrder',
    run: async (store, contentRoot) => {
      await store.updateOrder(unsafeAsLogicalPath('content/posts'), ['x', 'y'])
      const json = await readCollectionJsonByDirPrefix(contentRoot, 'posts')
      expect(json.order).toEqual(['x', 'y'])
    },
  },
  {
    method: 'createCollection (input.parentPath, sub-collection create)',
    run: async (store, contentRoot) => {
      const result = await store.createCollection({
        name: 'featured',
        parentPath: unsafeAsLogicalPath('content/posts'),
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      expect(result.collectionPath).toBe('posts/featured')
      const dirName = (await fs.readdir(contentRoot)).find((d) => d.startsWith('posts.'))!
      const childDirs = await fs.readdir(path.join(contentRoot, dirName))
      expect(childDirs.some((d) => d.startsWith('featured.'))).toBe(true)
    },
  },
]

describe('SchemaOps', () => {
  let tempDir: string
  let contentRoot: string
  let entrySchemaRegistry: Record<string, readonly FieldConfig[]>
  let store: SchemaOps

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-schema-store-test-'))
    contentRoot = path.join(tempDir, 'content')
    await fs.mkdir(contentRoot, { recursive: true })

    entrySchemaRegistry = {
      postSchema: [
        { name: 'title', type: 'string', required: true },
        { name: 'body', type: 'markdown' },
      ],
      pageSchema: [
        { name: 'title', type: 'string', required: true },
        { name: 'content', type: 'markdown' },
      ],
      authorSchema: [
        { name: 'name', type: 'string', required: true },
        { name: 'bio', type: 'string' },
      ],
    }

    store = new SchemaOps(contentRoot, entrySchemaRegistry)
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

  // [URL] Contested-URL guard on the collection-rename path. Renaming a collection re-paths every
  // entry beneath it, so its INDEX entry -- whose URL is the collection's own path -- lands on the
  // new name. If the parent already holds an entry with that slug, the two contest one URL.
  // Companion to the entry-side guard in content-store.test.ts's 'contested-URL guard'.
  describe('collection rename, contested URL', () => {
    /** A collection `name` under the content root, holding one entry with slug `slug`. */
    const seedCollection = async (name: string, slug: string) => {
      await store.createCollection({
        name,
        entries: [{ name: 'page', format: 'json', schema: 'pageSchema', default: true }],
      })
      const dir = (await fs.readdir(contentRoot)).find((d) => d.startsWith(`${name}.`))!
      await fs.writeFile(
        path.join(contentRoot, dir, `page.${slug}.aB3cD4eF5gH6.json`),
        JSON.stringify({ title: slug }),
      )
      return path.join(contentRoot, dir)
    }

    it("refuses a rename that would put its landing page on a parent entry's URL", async () => {
      await seedCollection('guides', 'index')
      // A root-level entry already at /docs.
      await fs.writeFile(
        path.join(contentRoot, 'page.docs.zZ9yY8xX7wW6.json'),
        JSON.stringify({ title: 'Docs' }),
      )

      await expect(
        store.updateCollection(unsafeAsLogicalPath('content/guides'), { slug: 'docs' }),
      ).rejects.toThrow(/share a URL with the "docs" entry already in the parent/)
    })

    it('ALLOWS the rename when the collection has no index entry', async () => {
      // No landing page, so nothing contests the parent entry — the same legitimate shape the
      // entry-side guard permits.
      await seedCollection('guides', 'getting-started')
      await fs.writeFile(
        path.join(contentRoot, 'page.docs.zZ9yY8xX7wW6.json'),
        JSON.stringify({ title: 'Docs' }),
      )

      await expect(
        store.updateCollection(unsafeAsLogicalPath('content/guides'), { slug: 'docs' }),
      ).resolves.toBeUndefined()
    })

    it('ALLOWS the rename when the parent holds no entry with that slug', async () => {
      await seedCollection('guides', 'index')

      await expect(
        store.updateCollection(unsafeAsLogicalPath('content/guides'), { slug: 'docs' }),
      ).resolves.toBeUndefined()
    })
  })

  describe('createCollection', () => {
    it('should create a new collection with entry types', async () => {
      const result = await store.createCollection({
        name: 'posts',
        label: 'Blog Posts',
        entries: [{ name: 'post', format: 'mdx', schema: 'postSchema', default: true }],
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
      expect(meta.entries[0].schema).toBe('postSchema')
    })

    it('should create nested collection under parent', async () => {
      // First create parent
      await store.createCollection({
        name: 'docs',
        entries: [{ name: 'doc', format: 'mdx', schema: 'pageSchema' }],
      })

      // Then create child
      const childResult = await store.createCollection({
        name: 'api',
        parentPath: unsafeAsLogicalPath('docs'),
        entries: [{ name: 'api-doc', format: 'mdx', schema: 'pageSchema' }],
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
          entries: [{ name: 'post', format: 'json', schema: 'invalidSchema' }],
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
          entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
        }),
      ).rejects.toThrow()
    })

    it('should reject names with path traversal or unsafe characters before any write', async () => {
      const invalidNames = [
        '../x',
        '..',
        'a/b',
        'a\\b',
        'Foo',
        'foo.bar',
        'foo bar',
        '-foo',
        '.hidden',
      ]

      for (const name of invalidNames) {
        await expect(
          store.createCollection({
            name,
            entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
          }),
        ).rejects.toThrow('Invalid input')
      }

      // Nothing was written inside or outside the content root
      expect(await fs.readdir(contentRoot)).toEqual([])
      expect(await fs.readdir(tempDir)).toEqual(['content'])
    })

    it('should accept a valid hyphenated name', async () => {
      const result = await store.createCollection({
        name: 'blog-posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      expect(result.collectionPath).toBe('blog-posts')
      const dirs = await fs.readdir(contentRoot)
      expect(dirs).toHaveLength(1)
      expect(dirs[0]).toMatch(/^blog-posts\.[a-zA-Z0-9]{12}$/)
    })

    it('should reject entry types with unsafe names', async () => {
      await expect(
        store.createCollection({
          name: 'posts',
          entries: [{ name: '../evil', format: 'json', schema: 'postSchema' }],
        }),
      ).rejects.toThrow('Invalid input')

      expect(await fs.readdir(contentRoot)).toEqual([])
    })

    it('should block traversal with the containment check even if input validation is bypassed', async () => {
      // Simulate a regression where the Zod name pattern is lost: force
      // safeParse to accept a traversal name so the containment backstop
      // is exercised directly.
      const maliciousInput: CreateCollectionInput = {
        name: '../evil',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      }
      const spy = vi
        .spyOn(createCollectionInputSchema, 'safeParse')
        .mockReturnValue({ success: true, data: maliciousInput })

      try {
        await expect(store.createCollection(maliciousInput)).rejects.toThrow(
          'Path traversal detected',
        )
      } finally {
        spy.mockRestore()
      }

      // Nothing was written outside the content root. `.canopy-meta/` is the
      // one expected exception: withSchemaLock's lock acquisition creates it
      // (outside the content tree, by design — see the module doc comment)
      // for every mutation attempt, successful or not, before the
      // containment check inside the lock ever runs. It's left empty (the
      // lock itself is released) rather than containing anything traversal-derived.
      expect((await fs.readdir(tempDir)).sort()).toEqual(['.canopy-meta', 'content'])
      expect(await fs.readdir(path.join(tempDir, '.canopy-meta'))).toEqual([])
      expect(await fs.readdir(contentRoot)).toEqual([])
    })
  })

  describe('readCollectionMeta', () => {
    it('should read existing collection meta', async () => {
      // Create a collection first
      await store.createCollection({
        name: 'posts',
        label: 'Posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      const order = ['abc123def456', 'ghi789jkl012']
      await store.updateCollection(unsafeAsLogicalPath('posts'), { order })

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.order).toEqual(order)
    })

    it('should throw for non-existent collection', async () => {
      await expect(
        store.updateCollection(unsafeAsLogicalPath('nonexistent'), {
          label: 'Test',
        }),
      ).rejects.toThrow('Collection not found')
    })

    it('should rename collection directory when slug changes', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      // Rename slug from "posts" to "blog"
      await store.updateCollection(unsafeAsLogicalPath('posts'), {
        slug: 'blog',
      })

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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      // Update both name (metadata) and slug (directory)
      await store.updateCollection(unsafeAsLogicalPath('posts'), {
        name: 'articles',
        slug: 'blog',
      })

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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      await store.createCollection({
        name: 'articles',
        entries: [{ name: 'article', format: 'json', schema: 'pageSchema' }],
      })

      // Try to rename posts to use articles' slug
      await expect(
        store.updateCollection(unsafeAsLogicalPath('posts'), {
          slug: 'articles',
        }),
      ).rejects.toThrow('already exists')
    })

    it('should validate slug format', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      // Invalid slug (uppercase)
      await expect(
        store.updateCollection(unsafeAsLogicalPath('posts'), {
          slug: 'Blog-Posts',
        }),
      ).rejects.toThrow('must start with a letter')

      // Invalid slug (starts with number)
      await expect(
        store.updateCollection(unsafeAsLogicalPath('posts'), {
          slug: '2024-posts',
        }),
      ).rejects.toThrow('must start with a letter')
    })

    it('should reject unsafe name updates', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      for (const name of ['../evil', 'Bad Name', 'foo.bar']) {
        await expect(
          store.updateCollection(unsafeAsLogicalPath('posts'), { name }),
        ).rejects.toThrow('Invalid input')
      }

      // Name unchanged on disk
      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.name).toBe('posts')
    })

    it('should not rename if slug is same as current', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      // Update with same slug - should not error or rename
      await store.updateCollection(unsafeAsLogicalPath('posts'), {
        slug: 'posts',
      })

      // Verify directory still exists with same name
      const dirName = `posts.${result.contentId}`
      await fs.access(path.join(contentRoot, dirName))
    })
  })

  describe('deleteCollection', () => {
    it('should delete empty collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await store.deleteCollection(unsafeAsLogicalPath('posts'))

      // Verify directory was removed
      const dirs = await fs.readdir(contentRoot)
      expect(dirs.length).toBe(0)
    })

    it('should throw when trying to delete non-empty collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      const isEmpty = await store.isCollectionEmpty(unsafeAsLogicalPath('posts'))
      expect(isEmpty).toBe(true)
    })

    it('should return false for non-empty collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
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
        entries: [{ name: 'doc', format: 'md', schema: 'postSchema' }],
      })

      // Create child collection inside it
      const docsPath = unsafeAsLogicalPath('docs')
      await store.createCollection({
        name: 'guides',
        parentPath: docsPath,
        entries: [{ name: 'guide', format: 'md', schema: 'postSchema' }],
      })

      // Parent has no files but has a child collection — not empty
      const isEmpty = await store.isCollectionEmpty(docsPath)
      expect(isEmpty).toBe(false)
    })

    it('should return true for collection with non-collection directories', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await store.addEntryType(unsafeAsLogicalPath('posts'), {
        name: 'featured-post',
        label: 'Featured Post',
        format: 'mdx',
        schema: 'postSchema',
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await expect(
        store.addEntryType(unsafeAsLogicalPath('posts'), {
          name: 'post', // duplicate
          format: 'mdx',
          schema: 'postSchema',
        }),
      ).rejects.toThrow('already exists')
    })

    it('should reject invalid schema reference', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await expect(
        store.addEntryType(unsafeAsLogicalPath('posts'), {
          name: 'page',
          format: 'json',
          schema: 'invalidSchema',
        }),
      ).rejects.toThrow('Schema reference "invalidSchema" not found')
    })

    it('should reject unsafe entry type names', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      for (const name of ['../evil', 'Bad Name', 'foo.bar']) {
        await expect(
          store.addEntryType(unsafeAsLogicalPath('posts'), {
            name,
            format: 'json',
            schema: 'postSchema',
          }),
        ).rejects.toThrow('Invalid input')
      }
    })
  })

  describe('updateEntryType', () => {
    it('should update entry type properties', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema', label: 'Post' }],
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await store.updateEntryType(unsafeAsLogicalPath('posts'), 'post', {
        schema: 'pageSchema',
      })

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.entries![0].schema).toBe('pageSchema')
    })

    it('should reject invalid schema reference', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await expect(
        store.updateEntryType(unsafeAsLogicalPath('posts'), 'post', {
          schema: 'invalidSchema',
        }),
      ).rejects.toThrow('Schema reference "invalidSchema" not found')
    })

    it('should throw for non-existent entry type', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await expect(
        store.updateEntryType(unsafeAsLogicalPath('posts'), 'nonexistent', {
          label: 'Test',
        }),
      ).rejects.toThrow('Entry type "nonexistent" not found')
    })

    // Breaking-change usage guard — moved here from api/schema.ts's
    // updateEntryTypeHandler (see updateEntryTypeInner's doc comment): the
    // handler used to count usages BEFORE calling the store, which left a
    // TOCTOU window; the guard now runs inside the store, under the same
    // schema lock that guards the write.
    it('should block format change when entries exist using this type', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      const collectionPath = path.join(contentRoot, `posts.${result.contentId}`)
      await fs.writeFile(
        path.join(collectionPath, 'post.first.abc123def456.json'),
        JSON.stringify({ title: 'First' }),
      )

      await expect(
        store.updateEntryType(unsafeAsLogicalPath('posts'), 'post', { format: 'mdx' }),
      ).rejects.toThrow('Cannot modify schema or format for entry type with existing entry')

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.entries![0].format).toBe('json') // unchanged
    })

    it('should block schema change when multiple entries exist using this type', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      const collectionPath = path.join(contentRoot, `posts.${result.contentId}`)
      await fs.writeFile(
        path.join(collectionPath, 'post.first.abc123def456.json'),
        JSON.stringify({ title: 'First' }),
      )
      await fs.writeFile(
        path.join(collectionPath, 'post.second.xyz789uvw123.json'),
        JSON.stringify({ title: 'Second' }),
      )

      await expect(
        store.updateEntryType(unsafeAsLogicalPath('posts'), 'post', { schema: 'pageSchema' }),
      ).rejects.toThrow('2 entries currently use this type')
    })

    it('should allow format/schema change when no entries use this type', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await store.updateEntryType(unsafeAsLogicalPath('posts'), 'post', {
        format: 'mdx',
        schema: 'pageSchema',
      })

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.entries![0].format).toBe('mdx')
      expect(meta!.entries![0].schema).toBe('pageSchema')
    })

    it('should allow label/maxItems changes even when entries exist (non-breaking)', async () => {
      const result = await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      const collectionPath = path.join(contentRoot, `posts.${result.contentId}`)
      await fs.writeFile(
        path.join(collectionPath, 'post.first.abc123def456.json'),
        JSON.stringify({ title: 'First' }),
      )

      await store.updateEntryType(unsafeAsLogicalPath('posts'), 'post', {
        label: 'Blog Post',
        maxItems: 5,
      })

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.entries![0].label).toBe('Blog Post')
      expect(meta!.entries![0].maxItems).toBe(5)
    })
  })

  describe('removeEntryType', () => {
    it('should remove entry type from collection', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', schema: 'postSchema' },
          { name: 'featured', format: 'mdx', schema: 'postSchema' },
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await expect(store.removeEntryType(unsafeAsLogicalPath('posts'), 'post')).rejects.toThrow(
        'Cannot remove last entry type',
      )
    })

    it('should throw for non-existent entry type', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [
          { name: 'post', format: 'json', schema: 'postSchema' },
          { name: 'page', format: 'json', schema: 'pageSchema' },
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
          { name: 'post', format: 'json', schema: 'postSchema' },
          { name: 'featured', format: 'json', schema: 'postSchema' },
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
          { name: 'post', format: 'json', schema: 'postSchema' },
          { name: 'featured', format: 'json', schema: 'postSchema' },
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
          { name: 'post', format: 'json', schema: 'postSchema' },
          { name: 'page', format: 'json', schema: 'pageSchema' },
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
          { name: 'post', format: 'json', schema: 'postSchema' },
          { name: 'draft', format: 'json', schema: 'postSchema' },
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
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
          { name: 'post', format: 'json', schema: 'postSchema' },
          { name: 'page', format: 'json', schema: 'pageSchema' },
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
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
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
          entries: [{ name: 'home', format: 'json', schema: 'pageSchema' }],
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
          entries: [{ name: 'home', format: 'json', schema: 'pageSchema' }],
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

  describe('invalidateSchemaCache eager re-resolve (with services)', () => {
    // Every SchemaOps constructed elsewhere in this file omits the `services`
    // arg, so invalidateSchemaCache() no-ops there (see the `if (!this.services)
    // return` guard) and the eager re-resolve added in 89f7885 is structurally
    // unreachable. This block constructs SchemaOps WITH a real
    // BranchSchemaCache-bearing services object so a mutation actually bumps
    // the on-disk generation marker AND eagerly rewrites schema-cache.json —
    // via resolveAndPersist(), never getSchema() (see invalidateSchemaCache's
    // doc comment for why getSchema()'s cache-read fast path would be the
    // wrong call here).
    it('bumps the schema generation marker and eagerly rewrites schema-cache.json via resolveAndPersist, without ever calling getSchema', async () => {
      const branchRoot = tempDir // contentRoot === path.join(branchRoot, 'content')
      const branchSchemaCache = new BranchSchemaCache('dev')
      const services = createMockServices({ branchSchemaCache })
      const storeWithServices = new SchemaOps(contentRoot, entrySchemaRegistry, services)

      await storeWithServices.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      const markerPath = resourceGenerationPath(branchRoot, SCHEMA_GENERATION_RESOURCE)
      const cachePath = path.join(branchRoot, '.canopy-meta', 'schema-cache.json')

      // Spy AFTER createCollection's own invalidate so it only observes the
      // updateCollection call below.
      const getSchemaSpy = vi.spyOn(branchSchemaCache, 'getSchema')
      const resolveAndPersistSpy = vi.spyOn(branchSchemaCache, 'resolveAndPersist')

      await storeWithServices.updateCollection(unsafeAsLogicalPath('posts'), {
        label: 'Posts!',
      })

      expect(getSchemaSpy).not.toHaveBeenCalled()
      expect(resolveAndPersistSpy).toHaveBeenCalledTimes(1)

      const token = await fs.readFile(markerPath, 'utf-8')
      expect(token.length).toBeGreaterThan(0)

      const cache = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as { generation: string }
      expect(cache.generation).toBe(token)
    })
  })

  describe('concurrency', () => {
    it('serializes two concurrent addEntryType calls on different SchemaOps instances — the second does not read until the first releases the lock', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      const gated = new GatedSchemaOps(contentRoot, entrySchemaRegistry)
      const second = new SchemaOps(contentRoot, entrySchemaRegistry)
      const secondReadSpy = vi.spyOn(second, 'readCollectionMeta')

      const addA = gated.addEntryType(unsafeAsLogicalPath('posts'), {
        name: 'entry-a',
        format: 'json',
        schema: 'postSchema',
      })
      // Wait for gated's read to actually start (and park) before starting
      // the second mutation — not just a microtask tick, since the read
      // involves real fs I/O.
      await gated.parked

      const addB = second.addEntryType(unsafeAsLogicalPath('posts'), {
        name: 'entry-b',
        format: 'json',
        schema: 'postSchema',
      })

      // Give any wrongly-unblocked async work a chance to run before
      // asserting — if the lock were NOT held (the pre-fix behavior),
      // second's readCollectionMeta would already have been called by now.
      await new Promise((resolve) => setImmediate(resolve))
      expect(secondReadSpy).not.toHaveBeenCalled()
      expect(gated.readCallCount).toBe(1)

      gated.release()
      await Promise.all([addA, addB])

      expect(secondReadSpy).toHaveBeenCalledTimes(1)

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      const names = meta!.entries!.map((e) => e.name)
      expect(names).toEqual(expect.arrayContaining(['post', 'entry-a', 'entry-b']))
      expect(names).toHaveLength(3)
    })

    it('serializes 5 concurrent addEntryType calls across 5 SchemaOps instances without losing any', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      const instances = Array.from(
        { length: 5 },
        () => new SchemaOps(contentRoot, entrySchemaRegistry),
      )
      await Promise.all(
        instances.map((instance, i) =>
          instance.addEntryType(unsafeAsLogicalPath('posts'), {
            name: `entry-${i}`,
            format: 'json',
            schema: 'postSchema',
          }),
        ),
      )

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      const names = meta!.entries!.map((e) => e.name)
      expect(names).toEqual(
        expect.arrayContaining(['post', 'entry-0', 'entry-1', 'entry-2', 'entry-3', 'entry-4']),
      )
      expect(names).toHaveLength(6)

      // The resulting file parses cleanly (no interleaved/corrupted write).
      const dirs = await fs.readdir(contentRoot)
      const collectionDir = dirs.find((d) => d.startsWith('posts.'))!
      const raw = await fs.readFile(
        path.join(contentRoot, collectionDir, '.collection.json'),
        'utf-8',
      )
      expect(() => JSON.parse(raw)).not.toThrow()
    })

    it('two concurrent createCollection calls under the same parent both land in the parent order array', async () => {
      await store.createCollection({
        name: 'docs',
        entries: [{ name: 'doc', format: 'md', schema: 'postSchema' }],
      })

      const a = new SchemaOps(contentRoot, entrySchemaRegistry)
      const b = new SchemaOps(contentRoot, entrySchemaRegistry)
      const docsPath = unsafeAsLogicalPath('docs')

      const [childA, childB] = await Promise.all([
        a.createCollection({
          name: 'guides',
          parentPath: docsPath,
          entries: [{ name: 'guide', format: 'md', schema: 'postSchema' }],
        }),
        b.createCollection({
          name: 'api',
          parentPath: docsPath,
          entries: [{ name: 'api-doc', format: 'md', schema: 'postSchema' }],
        }),
      ])

      const parentMeta = await store.readCollectionMeta(docsPath)
      expect(parentMeta!.order).toEqual(
        expect.arrayContaining([childA.contentId, childB.contentId]),
      )
      expect(parentMeta!.order).toHaveLength(2)
    })

    it('updateOrder on a non-root collection completes without deadlocking (no re-entrant lock via the public updateCollection)', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await expect(
        store.updateOrder(unsafeAsLogicalPath('posts'), ['a', 'b']),
      ).resolves.toBeUndefined()

      const meta = await store.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.order).toEqual(['a', 'b'])
    })

    it('leaves no lock or tmp artifacts under the branch root after mutations', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      await store.addEntryType(unsafeAsLogicalPath('posts'), {
        name: 'page',
        format: 'json',
        schema: 'postSchema',
      })
      await store.updateOrder(unsafeAsLogicalPath('posts'), ['x'])

      const metaDirEntries = await fs
        .readdir(path.join(tempDir, '.canopy-meta'))
        .catch(() => [] as string[])
      expect(metaDirEntries).not.toContain('schema.lock')

      const walk = async (dir: string): Promise<string[]> => {
        const out: string[] = []
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            out.push(...(await walk(full)))
          } else {
            out.push(full)
          }
        }
        return out
      }
      const files = await walk(contentRoot)
      expect(files.filter((f) => f.endsWith('.lock') || f.endsWith('.tmp'))).toEqual([])
    })

    it('rejects with SchemaStoreBusyError without recreating branchRoot when the branch has been deleted', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await fs.rm(tempDir, { recursive: true, force: true })

      await expect(
        store.addEntryType(unsafeAsLogicalPath('posts'), {
          name: 'page',
          format: 'json',
          schema: 'postSchema',
        }),
      ).rejects.toThrow(SchemaStoreBusyError)

      const exists = await fs
        .stat(tempDir)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    })

    it('maps a lock-acquisition failure into SchemaStoreBusyError once the branch directory disappears mid-contention', async () => {
      // Mirrors occ-json-write.test.ts's "deleteBranch vs. racing save" test:
      // an external holder keeps the surrogate schema lock while addEntryType
      // queues behind it; once the holder releases AND removes the branch
      // root, the queued attempt's next retry hits ENOENT (not ELOCKED) and
      // withOccFileLock fails fast rather than exhausting the ~13.5s
      // contention budget — withSchemaLock then translates that
      // OccWriteConflictError into SchemaStoreBusyError.
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      const schemaLockPath = path.join(tempDir, '.canopy-meta', 'schema')

      let resolveHolderAcquired!: () => void
      const holderAcquired = new Promise<void>((resolve) => {
        resolveHolderAcquired = resolve
      })
      let resolveProceed!: () => void
      const proceed = new Promise<void>((resolve) => {
        resolveProceed = resolve
      })

      const holder = withOccFileLock(schemaLockPath, async () => {
        resolveHolderAcquired()
        await proceed
        await fs.rm(tempDir, { recursive: true, force: true })
      })

      await holderAcquired

      const addPromise = store.addEntryType(unsafeAsLogicalPath('posts'), {
        name: 'page',
        format: 'json',
        schema: 'postSchema',
      })
      addPromise.catch(() => {})

      resolveProceed()
      await holder

      const failStart = Date.now()
      await expect(addPromise).rejects.toThrow(SchemaStoreBusyError)
      expect(Date.now() - failStart).toBeLessThan(5000)
    }, 15_000)
  })

  // A multi-segment `config.contentRoot` (e.g. "cms/content") is documented as
  // valid in config/helpers.ts. SchemaOps used to derive branchRoot as
  // dirname(contentRoot) and the root-collection's logical path as
  // basename(contentRoot); both are wrong once the content root is more than
  // one segment deep.
  describe('multi-segment contentRoot', () => {
    let branchRoot: string
    let nestedContentRoot: string

    beforeEach(async () => {
      branchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-nested-root-'))
      nestedContentRoot = path.join(branchRoot, 'cms', 'content')
      await fs.mkdir(nestedContentRoot, { recursive: true })
    })

    afterEach(async () => {
      await fs.rm(branchRoot, { recursive: true, force: true })
    })

    it('puts the schema lock under the supplied branchRoot, not dirname(contentRoot)', async () => {
      const nested = new SchemaOps(nestedContentRoot, entrySchemaRegistry, undefined, branchRoot)

      await nested.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await expect(fs.stat(path.join(branchRoot, '.canopy-meta'))).resolves.toBeTruthy()
      // dirname(contentRoot) would have put it here instead
      await expect(fs.stat(path.join(branchRoot, 'cms', '.canopy-meta'))).rejects.toThrow()
    })

    it('recognizes the multi-segment content root as the root collection', async () => {
      const nested = new SchemaOps(nestedContentRoot, entrySchemaRegistry, undefined, branchRoot)

      // basename(contentRoot) yields "content", which never equals the root
      // collection's logical path "cms/content" -- so this used to fall through
      // to the regular-collection branch and fail to resolve.
      await nested.updateCollection(unsafeAsLogicalPath('cms/content'), { label: 'Docs' })

      const meta = JSON.parse(
        await fs.readFile(path.join(nestedContentRoot, '.collection.json'), 'utf8'),
      ) as { label?: string }
      expect(meta.label).toBe('Docs')
    })

    it('still derives branchRoot from dirname(contentRoot) when none is supplied', async () => {
      const single = path.join(branchRoot, 'content')
      await fs.mkdir(single, { recursive: true })
      const store2 = new SchemaOps(single, entrySchemaRegistry)

      await store2.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })

      await expect(fs.stat(path.join(branchRoot, '.canopy-meta'))).resolves.toBeTruthy()
    })

    // August 2026 baseline review finding 4, multi-segment variant: the same
    // "content-root-prefixed path" bug (see the sibling describe block below)
    // also has to survive a multi-segment contentRoot -- a naive fix that
    // strips a prefix by basename() rather than full-string match would pass
    // the single-segment tests below while still being broken here.
    it('every mutation succeeds with the "cms/content"-prefixed path the editor sends for a multi-segment contentRoot', async () => {
      const nested = new SchemaOps(nestedContentRoot, entrySchemaRegistry, undefined, branchRoot)

      const created = await nested.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      expect(created.collectionPath).toBe('posts')

      const prefixed = unsafeAsLogicalPath('cms/content/posts')

      await nested.updateCollection(prefixed, { label: 'Posts' })
      await nested.addEntryType(prefixed, { name: 'page', format: 'json', schema: 'postSchema' })
      await nested.updateEntryType(prefixed, 'page', { label: 'Page' })
      await expect(nested.countEntriesUsingType(prefixed, 'page')).resolves.toBe(0)
      await nested.removeEntryType(prefixed, 'page')
      await nested.updateOrder(prefixed, [created.contentId])

      const meta = await nested.readCollectionMeta(unsafeAsLogicalPath('posts'))
      expect(meta!.label).toBe('Posts')
      expect(meta!.entries!.map((e) => e.name)).toEqual(['post'])
      expect(meta!.order).toEqual([created.contentId])

      await nested.deleteCollection(prefixed)
      await expect(nested.readCollectionMeta(unsafeAsLogicalPath('posts'))).resolves.toBeNull()
    })
  })

  // August 2026 baseline review finding 4: `flattenSchema`
  // (branch-schema-cache.ts) produces content-root-prefixed logical paths
  // (e.g. "content/posts"), and the editor round-trips those straight back
  // into every mutator (CollectionEditor.tsx passes
  // `editingCollection.logicalPath` as-is). Every mutator except
  // updateCollection/updateOrder used to resolve the raw prefixed path
  // against `this.contentRoot` (itself already the content root), landing
  // one level too deep and throwing "Collection not found" -- a 400 for
  // every add/update/remove entry type, sub-collection create, and delete.
  //
  // These tests drive a REAL SchemaOps (never a mock) with the prefixed
  // paths the editor actually sends -- api/schema.test.ts mocks SchemaOps,
  // the rest of this file uses unprefixed paths, and
  // useSchemaManager.test.ts mocks the API client, so this is the one place
  // that actually crosses the seam where the bug lived.
  describe('content-root-prefixed logical paths (the editor-seam bug)', () => {
    it('every mutation succeeds when given the content-root-prefixed path the editor actually sends', async () => {
      const created = await store.createCollection({
        name: 'posts',
        label: 'Posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      expect(created.collectionPath).toBe('posts')

      const prefixed = unsafeAsLogicalPath('content/posts')

      // updateCollection
      await store.updateCollection(prefixed, { label: 'Posts!' })
      expect((await store.readCollectionMeta(unsafeAsLogicalPath('posts')))!.label).toBe('Posts!')

      // addEntryType
      await store.addEntryType(prefixed, { name: 'page', format: 'json', schema: 'postSchema' })
      expect(
        (await store.readCollectionMeta(unsafeAsLogicalPath('posts')))!.entries!.map((e) => e.name),
      ).toEqual(['post', 'page'])

      // updateEntryType
      await store.updateEntryType(prefixed, 'page', { label: 'Page' })
      expect(
        (await store.readCollectionMeta(unsafeAsLogicalPath('posts')))!.entries!.find(
          (e) => e.name === 'page',
        )!.label,
      ).toBe('Page')

      // countEntriesUsingType -- used directly by api/schema.ts's
      // getCollectionHandler, and internally by the breaking-change/removal
      // guards below
      await expect(store.countEntriesUsingType(prefixed, 'page')).resolves.toBe(0)

      // removeEntryType
      await store.removeEntryType(prefixed, 'page')
      expect(
        (await store.readCollectionMeta(unsafeAsLogicalPath('posts')))!.entries!.map((e) => e.name),
      ).toEqual(['post'])

      // sub-collection create (parentPath itself content-root-prefixed, as
      // the editor sends when creating a collection nested under an
      // existing one)
      const child = await store.createCollection({
        name: 'featured',
        parentPath: prefixed,
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      expect(child.collectionPath).toBe('posts/featured')

      // updateOrder (non-root)
      await store.updateOrder(prefixed, [child.contentId])
      expect((await store.readCollectionMeta(unsafeAsLogicalPath('posts')))!.order).toEqual([
        child.contentId,
      ])

      // deleteCollection (must be empty -- delete the child first)
      await store.deleteCollection(unsafeAsLogicalPath('content/posts/featured'))
      await store.deleteCollection(prefixed)
      await expect(store.readCollectionMeta(unsafeAsLogicalPath('posts'))).resolves.toBeNull()
    })

    it('updateCollection and updateOrder on the root collection still work with the bare content-root path', async () => {
      await fs.writeFile(
        path.join(contentRoot, '.collection.json'),
        JSON.stringify({
          entries: [{ name: 'home', format: 'json', schema: 'pageSchema' }],
          order: [],
        }),
      )

      await store.updateCollection(unsafeAsLogicalPath('content'), { label: 'Home' })
      expect((await store.readRootCollectionMeta())!.label).toBe('Home')

      await store.updateOrder(unsafeAsLogicalPath('content'), ['a', 'b'])
      expect((await store.readRootCollectionMeta())!.order).toEqual(['a', 'b'])
    })

    it('unprefixed paths keep working (back-compat for existing callers and tests)', async () => {
      await store.createCollection({
        name: 'posts',
        entries: [{ name: 'post', format: 'json', schema: 'postSchema' }],
      })
      await store.addEntryType(unsafeAsLogicalPath('posts'), {
        name: 'page',
        format: 'json',
        schema: 'postSchema',
      })
      expect(
        (await store.readCollectionMeta(unsafeAsLogicalPath('posts')))!.entries!.map((e) => e.name),
      ).toEqual(['post', 'page'])
    })

    // Table-driven, one row per public method that normalizeCollectionPath
    // normalizes (see the list in schema-store.ts's doc comment). The
    // sequential test above already exercises a realistic call chain, but
    // bundles several methods' assertions together and never calls
    // readCollectionMeta/isCollectionEmpty with a prefixed path directly (it
    // only used them, unprefixed, to verify OTHER methods' effects) -- so a
    // regression in just one of those two methods could slip through. Each
    // row here gets its own fresh "posts" collection (via the beforeEach
    // below) and asserts its method's effect independently, off disk where
    // possible, so a failure names exactly which method regressed.
    describe('every normalized method, individually, with its intended effect asserted', () => {
      beforeEach(async () => {
        await store.createCollection({
          name: 'posts',
          entries: [
            { name: 'post', format: 'json', schema: 'postSchema' },
            { name: 'page', format: 'json', schema: 'postSchema' },
          ],
        })
      })

      it.each(prefixedPathCases)(
        '$method succeeds and has its intended effect when given the content-root-prefixed path',
        async ({ run }) => {
          await run(store, contentRoot)
        },
      )
    })
  })
})
