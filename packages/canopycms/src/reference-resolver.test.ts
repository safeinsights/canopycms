import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CanopyConfig } from './config'
import { flattenSchema } from './config'
import { ContentIdIndex } from './content-id-index'
import { ContentStore } from './content-store'
import { ReferenceResolver } from './reference-resolver'
import { unsafeAsContentId, unsafeAsLogicalPath } from './paths/test-utils'

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

    it('skips store.read() entirely for a path the canAccess predicate denies', async () => {
      // Regression test: loadReferenceOptions used to read() every candidate to
      // get its label, and only the API route filtered by access afterward --
      // meaning a denied path still triggered a file read for content the
      // caller would never see. The canAccess predicate must be consulted
      // BEFORE any read, so a denied candidate never reaches store.read() at all.
      const readSpy = vi.spyOn(store, 'read')

      const options = await resolver.loadReferenceOptions(
        [unsafeAsLogicalPath('authors')],
        'name',
        undefined,
        undefined,
        (logicalPath) => logicalPath !== 'content/authors/bob',
      )

      // Only the allowed candidate (alice) comes back...
      expect(options).toHaveLength(1)
      expect(options[0].label).toBe('Alice')
      // ...and bob's path was never read.
      expect(readSpy).toHaveBeenCalledTimes(1)
      expect(readSpy).toHaveBeenCalledWith(expect.anything(), 'alice', {
        resolveReferences: false,
        allowUnavailableEntryType: true,
      })
    })

    it('reads every candidate when no canAccess predicate is given (back-compat)', async () => {
      const readSpy = vi.spyOn(store, 'read')

      const options = await resolver.loadReferenceOptions([unsafeAsLogicalPath('authors')], 'name')

      expect(options).toHaveLength(2)
      expect(readSpy).toHaveBeenCalledTimes(2)
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

describe('ReferenceResolver options: noindex marker and sort', () => {
  let tempDir: string
  let resolver: ReferenceResolver

  const postSchema = [
    { name: 'title', type: 'string' as const },
    { name: 'publishedAt', type: 'string' as const },
    {
      name: 'meta',
      type: 'object' as const,
      fields: [{ name: 'publishedAt', type: 'string' as const }],
    },
    {
      name: 'visibility',
      type: 'group' as const,
      fields: [{ name: 'noindex', type: 'boolean' as const, label: 'Keep off search' }],
    },
  ]
  const pageSchema = [
    { name: 'title', type: 'string' as const },
    {
      name: 'seo',
      type: 'object' as const,
      fields: [{ name: 'noindex', type: 'boolean' as const, label: 'Hide this page' }],
    },
  ]

  // Root order puts posts (and so its subcollection) before pages; posts' own order puts
  // Bravo before Alpha, and the rest follow by label.
  const schema = {
    order: ['cPostsAAAAA1', 'cPagesAAAAA1'],
    collections: [
      {
        name: 'pages',
        path: 'pages',
        contentId: unsafeAsContentId('cPagesAAAAA1'),
        entries: [{ name: 'page', format: 'json' as const, schema: pageSchema }],
      },
      {
        name: 'posts',
        path: 'posts',
        contentId: unsafeAsContentId('cPostsAAAAA1'),
        order: ['pAAAAAAAAAA2', 'pAAAAAAAAAA1'],
        entries: [{ name: 'post', format: 'json' as const, schema: postSchema }],
        collections: [
          {
            name: 'news',
            path: 'posts/news',
            contentId: unsafeAsContentId('cNewsAAAAAA1'),
            entries: [{ name: 'post', format: 'json' as const, schema: postSchema }],
          },
        ],
      },
    ],
  }

  const entries: Array<[string, string, string, Record<string, unknown>]> = [
    [
      'posts',
      'post',
      'pAAAAAAAAAA1',
      { title: 'Alpha', publishedAt: '2026-03-04', meta: { publishedAt: '2026-01-01' } },
    ],
    [
      'posts',
      'post',
      'pAAAAAAAAAA2',
      {
        title: 'Bravo',
        publishedAt: '2026-05-01',
        meta: { publishedAt: '2026-02-01' },
        noindex: true,
      },
    ],
    ['posts', 'post', 'pAAAAAAAAAA3', { title: 'Charlie', meta: {} }],
    [
      'posts',
      'post',
      'pAAAAAAAAAA4',
      { title: 'Delta', publishedAt: '', meta: { publishedAt: '2025-12-01' } },
    ],
    ['posts/news', 'post', 'nAAAAAAAAAA1', { title: 'Echo', publishedAt: '2026-04-01' }],
    ['pages', 'page', 'gAAAAAAAAAA1', { title: 'Foxtrot', seo: { noindex: true } }],
    ['pages', 'page', 'gAAAAAAAAAA2', { title: 'Golf', seo: { noindex: false } }],
  ]

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
    for (const [dir, type, id, data] of entries) {
      const slug = String(data.title).toLowerCase()
      await fs.mkdir(path.join(tempDir, 'content', dir), { recursive: true })
      await fs.writeFile(
        path.join(tempDir, 'content', dir, `${type}.${slug}.${id}.json`),
        JSON.stringify(data),
      )
    }
    const store = new ContentStore(tempDir, flattenSchema(schema, 'content'))
    resolver = new ReferenceResolver(store, await store.idIndex())
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  const load = (
    settings: Parameters<ReferenceResolver['loadReferenceOptions']>[5],
    opts: { entryTypes?: string[]; collections?: string[]; search?: string } = {},
  ) =>
    resolver.loadReferenceOptions(
      opts.collections?.map(unsafeAsLogicalPath),
      'title',
      opts.search,
      opts.entryTypes ?? (opts.collections ? undefined : ['post', 'page']),
      undefined,
      settings,
    )
  const labels = (options: Array<{ label: string }>) => options.map((o) => o.label)

  describe('noindex', () => {
    it('marks a flat noindex target with its field label, looking through inline groups', async () => {
      const options = await load({})
      const bravo = options.find((o) => o.label === 'Bravo')
      expect(bravo?.noindex).toEqual({ fieldLabel: 'Keep off search' })
      expect(options.filter((o) => o.noindex).map((o) => o.label)).toEqual(['Bravo'])
    })

    it('reads the flag and its label inside config.seo.group', async () => {
      const options = await load({ seo: { group: 'seo' } })
      expect(options.filter((o) => o.noindex)).toEqual([
        expect.objectContaining({ label: 'Foxtrot', noindex: { fieldLabel: 'Hide this page' } }),
      ])
    })

    it('falls back to the field name when the schema has no such field', async () => {
      await fs.writeFile(
        path.join(tempDir, 'content', 'posts', 'post.hotel.pAAAAAAAAAA5.json'),
        JSON.stringify({ title: 'Hotel', hidden: true }),
      )
      const store = new ContentStore(tempDir, flattenSchema(schema, 'content'))
      resolver = new ReferenceResolver(store, await store.idIndex())
      const options = await load({ seo: { fields: { noindex: 'hidden' } } })
      expect(options.filter((o) => o.noindex)).toEqual([
        expect.objectContaining({ label: 'Hotel', noindex: { fieldLabel: 'hidden' } }),
      ])
    })
  })

  describe('sort', () => {
    it('sorts by label by default', async () => {
      expect(labels(await load({}))).toEqual([
        'Alpha',
        'Bravo',
        'Charlie',
        'Delta',
        'Echo',
        'Foxtrot',
        'Golf',
      ])
    })

    it('groups by collection in tree order, each in its own order, across collections', async () => {
      expect(labels(await load({ sort: 'collection' }))).toEqual([
        'Bravo',
        'Alpha',
        'Charlie',
        'Delta',
        'Echo',
        'Foxtrot',
        'Golf',
      ])
    })

    it('groups a collection scope with its subcollection after it', async () => {
      const options = await load({ sort: 'collection' }, { collections: ['posts'] })
      expect(labels(options)).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta', 'Echo'])
    })

    it('sorts by a field ascending, entries with no value last by label', async () => {
      const options = await load({ sort: { field: 'publishedAt' } }, { entryTypes: ['post'] })
      expect(labels(options)).toEqual(['Alpha', 'Echo', 'Bravo', 'Charlie', 'Delta'])
    })

    it('sorts by a field descending, entries with no value first by label', async () => {
      const options = await load(
        { sort: { field: 'publishedAt', direction: 'desc' } },
        { entryTypes: ['post'] },
      )
      expect(labels(options)).toEqual(['Charlie', 'Delta', 'Bravo', 'Echo', 'Alpha'])
    })

    it('sorts by a dotted path into a grouped field', async () => {
      const options = await load({ sort: { field: 'meta.publishedAt' } }, { entryTypes: ['post'] })
      expect(labels(options)).toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie', 'Echo'])
    })

    it('sorts unquoted md frontmatter dates, which parse as Date objects', async () => {
      const dir = path.join(tempDir, 'content', 'notes')
      await fs.mkdir(dir, { recursive: true })
      const note = (slug: string, id: string, date: string) =>
        fs.writeFile(
          path.join(dir, `note.${slug}.${id}.md`),
          `---\ntitle: ${slug}\npublishedAt: ${date}\n---\nBody.\n`,
        )
      await note('one', 'mAAAAAAAAAA1', '2026-01-01')
      await note('two', 'mAAAAAAAAAA2', '2026-03-01')
      await note('three', 'mAAAAAAAAAA3', '2026-02-01')
      const notesSchema = {
        collections: [
          {
            name: 'notes',
            path: 'notes',
            entries: [
              {
                name: 'note',
                format: 'md' as const,
                schema: [
                  { name: 'title', type: 'string' as const },
                  { name: 'publishedAt', type: 'string' as const },
                ],
              },
            ],
          },
        ],
      }
      const store = new ContentStore(tempDir, flattenSchema(notesSchema, 'content'))
      const notes = new ReferenceResolver(store, await store.idIndex())
      const options = await notes.loadReferenceOptions(
        [unsafeAsLogicalPath('notes')],
        'title',
        undefined,
        undefined,
        undefined,
        { sort: { field: 'publishedAt', direction: 'desc' } },
      )
      // Label order would be one, three, two.
      expect(labels(options)).toEqual(['two', 'three', 'one'])
    })

    it('sorts numbers numerically, and numbers before strings in one consistent order', async () => {
      const dir = path.join(tempDir, 'content', 'posts')
      const rank = (slug: string, id: string, value: unknown) =>
        fs.writeFile(
          path.join(dir, `post.${slug}.${id}.json`),
          JSON.stringify({ title: slug, rank: value }),
        )
      await rank('nine', 'rAAAAAAAAAA1', 9)
      await rank('ten', 'rAAAAAAAAAA2', 10)
      await rank('five', 'rAAAAAAAAAA3', '5')
      const store = new ContentStore(tempDir, flattenSchema(schema, 'content'))
      resolver = new ReferenceResolver(store, await store.idIndex())
      const options = await load({ sort: { field: 'rank' } }, { entryTypes: ['post'] })
      expect(labels(options).slice(0, 3)).toEqual(['nine', 'ten', 'five'])
    })

    it('sorts what the search leaves', async () => {
      const options = await load(
        { sort: { field: 'publishedAt', direction: 'desc' } },
        { entryTypes: ['post'], search: 'ha' },
      )
      expect(labels(options)).toEqual(['Charlie', 'Alpha'])
    })
  })
})
