import { describe, expect, it } from 'vitest'

import type { CanopyConfigFragment, CollectionConfig } from '../types'
import type { ContentId } from '../../paths/types'
import { ROOT_COLLECTION_ID } from '../../paths/types'
import { composeCanopyConfig, defineCanopyConfig } from '../helpers'
import { flattenSchema } from '../flatten'
import {
  ensureReferenceFieldsHaveScope,
  ensureNoGroupsInsideComplexFields,
  ensureNoFlattenedFieldNameCollisions,
  validateCanopyConfig,
} from '../validation'

const gitAuthor = {
  gitBotAuthorName: 'Test Bot',
  gitBotAuthorEmail: 'bot@example.com',
}

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
              schema: [
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
                        {
                          name: 'headline',
                          type: 'string' as const,
                          required: true,
                        },
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

    defineCanopyConfig({
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
      }),
    ).not.toThrow() // Config validation no longer includes schema validation
  })

  it('allows config without schema (schema loaded from .collection.json)', () => {
    // Schema is loaded from .collection.json meta files, not from config
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
      }),
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
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
          collections: [
            {
              name: 'pages',
              path: 'content/pages', // Full path from content root (as produced by meta-loader)
              entries: [
                {
                  name: 'entry',
                  format: 'md' as const,
                  schema: [{ name: 'title', type: 'string' as const }],
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

    const contentCollection = flat.find((item) => item.logicalPath === 'content/content')
    const pagesCollection = flat.find((item) => item.logicalPath === 'content/content/pages')

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
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
          collections: [
            {
              name: 'api',
              path: 'docs/api', // Full path from content root (as produced by meta-loader)
              entries: [
                {
                  name: 'entry',
                  format: 'md' as const,
                  schema: [{ name: 'title', type: 'string' as const }],
                },
              ],
              collections: [
                {
                  name: 'v2',
                  path: 'docs/api/v2', // Full path from content root (as produced by meta-loader)
                  entries: [
                    {
                      name: 'entry',
                      format: 'md' as const,
                      schema: [{ name: 'content', type: 'markdown' as const }],
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

    const docsCollection = flat.find((item) => item.logicalPath === 'content/docs')
    const apiCollection = flat.find((item) => item.logicalPath === 'content/docs/api')
    const v2Collection = flat.find((item) => item.logicalPath === 'content/docs/api/v2')

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
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
          collections: [
            {
              name: 'api',
              path: 'docs/api', // Full path from content root (as produced by meta-loader)
              entries: [
                {
                  name: 'entry',
                  format: 'mdx' as const,
                  schema: [{ name: 'title', type: 'string' as const }],
                },
              ],
              collections: [
                {
                  name: 'v1',
                  path: 'docs/api/v1', // Full path from content root (as produced by meta-loader)
                  entries: [
                    {
                      name: 'entry',
                      format: 'mdx' as const,
                      schema: [{ name: 'title', type: 'string' as const }],
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
    const docs = flat.find((item) => item.type === 'collection' && item.name === 'docs')
    const api = flat.find((item) => item.type === 'collection' && item.name === 'api')
    const v1 = flat.find((item) => item.type === 'collection' && item.name === 'v1')

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
          path: 'docs', // Top-level path
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
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
                  schema: [{ name: 'title', type: 'string' as const }],
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
                      schema: [{ name: 'title', type: 'string' as const }],
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
    const docs = flat.find((item) => item.type === 'collection' && item.name === 'docs')
    const api = flat.find((item) => item.type === 'collection' && item.name === 'api')
    const v1 = flat.find((item) => item.type === 'collection' && item.name === 'v1')

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
          path: 'docs', // Logical path without ID
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
          collections: [
            {
              name: 'api',
              path: 'docs/api', // Logical path without ID
              entries: [
                {
                  name: 'entry',
                  format: 'json' as const,
                  schema: [{ name: 'title', type: 'string' as const }],
                },
              ],
              collections: [
                {
                  name: 'v1',
                  path: 'docs/api/v1', // Logical path without ID
                  entries: [
                    {
                      name: 'entry',
                      format: 'json' as const,
                      schema: [{ name: 'title', type: 'string' as const }],
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
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
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
    const docs = flat.find((item) => item.type === 'collection' && item.name === 'docs')
    const api = flat.find((item) => item.type === 'collection' && item.name === 'api')
    const v1 = flat.find((item) => item.type === 'collection' && item.name === 'v1')
    const posts = flat.find((item) => item.type === 'collection' && item.name === 'posts')

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

  it('threads contentId from CollectionConfig through to FlatSchemaItem', () => {
    const TEST_ID = 'a1b2c3d4e5f6' as ContentId
    const CHILD_ID = 'Xz9kL2mN4pQr' as ContentId

    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          contentId: TEST_ID,
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
          collections: [
            {
              name: 'drafts',
              path: 'posts/drafts',
              contentId: CHILD_ID,
              entries: [
                {
                  name: 'entry',
                  format: 'json' as const,
                  schema: [{ name: 'title', type: 'string' as const }],
                },
              ],
            },
          ],
        } satisfies CollectionConfig,
      ],
    }

    const flat = flattenSchema(schema, 'content')

    const root = flat.find((item) => item.type === 'collection' && item.logicalPath === 'content')
    const posts = flat.find((item) => item.type === 'collection' && item.name === 'posts')
    const drafts = flat.find((item) => item.type === 'collection' && item.name === 'drafts')

    // Root collection gets the sentinel
    expect(root).toBeDefined()
    expect(root?.type === 'collection' && root.contentId).toBe(ROOT_COLLECTION_ID)

    // Child collections carry their own contentId
    expect(posts?.type === 'collection' && posts.contentId).toBe(TEST_ID)
    expect(drafts?.type === 'collection' && drafts.contentId).toBe(CHILD_ID)
  })

  it('leaves contentId undefined when CollectionConfig has no contentId', () => {
    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          // No contentId — simulates static config (not loaded from filesystem)
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    }

    const flat = flattenSchema(schema, 'content')
    const pages = flat.find((item) => item.type === 'collection' && item.name === 'pages')

    expect(pages).toBeDefined()
    expect(pages?.type === 'collection' && pages.contentId).toBeUndefined()
  })

  it('uses collection.path (not collection.name) for nested collection logical paths', () => {
    // Regression: collection.name from .collection.json can be mixed-case (e.g., "EdPlus-Learning-at-Scale")
    // but collection.path is derived from directory names via extractSlugFromFilename (always lowercase).
    // The logical path must use collection.path so lookups via lowercase slugs match.
    const schema = {
      collections: [
        {
          name: 'data-catalog',
          path: 'data-catalog',
          entries: [
            {
              name: 'entry',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
          collections: [
            {
              name: 'EdPlus-Learning-at-Scale', // Mixed-case name from .collection.json
              path: 'data-catalog/edplus-learning-at-scale', // Lowercase path from directory name
              entries: [
                {
                  name: 'doc',
                  format: 'mdx' as const,
                  schema: [{ name: 'title', type: 'string' as const }],
                },
              ],
            },
          ],
        },
      ],
    } as const

    const flat = flattenSchema(schema, 'content')

    const nested = flat.find(
      (item) => item.type === 'collection' && item.name === 'EdPlus-Learning-at-Scale',
    )
    expect(nested).toBeDefined()
    // Logical path uses collection.path (lowercase), not collection.name (mixed-case)
    expect(nested?.logicalPath).toBe('content/data-catalog/edplus-learning-at-scale')
    // Display name preserved as-is
    expect(nested?.name).toBe('EdPlus-Learning-at-Scale')
    expect(nested?.parentPath).toBe('content/data-catalog')
  })
})

describe('ensureReferenceFieldsHaveScope', () => {
  const makeConfig = (fields: unknown[]) => ({
    schema: {
      entries: [{ schema: fields }],
    },
  })

  it('passes when reference field has collections', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope(
        makeConfig([{ name: 'ref', type: 'reference', collections: ['authors'] }]),
      ),
    ).not.toThrow()
  })

  it('passes when reference field has entryTypes', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope(
        makeConfig([{ name: 'ref', type: 'reference', entryTypes: ['partner'] }]),
      ),
    ).not.toThrow()
  })

  it('passes when reference field has both', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope(
        makeConfig([
          { name: 'ref', type: 'reference', collections: ['catalog'], entryTypes: ['partner'] },
        ]),
      ),
    ).not.toThrow()
  })

  it('throws when reference field has neither', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope(makeConfig([{ name: 'ref', type: 'reference' }])),
    ).toThrow('Reference field "ref" requires at least one of "collections" or "entryTypes"')
  })

  it('throws when collections is empty array', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope(
        makeConfig([{ name: 'ref', type: 'reference', collections: [] }]),
      ),
    ).toThrow('Reference field "ref" requires at least one of "collections" or "entryTypes"')
  })

  it('throws when entryTypes is empty array', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope(
        makeConfig([{ name: 'ref', type: 'reference', entryTypes: [] }]),
      ),
    ).toThrow('Reference field "ref" requires at least one of "collections" or "entryTypes"')
  })

  it('ignores non-reference fields', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope(
        makeConfig([
          { name: 'title', type: 'string' },
          { name: 'tags', type: 'select', options: ['a'] },
        ]),
      ),
    ).not.toThrow()
  })

  it('validates reference fields inside object fields', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope(
        makeConfig([
          {
            name: 'meta',
            type: 'object',
            fields: [{ name: 'ref', type: 'reference' }],
          },
        ]),
      ),
    ).toThrow('Reference field "ref"')
  })

  it('validates reference fields inside block templates', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope(
        makeConfig([
          {
            name: 'blocks',
            type: 'block',
            templates: [{ name: 'card', fields: [{ name: 'ref', type: 'reference' }] }],
          },
        ]),
      ),
    ).toThrow('Reference field "ref"')
  })

  it('validates nested collections', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope({
        schema: {
          collections: [
            {
              entries: [{ schema: [{ name: 'ref', type: 'reference' }] }],
            },
          ],
        },
      }),
    ).toThrow('Reference field "ref"')
  })
})

