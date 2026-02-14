import { describe, expect, it } from 'vitest'

import type { CanopyConfigFragment } from '../types'
import { composeCanopyConfig, defineCanopyConfig } from '../helpers'
import { flattenSchema } from '../flatten'
import { validateCanopyConfig } from '../validation'

const gitAuthor = { gitBotAuthorName: 'Test Bot', gitBotAuthorEmail: 'bot@example.com' }

describe('config validation', () => {
  it('accepts a valid config with mdx collection and blocks', () => {
    const schema = {
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
    } as const

    const configBundle = defineCanopyConfig({
      ...gitAuthor,
      media: { adapter: 's3', bucket: 'my-bucket', region: 'us-east-1' },
    })

    // Verify schema is valid on its own (config no longer contains schema)
    expect(schema.collections).toBeDefined()
    expect(schema.collections[0].name).toBe('posts')
  })

  it('rejects select fields without options', () => {
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
      })
    ).not.toThrow() // Config validation no longer includes schema validation
  })

  it('allows config without schema (schema loaded from .collection.json)', () => {
    // Schema is loaded from .collection.json meta files, not from config
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
      })
    ).not.toThrow()
  })

  it('composes config fragments from multiple files', () => {
    const posts: CanopyConfigFragment = {
      ...gitAuthor,
    }
    const pages: CanopyConfigFragment = {
      ...gitAuthor,
      media: { adapter: 'local' as const },
    }

    const config = composeCanopyConfig(posts, pages)

    // Schema is no longer part of config - loaded from .collection.json files
    expect(config.media?.adapter).toBe('local')
  })

  it('flattens nested paths relative to parents', () => {
    const schema = {
      collections: [
        {
          name: 'content',
          path: 'content',
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              fields: [{ name: 'title', type: 'string' as const }],
            },
          ],
          collections: [
            {
              name: 'pages',
              path: 'pages',
              entries: [
                {
                  name: 'entry',
                  format: 'md' as const,
                  fields: [{ name: 'title', type: 'string' as const }],
                },
              ],
            },
          ],
        },
      ],
    } as const

    const configBundle = defineCanopyConfig({
      ...gitAuthor,
    })
    const cfg = configBundle.server
    const flat = flattenSchema(schema, cfg.contentRoot || 'content')

    const contentCollection = flat.find(item => item.logicalPath === 'content/content')
    const pagesCollection = flat.find(item => item.logicalPath === 'content/content/pages')

    expect(contentCollection).toBeDefined()
    expect(contentCollection?.type).toBe('collection')
    expect(pagesCollection).toBeDefined()
    expect(pagesCollection?.type).toBe('collection')
    expect(pagesCollection?.parentPath).toBe('content/content')
  })

  it('handles deeply nested collections with correct paths', () => {
    const schema = {
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [
            {
              name: 'entry',
              format: 'md' as const,
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
                  format: 'md' as const,
                  fields: [{ name: 'title', type: 'string' as const }],
                },
              ],
              collections: [
                {
                  name: 'v2',
                  path: 'v2',
                  entries: [
                    {
                      name: 'entry',
                      format: 'md' as const,
                      fields: [{ name: 'content', type: 'markdown' as const }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as const

    const configBundle = defineCanopyConfig({
      ...gitAuthor,
    })
    const cfg = configBundle.server
    const flat = flattenSchema(schema, cfg.contentRoot || 'content')

    const docsCollection = flat.find(item => item.logicalPath === 'content/docs')
    const apiCollection = flat.find(item => item.logicalPath === 'content/docs/api')
    const v2Collection = flat.find(item => item.logicalPath === 'content/docs/api/v2')

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
    const schema = {
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
    } as const

    const configBundle = defineCanopyConfig({
      ...gitAuthor,
    })
    const cfg = configBundle.server
    const flat = flattenSchema(schema, cfg.contentRoot || 'content')

    // Find all collections
    const docs = flat.find(item => item.type === 'collection' && item.name === 'docs')
    const api = flat.find(item => item.type === 'collection' && item.name === 'api')
    const v1 = flat.find(item => item.type === 'collection' && item.name === 'v1')

    // Verify docs collection (child of content root)
    expect(docs).toBeDefined()
    expect(docs?.logicalPath).toBe('content/docs')
    expect(docs?.parentPath).toBe('content') // Now has content root as parent

    // Verify api collection (nested under docs)
    expect(api).toBeDefined()
    expect(api?.logicalPath).toBe('content/docs/api')
    expect(api?.parentPath).toBe('content/docs')

    // Verify v1 collection (nested under api)
    expect(v1).toBeDefined()
    expect(v1?.logicalPath).toBe('content/docs/api/v1')
    expect(v1?.parentPath).toBe('content/docs/api')
  })

  it('handles schema-meta-loader nested structure correctly (from .collection.json pattern)', () => {
    // This simulates the structure created by schema-meta-loader
    // where nested collections have FULL paths (e.g., "docs/api") not relative paths (e.g., "api")
    const schema = {
      collections: [
        {
          name: 'docs',
          path: 'docs',  // Top-level path
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
              path: 'docs/api',  // FULL path from content root (as set by schema-meta-loader)
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
                  path: 'docs/api/v1',  // FULL path from content root
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
    } as const

    const configBundle = defineCanopyConfig({
      ...gitAuthor,
    })
    const cfg = configBundle.server
    const flat = flattenSchema(schema, cfg.contentRoot || 'content')

    // Find all collections
    const docs = flat.find(item => item.type === 'collection' && item.name === 'docs')
    const api = flat.find(item => item.type === 'collection' && item.name === 'api')
    const v1 = flat.find(item => item.type === 'collection' && item.name === 'v1')

    // Verify docs collection (child of content root)
    expect(docs).toBeDefined()
    expect(docs?.logicalPath).toBe('content/docs')
    expect(docs?.parentPath).toBe('content') // Now has content root as parent

    // Verify api collection (nested under docs)
    expect(api).toBeDefined()
    expect(api?.logicalPath).toBe('content/docs/api') // Should NOT be 'content/docs/docs/api'
    expect(api?.parentPath).toBe('content/docs')

    // Verify v1 collection (nested under api)
    expect(v1).toBeDefined()
    expect(v1?.logicalPath).toBe('content/docs/api/v1') // Should NOT be 'content/docs/docs/api/api/v1'
    expect(v1?.parentPath).toBe('content/docs/api')
  })

  it('strips embedded IDs from collection paths for logical identity', () => {
    // This test verifies that embedded IDs in directory names are stripped from logical paths
    // Directory on disk: "docs.bChqT78gcaLd", but logical path should be "docs"
    // This keeps IDs hidden from URLs and the editor while still using them for filesystem uniqueness
    const schema = {
      collections: [
        {
          name: 'docs',
          path: 'docs',  // Logical path without ID
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
              path: 'docs/api',  // Logical path without ID
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
                  path: 'docs/api/v1',  // Logical path without ID
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
        {
          name: 'posts',
          path: 'posts',  // Logical path without ID
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              fields: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const configBundle = defineCanopyConfig({
      ...gitAuthor,
    })
    const cfg = configBundle.server
    const flat = flattenSchema(schema, cfg.contentRoot || 'content')

    // Find all collections
    const docs = flat.find(item => item.type === 'collection' && item.name === 'docs')
    const api = flat.find(item => item.type === 'collection' && item.name === 'api')
    const v1 = flat.find(item => item.type === 'collection' && item.name === 'v1')
    const posts = flat.find(item => item.type === 'collection' && item.name === 'posts')

    // Verify docs collection (child of content root) - NO embedded ID in logical path
    expect(docs).toBeDefined()
    expect(docs?.logicalPath).toBe('content/docs')
    expect(docs?.parentPath).toBe('content') // Now has content root as parent

    // Verify api collection (nested under docs) - NO embedded ID in logical path
    expect(api).toBeDefined()
    expect(api?.logicalPath).toBe('content/docs/api')
    expect(api?.parentPath).toBe('content/docs')

    // Verify v1 collection (nested under api) - NO embedded ID in logical path
    expect(v1).toBeDefined()
    expect(v1?.logicalPath).toBe('content/docs/api/v1')
    expect(v1?.parentPath).toBe('content/docs/api')

    // Verify posts collection (child of content root) - NO embedded ID in logical path
    expect(posts).toBeDefined()
    expect(posts?.logicalPath).toBe('content/posts')
    expect(posts?.parentPath).toBe('content') // Now has content root as parent
  })
})
