import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import type { ContentId } from './paths/types'

import { sortByOrder, parseTypedFilename, listEntries } from './content-listing'
import { ContentIdIndex } from './content-id-index'
import { ContentStore } from './content-store'
import { flattenSchema } from './config/flatten'
import { generateId } from './id'
import type { EntryTypeConfig, FieldConfig, RootCollectionConfig } from './config'

// ---------------------------------------------------------------------------
// sortByOrder
// ---------------------------------------------------------------------------

describe('sortByOrder', () => {
  type Item = { contentId?: ContentId; name: string }
  const fallback = (item: Item) => item.name

  const item = (name: string, id?: string): Item => ({
    name,
    contentId: id as ContentId | undefined,
  })

  it('sorts alphabetically by fallback key when order is undefined', () => {
    const items = [item('cherry'), item('apple'), item('banana')]
    const result = sortByOrder(items, undefined, fallback)
    expect(result.map((i) => i.name)).toEqual(['apple', 'banana', 'cherry'])
  })

  it('sorts alphabetically by fallback key when order is empty', () => {
    const items = [item('cherry'), item('apple'), item('banana')]
    const result = sortByOrder(items, [], fallback)
    expect(result.map((i) => i.name)).toEqual(['apple', 'banana', 'cherry'])
  })

  it('sorts items by order array position', () => {
    const items = [item('c', 'id3'), item('a', 'id1'), item('b', 'id2')]
    const result = sortByOrder(items, ['id2', 'id1', 'id3'], fallback)
    expect(result.map((i) => i.name)).toEqual(['b', 'a', 'c'])
  })

  it('puts ordered items before unordered items', () => {
    const items = [
      item('unordered-b', 'id-x'),
      item('ordered', 'id-1'),
      item('unordered-a', 'id-y'),
    ]
    const result = sortByOrder(items, ['id-1'], fallback)
    expect(result.map((i) => i.name)).toEqual(['ordered', 'unordered-a', 'unordered-b'])
  })

  it('sorts unordered items alphabetically by fallback key', () => {
    const items = [
      item('delta', 'id-d'),
      item('alpha', 'id-a'),
      item('gamma', 'id-g'),
      item('beta', 'id-b'),
    ]
    // Only beta is in the order array
    const result = sortByOrder(items, ['id-b'], fallback)
    expect(result.map((i) => i.name)).toEqual(['beta', 'alpha', 'delta', 'gamma'])
  })

  it('handles items without contentId as unordered', () => {
    const items = [item('no-id'), item('has-id', 'id-1'), item('also-no-id')]
    const result = sortByOrder(items, ['id-1'], fallback)
    expect(result[0].name).toBe('has-id')
    // Remaining sorted alphabetically
    expect(result.slice(1).map((i) => i.name)).toEqual(['also-no-id', 'no-id'])
  })

  it('handles order array referencing nonexistent IDs gracefully', () => {
    const items = [item('b', 'id-b'), item('a', 'id-a')]
    // 'id-missing' doesn't match any item — should be ignored
    const result = sortByOrder(items, ['id-missing', 'id-a', 'id-b'], fallback)
    expect(result.map((i) => i.name)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// parseTypedFilename
// ---------------------------------------------------------------------------

describe('parseTypedFilename', () => {
  const entryTypes: EntryTypeConfig[] = [
    { name: 'post', format: 'md', schema: [] },
    { name: 'doc', format: 'mdx', schema: [] },
    { name: 'page', format: 'json', schema: [] },
  ]

  it('parses a valid typed filename', () => {
    const result = parseTypedFilename('post.hello-world.vh2WdhwAFiSL.md', entryTypes)
    expect(result).toEqual({
      type: 'post',
      slug: 'hello-world',
      id: 'vh2WdhwAFiSL',
    })
  })

  it('handles slugs with dots', () => {
    const result = parseTypedFilename('doc.getting.started.guide.aB3cD4eF5gH6.mdx', entryTypes)
    expect(result).toEqual({
      type: 'doc',
      slug: 'getting.started.guide',
      id: 'aB3cD4eF5gH6',
    })
  })

  it('returns null for unknown entry type', () => {
    const result = parseTypedFilename('unknown.slug.vh2WdhwAFiSL.md', entryTypes)
    expect(result).toBeNull()
  })

  it('returns null for too few parts', () => {
    const result = parseTypedFilename('post.md', entryTypes)
    expect(result).toBeNull()
  })

  it('returns null for no extension', () => {
    const result = parseTypedFilename('post.slug.vh2WdhwAFiSL', entryTypes)
    expect(result).toBeNull()
  })

  it('returns null for invalid content ID', () => {
    const result = parseTypedFilename('post.slug.INVALID!!!.md', entryTypes)
    expect(result).toBeNull()
  })

  it('normalizes mixed-case slug to lowercase', () => {
    const result = parseTypedFilename('doc.Onboarding-Checklist.aB3cD4eF5gH6.mdx', entryTypes)
    expect(result).toEqual({
      type: 'doc',
      slug: 'onboarding-checklist',
      id: 'aB3cD4eF5gH6',
    })
  })

  it('normalizes mixed-case dotted slug to lowercase', () => {
    const result = parseTypedFilename('doc.Getting.Started.aB3cD4eF5gH6.mdx', entryTypes)
    expect(result).toEqual({
      type: 'doc',
      slug: 'getting.started',
      id: 'aB3cD4eF5gH6',
    })
  })

  describe('without entryTypes (public adopter usage)', () => {
    it('parses any type token when entryTypes is omitted', () => {
      const result = parseTypedFilename('unknown.slug.vh2WdhwAFiSL.md')
      expect(result).toEqual({
        type: 'unknown',
        slug: 'slug',
        id: 'vh2WdhwAFiSL',
      })
    })

    it('still rejects an invalid content ID', () => {
      const result = parseTypedFilename('post.slug.INVALID!!!.md')
      expect(result).toBeNull()
    })

    it('still rejects too few parts', () => {
      const result = parseTypedFilename('post.md')
      expect(result).toBeNull()
    })

    it('matches the entryTypes-provided result for a known type', () => {
      const withTypes = parseTypedFilename('post.hello-world.vh2WdhwAFiSL.md', entryTypes)
      const withoutTypes = parseTypedFilename('post.hello-world.vh2WdhwAFiSL.md')
      expect(withoutTypes).toEqual(withTypes)
    })

    it('parses a normal filename with a real type segment', () => {
      const result = parseTypedFilename('doc.getting-started.vh2WdhwAFiSL.mdx')
      expect(result).toEqual({
        type: 'doc',
        slug: 'getting-started',
        id: 'vh2WdhwAFiSL',
      })
    })

    it('rejects a dotfile whose first segment would otherwise parse as an empty type', () => {
      // Reported by review: without a type check, this used to parse as
      // { type: '', slug: 'hidden.file', id: 'aB3cD4eF5gH6' } -- an empty
      // string is never a legal entry type.
      const result = parseTypedFilename('.hidden.file.aB3cD4eF5gH6.md')
      expect(result).toBeNull()
    })

    it('rejects a filename with multiple leading dots', () => {
      const result = parseTypedFilename('..thing.aB3cD4eF5gH6.md')
      expect(result).toBeNull()
    })
  })

  it('rejects a dotfile even when entryTypes is supplied (unchanged, byte-identical behavior)', () => {
    const result = parseTypedFilename('.hidden.file.aB3cD4eF5gH6.md', entryTypes)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listEntries
// ---------------------------------------------------------------------------

describe('listEntries', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-listing-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  /** Create a collection directory with .collection.json and embedded ID. */
  async function createCollection(
    parentDir: string,
    name: string,
    meta?: { label?: string; order?: string[] },
  ): Promise<{ dir: string; id: string }> {
    const id = generateId()
    const dirName = `${name}.${id}`
    const dir = path.join(parentDir, dirName)
    await fs.mkdir(dir, { recursive: true })
    const collectionJson: Record<string, unknown> = { name }
    if (meta?.label) collectionJson.label = meta.label
    if (meta?.order) collectionJson.order = meta.order
    await fs.writeFile(path.join(dir, '.collection.json'), JSON.stringify(collectionJson))
    return { dir, id }
  }

  /** Create an entry file: {type}.{slug}.{id}.{ext} */
  async function createEntry(
    collectionDir: string,
    entryType: string,
    slug: string,
    format: 'md' | 'mdx' | 'json' | 'yaml',
    data: Record<string, unknown>,
    body?: string,
  ): Promise<string> {
    const id = generateId()
    const ext = format === 'json' ? '.json' : `.${format}`
    const filename = `${entryType}.${slug}.${id}${ext}`
    const filePath = path.join(collectionDir, filename)

    if (format === 'json') {
      await fs.writeFile(filePath, JSON.stringify(data))
    } else if (format === 'yaml') {
      const { stringify } = await import('yaml')
      await fs.writeFile(filePath, stringify(data))
    } else {
      const frontmatter = Object.entries(data)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')
      await fs.writeFile(filePath, `---\n${frontmatter}\n---\n${body ?? 'Default body content'}`)
    }
    return id
  }

  it('lists entries across nested collections as a flat array', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
    await createEntry(postsDir, 'post', 'world', 'md', { title: 'World' })
    await createEntry(docsDir, 'doc', 'getting-started', 'mdx', { title: 'Getting Started' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
        {
          name: 'docs',
          path: 'docs',
          entries: [{ name: 'doc', format: 'mdx', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    expect(entries).toHaveLength(3)
    const slugs = entries.map((e) => e.slug).sort()
    expect(slugs).toEqual(['getting-started', 'hello', 'world'])
  })

  it('pathSegments has correct URL segments with content root stripped', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    const { dir: apiDir } = await createCollection(docsDir, 'api')
    await createEntry(apiDir, 'doc', 'auth', 'md', { title: 'Auth API' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [{ name: 'doc', format: 'md', schema: [] }],
          collections: [
            {
              name: 'api',
              path: 'docs/api',
              entries: [{ name: 'doc', format: 'md', schema: [] }],
            },
          ],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    const apiEntry = entries.find((e) => e.slug === 'auth')
    expect(apiEntry).toBeDefined()
    expect(apiEntry!.pathSegments).toEqual(['docs', 'api', 'auth'])
  })

  it('includes body in data for md/mdx entries', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(
      postsDir,
      'post',
      'hello',
      'md',
      { title: 'Hello' },
      '# Hello World\n\nSome content here.',
    )

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    expect(entries).toHaveLength(1)
    expect(entries[0].data.title).toBe('Hello')
    expect(entries[0].data.body).toBe('# Hello World\n\nSome content here.')
  })

  it('JSON entries have no body field unless it exists in the data', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: productsDir } = await createCollection(contentDir, 'products')
    await createEntry(productsDir, 'product', 'widget', 'json', {
      name: 'Widget',
      price: 9.99,
    })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'products',
          path: 'products',
          entries: [{ name: 'product', format: 'json', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    expect(entries).toHaveLength(1)
    expect(entries[0].data.name).toBe('Widget')
    expect(entries[0].data.price).toBe(9.99)
    expect(entries[0].data.body).toBeUndefined()
  })

  it('extract callback transforms data and drops body from memory', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' }, 'Long body content...')

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    interface TitleOnly {
      title: string
    }

    const entries = await listEntries<TitleOnly>(tempDir, flat, 'content', {
      extract: (raw) => ({ title: raw.title as string }),
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].data).toEqual({ title: 'Hello' })
    // Body is not in data because extract didn't include it
    expect((entries[0].data as unknown as Record<string, unknown>).body).toBeUndefined()
  })

  it('filter excludes entries using raw data', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'published', 'md', { title: 'Published', draft: false })
    await createEntry(postsDir, 'post', 'draft-post', 'md', { title: 'Draft', draft: true })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content', {
      filter: (entry) => entry.data.draft !== true,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].slug).toBe('published')
  })

  it('filter can use extracted data', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'published', 'md', { title: 'Published', draft: false })
    await createEntry(postsDir, 'post', 'draft-post', 'md', { title: 'Draft', draft: true })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    interface PostData {
      title: string
      draft: boolean
    }

    const entries = await listEntries<PostData>(tempDir, flat, 'content', {
      extract: (raw) => ({
        title: raw.title as string,
        draft: raw.draft === true,
      }),
      filter: (entry) => !entry.data.draft,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].data.title).toBe('Published')
  })

  it('empty collections return empty array', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)
    await createCollection(contentDir, 'posts')

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')
    expect(entries).toHaveLength(0)
  })

  it('rootPath scopes to subtree and returns all entries in that scope', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    const { dir: apiDir } = await createCollection(docsDir, 'api')
    await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
    await createEntry(docsDir, 'doc', 'intro', 'md', { title: 'Intro' })
    await createEntry(docsDir, 'doc', 'overview', 'md', { title: 'Overview' })
    await createEntry(apiDir, 'doc', 'auth', 'md', { title: 'Auth API' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
        {
          name: 'docs',
          path: 'docs',
          entries: [{ name: 'doc', format: 'md', schema: [] }],
          collections: [
            {
              name: 'api',
              path: 'docs/api',
              entries: [{ name: 'doc', format: 'md', schema: [] }],
            },
          ],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content', {
      rootPath: 'content/docs',
    })

    // Should include docs entries and nested api entries, but not posts
    expect(entries).toHaveLength(3)
    const slugs = entries.map((e) => e.slug).sort()
    expect(slugs).toEqual(['auth', 'intro', 'overview'])
  })

  it('sort orders the results', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'alpha', 'md', { title: 'Alpha', order: 3 })
    await createEntry(postsDir, 'post', 'beta', 'md', { title: 'Beta', order: 1 })
    await createEntry(postsDir, 'post', 'gamma', 'md', { title: 'Gamma', order: 2 })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content', {
      sort: (a, b) => (a.data.order as number) - (b.data.order as number),
    })

    expect(entries.map((e) => e.slug)).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('includes entryId and collectionId', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir, id: collectionId } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          contentId: collectionId as ContentId,
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    expect(entries).toHaveLength(1)
    expect(entries[0].entryId).toBeDefined()
    expect(entries[0].entryId).toHaveLength(12)
    expect(entries[0].collectionId).toBe(collectionId)
  })

  it('includes updatedAt sourced from the entry file mtime', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    const entryId = await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
    const filePath = path.join(postsDir, `post.hello.${entryId}.md`)
    const stats = await fs.stat(filePath)

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    expect(entries).toHaveLength(1)
    expect(entries[0].updatedAt).toBe(stats.mtime.toISOString())
  })

  it('urlPath collapses index entries to parent collection path', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    const { dir: guidesDir } = await createCollection(docsDir, 'guides')
    await createEntry(guidesDir, 'doc', 'index', 'md', { title: 'Guides Landing' })
    await createEntry(guidesDir, 'doc', 'getting-started', 'md', { title: 'Getting Started' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          collections: [
            {
              name: 'guides',
              path: 'docs/guides',
              entries: [{ name: 'doc', format: 'md', schema: [] }],
            },
          ],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    const indexEntry = entries.find((e) => e.slug === 'index')
    const regularEntry = entries.find((e) => e.slug === 'getting-started')

    expect(indexEntry).toBeDefined()
    expect(indexEntry!.urlPath).toBe('/docs/guides')
    expect(indexEntry!.pathSegments).toEqual(['docs', 'guides', 'index'])

    expect(regularEntry).toBeDefined()
    expect(regularEntry!.urlPath).toBe('/docs/guides/getting-started')
  })

  it('urlPath is collection path for a top-level index entry', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: homeDir } = await createCollection(contentDir, 'home')
    await createEntry(homeDir, 'page', 'index', 'md', { title: 'Home' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'home',
          path: 'home',
          entries: [{ name: 'page', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    expect(entries).toHaveLength(1)
    expect(entries[0].slug).toBe('index')
    // Index entry collapses to the collection path, not /home/index
    expect(entries[0].urlPath).toBe('/home')
    expect(entries[0].pathSegments).toEqual(['home', 'index'])
  })

  it('urlPath is "/" for an index entry in the content root collection', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    // Create an entry directly in the content root (the root collection has entries)
    await createEntry(contentDir, 'page', 'index', 'md', { title: 'Home' })

    const schema: RootCollectionConfig = {
      entries: [{ name: 'page', format: 'md', schema: [] }],
      collections: [],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    expect(entries).toHaveLength(1)
    expect(entries[0].slug).toBe('index')
    expect(entries[0].urlPath).toBe('/')
    expect(entries[0].pathSegments).toEqual(['index'])
  })

  it('returns empty array when content directory does not exist', async () => {
    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')
    expect(entries).toHaveLength(0)
  })

  it('populates schema with the matching entry type field definitions', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
    await createEntry(postsDir, 'page', 'about', 'md', { title: 'About' })

    const postSchema = [{ name: 'title', type: 'string' as const, required: true }]
    const pageSchema = [
      { name: 'title', type: 'string' as const },
      { name: 'slug', type: 'string' as const },
    ]

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            { name: 'post', format: 'md', schema: postSchema },
            { name: 'page', format: 'md', schema: pageSchema },
          ],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const entries = await listEntries(tempDir, flat, 'content')

    const postEntry = entries.find((e) => e.slug === 'hello')
    const pageEntry = entries.find((e) => e.slug === 'about')

    expect(postEntry?.schema).toEqual(postSchema)
    expect(pageEntry?.schema).toEqual(pageSchema)
  })

  // ---------------------------------------------------------------------------
  // Unparseable-filename files: silent outside build mode, a hard failure inside it.
  //
  // Regression: a content-extension file whose name doesn't match
  // {type}.{slug}.{id}.{ext} (e.g. a schema rename left behind a stale file, or an entry type
  // declared in one collection but not another) was silently dropped from listEntries — no
  // output at all outside CANOPYCMS_DEBUG=true — so the page vanished from a `next build` and
  // the sitemap with zero signal. See static/index.ts's assertBuildEntriesValid for the sibling
  // guard this mirrors for schema-invalid (but parseable) entries.
  // ---------------------------------------------------------------------------
  describe('unparseable-filename files', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('is silently skipped outside build mode (existing behavior preserved)', async () => {
      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: postsDir } = await createCollection(contentDir, 'posts')
      await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
      // A stray file: has a recognized content extension but not {type}.{slug}.{id}.{ext}
      // (no known entry type as its first segment).
      await fs.writeFile(path.join(postsDir, 'article.lost-page.4fBqT78gcaLd.md'), '# Lost')

      const schema: RootCollectionConfig = {
        collections: [
          { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', schema: [] }] },
        ],
      }
      const flat = flattenSchema(schema, 'content')

      const entries = await listEntries(tempDir, flat, 'content')

      expect(entries).toHaveLength(1)
      expect(entries[0].slug).toBe('hello')
    })

    it('throws in build mode (CANOPY_BUILD_MODE=true) instead of silently dropping the page', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')

      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: postsDir } = await createCollection(contentDir, 'posts')
      await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
      await fs.writeFile(path.join(postsDir, 'article.lost-page.4fBqT78gcaLd.md'), '# Lost')

      const schema: RootCollectionConfig = {
        collections: [
          { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', schema: [] }] },
        ],
      }
      const flat = flattenSchema(schema, 'content')

      await expect(listEntries(tempDir, flat, 'content')).rejects.toThrow(
        /look like malformed content entries.*article\.lost-page\.4fBqT78gcaLd\.md/s,
      )
    })

    it('does not throw in build mode when every file parses', async () => {
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')

      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: postsDir } = await createCollection(contentDir, 'posts')
      await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })

      const schema: RootCollectionConfig = {
        collections: [
          { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', schema: [] }] },
        ],
      }
      const flat = flattenSchema(schema, 'content')

      const entries = await listEntries(tempDir, flat, 'content')
      expect(entries).toHaveLength(1)
    })

    it('does not throw in build mode for a bare README.md dropped in a collection directory', async () => {
      // README.md has only 2 dot-separated segments -- it could never have parsed as
      // {type}.{slug}.{id}.{ext} (which needs 4+), so it was never entry-shaped to begin with.
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')

      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: postsDir } = await createCollection(contentDir, 'posts')
      await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
      await fs.writeFile(path.join(postsDir, 'README.md'), '# Not an entry')

      const schema: RootCollectionConfig = {
        collections: [
          { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', schema: [] }] },
        ],
      }
      const flat = flattenSchema(schema, 'content')

      const entries = await listEntries(tempDir, flat, 'content')
      expect(entries).toHaveLength(1)
      expect(entries[0].slug).toBe('hello')
    })

    it('does not throw in build mode for a colocated sibling artifact ({contentId}.suffix.ext)', async () => {
      // A sibling artifact named per the entryTransforms/readSibling convention documented in
      // the README (e.g. `${contentId}.profile.json`) has only 3 dot-separated segments -- one
      // short of the 4 a real entry needs -- so it is never mistaken for a malformed entry.
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')

      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: authorsDir } = await createCollection(contentDir, 'authors')
      const entryId = await createEntry(authorsDir, 'author', 'jane-doe', 'json', {
        name: 'Jane Doe',
      })
      await fs.writeFile(
        path.join(authorsDir, `${entryId}.profile.json`),
        JSON.stringify({ bio: 'A sibling artifact, not an entry.' }),
      )

      const schema: RootCollectionConfig = {
        collections: [
          {
            name: 'authors',
            path: 'authors',
            entries: [{ name: 'author', format: 'json', schema: [] }],
          },
        ],
      }
      const flat = flattenSchema(schema, 'content')

      const entries = await listEntries(tempDir, flat, 'content')
      expect(entries).toHaveLength(1)
      expect(entries[0].slug).toBe('jane-doe')
    })

    it('still throws in build mode for a dotfile with a 4+ segment shape (excluded regardless)', async () => {
      // Belt-and-suspenders case: a dot-prefixed name is always skipped outright, even when it
      // has enough segments to otherwise look like a malformed entry.
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')

      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: postsDir } = await createCollection(contentDir, 'posts')
      await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
      await fs.writeFile(path.join(postsDir, '.article.lost-page.4fBqT78gcaLd.md'), '# Lost')

      const schema: RootCollectionConfig = {
        collections: [
          { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', schema: [] }] },
        ],
      }
      const flat = flattenSchema(schema, 'content')

      const entries = await listEntries(tempDir, flat, 'content')
      expect(entries).toHaveLength(1)
    })

    it('throws in build mode for a 3-segment file that lost its ID segment ({type}.{slug}.{ext})', async () => {
      // The likeliest way a file loses its parse is losing its ID segment entirely -- a
      // hand-created file, a bad rename, a merge. `post.hello-world.md` has only 3
      // dot-separated segments (one short of the 4-segment cutoff the guard used to require),
      // so it used to be silently dropped exactly like README.md -- except this file's first
      // segment ("post") IS a real entry type in this collection, so it was almost certainly
      // meant to be an entry, not an unrelated file that happens to share the extension.
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')

      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: postsDir } = await createCollection(contentDir, 'posts')
      await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
      await fs.writeFile(path.join(postsDir, 'post.hello-world.md'), '# Lost my ID')

      const schema: RootCollectionConfig = {
        collections: [
          { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', schema: [] }] },
        ],
      }
      const flat = flattenSchema(schema, 'content')

      await expect(listEntries(tempDir, flat, 'content')).rejects.toThrow(
        /look like malformed content entries.*post\.hello-world\.md/s,
      )
    })

    it('does not throw in build mode for a 3-segment file whose first segment is NOT a known entry type', async () => {
      // Confirms the new 3-segment check is scoped to known entry types, not "any 3-segment
      // file" -- otherwise it would swallow the README.md / sibling-artifact cases this guard
      // must never flag.
      vi.stubEnv('CANOPY_BUILD_MODE', 'true')

      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: postsDir } = await createCollection(contentDir, 'posts')
      await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })
      await fs.writeFile(path.join(postsDir, 'unrelated.notice.md'), '# Not an entry type')

      const schema: RootCollectionConfig = {
        collections: [
          { name: 'posts', path: 'posts', entries: [{ name: 'post', format: 'md', schema: [] }] },
        ],
      }
      const flat = flattenSchema(schema, 'content')

      const entries = await listEntries(tempDir, flat, 'content')
      expect(entries).toHaveLength(1)
      expect(entries[0].slug).toBe('hello')
    })
  })

  // -------------------------------------------------------------------------
  // resolveReferences (adopter request #16)
  // -------------------------------------------------------------------------

  describe('resolveReferences', () => {
    /**
     * A `snippets` collection holding one shared entry, plus a `posts` collection whose
     * `post` type carries `refField`. Returns the snippet's content ID so a test can write
     * it into a post's frontmatter as a reference value.
     */
    async function createSnippetAndPosts(refField: FieldConfig) {
      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: snippetsDir } = await createCollection(contentDir, 'snippets')
      const snippetId = await createEntry(snippetsDir, 'ctaSnippet', 'signup', 'json', {
        title: 'Sign up today',
        ctaText: 'Get started',
      })

      const { dir: postsDir } = await createCollection(contentDir, 'posts')

      const schema: RootCollectionConfig = {
        collections: [
          {
            name: 'snippets',
            path: 'snippets',
            entries: [
              {
                name: 'ctaSnippet',
                format: 'json',
                schema: [
                  { name: 'title', type: 'string' },
                  { name: 'ctaText', type: 'string' },
                ],
              },
            ],
          },
          {
            name: 'posts',
            path: 'posts',
            entries: [
              {
                name: 'post',
                format: 'json',
                schema: [{ name: 'title', type: 'string' }, refField],
              },
            ],
          },
        ],
      }

      return { contentDir, postsDir, snippetId, schema }
    }

    const referenceField: FieldConfig = {
      name: 'snippet',
      type: 'reference',
      entryTypes: ['ctaSnippet'],
    }

    it('leaves a reference field as its bare id string by default', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts(referenceField)
      await createEntry(postsDir, 'post', 'hello', 'json', {
        title: 'Hello',
        snippet: snippetId,
      })

      const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content')

      const post = entries.find((e) => e.slug === 'hello')!
      expect(post.data.snippet).toBe(snippetId)
    })

    it('resolves a reference field to the referenced entry data when opted in', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts(referenceField)
      await createEntry(postsDir, 'post', 'hello', 'json', {
        title: 'Hello',
        snippet: snippetId,
      })

      const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content', {
        resolveReferences: true,
      })

      const post = entries.find((e) => e.slug === 'hello')!
      expect(post.data.snippet).toMatchObject({
        id: snippetId,
        slug: 'signup',
        title: 'Sign up today',
        ctaText: 'Get started',
      })
    })

    it('resolves a reference nested inside a block template', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts({
        name: 'blocks',
        type: 'block',
        templates: [{ name: 'sharedCta', fields: [referenceField] }],
      })
      await createEntry(postsDir, 'post', 'hello', 'json', {
        title: 'Hello',
        blocks: [{ template: 'sharedCta', value: { snippet: snippetId } }],
      })

      const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content', {
        resolveReferences: true,
      })

      const blocks = entries.find((e) => e.slug === 'hello')!.data.blocks as Array<{
        value: { snippet: Record<string, unknown> }
      }>
      expect(blocks[0].value.snippet).toMatchObject({ title: 'Sign up today' })
    })

    it('resolves references nested inside object fields and inline groups', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts({
        name: 'meta',
        type: 'object',
        fields: [{ name: 'inner', type: 'group', fields: [referenceField] }],
      })
      await createEntry(postsDir, 'post', 'hello', 'json', {
        title: 'Hello',
        meta: { snippet: snippetId },
      })

      const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content', {
        resolveReferences: true,
      })

      const meta = entries.find((e) => e.slug === 'hello')!.data.meta as {
        snippet: Record<string, unknown>
      }
      expect(meta.snippet).toMatchObject({ title: 'Sign up today' })
    })

    it('resolves every element of a list: true reference array', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts({
        ...referenceField,
        list: true,
      })
      await createEntry(postsDir, 'post', 'hello', 'json', {
        title: 'Hello',
        snippet: [snippetId, snippetId],
      })

      const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content', {
        resolveReferences: true,
      })

      const refs = entries.find((e) => e.slug === 'hello')!.data.snippet as Array<
        Record<string, unknown>
      >
      expect(refs).toHaveLength(2)
      expect(refs[0]).toMatchObject({ title: 'Sign up today' })
      expect(refs[1]).toMatchObject({ title: 'Sign up today' })
    })

    it('resolves a dangling reference to null rather than throwing', async () => {
      const { postsDir, schema } = await createSnippetAndPosts(referenceField)
      await createEntry(postsDir, 'post', 'hello', 'json', {
        title: 'Hello',
        snippet: generateId(),
      })

      const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content', {
        resolveReferences: true,
      })

      expect(entries.find((e) => e.slug === 'hello')!.data.snippet).toBeNull()
    })

    it('hands resolved data to extract and filter, not the raw id', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts(referenceField)
      await createEntry(postsDir, 'post', 'hello', 'json', {
        title: 'Hello',
        snippet: snippetId,
      })

      const seenByFilter: unknown[] = []
      const entries = await listEntries<{ ctaText: unknown }>(
        tempDir,
        flattenSchema(schema, 'content'),
        'content',
        {
          resolveReferences: true,
          extract: (raw) => ({
            ctaText: (raw.snippet as Record<string, unknown> | null)?.ctaText,
          }),
          filter: (item) => {
            seenByFilter.push(item.data.ctaText)
            return true
          },
        },
      )

      // The snippets collection has no reference field of its own, so its own entry
      // extracts to undefined; the post is the one that matters here.
      expect(entries.map((e) => e.data.ctaText)).toContain('Get started')
      expect(seenByFilter).toContain('Get started')
    })

    it('reads a shared reference once per batch, not once per referencing entry', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts(referenceField)
      for (const slug of ['a', 'b', 'c', 'd', 'e']) {
        await createEntry(postsDir, 'post', slug, 'json', { title: slug, snippet: snippetId })
      }

      const readSpy = vi.spyOn(ContentStore.prototype, 'read')
      try {
        const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content', {
          resolveReferences: true,
        })

        // All five posts resolved...
        const posts = entries.filter((e) => e.entryType === 'post')
        expect(posts).toHaveLength(5)
        for (const post of posts) {
          expect(post.data.snippet).toMatchObject({ title: 'Sign up today' })
        }
        // ...off a single read of the shared snippet. Without the per-batch cache this
        // is 5, and a real search-index build over thousands of entries scales with it.
        expect(readSpy).toHaveBeenCalledTimes(1)
      } finally {
        readSpy.mockRestore()
      }
    })

    it('never resolves references for an entry the visibility predicate denies', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts(referenceField)
      await createEntry(postsDir, 'post', 'denied', 'json', {
        title: 'Denied',
        snippet: snippetId,
      })

      const readSpy = vi.spyOn(ContentStore.prototype, 'read')
      try {
        const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content', {
          resolveReferences: true,
        })
        expect(entries.some((e) => e.slug === 'denied')).toBe(true)
        readSpy.mockClear()

        const filtered = await listEntries(
          tempDir,
          flattenSchema(schema, 'content'),
          'content',
          { resolveReferences: true },
          { shouldInclude: (physicalPath) => !physicalPath.includes('post.denied.') },
        )

        expect(filtered.some((e) => e.slug === 'denied')).toBe(false)
        // A denied entry's references cost nothing and leak nothing.
        expect(readSpy).not.toHaveBeenCalled()
      } finally {
        readSpy.mockRestore()
      }
    })

    it('scans no ContentId index and reads nothing extra when resolution is off', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts(referenceField)
      await createEntry(postsDir, 'post', 'hello', 'json', {
        title: 'Hello',
        snippet: snippetId,
      })

      const readSpy = vi.spyOn(ContentStore.prototype, 'read')
      // The index scan, not the read, is the cost that must stay off the default path:
      // `collectStaticPaths` and `build/generate-ai-content.ts` both list without ever
      // touching a reference field, and neither should pay for a full content-tree walk.
      const buildSpy = vi.spyOn(ContentIdIndex.prototype, 'buildFromFilenames')
      try {
        await listEntries(tempDir, flattenSchema(schema, 'content'), 'content')
        expect(readSpy).not.toHaveBeenCalled()
        expect(buildSpy).not.toHaveBeenCalled()
      } finally {
        readSpy.mockRestore()
        buildSpy.mockRestore()
      }
    })

    it('gives each referencing entry its own copy, so one caller cannot mutate another', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts(referenceField)
      await createEntry(postsDir, 'post', 'a', 'json', { title: 'A', snippet: snippetId })
      await createEntry(postsDir, 'post', 'b', 'json', { title: 'B', snippet: snippetId })

      const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content', {
        resolveReferences: true,
      })

      const a = entries.find((e) => e.slug === 'a')!.data.snippet as Record<string, unknown>
      const b = entries.find((e) => e.slug === 'b')!.data.snippet as Record<string, unknown>
      expect(a).not.toBe(b)

      // The batch cache must stay a pure performance optimization. Sharing one object across
      // every referencing entry would make an `extract` that trims a body for a search index
      // silently rewrite it for all its siblings -- a class of corruption the uncached path
      // cannot produce, since it reparses per occurrence.
      a.title = 'mutated via entry a'
      expect(b.title).toBe('Sign up today')
    })

    it('gives each element of a list: true array its own copy', async () => {
      const { postsDir, snippetId, schema } = await createSnippetAndPosts({
        ...referenceField,
        list: true,
      })
      await createEntry(postsDir, 'post', 'hello', 'json', {
        title: 'Hello',
        snippet: [snippetId, snippetId],
      })

      const entries = await listEntries(tempDir, flattenSchema(schema, 'content'), 'content', {
        resolveReferences: true,
      })

      const refs = entries.find((e) => e.slug === 'hello')!.data.snippet as Array<
        Record<string, unknown>
      >
      expect(refs[0]).not.toBe(refs[1])
      refs[0].title = 'mutated'
      expect(refs[1].title).toBe('Sign up today')
    })
  })
})