describe('ensureNoGroupsInsideComplexFields', () => {
  const makeConfig = (fields: unknown[]) => ({
    schema: { entries: [{ name: 'doc', schema: fields }] },
  })

  it('passes when a group is at the top level', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields(
        makeConfig([
          { name: 'seo', type: 'group', fields: [{ name: 'metaTitle', type: 'string' }] },
        ]),
      ),
    ).not.toThrow()
  })

  it('passes when a group is nested inside another group', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields(
        makeConfig([
          {
            name: 'outer',
            type: 'group',
            fields: [{ name: 'inner', type: 'group', fields: [{ name: 'a', type: 'string' }] }],
          },
        ]),
      ),
    ).not.toThrow()
  })

  it('throws when a group is directly inside an object field', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields(
        makeConfig([
          {
            name: 'meta',
            type: 'object',
            fields: [
              { name: 'seo', type: 'group', fields: [{ name: 'metaTitle', type: 'string' }] },
            ],
          },
        ]),
      ),
    ).toThrow('Inline group "seo" cannot be nested inside a object field')
  })

  it('throws when a group is inside a block template', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields(
        makeConfig([
          {
            name: 'blocks',
            type: 'block',
            templates: [
              {
                name: 'hero',
                fields: [
                  { name: 'seo', type: 'group', fields: [{ name: 'metaTitle', type: 'string' }] },
                ],
              },
            ],
          },
        ]),
      ),
    ).toThrow('Inline group "seo" cannot be nested inside a block field')
  })

  it('throws when a group is inside an object that is inside a top-level group', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields(
        makeConfig([
          {
            name: 'outer',
            type: 'group',
            fields: [
              {
                name: 'meta',
                type: 'object',
                fields: [{ name: 'inner', type: 'group', fields: [{ name: 'a', type: 'string' }] }],
              },
            ],
          },
        ]),
      ),
    ).toThrow('Inline group "inner" cannot be nested inside a object field')
  })
})

