import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import type { ContentId } from './paths/types'

import { sortByOrder, parseTypedFilename, listEntries } from './content-listing'
import { flattenSchema } from './config/flatten'
import { generateId } from './id'
import type { EntryTypeConfig, RootCollectionConfig } from './config'

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
    format: 'md' | 'mdx' | 'json',
    data: Record<string, unknown>,
    body?: string,
  ): Promise<string> {
    const id = generateId()
    const ext = format === 'json' ? '.json' : `.${format}`
    const filename = `${entryType}.${slug}.${id}${ext}`
    const filePath = path.join(collectionDir, filename)

    if (format === 'json') {
      await fs.writeFile(filePath, JSON.stringify(data))
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
})
