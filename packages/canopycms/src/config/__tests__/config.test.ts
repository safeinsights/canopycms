import { describe, expect, it } from 'vitest'

import type { CanopyConfigFragment, CollectionConfig, ValidateEntryHook } from '../types'
import type { ContentId } from '../../paths/types'
import type { AuthPlugin } from '../../auth/plugin'
import { ROOT_COLLECTION_ID } from '../../paths/types'
import { composeCanopyConfig, defineCanopyConfig } from '../helpers'
import { flattenSchema } from '../flatten'
import { mediaSchema } from '../schemas/media'
import {
  ensureSelectFieldsHaveOptions,
  ensureReferenceFieldsHaveScope,
  ensureNoGroupsInsideComplexFields,
  ensureNoFlattenedFieldNameCollisions,
  validateCanopyConfig,
} from '../validation'

const gitAuthor = {
  gitBotAuthorName: 'Test Bot',
  gitBotAuthorEmail: 'bot@example.com',
  mode: 'dev' as const,
}

// Minimal stub satisfying the AuthPlugin interface, for fragment-merge tests (SCH-H2).
const fakeAuthPlugin: AuthPlugin = {
  authenticate: async () => ({ success: false, error: 'not implemented' }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
}

const fakeValidateEntry: ValidateEntryHook = async () => []

describe('config validation', () => {
  it('accepts a minimal config', () => {
    expect(() => validateCanopyConfig({ ...gitAuthor })).not.toThrow()
  })

  // SEC-C1: `mode` has no default. A prod deploy that omits it must fail validation
  // loudly instead of silently running header-trusting dev auth semantics.
  it('throws when mode is omitted, with an error mentioning "mode"', () => {
    const { mode: _mode, ...withoutMode } = gitAuthor

    expect(() => validateCanopyConfig({ ...withoutMode })).toThrow(/mode/i)
  })

  // SEC-C1: composeCanopyConfig must not paper over a missing mode either — if no
  // fragment in the chain supplies it, validation should fail the same way.
  it('throws from composeCanopyConfig when no fragment supplies mode', () => {
    const posts: CanopyConfigFragment = {
      gitBotAuthorName: gitAuthor.gitBotAuthorName,
      gitBotAuthorEmail: gitAuthor.gitBotAuthorEmail,
    }

    expect(() => composeCanopyConfig(posts)).toThrow(/mode/i)
  })

  it('round-trips an explicit mode: "prod"', () => {
    const config = validateCanopyConfig({ ...gitAuthor, mode: 'prod' })

    expect(config.mode).toBe('prod')
  })

  // SCH-M1: defaultBranchAccess/defaultPathAccess must resolve to 'deny' (fail closed),
  // not undefined, when omitted. An outer .optional() around a .default('deny') schema
  // previously short-circuited before the inner default ran.
  it('defaults defaultBranchAccess and defaultPathAccess to "deny" when omitted', () => {
    const config = validateCanopyConfig({ ...gitAuthor })

    expect(config.defaultBranchAccess).toBe('deny')
    expect(config.defaultPathAccess).toBe('deny')
  })

  it('still allows an explicit "allow" for defaultBranchAccess/defaultPathAccess', () => {
    const config = validateCanopyConfig({
      ...gitAuthor,
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
    })

    expect(config.defaultBranchAccess).toBe('allow')
    expect(config.defaultPathAccess).toBe('allow')
  })

  // Level-scoped defaultPathAccess: object form round-trips exactly, with omitted
  // levels left undefined rather than filled in (resolveDefaultPathAccess handles the
  // fail-closed 'deny' fallback at read time, not the schema).
  it('accepts an object form of defaultPathAccess and round-trips it exactly', () => {
    const config = validateCanopyConfig({
      ...gitAuthor,
      defaultPathAccess: { read: 'allow' },
    })

    expect(config.defaultPathAccess).toEqual({ read: 'allow' })
  })

  it('rejects an unknown level key in the defaultPathAccess object form', () => {
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
        defaultPathAccess: { readx: 'allow' },
      } as Record<string, unknown>),
    ).toThrow()
  })

  it('rejects an invalid level value in the defaultPathAccess object form', () => {
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
        defaultPathAccess: { read: 'sometimes' },
      } as Record<string, unknown>),
    ).toThrow()
  })

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      validateCanopyConfig({
        ...gitAuthor,
        unknownField: 'oops',
      } as Record<string, unknown>),
    ).toThrow()
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

  // SCH-H2: composeCanopyConfig previously only merged a hand-picked subset of fragment
  // keys, silently dropping authPlugin/validateEntry (and others) even though they're
  // typed on CanopyConfigFragment. Verify the full fragment is merged.
  it('preserves authPlugin, validateEntry, and other previously-dropped fields through composeCanopyConfig', () => {
    const base: CanopyConfigFragment = {
      ...gitAuthor,
      authPlugin: fakeAuthPlugin,
      validateEntry: fakeValidateEntry,
      githubTokenEnvVar: 'MY_BOT_TOKEN',
      deployedAs: 'static',
      settingsBranch: 'canopy-settings',
      autoCreateSettingsPR: true,
      allowNetworkRemoteInProd: true,
      editor: { title: 'My Editor' },
      entryLinkUrl: () => '/some/url',
    }

    const config = composeCanopyConfig(base)

    expect(config.authPlugin).toBe(fakeAuthPlugin)
    expect(config.validateEntry).toBe(fakeValidateEntry)
    expect(config.githubTokenEnvVar).toBe('MY_BOT_TOKEN')
    expect(config.deployedAs).toBe('static')
    expect(config.settingsBranch).toBe('canopy-settings')
    expect(config.autoCreateSettingsPR).toBe(true)
    expect(config.allowNetworkRemoteInProd).toBe(true)
    expect(config.editor?.title).toBe('My Editor')
    expect(typeof config.entryLinkUrl).toBe('function')
  })

  // PR-F: allowNetworkRemoteInProd must be accepted by the .strict() schema (it's
  // consumed by GitManager's prod-mode network-remote guard, not by config
  // validation itself) and must default to undefined/falsy when omitted.
  it('accepts allowNetworkRemoteInProd and defaults it to undefined when omitted', () => {
    const withFlag = validateCanopyConfig({
      ...gitAuthor,
      mode: 'prod',
      allowNetworkRemoteInProd: true,
    })
    expect(withFlag.allowNetworkRemoteInProd).toBe(true)

    const withoutFlag = validateCanopyConfig({ ...gitAuthor, mode: 'prod' })
    expect(withoutFlag.allowNetworkRemoteInProd).toBeUndefined()
  })

  it('lets a later fragment override an earlier fragment field-by-field', () => {
    const first: CanopyConfigFragment = {
      ...gitAuthor,
      settingsBranch: 'first-branch',
      deployedAs: 'static',
    }
    const second: CanopyConfigFragment = {
      settingsBranch: 'second-branch',
    }

    const config = composeCanopyConfig(first, second)

    // Later fragment's explicit value wins...
    expect(config.settingsBranch).toBe('second-branch')
    // ...but a field the later fragment never mentions is not clobbered by undefined.
    expect(config.deployedAs).toBe('static')
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

// The ensure* field-shape validators take a flat EntrySchema (field array) directly.
// They're called from createEntrySchemaRegistry on each schema in the registry; these
// tests exercise them on representative field arrays without any config wrapper.

describe('ensureSelectFieldsHaveOptions', () => {
  it('passes when select field has non-empty options', () => {
    expect(() =>
      ensureSelectFieldsHaveOptions([{ name: 'tags', type: 'select', options: ['a', 'b'] }]),
    ).not.toThrow()
  })

  it('throws when select field has no options', () => {
    expect(() => ensureSelectFieldsHaveOptions([{ name: 'tags', type: 'select' }])).toThrow(
      'Select field "tags" requires options',
    )
  })

  it('throws when select field has empty options array', () => {
    expect(() =>
      ensureSelectFieldsHaveOptions([{ name: 'tags', type: 'select', options: [] }]),
    ).toThrow('Select field "tags" requires options')
  })

  it('ignores non-select fields', () => {
    expect(() =>
      ensureSelectFieldsHaveOptions([
        { name: 'title', type: 'string' },
        { name: 'ref', type: 'reference', collections: ['authors'] },
      ]),
    ).not.toThrow()
  })

  it('validates select fields inside group fields', () => {
    expect(() =>
      ensureSelectFieldsHaveOptions([
        {
          name: 'seo',
          type: 'group',
          fields: [{ name: 'category', type: 'select' }],
        },
      ]),
    ).toThrow('Select field "category" requires options')
  })

  it('validates select fields inside object fields', () => {
    expect(() =>
      ensureSelectFieldsHaveOptions([
        {
          name: 'meta',
          type: 'object',
          fields: [{ name: 'category', type: 'select' }],
        },
      ]),
    ).toThrow('Select field "category" requires options')
  })

  it('validates select fields inside block templates', () => {
    expect(() =>
      ensureSelectFieldsHaveOptions([
        {
          name: 'blocks',
          type: 'block',
          templates: [{ name: 'card', fields: [{ name: 'category', type: 'select' }] }],
        },
      ]),
    ).toThrow('Select field "category" requires options')
  })
})

describe('ensureReferenceFieldsHaveScope', () => {
  it('passes when reference field has collections', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope([
        { name: 'ref', type: 'reference', collections: ['authors'] },
      ]),
    ).not.toThrow()
  })

  it('passes when reference field has entryTypes', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope([{ name: 'ref', type: 'reference', entryTypes: ['partner'] }]),
    ).not.toThrow()
  })

  it('passes when reference field has both', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope([
        { name: 'ref', type: 'reference', collections: ['catalog'], entryTypes: ['partner'] },
      ]),
    ).not.toThrow()
  })

  it('throws when reference field has neither', () => {
    expect(() => ensureReferenceFieldsHaveScope([{ name: 'ref', type: 'reference' }])).toThrow(
      'Reference field "ref" requires at least one of "collections" or "entryTypes"',
    )
  })

  it('throws when collections is empty array', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope([{ name: 'ref', type: 'reference', collections: [] }]),
    ).toThrow('Reference field "ref" requires at least one of "collections" or "entryTypes"')
  })

  it('throws when entryTypes is empty array', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope([{ name: 'ref', type: 'reference', entryTypes: [] }]),
    ).toThrow('Reference field "ref" requires at least one of "collections" or "entryTypes"')
  })

  it('ignores non-reference fields', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope([
        { name: 'title', type: 'string' },
        { name: 'tags', type: 'select', options: ['a'] },
      ]),
    ).not.toThrow()
  })

  it('validates reference fields inside object fields', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope([
        {
          name: 'meta',
          type: 'object',
          fields: [{ name: 'ref', type: 'reference' }],
        },
      ]),
    ).toThrow('Reference field "ref"')
  })

  it('validates reference fields inside block templates', () => {
    expect(() =>
      ensureReferenceFieldsHaveScope([
        {
          name: 'blocks',
          type: 'block',
          templates: [{ name: 'card', fields: [{ name: 'ref', type: 'reference' }] }],
        },
      ]),
    ).toThrow('Reference field "ref"')
  })
})

