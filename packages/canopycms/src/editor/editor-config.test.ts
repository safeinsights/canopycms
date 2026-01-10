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
        entries: {
          format: 'json' as const,
          fields: [],
        },
      },
      {
        name: 'nested',
        path: 'nested',
        entries: {
          format: 'md' as const,
          fields: [],
        },
        collections: [
          {
            name: 'child',
            path: 'child',
            entries: {
              format: 'md' as const,
              fields: [],
            },
          },
        ],
      },
    ],
    singletons: [
      {
        name: 'home',
        path: 'home',
        format: 'json' as const,
        fields: [],
      },
    ],
  },
}

describe('editor-config helpers', () => {
  it('builds editor collections from schema/config including singletons', () => {
    const collections = buildEditorCollections(flattenSchema(baseConfig.schema, baseConfig.contentRoot))
    expect(collections).toHaveLength(3)  // 2 collections + 1 singleton
    expect(collections.map((c) => c.id).sort()).toEqual(['content/home', 'content/nested', 'content/posts'])

    // Verify collection structure
    const nested = collections.find((c) => c.id === 'content/nested')
    expect(nested?.type).toBe('collection')
    expect(nested?.children?.[0]?.id).toBe('content/nested/child')

    // Verify singleton structure
    const home = collections.find((c) => c.id === 'content/home')
    expect(home?.type).toBe('entry')
    expect(home?.format).toBe('json')
    expect(home?.children).toEqual([])
  })

  it('derives preview bases from content root and schema paths', () => {
    const previewBase = buildPreviewBaseByCollection(baseConfig, flattenSchema(baseConfig.schema, baseConfig.contentRoot))
    expect(previewBase['content/posts']).toBe('/posts')
    expect(previewBase['content/home']).toBe('/')  // Singleton gets root
    expect(previewBase['content/nested/child']).toBe('/nested/child')
  })

  it('trims content root slashes when building preview bases', () => {
    const config = {
      ...baseConfig,
      contentRoot: '/site/content/',
    }
    const previewBase = buildPreviewBaseByCollection(config, flattenSchema(config.schema, config.contentRoot))
    expect(previewBase['site/content/posts']).toBe('/posts')
  })

  it('includes nested singletons under collections', () => {
    const config = {
      contentRoot: 'content',
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: {
              format: 'mdx' as const,
              fields: [],
            },
            singletons: [
              {
                name: 'overview',
                path: 'overview',
                format: 'md' as const,
                fields: [],
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

    const overview = docs.children?.[0]
    expect(overview?.id).toBe('content/docs/overview')
    expect(overview?.name).toBe('overview')
    expect(overview?.type).toBe('entry')
    expect(overview?.format).toBe('md')
    expect(overview?.children).toEqual([])
  })
})