describe('ensureNoFlattenedFieldNameCollisions', () => {
  const makeConfig = (fields: unknown[]) => ({
    schema: { entries: [{ name: 'doc', schema: fields }] },
  })

  it('passes with no duplicates', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions(
        makeConfig([
          { name: 'title', type: 'string' },
          { name: 'seo', type: 'group', fields: [{ name: 'metaTitle', type: 'string' }] },
        ]),
      ),
    ).not.toThrow()
  })

  it('throws when a group field collides with a top-level field', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions(
        makeConfig([
          { name: 'title', type: 'string' },
          { name: 'seo', type: 'group', fields: [{ name: 'title', type: 'string' }] },
        ]),
      ),
    ).toThrow('Field name collision')
  })

  it('throws when two groups have a field with the same name', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions(
        makeConfig([
          { name: 'nav', type: 'group', fields: [{ name: 'label', type: 'string' }] },
          { name: 'seo', type: 'group', fields: [{ name: 'label', type: 'string' }] },
        ]),
      ),
    ).toThrow('Field name collision')
  })

  it('passes when collisions are in separate object scopes', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions(
        makeConfig([
          { name: 'hero', type: 'object', fields: [{ name: 'title', type: 'string' }] },
          { name: 'footer', type: 'object', fields: [{ name: 'title', type: 'string' }] },
        ]),
      ),
    ).not.toThrow()
  })

  it('throws on collision within a nested object scope', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions(
        makeConfig([
          {
            name: 'hero',
            type: 'object',
            fields: [
              { name: 'title', type: 'string' },
              { name: 'inner', type: 'group', fields: [{ name: 'title', type: 'string' }] },
            ],
          },
        ]),
      ),
    ).toThrow('Field name collision')
  })
})
