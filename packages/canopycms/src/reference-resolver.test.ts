import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CanopyConfig } from './config'
import { flattenSchema } from './config'
import { ContentIdIndex } from './content-id-index'
import { ContentStore } from './content-store'
import { ReferenceResolver } from './reference-resolver'
import { unsafeAsLogicalPath } from './paths/test-utils'

describe('ReferenceResolver', () => {
  let tempDir: string
  let store: ContentStore
  let idIndex: ContentIdIndex
  let resolver: ReferenceResolver

  beforeEach(async () => {
    // Create temp directory with content structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
    await fs.mkdir(path.join(tempDir, 'content', 'authors'), {
      recursive: true,
    })

    // Create test author files with embedded IDs: {type}.{slug}.{id}.{ext}
    const aliceId = 'aXice123ABC4' // 12 chars, valid Base58
    const bobId = 'bob456XYZ789' // 12 chars, valid Base58

    await fs.writeFile(
      path.join(tempDir, 'content', 'authors', `author.alice.${aliceId}.json`),
      JSON.stringify({ slug: 'alice', name: 'Alice' }),
    )
    await fs.writeFile(
      path.join(tempDir, 'content', 'authors', `author.bob.${bobId}.json`),
      JSON.stringify({ slug: 'bob', name: 'Bob' }),
    )

    // Initialize store and index
    const schema = {
      collections: [
        {
          name: 'authors',
          path: 'authors',
          entries: [
            {
              name: 'author',
              format: 'json' as const,
              schema: [{ name: 'name', type: 'string' as const, label: 'Name' }],
            },
          ],
        },
      ],
    } as const

    const config: CanopyConfig = {
      contentRoot: 'content',
      gitBotAuthorName: 'Test Bot',
      gitBotAuthorEmail: 'test@example.com',
      mode: 'prod',
      deployedAs: 'server',
    }

    store = new ContentStore(tempDir, flattenSchema(schema, config.contentRoot))
    idIndex = await store.idIndex()
    resolver = new ReferenceResolver(store, idIndex)
  })

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('loadReferenceOptions', () => {
    it('loads options when collection path does not include content/ prefix', async () => {
      // REGRESSION TEST: ID index stores "content/authors" but schema specifies "authors"
      // This ensures the collection path normalization works correctly
      const options = await resolver.loadReferenceOptions([unsafeAsLogicalPath('authors')], 'name')

      expect(options).toHaveLength(2)
      const labels = options.map((o) => o.label).sort()
      expect(labels).toEqual(['Alice', 'Bob'])
      expect(options.every((o) => o.id && o.collection)).toBe(true)
    })

    it('loads options when collection path includes content/ prefix', async () => {
      // REGRESSION TEST: Should also work if "content/authors" is explicitly specified
      const options = await resolver.loadReferenceOptions(
        [unsafeAsLogicalPath('content/authors')],
        'name',
      )

      expect(options).toHaveLength(2)
      const labels = options.map((o) => o.label).sort()
      expect(labels).toEqual(['Alice', 'Bob'])
    })

    it('returns empty array for non-existent collection', async () => {
      const options = await resolver.loadReferenceOptions(
        [unsafeAsLogicalPath('nonexistent')],
        'name',
      )

      expect(options).toHaveLength(0)
    })
  })
})

