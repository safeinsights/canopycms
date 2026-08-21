import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { buildContentTree, defaultBuildPath, type ContentTreeNode } from './content-tree'
import type { CanopyBuildContext } from './context'
import { flattenSchema } from './config/flatten'
import { generateId } from './id'
import type { RootCollectionConfig } from './config'
import type { ContentId } from './paths/types'
import type { LogicalPath } from './paths/types'

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
  format: 'md' | 'mdx' | 'json' | 'yaml',
  data: Record<string, unknown>,
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

  it('normalizes mixed-case entry slugs to lowercase in tree output', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: postsDir } = await createCollection(contentDir, 'posts')
    await createEntry(postsDir, 'post', 'Hello-World', 'md', { title: 'Hello World' })
    await createEntry(postsDir, 'post', 'Getting-Started', 'md', { title: 'Getting Started' })

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

    expect(tree[0].children).toHaveLength(2)
    // Slugs should be lowercase despite mixed-case filenames
    const slugs = tree[0].children!.map((c: ContentTreeNode) => c.entry?.slug).sort()
    expect(slugs).toEqual(['getting-started', 'hello-world'])
    // Logical paths should also use lowercase slugs
    const paths = tree[0].children!.map((c: ContentTreeNode) => c.logicalPath).sort()
    expect(paths[0]).toBe('content/posts/getting-started')
    expect(paths[1]).toBe('content/posts/hello-world')
  })

  it('default buildPath collapses index entries to parent collection path', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    await createEntry(docsDir, 'doc', 'index', 'md', { title: 'Docs Landing' })
    await createEntry(docsDir, 'doc', 'getting-started', 'md', { title: 'Getting Started' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [{ name: 'doc', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const tree = await buildContentTree(tempDir, flat, 'content')

    const docsNode = tree[0]
    expect(docsNode.path).toBe('/docs')
    expect(docsNode.kind).toBe('collection')

    const indexEntry = docsNode.children!.find((n: ContentTreeNode) => n.entry?.slug === 'index')
    const regularEntry = docsNode.children!.find(
      (n: ContentTreeNode) => n.entry?.slug === 'getting-started',
    )

    // Index entry path collapses to the collection path
    expect(indexEntry?.path).toBe('/docs')
    // Regular entry path is unchanged
    expect(regularEntry?.path).toBe('/docs/getting-started')
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

  it('extract receives meta.indexEntry for a collection with an index entry', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: marsDir } = await createCollection(contentDir, 'mars')
    await createEntry(marsDir, 'partner', 'index', 'yaml', {
      name: 'Mars University',
      isFictional: true,
      tagline: 'Education on the red planet',
    })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'mars',
          path: 'mars',
          entries: [{ name: 'partner', format: 'yaml', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const collectionMetas: Array<{
      logicalPath: string
      indexEntry: { entryType: string; format: string; data: Record<string, unknown> } | undefined
    }> = []
    await buildContentTree(tempDir, flat, 'content', {
      extract: (_data, meta) => {
        if (meta.kind === 'collection') {
          collectionMetas.push({
            logicalPath: meta.logicalPath,
            indexEntry: meta.indexEntry,
          })
        }
        return {}
      },
    })

    const marsMeta = collectionMetas.find((m) => m.logicalPath === 'content/mars')
    expect(marsMeta).toBeDefined()
    expect(marsMeta?.indexEntry?.entryType).toBe('partner')
    expect(marsMeta?.indexEntry?.format).toBe('yaml')
    expect(marsMeta?.indexEntry?.data.name).toBe('Mars University')
    expect(marsMeta?.indexEntry?.data.isFictional).toBe(true)
  })

  it('extract receives meta.indexEntry === undefined for a collection without an index entry', async () => {
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

    const collectionMetas: Array<{
      logicalPath: string
      indexEntry: { entryType: string; format: string; data: Record<string, unknown> } | undefined
    }> = []
    await buildContentTree(tempDir, flat, 'content', {
      extract: (_data, meta) => {
        if (meta.kind === 'collection') {
          collectionMetas.push({
            logicalPath: meta.logicalPath,
            indexEntry: meta.indexEntry,
          })
        }
        return {}
      },
    })

    const postsMeta = collectionMetas.find((m) => m.logicalPath === 'content/posts')
    expect(postsMeta).toBeDefined()
    expect(postsMeta?.indexEntry).toBeUndefined()
  })

  it('adopters can narrow on meta.indexEntry.entryType to read type-specific fields', async () => {
    // Two sibling collections: one has a 'partner' index with isFictional, the other has a
    // 'doc' index without isFictional. The extract callback narrows on entryType.
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: marsDir } = await createCollection(contentDir, 'mars')
    await createEntry(marsDir, 'partner', 'index', 'yaml', {
      name: 'Mars University',
      isFictional: true,
    })

    const { dir: guideDir } = await createCollection(contentDir, 'guide')
    await createEntry(guideDir, 'doc', 'index', 'md', { title: 'Guide Overview' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'mars',
          path: 'mars',
          entries: [{ name: 'partner', format: 'yaml', schema: [] }],
        },
        {
          name: 'guide',
          path: 'guide',
          entries: [{ name: 'doc', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    interface NavFields {
      isFictional: boolean
    }

    const tree = await buildContentTree<NavFields>(tempDir, flat, 'content', {
      extract: (data, meta) => {
        if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
          return { isFictional: Boolean(meta.indexEntry.data.isFictional) }
        }
        if (meta.kind === 'collection') {
          return { isFictional: false }
        }
        return { isFictional: false }
      },
    })

    const marsNode = tree.find((n) => n.collection?.name === 'mars')
    const guideNode = tree.find((n) => n.collection?.name === 'guide')
    expect(marsNode?.fields?.isFictional).toBe(true)
    expect(guideNode?.fields?.isFictional).toBe(false)
  })

  it('extract is invoked exactly once per collection node', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: marsDir } = await createCollection(contentDir, 'mars')
    await createEntry(marsDir, 'partner', 'index', 'yaml', { name: 'Mars' })
    await createEntry(marsDir, 'partner', 'about', 'yaml', { name: 'About' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'mars',
          path: 'mars',
          entries: [{ name: 'partner', format: 'yaml', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const calls: string[] = []
    await buildContentTree(tempDir, flat, 'content', {
      extract: (_data, meta) => {
        if (meta.kind === 'collection') calls.push(`collection:${meta.logicalPath}`)
        return {}
      },
    })

    // One call for the mars collection (root collection isn't returned as a node)
    expect(calls.filter((c) => c === 'collection:content/mars')).toHaveLength(1)
  })

  it('filter sees node.fields derived from index entry data', async () => {
    // A draft flag on the index entry should be visible to filter via fields.
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: marsDir } = await createCollection(contentDir, 'mars')
    await createEntry(marsDir, 'partner', 'index', 'yaml', { name: 'Mars', draft: true })

    const { dir: openstaxDir } = await createCollection(contentDir, 'openstax')
    await createEntry(openstaxDir, 'partner', 'index', 'yaml', { name: 'OpenStax', draft: false })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'mars',
          path: 'mars',
          entries: [{ name: 'partner', format: 'yaml', schema: [] }],
        },
        {
          name: 'openstax',
          path: 'openstax',
          entries: [{ name: 'partner', format: 'yaml', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    interface NavFields {
      draft: boolean
    }

    const tree = await buildContentTree<NavFields>(tempDir, flat, 'content', {
      extract: (_data, meta) => {
        if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
          return { draft: Boolean(meta.indexEntry.data.draft) }
        }
        return { draft: false }
      },
      filter: (node) => {
        if (node.kind === 'collection' && node.fields?.draft) return false
        return true
      },
    })

    const names = tree.map((n) => n.collection?.name).filter(Boolean)
    expect(names).toEqual(['openstax'])
  })

  it('maxDepth cap suppresses meta.indexEntry exposure on capped collections', async () => {
    // When traversal halts at maxDepth, entries aren't loaded, so meta.indexEntry is undefined.
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: marsDir } = await createCollection(contentDir, 'mars')
    await createEntry(marsDir, 'partner', 'index', 'yaml', { name: 'Mars' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'mars',
          path: 'mars',
          entries: [{ name: 'partner', format: 'yaml', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const collectionMetas: Array<{
      logicalPath: string
      indexEntry: { entryType: string; format: string; data: Record<string, unknown> } | undefined
    }> = []
    await buildContentTree(tempDir, flat, 'content', {
      maxDepth: 1,
      extract: (_data, meta) => {
        if (meta.kind === 'collection') {
          collectionMetas.push({
            logicalPath: meta.logicalPath,
            indexEntry: meta.indexEntry,
          })
        }
        return {}
      },
    })

    const marsMeta = collectionMetas.find((m) => m.logicalPath === 'content/mars')
    expect(marsMeta).toBeDefined()
    expect(marsMeta?.indexEntry).toBeUndefined()
  })

  it('index entry still appears as a child of the collection', async () => {
    // Backwards compatibility: surfacing indexEntry on meta does NOT remove it from children[].
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: marsDir } = await createCollection(contentDir, 'mars')
    await createEntry(marsDir, 'partner', 'index', 'yaml', { name: 'Mars' })
    await createEntry(marsDir, 'partner', 'about', 'yaml', { name: 'About' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'mars',
          path: 'mars',
          entries: [{ name: 'partner', format: 'yaml', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const tree = await buildContentTree(tempDir, flat, 'content')

    const marsNode = tree[0]
    const indexChild = marsNode.children?.find(
      (c) => c.kind === 'entry' && c.entry?.slug === 'index',
    )
    expect(indexChild).toBeDefined()
  })

  it('TEntryTypes generic narrows meta.indexEntry.data via entryType discriminant', async () => {
    // Compile-time + runtime check: when the adopter supplies an EntryTypeMap, TS narrows
    // meta.indexEntry.data to the registered shape after meta.indexEntry.entryType === '...'.
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: marsDir } = await createCollection(contentDir, 'mars')
    await createEntry(marsDir, 'partner', 'index', 'yaml', {
      name: 'Mars University',
      isFictional: true,
    })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'mars',
          path: 'mars',
          entries: [{ name: 'partner', format: 'yaml', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    // `TEntryTypes` is unconstrained, so plain interfaces (no `extends Record<...>`,
    // no index signatures) satisfy it. `EntryTypeMap` is an optional convenience
    // alias adopters can target, not a bound on the generic.
    interface MyEntries {
      partner: { name: string; isFictional?: boolean; tagline?: string }
      doc: { title: string }
    }
    interface NavFields {
      partnerName: string | null
    }

    const tree = await buildContentTree<NavFields, MyEntries>(tempDir, flat, 'content', {
      extract: (_data, meta) => {
        if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
          // After the narrow, TS sees meta.indexEntry.data as MyEntries['partner'].
          // Both .name and .isFictional are typed (no `unknown`) — refactor-safe.
          const partner: MyEntries['partner'] = meta.indexEntry.data
          return { partnerName: partner.name }
        }
        return { partnerName: null }
      },
    })

    const marsNode = tree.find((n) => n.collection?.name === 'mars')
    expect(marsNode?.fields?.partnerName).toBe('Mars University')
  })

  it('does not store indexEntry on the public collection node', async () => {
    // Guards against accidentally regrowing the node payload in a future refactor.
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: marsDir } = await createCollection(contentDir, 'mars')
    await createEntry(marsDir, 'partner', 'index', 'yaml', { name: 'Mars' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'mars',
          path: 'mars',
          entries: [{ name: 'partner', format: 'yaml', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const tree = await buildContentTree(tempDir, flat, 'content')

    const marsNode = tree[0]
    expect(marsNode.kind).toBe('collection')
    // Assert the full own-key set rather than just the absence of `indexEntry`:
    // catches any future refactor that grows the node payload, not only the one
    // specific key we currently care about.
    expect(Object.keys(marsNode).sort()).toEqual(
      ['path', 'logicalPath', 'kind', 'contentId', 'collection', 'children'].sort(),
    )
  })

  it('filter rejecting a collection short-circuits descendant traversal', async () => {
    // Locks in the perf optimization: when filter rejects a collection, its
    // child collections should never have extract called on them (we never
    // recurse into them, never read their entries). A reorder that recursed
    // before filter would silently regress this — the tree output would still
    // be correct, but every descendant would have been visited.
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)

    const { dir: parentDir } = await createCollection(contentDir, 'parent')
    await createEntry(parentDir, 'page', 'index', 'yaml', { draft: true })
    const { dir: childDir } = await createCollection(parentDir, 'child')
    await createEntry(childDir, 'page', 'visible', 'md', { title: 'Visible' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'parent',
          path: 'parent',
          entries: [{ name: 'page', format: 'yaml', schema: [] }],
          collections: [
            {
              name: 'child',
              path: 'parent/child',
              entries: [{ name: 'page', format: 'md', schema: [] }],
            },
          ],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')

    const visited: string[] = []
    await buildContentTree(tempDir, flat, 'content', {
      extract: (_data, meta) => {
        visited.push(`${meta.kind}:${meta.logicalPath}`)
        if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'page') {
          return { draft: Boolean(meta.indexEntry.data.draft) }
        }
        return { draft: false }
      },
      filter: (node) => {
        if (node.kind === 'collection' && (node.fields as { draft?: boolean })?.draft) return false
        return true
      },
    })

    expect(visited).toContain('collection:content/parent')
    // The child collection must NOT have been visited — parent's filter rejected it.
    expect(visited).not.toContain('collection:content/parent/child')
    expect(visited).not.toContain('entry:content/parent/child/visible')
  })

  it('CanopyBuildContext.buildContentTree accepts plain interfaces for TEntryTypes (compile-time check)', () => {
    // This test exists purely to exercise the context-path generic constraint at
    // typecheck time. The runtime body never executes the call — but `tsc` must
    // accept it. A prior version of context.ts re-imposed `extends EntryTypeMap`,
    // which rejected plain interfaces with TS2344; this test would have failed
    // typecheck under that regression.
    interface PartnerContent {
      name: string
      isFictional?: boolean
    }
    interface DocContent {
      title: string
    }
    interface MyEntries {
      partner: PartnerContent
      doc: DocContent
    }
    const _typecheckOnly = (ctx: CanopyBuildContext) =>
      ctx.buildContentTree<{ partnerName: string }, MyEntries>({
        extract: (_data, meta) => {
          if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
            // meta.indexEntry.data must narrow to PartnerContent here
            return { partnerName: meta.indexEntry.data.name }
          }
          return { partnerName: '' }
        },
      })
    void _typecheckOnly
    expect(true).toBe(true)
  })

  // -------------------------------------------------------------------------
  // resolveReferences (adopter request #16)
  // -------------------------------------------------------------------------

  describe('resolveReferences', () => {
    /**
     * A `snippets` collection with one shared entry, and a `docs` collection whose `doc`
     * type references it. `docs` gets an `index` entry too, so the same run covers the
     * `meta.indexEntry` handed to a collection's `extract` as well as the entry nodes.
     */
    async function createReferencingTree() {
      const contentDir = path.join(tempDir, 'content')
      await fs.mkdir(contentDir)

      const { dir: snippetsDir } = await createCollection(contentDir, 'snippets')
      const snippetId = await createEntry(snippetsDir, 'ctaSnippet', 'signup', 'json', {
        title: 'Sign up today',
      })

      const { dir: docsDir } = await createCollection(contentDir, 'docs')
      await createEntry(docsDir, 'doc', 'index', 'json', { title: 'Docs', snippet: snippetId })
      await createEntry(docsDir, 'doc', 'guide', 'json', { title: 'Guide', snippet: snippetId })

      const schema: RootCollectionConfig = {
        collections: [
          {
            name: 'snippets',
            path: 'snippets',
            entries: [
              {
                name: 'ctaSnippet',
                format: 'json',
                schema: [{ name: 'title', type: 'string' }],
              },
            ],
          },
          {
            name: 'docs',
            path: 'docs',
            entries: [
              {
                name: 'doc',
                format: 'json',
                schema: [
                  { name: 'title', type: 'string' },
                  { name: 'snippet', type: 'reference', entryTypes: ['ctaSnippet'] },
                ],
              },
            ],
          },
        ],
      }

      return { snippetId, flat: flattenSchema(schema, 'content') }
    }

    it('leaves references as bare ids by default', async () => {
      const { snippetId, flat } = await createReferencingTree()

      const tree = await buildContentTree<{ snippet: unknown }>(tempDir, flat, 'content', {
        extract: (data) => ({ snippet: data.snippet }),
      })

      const docs = tree.find((n) => n.logicalPath === 'content/docs')!
      const guide = docs.children!.find((n) => n.logicalPath === 'content/docs/guide')!
      expect(guide.fields!.snippet).toBe(snippetId)
    })

    it('resolves references in both entry nodes and meta.indexEntry when opted in', async () => {
      const { flat } = await createReferencingTree()

      let indexEntrySnippet: unknown
      const tree = await buildContentTree<{ snippet: unknown }>(tempDir, flat, 'content', {
        resolveReferences: true,
        extract: (data, meta) => {
          if (meta.kind === 'collection' && meta.logicalPath === 'content/docs') {
            const indexData = meta.indexEntry?.data as Record<string, unknown> | undefined
            indexEntrySnippet = indexData?.snippet
          }
          return { snippet: data.snippet }
        },
      })

      const docs = tree.find((n) => n.logicalPath === 'content/docs')!
      const guide = docs.children!.find((n) => n.logicalPath === 'content/docs/guide')!
      expect(guide.fields!.snippet).toMatchObject({ slug: 'signup', title: 'Sign up today' })
      // The index entry reaches `extract` through a different path than the entry nodes;
      // resolving at the shared listVisibleEntries choke point is what covers both.
      expect(indexEntrySnippet).toMatchObject({ slug: 'signup', title: 'Sign up today' })
    })
  })
})

// ---------------------------------------------------------------------------
// defaultBuildPath (exported for adopters extending, not replacing, the default)
// ---------------------------------------------------------------------------

describe('defaultBuildPath', () => {
  it('strips the content root prefix', () => {
    expect(defaultBuildPath('content/docs/guides' as LogicalPath, 'content', 'entry')).toBe(
      '/docs/guides',
    )
  })

  it('collapses an entry index slug to its parent collection path', () => {
    expect(defaultBuildPath('content/guides/index' as LogicalPath, 'content', 'entry')).toBe(
      '/guides',
    )
  })

  it('does not collapse a collection literally named index', () => {
    expect(defaultBuildPath('content/index' as LogicalPath, 'content', 'collection')).toBe('/index')
  })

  it('collapses the root index entry to "/"', () => {
    expect(defaultBuildPath('content/index' as LogicalPath, 'content', 'entry')).toBe('/')
  })

  it('lowercases the result unconditionally', () => {
    expect(defaultBuildPath('content/API-Reference' as LogicalPath, 'content', 'entry')).toBe(
      '/api-reference',
    )
  })

  it('matches buildContentTree default output for the same inputs', async () => {
    const contentDir = path.join(tempDir, 'content')
    await fs.mkdir(contentDir)
    const { dir: docsDir } = await createCollection(contentDir, 'docs')
    await createEntry(docsDir, 'doc', 'index', 'md', { title: 'Docs Landing' })

    const schema: RootCollectionConfig = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [{ name: 'doc', format: 'md', schema: [] }],
        },
      ],
    }
    const flat = flattenSchema(schema, 'content')
    const tree = await buildContentTree(tempDir, flat, 'content')

    const docsNode = tree[0]
    expect(docsNode.path).toBe(
      defaultBuildPath('content/docs' as LogicalPath, 'content', 'collection'),
    )
  })
})
