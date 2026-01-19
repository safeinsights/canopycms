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
    expect(collections).toHaveLength(2) // 2 collections
    expect(collections.map((c) => c.id).sort()).toEqual(['content/nested', 'content/posts'])

    // Verify collection structure
    const nested = collections.find((c) => c.id === 'content/nested')
    expect(nested?.type).toBe('collection')
    expect(nested?.children?.[0]?.id).toBe('content/nested/child')

    // Verify posts collection
    const posts = collections.find((c) => c.id === 'content/posts')
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
    expect(collections).toHaveLength(1)

    const docs = collections[0]
    expect(docs.id).toBe('content/docs')
    expect(docs.type).toBe('collection')
    expect(docs.children).toHaveLength(1)

    const api = docs.children?.[0]
    expect(api?.id).toBe('content/docs/api')
    expect(api?.name).toBe('api')
    expect(api?.type).toBe('collection')
    expect(api?.format).toBe('md')
  })

  it('includes root-level entry types with maxItems: 1 as navigable entries', () => {
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

    // Should have 3 items: 2 root-level entries + 1 collection
    expect(collections).toHaveLength(3)

    // Root-level entries with maxItems: 1 should appear first and be type 'entry'
    const home = collections.find((c) => c.id === 'content/home')
    expect(home).toBeDefined()
    expect(home?.type).toBe('entry')
    expect(home?.label).toBe('Home')
    expect(home?.format).toBe('json')

    const settings = collections.find((c) => c.id === 'content/settings')
    expect(settings).toBeDefined()
    expect(settings?.type).toBe('entry')
    expect(settings?.label).toBe('Settings')

    // Collection should also be present
    const posts = collections.find((c) => c.id === 'content/posts')
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

    // Only the collection should be present, not the entry type without maxItems: 1
    expect(collections).toHaveLength(1)
    expect(collections[0].id).toBe('content/posts')
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

    // Only the collection, not its entry types
    expect(collections).toHaveLength(1)
    expect(collections[0].id).toBe('content/posts')
    expect(collections[0].type).toBe('collection')
    // Entry types within a collection are not children in the navigation
    expect(collections[0].children).toHaveLength(0)
  })
})