describe('ReferenceResolver with entryTypes and subcollections', () => {
  let tempDir: string
  let store: ContentStore
  let idIndex: ContentIdIndex
  let resolver: ReferenceResolver

  beforeEach(async () => {
    // Create temp directory with nested content structure simulating the data-catalog pattern
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
    await fs.mkdir(path.join(tempDir, 'content', 'data-catalog', 'partner-a'), { recursive: true })
    await fs.mkdir(path.join(tempDir, 'content', 'data-catalog', 'partner-b'), { recursive: true })

    const partnerAId = 'p1r2t3n4a5b6'
    const partnerBId = 'p1r2t3n4b5c7'
    const docAId = 'd1c2a3e4n5t6'

    await fs.writeFile(
      path.join(
        tempDir,
        'content',
        'data-catalog',
        'partner-a',
        `partner.index.${partnerAId}.json`,
      ),
      JSON.stringify({ title: 'Partner A', description: 'First partner' }),
    )
    await fs.writeFile(
      path.join(
        tempDir,
        'content',
        'data-catalog',
        'partner-b',
        `partner.index.${partnerBId}.json`,
      ),
      JSON.stringify({ title: 'Partner B', description: 'Second partner' }),
    )
    await fs.writeFile(
      path.join(
        tempDir,
        'content',
        'data-catalog',
        'partner-a',
        `doc.getting-started.${docAId}.json`,
      ),
      JSON.stringify({ title: 'Getting Started' }),
    )

    const schema = {
      collections: [
        {
          name: 'data-catalog',
          path: 'data-catalog',
          collections: [
            {
              name: 'partner-a',
              path: 'data-catalog/partner-a',
              entries: [
                {
                  name: 'partner',
                  format: 'json' as const,
                  schema: [
                    { name: 'title', type: 'string' as const, label: 'Title' },
                    { name: 'description', type: 'string' as const, label: 'Description' },
                  ],
                },
                {
                  name: 'doc',
                  format: 'json' as const,
                  schema: [{ name: 'title', type: 'string' as const, label: 'Title' }],
                },
              ],
            },
            {
              name: 'partner-b',
              path: 'data-catalog/partner-b',
              entries: [
                {
                  name: 'partner',
                  format: 'json' as const,
                  schema: [
                    { name: 'title', type: 'string' as const, label: 'Title' },
                    { name: 'description', type: 'string' as const, label: 'Description' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as const

    const config: CanopyConfig = {
      contentRoot: 'content',
      gitBotAuthorName: 'Test Bot',
      gitBotAuthorEmail: 'test@example.com',
      mode: 'prod',
      deployedAs: 'server',
    }

    store = new ContentStore(tempDir, flattenSchema(schema, config.contentRoot))
    idIndex = await store.idIndex()
    resolver = new ReferenceResolver(store, idIndex)
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('loadReferenceOptions with entryTypes', () => {
    it('filters by entryTypes within a collection tree', async () => {
      // Should find only partner entries, not doc entries
      const options = await resolver.loadReferenceOptions(
        [unsafeAsLogicalPath('data-catalog')],
        'title',
        undefined,
        ['partner'],
      )

      expect(options).toHaveLength(2)
      const labels = options.map((o) => o.label).sort()
      expect(labels).toEqual(['Partner A', 'Partner B'])
    })

    it('returns all entries in tree when no entryTypes filter', async () => {
      const options = await resolver.loadReferenceOptions(
        [unsafeAsLogicalPath('data-catalog')],
        'title',
      )

      // Should return all 3 entries (2 partners + 1 doc)
      expect(options).toHaveLength(3)
    })

    it('filters by entryTypes without collections (searches all)', async () => {
      const options = await resolver.loadReferenceOptions(undefined, 'title', undefined, [
        'partner',
      ])

      expect(options).toHaveLength(2)
      const labels = options.map((o) => o.label).sort()
      expect(labels).toEqual(['Partner A', 'Partner B'])
    })

    it('filters by entryTypes with search', async () => {
      const options = await resolver.loadReferenceOptions(undefined, 'title', 'Partner A', [
        'partner',
      ])

      expect(options).toHaveLength(1)
      expect(options[0].label).toBe('Partner A')
    })

    it('returns empty when entryTypes matches nothing', async () => {
      const options = await resolver.loadReferenceOptions(
        [unsafeAsLogicalPath('data-catalog')],
        'title',
        undefined,
        ['nonexistent-type'],
      )

      expect(options).toHaveLength(0)
    })
  })

  describe('loadReferenceOptions with subcollection traversal', () => {
    it('finds entries in subcollections when parent collection specified', async () => {
      // This was the core bug: loadReferenceOptions didn't traverse subcollections
      const options = await resolver.loadReferenceOptions(
        [unsafeAsLogicalPath('data-catalog')],
        'title',
      )

      // Should find all entries across subcollections
      expect(options).toHaveLength(3)
    })
  })
})
