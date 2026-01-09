import { describe, expect, it } from 'vitest'

import type { CanopyConfigFragment } from './config'
import {
  composeCanopyConfig,
  defineCanopyConfig,
  flattenSchema,
  validateCanopyConfig,
} from './config'

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
            entries: {
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
            singletons: [
              {
                name: 'landing',
                path: 'landing',
                format: 'json' as const,
                fields: [{ name: 'heading', type: 'string' as const }],
              },
            ],
          },
        ],
      },
      media: { adapter: 's3', bucket: 'my-bucket', region: 'us-east-1' },
    })

    expect(configBundle.server.schema.collections).toBeDefined()
    expect(configBundle.server.schema.collections?.[0].singletons).toBeDefined()
    expect(configBundle.server.schema.collections?.[0].singletons?.[0].name).toBe('landing')
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
              entries: {
                format: 'md' as const,
                fields: [{ name: 'badSelect', type: 'select' as const }],
              },
            },
          ],
        },
      }),
    ).toThrow(/options/i)
  })

  it('requires at least one collection or singleton', () => {
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
        schema: {},
      }),
    ).toThrow()
  })

  it('composes config fragments from multiple files', () => {
    const posts: CanopyConfigFragment = {
      ...gitAuthor,
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: {
              format: 'mdx',
              fields: [{ name: 'title', type: 'string' }],
            },
          },
        ],
      },
    }
    const homesingleton: CanopyConfigFragment = {
      ...gitAuthor,
      schema: {
        singletons: [
          {
            name: 'homepage',
            path: 'home',
            format: 'json',
            fields: [{ name: 'hero', type: 'string' }],
          },
        ],
      },
      media: { adapter: 'local' as const },
    }

    const config = composeCanopyConfig(posts, homesingleton)

    expect(config.schema.collections?.[0].name).toBe('posts')
    expect(config.schema.singletons?.[0].name).toBe('homepage')
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
            entries: {
              format: 'json',
              fields: [{ name: 'title', type: 'string' }],
            },
            collections: [
              {
                name: 'pages',
                path: 'pages',
                entries: {
                  format: 'md',
                  fields: [{ name: 'title', type: 'string' }],
                },
              },
            ],
          },
        ],
      },
    })
    const cfg = configBundle.server
    const flat = flattenSchema(cfg.schema, cfg.contentRoot || 'content')

    const contentCollection = flat.find((item) => item.fullPath === 'content/content')
    const pagesCollection = flat.find((item) => item.fullPath === 'content/content/pages')

    expect(contentCollection).toBeDefined()
    expect(contentCollection?.type).toBe('collection')
    expect(pagesCollection).toBeDefined()
    expect(pagesCollection?.type).toBe('collection')
    expect(pagesCollection?.parentPath).toBe('content/content')
  })
})