describe('ensureNoGroupsInsideComplexFields', () => {
  it('passes when a group is at the top level', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields([
        { name: 'seo', type: 'group', fields: [{ name: 'metaTitle', type: 'string' }] },
      ]),
    ).not.toThrow()
  })

  it('passes when a group is nested inside another group', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields([
        {
          name: 'outer',
          type: 'group',
          fields: [{ name: 'inner', type: 'group', fields: [{ name: 'a', type: 'string' }] }],
        },
      ]),
    ).not.toThrow()
  })

  it('throws when a group is directly inside an object field', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields([
        {
          name: 'meta',
          type: 'object',
          fields: [{ name: 'seo', type: 'group', fields: [{ name: 'metaTitle', type: 'string' }] }],
        },
      ]),
    ).toThrow('Inline group "seo" cannot be nested inside a object field')
  })

  it('throws when a group is inside a block template', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields([
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
    ).toThrow('Inline group "seo" cannot be nested inside a block field')
  })

  it('throws when a group is inside an object that is inside a top-level group', () => {
    expect(() =>
      ensureNoGroupsInsideComplexFields([
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
    ).toThrow('Inline group "inner" cannot be nested inside a object field')
  })
})

describe('ensureNoFlattenedFieldNameCollisions', () => {
  it('passes with no duplicates', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions([
        { name: 'title', type: 'string' },
        { name: 'seo', type: 'group', fields: [{ name: 'metaTitle', type: 'string' }] },
      ]),
    ).not.toThrow()
  })

  it('throws when a group field collides with a top-level field', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions([
        { name: 'title', type: 'string' },
        { name: 'seo', type: 'group', fields: [{ name: 'title', type: 'string' }] },
      ]),
    ).toThrow('Field name collision')
  })

  it('throws when two groups have a field with the same name', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions([
        { name: 'nav', type: 'group', fields: [{ name: 'label', type: 'string' }] },
        { name: 'seo', type: 'group', fields: [{ name: 'label', type: 'string' }] },
      ]),
    ).toThrow('Field name collision')
  })

  it('passes when collisions are in separate object scopes', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions([
        { name: 'hero', type: 'object', fields: [{ name: 'title', type: 'string' }] },
        { name: 'footer', type: 'object', fields: [{ name: 'title', type: 'string' }] },
      ]),
    ).not.toThrow()
  })

  it('throws on collision within a nested object scope', () => {
    expect(() =>
      ensureNoFlattenedFieldNameCollisions([
        {
          name: 'hero',
          type: 'object',
          fields: [
            { name: 'title', type: 'string' },
            { name: 'inner', type: 'group', fields: [{ name: 'title', type: 'string' }] },
          ],
        },
      ]),
    ).toThrow('Field name collision')
  })
})

