import { describe, expect, it } from 'vitest'

import type { CanopyConfigFragment } from './config'
import { composeCanopyConfig, defineCanopyConfig, resolveSchema, validateCanopyConfig } from './config'

const gitAuthor = { gitBotAuthorName: 'Test Bot', gitBotAuthorEmail: 'bot@example.com' }

describe('config validation', () => {
  it('accepts a valid config with mdx collection and blocks', () => {
    const config = defineCanopyConfig({
      ...gitAuthor,
      schema: [
        {
          type: 'collection' as const,
          name: 'posts',
          path: 'content/posts',
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
          children: [
            {
              type: 'singleton' as const,
              name: 'landing',
              path: 'landing',
              format: 'json' as const,
              fields: [{ name: 'heading', type: 'string' as const }],
            },
          ],
        },
      ],
      pathPermissions: [{ path: 'content/partners/**', allowedGroups: ['partner-org'] }],
      media: { adapter: 's3', bucket: 'my-bucket', region: 'us-east-1' },
    })

    expect(config.schema[0].type).toBe('collection')
    expect(config.schema[0].children?.[0].type).toBe('singleton')
  })

  it('rejects select fields without options', () => {
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
        schema: [
          {
            type: 'collection',
            name: 'pages',
            path: 'content/pages',
            format: 'md' as const,
            fields: [{ name: 'badSelect', type: 'select' as const }],
          },
        ],
      })
    ).toThrow(/options/i)
  })

  it('requires at least one collection or singleton', () => {
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
        schema: [],
      })
    ).toThrow(/at least one collection/i)
  })

  it('composes config fragments from multiple files', () => {
    const posts: CanopyConfigFragment = {
      ...gitAuthor,
      schema: [
        {
          type: 'collection',
          name: 'posts',
          path: 'content/posts',
          format: 'mdx',
          fields: [{ name: 'title', type: 'string' }],
        },
      ],
    }
    const heroSingleton: CanopyConfigFragment = {
      ...gitAuthor,
      schema: [
        {
          type: 'singleton',
          name: 'homepage',
          path: 'content/home',
          format: 'json',
          fields: [{ name: 'hero', type: 'string' }],
        },
      ],
      pathPermissions: [{ path: 'content/home/**', managerOrAdminAllowed: true }],
      media: { adapter: 'local' as const },
    }

    const config = composeCanopyConfig(posts, heroSingleton)

    expect(config.schema[0].name).toBe('posts')
    expect(config.schema[1].name).toBe('homepage')
    expect(config.pathPermissions?.[0].path).toBe('content/home/**')
    expect(config.media?.adapter).toBe('local')
  })

  it('resolves nested paths relative to parents', () => {
    const cfg = defineCanopyConfig({
      ...gitAuthor,
      schema: [
        {
          type: 'collection',
          name: 'content',
          path: 'content',
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
          children: [
            {
              type: 'collection',
              name: 'pages',
              path: 'pages',
              format: 'md',
              fields: [{ name: 'title', type: 'string' }],
            },
          ],
        },
      ],
    })
    const resolved = resolveSchema(cfg.schema, cfg.contentRoot)
    expect(resolved[0].fullPath).toBe('content')
    expect(resolved[0].children?.[0].fullPath).toBe('content/pages')
    expect(resolved[0].children?.[0].parentPath).toBe('content')
  })
})
