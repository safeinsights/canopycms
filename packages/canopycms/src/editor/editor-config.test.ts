import { describe, expect, it } from 'vitest'

import { flattenSchema } from '../config'
import { buildEditorCollections, buildPreviewBaseByCollection } from './editor-config'

const baseConfig = {
  contentRoot: 'content',
  schema: {
    collections: [
      {
        name: 'posts',
        label: 'Posts',
        path: 'posts',
        entries: [
          {
            name: 'entry',
            format: 'json' as const,
            fields: [],
          },
        ],
      },
      {
        name: 'nested',
        path: 'nested',
        entries: [
          {
            name: 'entry',
            format: 'md' as const,
            fields: [],
          },
        ],
        collections: [
          {
            name: 'child',
            path: 'child',
            entries: [
              {
                name: 'entry',
                format: 'md' as const,
                fields: [],
              },
            ],
          },
        ],
      },
    ],
  },
}

describe('editor-config helpers', () => {
  it('builds editor collections from schema/config', () => {
    const collections = buildEditorCollections(
      flattenSchema(baseConfig.schema, baseConfig.contentRoot),
    )

    // With schema refactor, content root is now a visible collection
    expect(collections).toHaveLength(1)
    expect(collections[0].path).toBe('content')
    expect(collections[0].children).toHaveLength(2)
    expect(collections[0].children!.map((c) => c.path).sort()).toEqual([
      'content/nested',
      'content/posts',
    ])

    // Verify nested collection structure
    const nested = collections[0].children!.find((c) => c.path === 'content/nested')
    expect(nested?.type).toBe('collection')
    expect(nested?.children?.[0]?.path).toBe('content/nested/child')

    // Verify posts collection
    const posts = collections[0].children!.find((c) => c.path === 'content/posts')
    expect(posts?.type).toBe('collection')
    expect(posts?.format).toBe('json')
  })

  it('derives preview bases from content root and schema paths', () => {
    const previewBase = buildPreviewBaseByCollection(
      baseConfig,
      flattenSchema(baseConfig.schema, baseConfig.contentRoot),
    )
    expect(previewBase['content/posts']).toBe('/posts')
    expect(previewBase['content/nested']).toBe('/nested')
    expect(previewBase['content/nested/child']).toBe('/nested/child')
  })

  it('trims content root slashes when building preview bases', () => {
    const config = {
      ...baseConfig,
      contentRoot: '/site/content/',
    }
    const previewBase = buildPreviewBaseByCollection(
      config,
      flattenSchema(config.schema, config.contentRoot),
    )
    expect(previewBase['site/content/posts']).toBe('/posts')
  })

  it('includes nested collections under parent collections', () => {
    const config = {
      contentRoot: 'content',
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: [
              {
                name: 'entry',
                format: 'mdx' as const,
                fields: [],
              },
            ],
            collections: [
              {
                name: 'api',
                path: 'api',
                entries: [
                  {
                    name: 'doc',
                    format: 'md' as const,
                    fields: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    }

    const collections = buildEditorCollections(flattenSchema(config.schema, config.contentRoot))

    // Content root is the top-level collection
    expect(collections).toHaveLength(1)
    expect(collections[0].path).toBe('content')
    expect(collections[0].children).toHaveLength(1)

    // Docs is a child of content
    const docs = collections[0].children![0]
    expect(docs.path).toBe('content/docs')
    expect(docs.type).toBe('collection')
    expect(docs.children).toHaveLength(1)

    // API is nested under docs
    const api = docs.children?.[0]
    expect(api?.path).toBe('content/docs/api')
    expect(api?.name).toBe('api')
    expect(api?.type).toBe('collection')
    expect(api?.format).toBe('md')
  })

  it.skip('includes root-level entry types with maxItems: 1 as navigable entries', () => {
    const config = {
      contentRoot: 'content',
      schema: {
        entries: [
          {
            name: 'home',
            label: 'Home',
            format: 'json' as const,
            fields: [],
            maxItems: 1,
          },
          {
            name: 'settings',
            label: 'Settings',
            format: 'json' as const,
            fields: [],
            maxItems: 1,
          },
        ],
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [
              {
                name: 'post',
                format: 'mdx' as const,
                fields: [],
              },
            ],
          },
        ],
      },
    }

    const collections = buildEditorCollections(flattenSchema(config.schema, config.contentRoot))

    // Content root is the top-level collection
    expect(collections).toHaveLength(1)
    expect(collections[0].path).toBe('content')

    // Children should have 3 items: 2 root-level entries + 1 collection
    const children = collections[0].children!
    expect(children).toHaveLength(3)

    // Root-level entries with maxItems: 1 should appear as type 'entry'
    const home = children.find((c) => c.path === 'content/home')
    expect(home).toBeDefined()
    expect(home?.type).toBe('entry')
    expect(home?.label).toBe('Home')
    expect(home?.format).toBe('json')

    const settings = children.find((c) => c.path === 'content/settings')
    expect(settings).toBeDefined()
    expect(settings?.type).toBe('entry')
    expect(settings?.label).toBe('Settings')

    // Collection should also be present as a child
    const posts = children.find((c) => c.path === 'content/posts')
    expect(posts).toBeDefined()
    expect(posts?.type).toBe('collection')
  })

  it('excludes root-level entry types without maxItems: 1', () => {
    const config = {
      contentRoot: 'content',
      schema: {
        entries: [
          {
            name: 'page',
            label: 'Page',
            format: 'json' as const,
            fields: [],
            // No maxItems - should not be navigable
          },
        ],
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [
              {
                name: 'post',
                format: 'mdx' as const,
                fields: [],
              },
            ],
          },
        ],
      },
    }

    const collections = buildEditorCollections(flattenSchema(config.schema, config.contentRoot))

    // The content root collection should be present with posts as a child
    // Entry types without maxItems: 1 are not navigable
    expect(collections).toHaveLength(1)
    expect(collections[0].path).toBe('content')
    expect(collections[0].children).toHaveLength(1)
    expect(collections[0].children![0].path).toBe('content/posts')
  })

  it('excludes collection entry types from navigation', () => {
    const config = {
      contentRoot: 'content',
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [
              {
                name: 'post',
                format: 'mdx' as const,
                fields: [],
              },
              {
                name: 'doc',
                format: 'md' as const,
                fields: [],
              },
            ],
          },
        ],
      },
    }

    const collections = buildEditorCollections(flattenSchema(config.schema, config.contentRoot))

    // The content root collection should be present with posts as a child
    expect(collections).toHaveLength(1)
    expect(collections[0].path).toBe('content')
    expect(collections[0].type).toBe('collection')
    expect(collections[0].children).toHaveLength(1)

    // The posts collection should be present, not its entry types
    const posts = collections[0].children![0]
    expect(posts.path).toBe('content/posts')
    expect(posts.type).toBe('collection')
    // Entry types within a collection are not children in the navigation
    expect(posts.children).toHaveLength(0)
  })
})