// SCH-H1: mediaSchema must be a discriminated union keyed on `adapter` so each adapter's
// required fields are enforced. Previously (plain z.union) a malformed s3 config could
// fall through to a looser branch, silently stripping fields (e.g. `bucket`) instead of
// failing validation.
describe('mediaSchema', () => {
  it('rejects a malformed s3 config missing region', () => {
    expect(() => mediaSchema.parse({ adapter: 's3', bucket: 'x' })).toThrow()
  })

  it('rejects a malformed s3 config missing bucket', () => {
    expect(() => mediaSchema.parse({ adapter: 's3', region: 'us-east-1' })).toThrow()
  })

  it('parses a valid s3 config with all fields intact', () => {
    const result = mediaSchema.parse({
      adapter: 's3',
      bucket: 'my-bucket',
      region: 'us-east-1',
      publicBaseUrl: 'https://cdn.example.com',
    })

    expect(result).toEqual({
      adapter: 's3',
      bucket: 'my-bucket',
      region: 'us-east-1',
      publicBaseUrl: 'https://cdn.example.com',
    })
  })

  it('parses a valid local config with all fields intact', () => {
    const result = mediaSchema.parse({
      adapter: 'local',
      publicBaseUrl: 'https://cdn.example.com',
    })

    expect(result).toEqual({
      adapter: 'local',
      publicBaseUrl: 'https://cdn.example.com',
    })
  })

  it('parses a minimal local config without publicBaseUrl', () => {
    expect(mediaSchema.parse({ adapter: 'local' })).toEqual({ adapter: 'local' })
  })

  it('rejects an unknown adapter name', () => {
    expect(() => mediaSchema.parse({ adapter: 'cloudinary' })).toThrow()
  })
})
