import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ContentIdIndex, extractIdFromFilename, extractSlugFromFilename } from './content-id-index'
import {
  unsafeAsLogicalPath,
  unsafeAsSlug,
  unsafeAsPhysicalPath,
  unsafeAsContentId,
} from './paths/test-utils'

describe('ContentIdIndex', () => {
  let tempDir: string
  let index: ContentIdIndex

  beforeEach(async () => {
    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
    await fs.mkdir(path.join(tempDir, 'content'), { recursive: true })
    index = new ContentIdIndex(tempDir)
  })

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('buildFromFilenames', () => {
    it('finds no IDs in empty directory', async () => {
      await index.buildFromFilenames('content')

      expect(index.findById('anyid')).toBeNull()
    })

    it('builds index from filenames with embedded IDs', async () => {
      // Create a test file with embedded ID
      const testId = 'a1b2c3d4e5f6'
      const filePath = path.join(tempDir, `content/test.${testId}.json`)
      await fs.writeFile(filePath, '{}')

      // Build index
      await index.buildFromFilenames('content')

      // Verify
      const location = index.findById(testId)
      expect(location).not.toBeNull()
      expect(location?.id).toBe(testId)
      expect(location?.type).toBe('entry')
      expect(location?.relativePath).toBe(`content/test.${testId}.json`)
      expect(location?.slug).toBe('test')
    })

    it('indexes multiple entries', async () => {
      // Create files with embedded IDs (valid Base58, no 0/O/I/l)
      const homeId = 'h1m2e3e4a5b6'
      const aboutId = 'x7y8z9abB1c2'
      await fs.writeFile(path.join(tempDir, `content/home.${homeId}.json`), '{}')
      await fs.writeFile(path.join(tempDir, `content/about.${aboutId}.json`), '{}')

      // Build index
      await index.buildFromFilenames('content')

      // Verify all entries
      const homeLocation = index.findById(homeId)
      expect(homeLocation).not.toBeNull()
      expect(homeLocation?.type).toBe('entry')
      expect(homeLocation?.slug).toBe('home')

      const aboutLocation = index.findById(aboutId)
      expect(aboutLocation).not.toBeNull()
      expect(aboutLocation?.type).toBe('entry')
      expect(aboutLocation?.slug).toBe('about')
    })

    it('skips files without IDs', async () => {
      // Create file without ID (legacy format)
      await fs.writeFile(path.join(tempDir, 'content/legacy.json'), '{}')

      // Build index
      await index.buildFromFilenames('content')

      // Should not be in index
      expect(index.getAllLocations()).toHaveLength(0)
    })

    it('skips hidden files and _ids_ directory', async () => {
      // Create hidden file and _ids_ directory
      await fs.writeFile(path.join(tempDir, 'content/.gitignore'), '')
      await fs.mkdir(path.join(tempDir, 'content/_ids_'), { recursive: true })

      // Build index
      await index.buildFromFilenames('content')

      // Should not be in index
      expect(index.getAllLocations()).toHaveLength(0)
    })

    it('throws on ID collision', async () => {
      const duplicateId = 'a1b2c3d4e5f6'
      await fs.writeFile(path.join(tempDir, `content/file1.${duplicateId}.json`), '{}')
      await fs.writeFile(path.join(tempDir, `content/file2.${duplicateId}.json`), '{}')

      // Should throw
      await expect(index.buildFromFilenames('content')).rejects.toThrow('ID collision')
    })

    it('indexes nested directories', async () => {
      const postId = 'p1s2t3a4b5c6'
      await fs.mkdir(path.join(tempDir, 'content/posts'), { recursive: true })
      await fs.writeFile(path.join(tempDir, `content/posts/hello.${postId}.json`), '{}')

      await index.buildFromFilenames('content')

      const location = index.findById(postId)
      expect(location?.relativePath).toBe(`content/posts/hello.${postId}.json`)
      expect(location?.collection).toBe('content/posts')
    })

    it('indexes collection directories with IDs', async () => {
      const collectionId = 'c1L2L3e4c5t6'
      await fs.mkdir(path.join(tempDir, `content/posts.${collectionId}`), {
        recursive: true,
      })

      await index.buildFromFilenames('content')

      const location = index.findById(collectionId)
      expect(location).not.toBeNull()
      expect(location?.type).toBe('collection')
      expect(location?.relativePath).toBe(`content/posts.${collectionId}`)
    })
  })

  describe('findById', () => {
    it('returns null for non-existent ID', async () => {
      await index.buildFromFilenames('content')
      expect(index.findById('nonexistent')).toBeNull()
    })

    it('returns location for existing ID', async () => {
      // Setup
      const testId = 'a1b2c3d4e5f6'
      await fs.writeFile(path.join(tempDir, `content/test.${testId}.json`), '{}')
      await index.buildFromFilenames('content')

      // Test
      const location = index.findById(testId)
      expect(location).toMatchObject({
        id: testId,
        type: 'entry',
        relativePath: `content/test.${testId}.json`,
      })
    })
  })

  describe('findByPath', () => {
    it('returns null for non-existent path', async () => {
      await index.buildFromFilenames('content')
      expect(index.findByPath(unsafeAsPhysicalPath('content/nonexistent.json'))).toBeNull()
    })

    it('returns ID for existing path', async () => {
      // Setup
      const testId = 'a1b2c3d4e5f6'
      await fs.writeFile(path.join(tempDir, `content/test.${testId}.json`), '{}')
      await index.buildFromFilenames('content')

      // Test
      const id = index.findByPath(unsafeAsPhysicalPath(`content/test.${testId}.json`))
      expect(id).toBe(testId)
    })
  })

  describe('add', () => {
    it('updates index for new file', () => {
      // Add to index (file must have ID in name)
      const testId = 'n1e2w3f4i5j6'
      index.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/new.${testId}.json`),
        collection: unsafeAsLogicalPath('content'),
        slug: unsafeAsSlug('new'),
      })

      // Verify index updated
      expect(index.findById(testId)).not.toBeNull()
      expect(index.findByPath(unsafeAsPhysicalPath(`content/new.${testId}.json`))).toBe(testId)
    })

    it('throws on collision', () => {
      const testId = 'a1b2c3d4e5f6'

      index.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/file1.${testId}.json`),
        collection: unsafeAsLogicalPath('content'),
        slug: unsafeAsSlug('file1'),
      })

      // Attempt to add duplicate ID
      expect(() =>
        index.add({
          type: 'entry',
          relativePath: unsafeAsPhysicalPath(`content/file2.${testId}.json`),
          collection: unsafeAsLogicalPath('content'),
          slug: unsafeAsSlug('file2'),
        }),
      ).toThrow('ID collision')
    })

    it('throws if filename has no ID', () => {
      expect(() =>
        index.add({
          type: 'entry',
          relativePath: unsafeAsPhysicalPath('content/no-id.json'),
          collection: unsafeAsLogicalPath('content'),
          slug: unsafeAsSlug('no-id'),
        }),
      ).toThrow('Cannot add location without ID')
    })

    it('adds collection entries', () => {
      const collectionId = 'c1L2L3e4c5t6'

      index.add({
        type: 'collection',
        relativePath: unsafeAsPhysicalPath(`content/posts.${collectionId}`),
      })

      const location = index.findById(collectionId)
      expect(location?.type).toBe('collection')
    })
  })

  describe('remove', () => {
    it('removes entry from index', () => {
      // Setup
      const testId = 'r1e2m3v4e5x6'
      index.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/test.${testId}.json`),
        collection: unsafeAsLogicalPath('content'),
        slug: unsafeAsSlug('test'),
      })

      // Remove
      index.remove(unsafeAsContentId(testId))

      // Verify index updated
      expect(index.findById(testId)).toBeNull()
      expect(index.findByPath(unsafeAsPhysicalPath(`content/test.${testId}.json`))).toBeNull()
    })

    it('handles non-existent ID gracefully', () => {
      expect(() => index.remove(unsafeAsContentId('nonexistent'))).not.toThrow()
    })
  })

  describe('updatePath', () => {
    it('updates path for existing ID', () => {
      const testId = 'u1p2d3t4e5x6'
      index.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/old.${testId}.json`),
        collection: unsafeAsLogicalPath('content'),
        slug: unsafeAsSlug('old'),
      })

      // Update path
      index.updatePath(
        unsafeAsContentId(testId),
        unsafeAsPhysicalPath(`content/new.${testId}.json`),
      )

      // Verify
      const location = index.findById(testId)
      expect(location?.relativePath).toBe(`content/new.${testId}.json`)
      expect(location?.slug).toBe('new')
      expect(index.findByPath(unsafeAsPhysicalPath(`content/old.${testId}.json`))).toBeNull()
      expect(index.findByPath(unsafeAsPhysicalPath(`content/new.${testId}.json`))).toBe(testId)
    })

    it('throws for non-existent ID', () => {
      expect(() =>
        index.updatePath(
          unsafeAsContentId('nonexistent'),
          unsafeAsPhysicalPath('content/new.json'),
        ),
      ).toThrow('Cannot update path for unknown ID')
    })
  })

  describe('getEntriesInCollection', () => {
    it('returns empty array for non-existent collection', async () => {
      await index.buildFromFilenames('content')

      const entries = index.getEntriesInCollection(unsafeAsLogicalPath('content/nonexistent'))
      expect(entries).toEqual([])
    })

    it('returns empty array for empty collection', async () => {
      await fs.mkdir(path.join(tempDir, 'content/empty'), { recursive: true })
      await index.buildFromFilenames('content')

      const entries = index.getEntriesInCollection(unsafeAsLogicalPath('content/empty'))
      expect(entries).toEqual([])
    })

    it('returns all entries in a collection', async () => {
      // Create collection with entries
      await fs.mkdir(path.join(tempDir, 'content/posts'), { recursive: true })

      const post1Id = 'p1s2t3a4b5c6'
      const post2Id = 'x7y8z9abB1c2'
      await fs.writeFile(path.join(tempDir, `content/posts/post.hello.${post1Id}.json`), '{}')
      await fs.writeFile(path.join(tempDir, `content/posts/post.world.${post2Id}.json`), '{}')

      await index.buildFromFilenames('content')

      const entries = index.getEntriesInCollection(unsafeAsLogicalPath('content/posts'))
      expect(entries).toHaveLength(2)
      expect(entries.map((e) => e.id).sort()).toEqual([post1Id, post2Id].sort())
      expect(entries.every((e) => e.collection === 'content/posts')).toBe(true)
    })

    it('does not include collection directories in results', async () => {
      // Create nested collection structure
      const collectionId = 'c1L2L3e4c5t6'
      await fs.mkdir(path.join(tempDir, `content/posts.${collectionId}`), {
        recursive: true,
      })

      const entryId = 'p1s2t3a4b5c6'
      await fs.writeFile(
        path.join(tempDir, `content/posts.${collectionId}/post.hello.${entryId}.json`),
        '{}',
      )

      await index.buildFromFilenames('content')

      const entries = index.getEntriesInCollection(unsafeAsLogicalPath('content/posts'))
      expect(entries).toHaveLength(1)
      expect(entries[0].type).toBe('entry')
      expect(entries[0].id).toBe(entryId)
    })

    it('maintains index consistency after add', () => {
      const entryId = 'n1e2w3f4i5j6'

      index.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/posts/post.new.${entryId}.json`),
        collection: unsafeAsLogicalPath('content/posts'),
        slug: unsafeAsSlug('new'),
      })

      const entries = index.getEntriesInCollection(unsafeAsLogicalPath('content/posts'))
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe(entryId)
    })

    it('maintains index consistency after remove', () => {
      const entry1Id = 'e1n2t3r4y5a6'
      const entry2Id = 'e1n2t3r4y5b7'

      index.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/posts/post.first.${entry1Id}.json`),
        collection: unsafeAsLogicalPath('content/posts'),
        slug: unsafeAsSlug('first'),
      })
      index.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/posts/post.second.${entry2Id}.json`),
        collection: unsafeAsLogicalPath('content/posts'),
        slug: unsafeAsSlug('second'),
      })

      index.remove(unsafeAsContentId(entry1Id))

      const entries = index.getEntriesInCollection(unsafeAsLogicalPath('content/posts'))
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe(entry2Id)
    })

    it('cleans up empty collections after remove', () => {
      const entryId = 'e1n2t3r4y5a6'

      index.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/posts/post.only.${entryId}.json`),
        collection: unsafeAsLogicalPath('content/posts'),
        slug: unsafeAsSlug('only'),
      })

      index.remove(unsafeAsContentId(entryId))

      // Should return empty array, not throw
      const entries = index.getEntriesInCollection(unsafeAsLogicalPath('content/posts'))
      expect(entries).toEqual([])
    })

    it('maintains index consistency after updatePath with collection change', () => {
      const entryId = 'u1p2d3t4e5x6'

      index.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/posts/post.article.${entryId}.json`),
        collection: unsafeAsLogicalPath('content/posts'),
        slug: unsafeAsSlug('article'),
      })

      // Move to different collection
      index.updatePath(
        unsafeAsContentId(entryId),
        unsafeAsPhysicalPath(`content/pages/page.article.${entryId}.json`),
      )

      // Should be removed from old collection
      const postsEntries = index.getEntriesInCollection(unsafeAsLogicalPath('content/posts'))
      expect(postsEntries).toHaveLength(0)

      // Should appear in new collection
      const pagesEntries = index.getEntriesInCollection(unsafeAsLogicalPath('content/pages'))
      expect(pagesEntries).toHaveLength(1)
      expect(pagesEntries[0].id).toBe(entryId)
    })

    it('handles nested collections correctly', async () => {
      // Create nested structure
      await fs.mkdir(path.join(tempDir, 'content/docs/api'), {
        recursive: true,
      })

      const apiEntryId = 'a1p2i3e4n5t6'
      await fs.writeFile(path.join(tempDir, `content/docs/api/doc.intro.${apiEntryId}.json`), '{}')

      const docsEntryId = 'd1c2s3e4n5t6'
      await fs.writeFile(path.join(tempDir, `content/docs/doc.guide.${docsEntryId}.json`), '{}')

      await index.buildFromFilenames('content')

      // Parent collection should only have its direct entries
      const docsEntries = index.getEntriesInCollection(unsafeAsLogicalPath('content/docs'))
      expect(docsEntries).toHaveLength(1)
      expect(docsEntries[0].id).toBe(docsEntryId)

      // Nested collection should have its entries
      const apiEntries = index.getEntriesInCollection(unsafeAsLogicalPath('content/docs/api'))
      expect(apiEntries).toHaveLength(1)
      expect(apiEntries[0].id).toBe(apiEntryId)
    })
  })

  describe('getEntriesInCollectionTree', () => {
    it('returns entries from a collection and all subcollections', async () => {
      // Create nested structure: content/catalog, content/catalog/partner-a, content/catalog/partner-b
      await fs.mkdir(path.join(tempDir, 'content/catalog/partner-a'), { recursive: true })
      await fs.mkdir(path.join(tempDir, 'content/catalog/partner-b'), { recursive: true })

      const catalogEntryId = 'c1t2L3g4e5n6'
      const partnerAId = 'p1r2t3n4a5b6'
      const partnerBId = 'p1r2t3n4b5c7'

      await fs.writeFile(
        path.join(tempDir, `content/catalog/page.index.${catalogEntryId}.json`),
        '{}',
      )
      await fs.writeFile(
        path.join(tempDir, `content/catalog/partner-a/partner.overview.${partnerAId}.yaml`),
        '',
      )
      await fs.writeFile(
        path.join(tempDir, `content/catalog/partner-b/partner.overview.${partnerBId}.yaml`),
        '',
      )

      await index.buildFromFilenames('content')

      // Tree traversal should return all entries under catalog
      const treeEntries = index.getEntriesInCollectionTree(unsafeAsLogicalPath('content/catalog'))
      expect(treeEntries).toHaveLength(3)
      const ids = treeEntries.map((e) => e.id).sort()
      expect(ids).toEqual([catalogEntryId, partnerAId, partnerBId].sort())
    })

    it('returns only direct entries when no subcollections exist', async () => {
      await fs.mkdir(path.join(tempDir, 'content/posts'), { recursive: true })

      const postId = 'p1s2t3a4b5c6'
      await fs.writeFile(path.join(tempDir, `content/posts/post.hello.${postId}.json`), '{}')

      await index.buildFromFilenames('content')

      const entries = index.getEntriesInCollectionTree(unsafeAsLogicalPath('content/posts'))
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe(postId)
    })

    it('returns empty array for non-existent collection', async () => {
      await index.buildFromFilenames('content')

      const entries = index.getEntriesInCollectionTree(unsafeAsLogicalPath('content/nonexistent'))
      expect(entries).toEqual([])
    })

    it('does not return entries from sibling collections', async () => {
      await fs.mkdir(path.join(tempDir, 'content/catalog/partner-a'), { recursive: true })
      await fs.mkdir(path.join(tempDir, 'content/blog'), { recursive: true })

      const partnerId = 'p1r2t3n4a5b6'
      const blogId = 'b1L2g3e4n5t6'

      await fs.writeFile(
        path.join(tempDir, `content/catalog/partner-a/partner.index.${partnerId}.yaml`),
        '',
      )
      await fs.writeFile(path.join(tempDir, `content/blog/post.hello.${blogId}.json`), '{}')

      await index.buildFromFilenames('content')

      const catalogEntries = index.getEntriesInCollectionTree(
        unsafeAsLogicalPath('content/catalog'),
      )
      expect(catalogEntries).toHaveLength(1)
      expect(catalogEntries[0].id).toBe(partnerId)
    })
  })

  describe('getAllEntryLocations', () => {
    it('returns all entries across all collections', async () => {
      await fs.mkdir(path.join(tempDir, 'content/posts'), { recursive: true })
      await fs.mkdir(path.join(tempDir, 'content/authors'), { recursive: true })

      const postId = 'p1s2t3a4b5c6'
      const authorId = 'a1u2t3h4r5s6'
      const rootId = 'r1t2e3n4t5y6'

      await fs.writeFile(path.join(tempDir, `content/posts/post.hello.${postId}.json`), '{}')
      await fs.writeFile(path.join(tempDir, `content/authors/author.alice.${authorId}.json`), '{}')
      await fs.writeFile(path.join(tempDir, `content/home.${rootId}.json`), '{}')

      await index.buildFromFilenames('content')

      const allEntries = index.getAllEntryLocations()
      expect(allEntries).toHaveLength(3)
      const ids = allEntries.map((e) => e.id).sort()
      expect(ids).toEqual([postId, authorId, rootId].sort())
    })

    it('excludes collection directories', async () => {
      const collectionId = 'c1L2L3e4c5t6'
      await fs.mkdir(path.join(tempDir, `content/posts.${collectionId}`), { recursive: true })

      const entryId = 'e1n2t3r4y5a6'
      await fs.writeFile(
        path.join(tempDir, `content/posts.${collectionId}/post.hello.${entryId}.json`),
        '{}',
      )

      await index.buildFromFilenames('content')

      const allEntries = index.getAllEntryLocations()
      expect(allEntries).toHaveLength(1)
      expect(allEntries[0].type).toBe('entry')
      expect(allEntries[0].id).toBe(entryId)
    })

    it('returns empty array when no entries exist', async () => {
      await index.buildFromFilenames('content')

      const allEntries = index.getAllEntryLocations()
      expect(allEntries).toEqual([])
    })
  })
})

describe('extractIdFromFilename', () => {
  it('extracts ID from files', () => {
    expect(extractIdFromFilename('slug.a1b2c3d4e5f6.json')).toBe('a1b2c3d4e5f6')
    expect(extractIdFromFilename('my-post.x7y8z9abB1c2.mdx')).toBe('x7y8z9abB1c2')
  })

  it('extracts ID from directories', () => {
    expect(extractIdFromFilename('posts.a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6')
  })

  it('returns null for files without IDs', () => {
    expect(extractIdFromFilename('legacy.json')).toBeNull()
    expect(extractIdFromFilename('no-id.mdx')).toBeNull()
  })

  it('returns null for metadata files', () => {
    expect(extractIdFromFilename('.collection.json')).toBeNull()
    expect(extractIdFromFilename('.gitignore')).toBeNull()
  })

  it('returns null for invalid IDs', () => {
    expect(extractIdFromFilename('slug.tooshort.json')).toBeNull()
    expect(extractIdFromFilename('slug.wayyyyyyyyyyyytoooooolong.json')).toBeNull()
    expect(extractIdFromFilename('slug.has0invalid.json')).toBeNull() // Contains 0
  })
})

describe('extractSlugFromFilename', () => {
  it('extracts slug from files', () => {
    expect(extractSlugFromFilename('my-post.a1b2c3d4e5f6.json')).toBe('my-post')
    expect(extractSlugFromFilename('hello-world.x7y8z9abB1c2.mdx')).toBe('hello-world')
  })

  it('extracts slug from directories', () => {
    expect(extractSlugFromFilename('posts.a1b2c3d4e5f6')).toBe('posts')
  })

  it('extracts slug from files without IDs', () => {
    expect(extractSlugFromFilename('legacy.json')).toBe('legacy')
  })

  it('extracts slug with dots correctly', () => {
    // Collection entries (4+ parts): type.slug.{id}.ext → extracts slug (strips type)
    // type.my.page.{id}.json has 5 parts, should extract "my.page" (strips first part "type")
    expect(extractSlugFromFilename('page.my.page.a1b2c3d4e5f6.json')).toBe('my.page')
    expect(extractSlugFromFilename('doc.api.v2.x7y8z9abB1c2.mdx')).toBe('api.v2')
    expect(extractSlugFromFilename('item.foo.bar.baz.p1s2t3a4b5c6.json')).toBe('foo.bar.baz')
  })

  it('extracts slug from 3-part filenames (name.id.ext)', () => {
    // 3-part files: name.{id}.ext → the name portion before the ID
    expect(extractSlugFromFilename('home.a1b2c3d4e5f6.json')).toBe('home')
  })

  it('normalizes mixed-case slugs to lowercase', () => {
    expect(extractSlugFromFilename('Hello-World.a1b2c3d4e5f6.json')).toBe('hello-world')
    expect(extractSlugFromFilename('doc.Onboarding-Checklist.a1b2c3d4e5f6.mdx')).toBe(
      'onboarding-checklist',
    )
    // Directories
    expect(extractSlugFromFilename('Posts.a1b2c3d4e5f6')).toBe('posts')
    // Files without IDs
    expect(extractSlugFromFilename('README.json')).toBe('readme')
  })
})
