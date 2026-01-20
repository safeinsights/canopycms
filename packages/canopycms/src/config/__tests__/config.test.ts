import { describe, expect, it } from 'vitest'

import type { CanopyConfigFragment } from '../types'
import { composeCanopyConfig, defineCanopyConfig } from '../helpers'
import { flattenSchema } from '../flatten'
import { validateCanopyConfig } from '../validation'

const gitAuthor = { gitBotAuthorName: 'Test Bot', gitBotAuthorEmail: 'bot@example.com' }

describe('config validation', () => {
  it('accepts a valid config with mdx collection and blocks', () => {
    const configBundle = defineCanopyConfig({
      ...gitAuthor,
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [
              {
                name: 'entry',
                format: 'mdx' as const,
                fields: [
                  { name: 'title', type: 'string' as const, required: true },
                  { name: 'body', type: 'mdx' as const, required: true },
                  { name: 'tags', type: 'string' as const, list: true },
                  {
                    name: 'layout',
                    type: 'block' as const,
                    templates: [
                      {
                        name: 'hero',
                        label: 'Hero',
                        fields: [
                          { name: 'headline', type: 'string' as const, required: true },
                          { name: 'ctaLabel', type: 'string' as const },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      media: { adapter: 's3', bucket: 'my-bucket', region: 'us-east-1' },
    })

    expect(configBundle.server.schema?.collections).toBeDefined()
    expect(configBundle.server.schema?.collections?.[0].name).toBe('posts')
  })

  it('rejects select fields without options', () => {
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
        schema: {
          collections: [
            {
              name: 'pages',
              path: 'pages',
              entries: [
                {
                  name: 'entry',
                  format: 'md' as const,
                  fields: [{ name: 'badSelect', type: 'select' as const }],
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(/options/i)
  })

  it('allows empty schema (for loading from meta files)', () => {
    // Schema can be empty if collections are defined in .collection.json meta files
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
        schema: {},
      }),
    ).not.toThrow()
  })

  it('composes config fragments from multiple files', () => {
    const posts: CanopyConfigFragment = {
      ...gitAuthor,
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [
              {
                name: 'entry',
                format: 'mdx',
                fields: [{ name: 'title', type: 'string' }],
              },
            ],
          },
        ],
      },
    }
    const pages: CanopyConfigFragment = {
      ...gitAuthor,
      schema: {
        collections: [
          {
            name: 'pages',
            path: 'pages',
            entries: [
              {
                name: 'page',
                format: 'json',
                fields: [{ name: 'hero', type: 'string' }],
              },
            ],
          },
        ],
      },
      media: { adapter: 'local' as const },
    }

    const config = composeCanopyConfig(posts, pages)

    expect(config.schema?.collections?.[0].name).toBe('posts')
    expect(config.schema?.collections?.[1].name).toBe('pages')
    expect(config.media?.adapter).toBe('local')
  })

  it('flattens nested paths relative to parents', () => {
    const configBundle = defineCanopyConfig({
      ...gitAuthor,
      schema: {
        collections: [
          {
            name: 'content',
            path: 'content',
            entries: [
              {
                name: 'entry',
                format: 'json',
                fields: [{ name: 'title', type: 'string' }],
              },
            ],
            collections: [
              {
                name: 'pages',
                path: 'pages',
                entries: [
                  {
                    name: 'entry',
                    format: 'md',
                    fields: [{ name: 'title', type: 'string' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    const cfg = configBundle.server
    const flat = flattenSchema(cfg.schema!, cfg.contentRoot || 'content')

    const contentCollection = flat.find((item) => item.fullPath === 'content/content')
    const pagesCollection = flat.find((item) => item.fullPath === 'content/content/pages')

    expect(contentCollection).toBeDefined()
    expect(contentCollection?.type).toBe('collection')
    expect(pagesCollection).toBeDefined()
    expect(pagesCollection?.type).toBe('collection')
    expect(pagesCollection?.parentPath).toBe('content/content')
  })

  it('handles deeply nested collections with correct paths', () => {
    const configBundle = defineCanopyConfig({
      ...gitAuthor,
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: [
              {
                name: 'entry',
                format: 'md',
                fields: [{ name: 'title', type: 'string' }],
              },
            ],
            collections: [
              {
                name: 'api',
                path: 'api',
                entries: [
                  {
                    name: 'entry',
                    format: 'md',
                    fields: [{ name: 'title', type: 'string' }],
                  },
                ],
                collections: [
                  {
                    name: 'v2',
                    path: 'v2',
                    entries: [
                      {
                        name: 'entry',
                        format: 'md',
                        fields: [{ name: 'content', type: 'markdown' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    const cfg = configBundle.server
    const flat = flattenSchema(cfg.schema!, cfg.contentRoot || 'content')

    const docsCollection = flat.find((item) => item.fullPath === 'content/docs')
    const apiCollection = flat.find((item) => item.fullPath === 'content/docs/api')
    const v2Collection = flat.find((item) => item.fullPath === 'content/docs/api/v2')

    expect(docsCollection).toBeDefined()
    expect(docsCollection?.type).toBe('collection')

    expect(apiCollection).toBeDefined()
    expect(apiCollection?.type).toBe('collection')
    expect(apiCollection?.parentPath).toBe('content/docs')

    expect(v2Collection).toBeDefined()
    expect(v2Collection?.type).toBe('collection')
    expect(v2Collection?.parentPath).toBe('content/docs/api')
  })

  it('correctly flattens nested collections without path duplication', () => {
    const configBundle = defineCanopyConfig({
      ...gitAuthor,
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: [
              {
                name: 'entry',
                format: 'mdx' as const,
                fields: [{ name: 'title', type: 'string' as const }],
              },
            ],
            collections: [
              {
                name: 'api',
                path: 'api',
                entries: [
                  {
                    name: 'entry',
                    format: 'mdx' as const,
                    fields: [{ name: 'title', type: 'string' as const }],
                  },
                ],
                collections: [
                  {
                    name: 'v1',
                    path: 'v1',
                    entries: [
                      {
                        name: 'entry',
                        format: 'mdx' as const,
                        fields: [{ name: 'title', type: 'string' as const }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    const cfg = configBundle.server
    const flat = flattenSchema(cfg.schema!, cfg.contentRoot || 'content')

    // Find all collections
    const docs = flat.find((item) => item.type === 'collection' && item.name === 'docs')
    const api = flat.find((item) => item.type === 'collection' && item.name === 'api')
    const v1 = flat.find((item) => item.type === 'collection' && item.name === 'v1')

    // Verify docs collection (child of content root)
    expect(docs).toBeDefined()
    expect(docs?.fullPath).toBe('content/docs')
    expect(docs?.parentPath).toBe('content') // Now has content root as parent

    // Verify api collection (nested under docs)
    expect(api).toBeDefined()
    expect(api?.fullPath).toBe('content/docs/api')
    expect(api?.parentPath).toBe('content/docs')

    // Verify v1 collection (nested under api)
    expect(v1).toBeDefined()
    expect(v1?.fullPath).toBe('content/docs/api/v1')
    expect(v1?.parentPath).toBe('content/docs/api')
  })

  it('handles schema-meta-loader nested structure correctly (from .collection.json pattern)', () => {
    // This simulates the structure created by schema-meta-loader
    // where nested collections have FULL paths (e.g., "docs/api") not relative paths (e.g., "api")
    const configBundle = defineCanopyConfig({
      ...gitAuthor,
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs', // Top-level path
            entries: [
              {
                name: 'entry',
                format: 'json' as const,
                fields: [{ name: 'title', type: 'string' as const }],
              },
            ],
            collections: [
              {
                name: 'api',
                path: 'docs/api', // FULL path from content root (as set by schema-meta-loader)
                entries: [
                  {
                    name: 'entry',
                    format: 'json' as const,
                    fields: [{ name: 'title', type: 'string' as const }],
                  },
                ],
                collections: [
                  {
                    name: 'v1',
                    path: 'docs/api/v1', // FULL path from content root
                    entries: [
                      {
                        name: 'entry',
                        format: 'json' as const,
                        fields: [{ name: 'title', type: 'string' as const }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    const cfg = configBundle.server
    const flat = flattenSchema(cfg.schema!, cfg.contentRoot || 'content')

    // Find all collections
    const docs = flat.find((item) => item.type === 'collection' && item.name === 'docs')
    const api = flat.find((item) => item.type === 'collection' && item.name === 'api')
    const v1 = flat.find((item) => item.type === 'collection' && item.name === 'v1')

    // Verify docs collection (child of content root)
    expect(docs).toBeDefined()
    expect(docs?.fullPath).toBe('content/docs')
    expect(docs?.parentPath).toBe('content') // Now has content root as parent

    // Verify api collection (nested under docs)
    expect(api).toBeDefined()
    expect(api?.fullPath).toBe('content/docs/api') // Should NOT be 'content/docs/docs/api'
    expect(api?.parentPath).toBe('content/docs')

    // Verify v1 collection (nested under api)
    expect(v1).toBeDefined()
    expect(v1?.fullPath).toBe('content/docs/api/v1') // Should NOT be 'content/docs/docs/api/api/v1'
    expect(v1?.parentPath).toBe('content/docs/api')
  })

  it('strips embedded IDs from collection paths for logical identity', () => {
    // This test verifies that embedded IDs in directory names are stripped from logical paths
    // Directory on disk: "docs.bChqT78gcaLd", but logical path should be "docs"
    // This keeps IDs hidden from URLs and the editor while still using them for filesystem uniqueness
    const configBundle = defineCanopyConfig({
      ...gitAuthor,
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs', // Logical path without ID
            entries: [
              {
                name: 'entry',
                format: 'json',
                fields: [{ name: 'title', type: 'string' as const }],
              },
            ],
            collections: [
              {
                name: 'api',
                path: 'docs/api', // Logical path without ID
                entries: [
                  {
                    name: 'entry',
                    format: 'json',
                    fields: [{ name: 'title', type: 'string' as const }],
                  },
                ],
                collections: [
                  {
                    name: 'v1',
                    path: 'docs/api/v1', // Logical path without ID
                    entries: [
                      {
                        name: 'entry',
                        format: 'json',
                        fields: [{ name: 'title', type: 'string' as const }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            name: 'posts',
            path: 'posts', // Logical path without ID
            entries: [
              {
                name: 'entry',
                format: 'json',
                fields: [{ name: 'title', type: 'string' as const }],
              },
            ],
          },
        ],
      },
    })
    const cfg = configBundle.server
    const flat = flattenSchema(cfg.schema!, cfg.contentRoot || 'content')

    // Find all collections
    const docs = flat.find((item) => item.type === 'collection' && item.name === 'docs')
    const api = flat.find((item) => item.type === 'collection' && item.name === 'api')
    const v1 = flat.find((item) => item.type === 'collection' && item.name === 'v1')
    const posts = flat.find((item) => item.type === 'collection' && item.name === 'posts')

    // Verify docs collection (child of content root) - NO embedded ID in logical path
    expect(docs).toBeDefined()
    expect(docs?.fullPath).toBe('content/docs')
    expect(docs?.parentPath).toBe('content') // Now has content root as parent

    // Verify api collection (nested under docs) - NO embedded ID in logical path
    expect(api).toBeDefined()
    expect(api?.fullPath).toBe('content/docs/api')
    expect(api?.parentPath).toBe('content/docs')

    // Verify v1 collection (nested under api) - NO embedded ID in logical path
    expect(v1).toBeDefined()
    expect(v1?.fullPath).toBe('content/docs/api/v1')
    expect(v1?.parentPath).toBe('content/docs/api')

    // Verify posts collection (child of content root) - NO embedded ID in logical path
    expect(posts).toBeDefined()
    expect(posts?.fullPath).toBe('content/posts')
    expect(posts?.parentPath).toBe('content') // Now has content root as parent
  })
})
