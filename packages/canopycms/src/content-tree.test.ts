import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { buildContentTree, type ContentTreeNode } from './content-tree'
import { flattenSchema } from './config/flatten'
import { generateId } from './id'
import type { RootCollectionConfig } from './config'
import type { ContentId } from './paths/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-tree-test-'))
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
    await fs.writeFile(filePath, `---\n${frontmatter}\n---\nBody content`)
  }
  return id
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildContentTree', () => {
  it('builds a basic tree from a single collection with entries', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'hello-world', 'md', { title: 'Hello World' })
    await createEntry(postsDir, 'post', 'second-post', 'md', { title: 'Second Post' })

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

    const tree = await buildContentTree(tempDir, flat, 'content')

    expect(tree).toHaveLength(1)
    expect(tree[0].kind).toBe('collection')
    expect(tree[0].collection?.name).toBe('posts')
    expect(tree[0].children).toHaveLength(2)
    // Alphabetical order by default
    expect(tree[0].children![0].entry?.slug).toBe('hello-world')
    expect(tree[0].children![1].entry?.slug).toBe('second-post')
  })

  it('entries have path computed by stripping content root', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'my-post', 'md', { title: 'My Post' })

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

    const tree = await buildContentTree(tempDir, flat, 'content')

    expect(tree[0].path).toBe('/posts')
    expect(tree[0].children![0].path).toBe('/posts/my-post')
    expect(tree[0].children![0].kind).toBe('entry')
  })

  it('reads entry data from frontmatter', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    await createEntry(docsDir, 'doc', 'getting-started', 'mdx', {
      title: 'Getting Started',
      navTitle: 'Start Here',
      navOrder: 1,
      draft: false,
    })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [{ name: 'doc', format: 'mdx', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const tree = await buildContentTree(tempDir, flat, 'content')
    const entry = tree[0].children![0]

    expect(entry.entry?.data.title).toBe('Getting Started')
    expect(entry.entry?.data.navTitle).toBe('Start Here')
  })

  it('extract callback populates typed fields', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })

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

    interface NavFields {
      label: string
    }

    const tree = await buildContentTree<NavFields>(tempDir, flat, 'content', {
      extract: (data, node) => ({
        label:
          node.kind === 'collection'
            ? ((data.label as string) ?? (data.name as string))
            : ((data.title as string) ?? ''),
      }),
    })

    expect(tree[0].fields?.label).toBe('posts')
    expect(tree[0].children![0].fields?.label).toBe('Hello')
  })

  it('filter excludes nodes', async () => {
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

    const tree = await buildContentTree(tempDir, flat, 'content', {
      filter: (node) => {
        if (node.kind === 'entry' && node.entry?.data.draft === true) return false
        return true
      },
    })

    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children![0].entry?.slug).toBe('published')
  })

  it('prunes empty collections after filtering', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'only-draft', 'md', { title: 'Draft', draft: true })

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

    const tree = await buildContentTree(tempDir, flat, 'content', {
      filter: (node) => {
        if (node.kind === 'entry' && node.entry?.data.draft === true) return false
        return true
      },
    })

    // Collection should be pruned because it has no entries after filtering
    expect(tree).toHaveLength(0)
  })

  it('orders by collection order array, interleaving entries and subcollections', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    // Create parent collection with entries and a subcollection
    const entryId1 = generateId()
    const entryId2 = generateId()
    const subCollectionId = generateId()

    // Create parent 'docs' collection
    const { dir: docsDir } = await createCollection(contentDir, 'docs', {
      // Order: subcollection first, then entry2, then entry1
      order: [subCollectionId, entryId2, entryId1],
    })

    // Create entries in docs
    const ext1 = `doc.alpha.${entryId1}.mdx`
    await fs.writeFile(path.join(docsDir, ext1), '---\ntitle: Alpha\n---\nBody')

    const ext2 = `doc.beta.${entryId2}.mdx`
    await fs.writeFile(path.join(docsDir, ext2), '---\ntitle: Beta\n---\nBody')

    // Create subcollection
    const subDir = path.join(docsDir, `guides.${subCollectionId}`)
    await fs.mkdir(subDir)
    await fs.writeFile(
      path.join(subDir, '.collection.json'),
      JSON.stringify({ name: 'guides', label: 'Guides' }),
    )

    // Create an entry in the subcollection so it doesn't get pruned
    const guideEntryId = generateId()
    await fs.writeFile(
      path.join(subDir, `guide.intro.${guideEntryId}.mdx`),
      '---\ntitle: Intro\n---\nBody',
    )

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          order: [subCollectionId, entryId2, entryId1],
          entries: [{ name: 'doc', format: 'mdx', schema: [] }],
          collections: [
            {
              name: 'guides',
              path: 'docs/guides',
              contentId: subCollectionId as ContentId,
              entries: [{ name: 'guide', format: 'mdx', schema: [] }],
            },
          ],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const tree = await buildContentTree(tempDir, flat, 'content')

    expect(tree).toHaveLength(1)
    const docsNode = tree[0]
    expect(docsNode.children).toHaveLength(3)

    // Order should be: guides (subcollection), beta (entry), alpha (entry)
    expect(docsNode.children![0].kind).toBe('collection')
    expect(docsNode.children![0].collection?.name).toBe('guides')
    expect(docsNode.children![1].entry?.slug).toBe('beta')
    expect(docsNode.children![2].entry?.slug).toBe('alpha')
  })

  it('custom buildPath overrides default URL generation', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })

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

    const tree = await buildContentTree(tempDir, flat, 'content', {
      buildPath: (lp) => `/custom/${lp}`,
    })

    expect(tree[0].path).toBe('/custom/content/posts')
    expect(tree[0].children![0].path).toBe('/custom/content/posts/hello')
  })

  it('maxDepth limits traversal', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    const { dir: guidesDir } = await createCollection(docsDir, 'guides')
    await createEntry(guidesDir, 'guide', 'intro', 'md', { title: 'Intro' })
    await createEntry(docsDir, 'doc', 'overview', 'md', { title: 'Overview' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [{ name: 'doc', format: 'md', schema: [] }],
          collections: [
            {
              name: 'guides',
              path: 'docs/guides',
              entries: [{ name: 'guide', format: 'md', schema: [] }],
            },
          ],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const tree = await buildContentTree(tempDir, flat, 'content', { maxDepth: 1 })

    // docs collection should be present but without children (depth 1 = only top-level collections)
    expect(tree).toHaveLength(1)
    expect(tree[0].collection?.name).toBe('docs')
    expect(tree[0].children).toBeUndefined()
  })

  it('nested collections build correct hierarchy', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    const { dir: apiDir } = await createCollection(docsDir, 'api')
    await createEntry(apiDir, 'doc', 'auth', 'md', { title: 'Auth API' })
    await createEntry(docsDir, 'doc', 'intro', 'md', { title: 'Intro' })

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

    const tree = await buildContentTree(tempDir, flat, 'content')

    expect(tree).toHaveLength(1)
    const docs = tree[0]
    expect(docs.collection?.name).toBe('docs')
    expect(docs.children).toHaveLength(2) // api collection + intro entry

    const apiNode = docs.children!.find((n): n is ContentTreeNode => n.kind === 'collection')
    expect(apiNode?.collection?.name).toBe('api')
    expect(apiNode?.children).toHaveLength(1)
    expect(apiNode?.children![0].entry?.slug).toBe('auth')
    expect(apiNode?.children![0].path).toBe('/docs/api/auth')
  })

  it('rootPath scopes the tree to a subtree', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(docsDir, 'doc', 'intro', 'md', { title: 'Intro' })
    await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [{ name: 'doc', format: 'md', schema: [] }],
        },
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const tree = await buildContentTree(tempDir, flat, 'content', {
      rootPath: 'content/docs',
    })

    // Should only have entries from docs, not posts
    // rootPath starts from that collection's children
    expect(tree).toHaveLength(1)
    expect(tree[0].entry?.slug).toBe('intro')
  })

  it('JSON entries have full data', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: productsDir } = await createCollection(contentDir, 'products')
    await createEntry(productsDir, 'product', 'widget', 'json', {
      name: 'Widget',
      price: 9.99,
      tags: ['gadget', 'sale'],
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

    const tree = await buildContentTree(tempDir, flat, 'content')

    const entry = tree[0].children![0]
    expect(entry.entry?.data.name).toBe('Widget')
    expect(entry.entry?.data.price).toBe(9.99)
    expect(entry.entry?.data.tags).toEqual(['gadget', 'sale'])
  })

  it('returns empty array when root collection does not exist on disk', async () => {
    // No content directory created on disk
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

    const tree = await buildContentTree(tempDir, flat, 'content')

    expect(tree).toHaveLength(0)
  })

  it('custom sort overrides default ordering', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'alpha', 'md', { title: 'Alpha', navOrder: 3 })
    await createEntry(postsDir, 'post', 'beta', 'md', { title: 'Beta', navOrder: 1 })
    await createEntry(postsDir, 'post', 'gamma', 'md', { title: 'Gamma', navOrder: 2 })

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

    interface NavFields {
      navOrder: number
    }

    const tree = await buildContentTree<NavFields>(tempDir, flat, 'content', {
      extract: (data) => ({
        navOrder: typeof data.navOrder === 'number' ? data.navOrder : 999,
      }),
      sort: (a, b) => (a.fields?.navOrder ?? 999) - (b.fields?.navOrder ?? 999),
    })

    const slugs = tree[0].children!.map((n) => n.entry?.slug)
    expect(slugs).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('collection nodes have collection metadata from schema', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'hello', 'md', { title: 'Hello' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          label: 'Blog Posts',
          entries: [{ name: 'post', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const tree = await buildContentTree(tempDir, flat, 'content')

    expect(tree[0].collection?.name).toBe('posts')
    expect(tree[0].collection?.label).toBe('Blog Posts')
  })
})
