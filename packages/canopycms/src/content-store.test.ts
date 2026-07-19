import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from './config-test'
import { flattenSchema } from './config'
import { ContentIdIndex } from './content-id-index'
import {
  bumpContentIndexGeneration,
  invalidateContentIndexesDurable,
} from './content-index-generation'
import { invalidateContentIndexesForRoot } from './content-index-registry'
import { ContentStore, ContentStoreError, ContentConflictError } from './content-store'
import { generateId } from './id'
import { unsafeAsLogicalPath, unsafeAsSlug } from './paths/test-utils'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-'))

describe('ContentStore', () => {
  it('writes and reads markdown content', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'md' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('hello-world'), {
      format: 'md',
      data: { title: 'Hello' },
      body: 'Body text',
    })

    const doc = await store.read(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('hello-world'))
    if (doc.format !== 'md' && doc.format !== 'mdx') throw new Error('expected markdown')
    expect(doc.data.title).toBe('Hello')
    expect(doc.body).toContain('Body text')
    expect(doc.relativePath.endsWith('.md')).toBe(true)
  })

  it('writes and reads mdx content with frontmatter', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          entries: [
            {
              name: 'page',
              format: 'mdx' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await store.write(unsafeAsLogicalPath('content/pages'), unsafeAsSlug('landing'), {
      format: 'mdx',
      data: { title: 'Landing' },
      body: '<Hero title="Hi" />',
    })

    const doc = await store.read(unsafeAsLogicalPath('content/pages'), unsafeAsSlug('landing'))
    if (doc.format !== 'md' && doc.format !== 'mdx') throw new Error('expected mdx')
    expect(doc.data.title).toBe('Landing')
    expect(doc.body?.includes('<Hero')).toBe(true)
    expect(doc.absolutePath.endsWith('.mdx')).toBe(true)
  })

  it('writes and reads json content', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'settings',
          path: 'config',
          entries: [
            {
              name: 'setting',
              format: 'json' as const,
              schema: [{ name: 'siteName', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await store.write(unsafeAsLogicalPath('content/config'), unsafeAsSlug('site'), {
      format: 'json',
      data: { siteName: 'CanopyCMS' },
    })

    const doc = await store.read(unsafeAsLogicalPath('content/config'), unsafeAsSlug('site'))
    expect(doc.data.siteName).toBe('CanopyCMS')
    expect(doc.relativePath.endsWith('.json')).toBe(true)
  })

  it('writes and reads yaml content', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'settings',
          path: 'config',
          entries: [
            {
              name: 'setting',
              format: 'yaml' as const,
              schema: [{ name: 'siteName', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await store.write(unsafeAsLogicalPath('content/config'), unsafeAsSlug('site'), {
      format: 'yaml',
      data: { siteName: 'CanopyCMS' },
    })

    const doc = await store.read(unsafeAsLogicalPath('content/config'), unsafeAsSlug('site'))
    expect(doc.data.siteName).toBe('CanopyCMS')
    expect(doc.format).toBe('yaml')
    expect(doc.relativePath.endsWith('.yaml')).toBe(true)
  })

  it('reads non-default yaml entry type with correct format', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'research',
          path: 'research',
          entries: [
            {
              name: 'doc',
              format: 'mdx' as const,
              schema: [{ name: 'title', type: 'string' as const }],
              default: true,
            },
            {
              name: 'catalog',
              format: 'yaml' as const,
              schema: [{ name: 'source', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    // Write a YAML entry (non-default type)
    await store.write(
      unsafeAsLogicalPath('content/research'),
      unsafeAsSlug('index'),
      { format: 'yaml', data: { source: 'NIH' } },
      'catalog',
    )

    // Read it back — should use yaml parser, not gray-matter
    const doc = await store.read(unsafeAsLogicalPath('content/research'), unsafeAsSlug('index'))
    expect(doc.format).toBe('yaml')
    expect(doc.data.source).toBe('NIH')
    expect('body' in doc).toBe(false)
  })

  it('prevents path traversal outside root', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'md' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await expect(
      store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('../escape'), {
        format: 'md',
        data: { title: 'bad' },
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(ContentStoreError)
  })

  it('reads and writes entry items with a slug', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'settings',
          path: 'settings',
          entries: [
            {
              name: 'setting',
              format: 'json' as const,
              schema: [{ name: 'siteName', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await store.write(unsafeAsLogicalPath('content/settings'), unsafeAsSlug('site'), {
      format: 'json',
      data: { siteName: 'CanopyCMS' },
    })

    const doc = await store.read(unsafeAsLogicalPath('content/settings'), unsafeAsSlug('site'))
    expect(doc.format).toBe('json')
    expect(doc.data.siteName).toBe('CanopyCMS')
    // Pattern: {type}.{slug}.{id}.{ext}
    expect(doc.relativePath).toMatch(/content\/settings\/setting\.site\.[a-zA-Z0-9]+\.json/)
  })

  it('rejects slugs with forward slashes', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'md' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await expect(
      store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('2024/hello'), {
        format: 'md',
        data: { title: 'Bad Slug' },
        body: 'Content',
      }),
    ).rejects.toThrow('Slugs cannot contain forward slashes')
  })

  it('rejects slugs with backslashes', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'md' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await expect(
      store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('bad\\slug'), {
        format: 'md',
        data: { title: 'Bad Slug' },
        body: 'Content',
      }),
    ).rejects.toThrow('Slugs cannot contain backslashes')
  })

  it('resolves paths using trivial algorithm: collection + slug', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'md' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    // Path: content/posts/hello -> collection=content/posts, slug=hello
    const result = store.resolvePath(['content', 'posts', 'hello'])
    expect(result.schemaItem.logicalPath).toBe('content/posts')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('hello')
  })

  it('resolves paths for collection entries with slug', async () => {
    const root = await tmpDir()
    const schema = {
      collections: [
        {
          name: 'settings',
          path: 'settings',
          entries: [
            {
              name: 'setting',
              format: 'json' as const,
              schema: [{ name: 'siteName', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    // Path: content/settings/site -> collection entry with slug
    const result = store.resolvePath(['content', 'settings', 'site'])
    expect(result.schemaItem.logicalPath).toBe('content/settings')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('site')
  })

  it('resolves nested collection paths', async () => {
    const root = await tmpDir()
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
              name: 'guides',
              path: 'docs/guides',
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

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    // Path: content/docs/guides/getting-started
    // -> collection=content/docs/guides, slug=getting-started
    const result = store.resolvePath(['content', 'docs', 'guides', 'getting-started'])
    expect(result.schemaItem.logicalPath).toBe('content/docs/guides')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('getting-started')
  })

  it('resolves 3-level nested collection paths', async () => {
    const root = await tmpDir()
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
              path: 'docs/api',
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
                  path: 'docs/api/v2',
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
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    // Path: content/docs/api/v2/authentication
    // -> collection=content/docs/api/v2, slug=authentication
    const result = store.resolvePath(['content', 'docs', 'api', 'v2', 'authentication'])
    expect(result.schemaItem.logicalPath).toBe('content/docs/api/v2')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('authentication')
  })

  it('resolves 4-level nested collection paths', async () => {
    const root = await tmpDir()
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
              path: 'docs/api',
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
                  path: 'docs/api/v2',
                  entries: [
                    {
                      name: 'entry',
                      format: 'md' as const,
                      schema: [{ name: 'title', type: 'string' as const }],
                    },
                  ],
                  collections: [
                    {
                      name: 'endpoints',
                      path: 'docs/api/v2/endpoints',
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
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    // Path: content/docs/api/v2/endpoints/users
    // -> collection=content/docs/api/v2/endpoints, slug=users
    const result = store.resolvePath(['content', 'docs', 'api', 'v2', 'endpoints', 'users'])
    expect(result.schemaItem.logicalPath).toBe('content/docs/api/v2/endpoints')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('users')
  })

  it('writes and reads content in deeply nested collections', async () => {
    const root = await tmpDir()
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
              path: 'docs/api',
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
                  path: 'docs/api/v2',
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
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    // Write to 3-level nested collection
    await store.write(unsafeAsLogicalPath('content/docs/api/v2'), unsafeAsSlug('authentication'), {
      format: 'md',
      data: { title: 'Authentication Guide' },
      body: '# Authentication\n\nHow to authenticate.',
    })

    // Read it back
    const doc = await store.read(
      unsafeAsLogicalPath('content/docs/api/v2'),
      unsafeAsSlug('authentication'),
    )
    if (doc.format !== 'md' && doc.format !== 'mdx') throw new Error('expected markdown')
    expect(doc.data.title).toBe('Authentication Guide')
    expect(doc.body).toContain('How to authenticate')
    // Pattern: {type}.{slug}.{id}.{ext}
    expect(doc.relativePath).toMatch(
      /^content\/docs\/api\/v2\/entry\.authentication\.[a-zA-Z0-9]{12}\.md$/,
    )
  })

  describe('renameEntry', () => {
    it('renames an entry by changing its slug', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [
              {
                name: 'post',
                format: 'md' as const,
                schema: [{ name: 'title', type: 'string' as const }],
              },
            ],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create an entry
      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('old-slug'), {
        format: 'md',
        data: { title: 'Test Post' },
        body: 'Content here',
      })

      // Rename it
      const result = await store.renameEntry(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('old-slug'),
        unsafeAsSlug('new-slug'),
      )

      // Verify new path is returned
      expect(result.newPath).toBe('content/posts/new-slug')

      // Verify old path doesn't exist anymore
      await expect(
        store.read(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('old-slug')),
      ).rejects.toThrow()

      // Verify new path works
      const doc = await store.read(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('new-slug'))
      if (doc.format !== 'md' && doc.format !== 'mdx') throw new Error('expected markdown')
      expect(doc.data.title).toBe('Test Post')
      expect(doc.body).toContain('Content here')
    })

    it('throws when entry does not exist', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'json' as const, schema: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      await expect(
        store.renameEntry(
          unsafeAsLogicalPath('content/posts'),
          unsafeAsSlug('nonexistent'),
          unsafeAsSlug('new-slug'),
        ),
      ).rejects.toThrow('Entry not found: nonexistent')
    })

    it('throws when new slug already exists', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'json' as const, schema: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create two entries
      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('first-post'), {
        format: 'json',
        data: { title: 'First' },
      })
      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('second-post'), {
        format: 'json',
        data: { title: 'Second' },
      })

      // Try to rename first-post to second-post (conflict)
      await expect(
        store.renameEntry(
          unsafeAsLogicalPath('content/posts'),
          unsafeAsSlug('first-post'),
          unsafeAsSlug('second-post'),
        ),
      ).rejects.toThrow('already exists')
    })

    it('validates slug format', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'json' as const, schema: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create an entry
      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('test-post'), {
        format: 'json',
        data: { title: 'Test' },
      })

      // Try invalid slug with slash
      await expect(
        store.renameEntry(
          unsafeAsLogicalPath('content/posts'),
          unsafeAsSlug('test-post'),
          unsafeAsSlug('invalid/slug'),
        ),
      ).rejects.toThrow('cannot contain forward slashes')

      // Uppercase slugs are normalized by parseSlug at the API boundary,
      // so renameEntry receives already-validated Slug branded types
    })

    it('handles no-op when slug is unchanged', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'json' as const, schema: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create an entry
      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('same-slug'), {
        format: 'json',
        data: { title: 'Test' },
      })

      // Rename to same slug (no-op)
      const result = await store.renameEntry(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('same-slug'),
        unsafeAsSlug('same-slug'),
      )

      // Should return the same path
      expect(result.newPath).toBe('content/posts/same-slug')

      // Entry should still be readable
      const doc = await store.read(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('same-slug'))
      expect(doc.format).toBe('json')
      if (doc.format === 'json') {
        expect(doc.data.title).toBe('Test')
      }
    })

    it('preserves content ID through rename', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'json' as const, schema: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create an entry
      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('original'), {
        format: 'json',
        data: { title: 'Test' },
      })

      // Get the content ID before rename
      const idBefore = await store.getIdForEntry(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('original'),
      )

      // Rename the entry
      await store.renameEntry(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('original'),
        unsafeAsSlug('renamed'),
      )

      // Get the content ID after rename
      const idAfter = await store.getIdForEntry(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('renamed'),
      )

      // IDs should match (preserved through rename)
      expect(idBefore).toBe(idAfter)
      expect(idBefore).toBeTruthy()
    })
  })

  describe('write with existingId (slug change)', () => {
    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [{ name: 'post', format: 'json' as const, schema: [] }],
        },
      ],
    } as const

    it('deletes the old file when writing with a changed slug', async () => {
      const root = await tmpDir()
      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Write initial entry
      const doc = await store.write(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('old-slug'),
        {
          format: 'json',
          data: { title: 'Original' },
        },
      )
      const oldAbsPath = doc.absolutePath

      // Get the stable content ID
      const existingId = await store.getIdForEntry(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('old-slug'),
      )
      expect(existingId).toBeTruthy()

      // Write to a new slug, carrying the same content ID
      await store.write(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('new-slug'),
        { format: 'json', data: { title: 'Updated' } },
        undefined,
        existingId!,
      )

      // Old file must be gone — not just absent from the index, gone from disk
      await expect(fs.access(oldAbsPath)).rejects.toThrow()

      // New file must exist and have updated content
      const newDoc = await store.read(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('new-slug'),
      )
      expect(newDoc.data.title).toBe('Updated')
    })

    it('does not throw when the old file was already deleted externally', async () => {
      const root = await tmpDir()
      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      const doc = await store.write(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('old-slug'),
        {
          format: 'json',
          data: { title: 'Original' },
        },
      )

      const existingId = await store.getIdForEntry(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('old-slug'),
      )
      expect(existingId).toBeTruthy()

      // Delete the old file externally before the slug-change write
      await fs.unlink(doc.absolutePath)

      // Should complete without error even though the old file is already gone
      await expect(
        store.write(
          unsafeAsLogicalPath('content/posts'),
          unsafeAsSlug('new-slug'),
          { format: 'json', data: { title: 'Updated' } },
          undefined,
          existingId!,
        ),
      ).resolves.toBeDefined()

      // New file must exist
      const newDoc = await store.read(
        unsafeAsLogicalPath('content/posts'),
        unsafeAsSlug('new-slug'),
      )
      expect(newDoc.data.title).toBe('Updated')
    })
  })

  describe('multiple entry types', () => {
    it('creates entries with specified entry type', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'content',
            path: 'content',
            entries: [
              {
                name: 'post',
                format: 'mdx' as const,
                schema: [],
                default: true,
              },
              { name: 'article', format: 'md' as const, schema: [] },
              { name: 'note', format: 'json' as const, schema: [] },
            ],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create entries of different types
      const post = await store.write(
        unsafeAsLogicalPath('content/content'),
        unsafeAsSlug('my-post'),
        { format: 'mdx', data: {}, body: 'Post content' },
        'post',
      )
      const article = await store.write(
        unsafeAsLogicalPath('content/content'),
        unsafeAsSlug('my-article'),
        { format: 'md', data: {}, body: 'Article content' },
        'article',
      )
      const note = await store.write(
        unsafeAsLogicalPath('content/content'),
        unsafeAsSlug('my-note'),
        { format: 'json', data: { text: 'Note' } },
        'note',
      )

      // Verify filenames include correct entry type (check the returned paths)
      const postFile = path.basename(post.relativePath)
      const articleFile = path.basename(article.relativePath)
      const noteFile = path.basename(note.relativePath)

      expect(postFile.startsWith('post.my-post.')).toBe(true)
      expect(postFile.endsWith('.mdx')).toBe(true)
      expect(articleFile.startsWith('article.my-article.')).toBe(true)
      expect(articleFile.endsWith('.md')).toBe(true)
      expect(noteFile.startsWith('note.my-note.')).toBe(true)
      expect(noteFile.endsWith('.json')).toBe(true)
    })

    it('throws error for invalid entry type', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'mdx' as const, schema: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      await expect(
        store.write(
          unsafeAsLogicalPath('content/posts'),
          unsafeAsSlug('test'),
          { format: 'mdx', data: {}, body: '' },
          'invalid-type',
        ),
      ).rejects.toThrow("Entry type 'invalid-type' not found in collection")
    })

    it('uses default entry type when not specified', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: [
              { name: 'guide', format: 'md' as const, schema: [] },
              {
                name: 'tutorial',
                format: 'mdx' as const,
                schema: [],
                default: true,
              },
            ],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Write without specifying entry type - should use default (tutorial)
      const doc = await store.write(unsafeAsLogicalPath('content/docs'), unsafeAsSlug('my-doc'), {
        format: 'mdx',
        data: {},
        body: 'Content',
      })

      const tutorialFile = path.basename(doc.relativePath)
      expect(tutorialFile.startsWith('tutorial.my-doc.')).toBe(true)
      expect(tutorialFile.endsWith('.mdx')).toBe(true)
    })

    it('preserves entry type for existing entries (immutable after creation)', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'content',
            path: 'content',
            entries: [
              { name: 'post', format: 'mdx' as const, schema: [] },
              { name: 'article', format: 'md' as const, schema: [] },
            ],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create an entry with entry type "post"
      const created = await store.write(
        unsafeAsLogicalPath('content/content'),
        unsafeAsSlug('my-content'),
        { format: 'mdx', data: {}, body: 'Original' },
        'post',
      )
      const createdFile = path.basename(created.relativePath)
      expect(createdFile.startsWith('post.my-content.')).toBe(true)

      // Update the same entry WITHOUT specifying entry type
      // The entry type should be automatically preserved from the existing file
      const updated = await store.write(
        unsafeAsLogicalPath('content/content'),
        unsafeAsSlug('my-content'),
        { format: 'mdx', data: {}, body: 'Updated' },
      )
      const updatedFile = path.basename(updated.relativePath)

      // Entry type should still be "post" (preserved from existing file)
      expect(updatedFile.startsWith('post.my-content.')).toBe(true)
      expect(updatedFile).toBe(createdFile) // Filename should be exactly the same

      // Verify the content was updated
      const read = await store.read(
        unsafeAsLogicalPath('content/content'),
        unsafeAsSlug('my-content'),
      )
      if (read.format !== 'md' && read.format !== 'mdx') throw new Error('Expected mdx')
      expect(read.body.trim()).toBe('Updated')

      // Also verify that even if we specify a different entry type, it gets ignored (preserved)
      const updated2 = await store.write(
        unsafeAsLogicalPath('content/content'),
        unsafeAsSlug('my-content'),
        { format: 'mdx', data: {}, body: 'Updated again' },
        'post',
      )
      const updated2File = path.basename(updated2.relativePath)
      expect(updated2File).toBe(createdFile) // Still the same filename
    })
  })

  describe('entry-type path delegation', () => {
    // When buildPaths receives an entry-type schema item (e.g., from
    // store.read('content/home', '')), it delegates to the parent collection.
    // The API layer doesn't trigger this path (resolvePath returns collections
    // directly), but direct ContentStore usage can.

    it('writes and reads via entry-type logical path', async () => {
      const root = await tmpDir()
      const schema = {
        entries: [
          {
            name: 'home',
            format: 'json' as const,
            schema: [{ name: 'hero', type: 'string' as const }],
            maxItems: 1,
          },
          {
            name: 'settings',
            format: 'json' as const,
            schema: [{ name: 'siteName', type: 'string' as const }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Write using the entry-type path (content/home) with empty slug
      await store.write(unsafeAsLogicalPath('content/home'), unsafeAsSlug(''), {
        format: 'json',
        data: { hero: 'Welcome' },
      })

      // Read it back via the same entry-type path
      const doc = await store.read(unsafeAsLogicalPath('content/home'), unsafeAsSlug(''))
      expect(doc.format).toBe('json')
      expect(doc.data.hero).toBe('Welcome')

      // Verify 4-part filename: home.home.{id}.json
      expect(doc.relativePath).toMatch(/^content\/home\.home\.[a-zA-Z0-9]{12}\.json$/)
    })

    it('uses provided slug instead of entry type name', async () => {
      const root = await tmpDir()
      const schema = {
        entries: [
          {
            name: 'page',
            format: 'json' as const,
            schema: [{ name: 'title', type: 'string' as const }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Write with an explicit slug different from entry type name
      await store.write(unsafeAsLogicalPath('content/page'), unsafeAsSlug('about'), {
        format: 'json',
        data: { title: 'About Us' },
      })

      const doc = await store.read(unsafeAsLogicalPath('content/page'), unsafeAsSlug('about'))
      expect(doc.data.title).toBe('About Us')

      // Verify filename: page.about.{id}.json (type from entry type, slug from arg)
      expect(doc.relativePath).toMatch(/^content\/page\.about\.[a-zA-Z0-9]{12}\.json$/)
    })

    it('uses correct format and fields from entry-type schema', async () => {
      const root = await tmpDir()
      const schema = {
        entries: [
          {
            name: 'post',
            format: 'md' as const,
            schema: [{ name: 'title', type: 'string' as const }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      await store.write(unsafeAsLogicalPath('content/post'), unsafeAsSlug('hello'), {
        format: 'md',
        data: { title: 'Hello' },
        body: 'World',
      })

      const doc = await store.read(unsafeAsLogicalPath('content/post'), unsafeAsSlug('hello'))
      if (doc.format !== 'md' && doc.format !== 'mdx') throw new Error('Expected md')
      expect(doc.format).toBe('md')
      expect(doc.data.title).toBe('Hello')
      expect(doc.body).toContain('World')
      expect(doc.relativePath).toMatch(/^content\/post\.hello\.[a-zA-Z0-9]{12}\.md$/)
    })
  })

  describe('complex frontmatter roundtrip', () => {
    it('preserves nested objects and arrays in markdown frontmatter via gray-matter', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [
              {
                name: 'post',
                format: 'md' as const,
                schema: [
                  { name: 'title', type: 'string' as const },
                  { name: 'tags', type: 'string' as const, list: true },
                  { name: 'published', type: 'boolean' as const },
                ],
              },
            ],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      const complexData = {
        title: 'Complex Post',
        author: '5NVkkrB1MJUv',
        tags: ['typed', 'fast'],
        published: false,
        blocks: [
          {
            template: 'hero',
            value: {
              headline: 'Hero block',
              body: 'Hero copy',
            },
          },
          {
            template: 'cta',
            value: {
              title: 'Try CanopyCMS',
              ctaText: 'Click me',
            },
          },
        ],
      }

      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('complex'), {
        format: 'md',
        data: complexData,
        body: '# Hello World\n\nSome **bold** text with `code`.',
      })

      const doc = await store.read(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('complex'))
      if (doc.format !== 'md' && doc.format !== 'mdx') throw new Error('expected markdown')

      // Verify all frontmatter data survived the roundtrip
      expect(doc.data.title).toBe('Complex Post')
      expect(doc.data.author).toBe('5NVkkrB1MJUv')
      expect(doc.data.tags).toEqual(['typed', 'fast'])
      expect(doc.data.published).toBe(false)
      expect(doc.data.blocks).toEqual(complexData.blocks)

      // Verify body survived
      expect(doc.body).toContain('# Hello World')
      expect(doc.body).toContain('Some **bold** text')
    })
  })

  describe('case-insensitive slug matching', () => {
    it('reads an entry whose physical filename has a mixed-case slug', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: [
              {
                name: 'doc',
                format: 'mdx' as const,
                schema: [{ name: 'title', type: 'string' as const }],
              },
            ],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create the collection directory and a mixed-case file directly on disk
      // (simulating pre-existing content from before CanopyCMS adoption)
      const collectionDir = path.join(root, 'content', 'docs')
      await fs.mkdir(collectionDir, { recursive: true })

      const id = generateId()
      await fs.writeFile(
        path.join(collectionDir, `doc.Onboarding-Checklist.${id}.mdx`),
        '---\ntitle: Onboarding\n---\nChecklist content',
      )

      // Read using lowercase slug — should find the mixed-case file
      const doc = await store.read(
        unsafeAsLogicalPath('content/docs'),
        unsafeAsSlug('onboarding-checklist'),
      )
      if (doc.format !== 'md' && doc.format !== 'mdx') throw new Error('expected mdx')
      expect(doc.data.title).toBe('Onboarding')
      expect(doc.body).toContain('Checklist content')
    })

    it('detects slug conflict with different casing on rename', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [
              {
                name: 'post',
                format: 'md' as const,
                schema: [{ name: 'title', type: 'string' as const }],
              },
            ],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create the collection directory with both entries directly on disk
      const collectionDir = path.join(root, 'content', 'posts')
      await fs.mkdir(collectionDir, { recursive: true })

      // Create my-post via the store (so renameEntry can find it)
      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('my-post'), {
        format: 'md',
        data: { title: 'My Post' },
        body: 'Content',
      })

      // Manually create a file with a mixed-case slug
      const id = generateId()
      await fs.writeFile(
        path.join(collectionDir, `post.Hello-World.${id}.md`),
        '---\ntitle: Hello\n---\nBody',
      )

      // Try to rename my-post to hello-world — should conflict with the mixed-case file
      await expect(
        store.renameEntry(
          unsafeAsLogicalPath('content/posts'),
          unsafeAsSlug('my-post'),
          unsafeAsSlug('hello-world'),
        ),
      ).rejects.toThrow('already exists')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// OCC (Optimistic Concurrency Control) version token
// ─────────────────────────────────────────────────────────────────────────────

describe('ContentStore OCC', () => {
  const schema = {
    collections: [
      {
        name: 'posts',
        path: 'posts',
        entries: [{ name: 'post', format: 'json' as const, schema: [] }],
      },
    ],
  } as const

  const makeStore = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-occ-'))
    const config = defineCanopyTestConfig({ schema })
    return new ContentStore(root, flattenSchema(schema, config.contentRoot))
  }

  it('read returns a version (mtime) field', async () => {
    const store = await makeStore()
    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('a'), {
      format: 'json',
      data: { v: 1 },
    })
    const doc = await store.read(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('a'))
    expect(typeof doc.version).toBe('number')
    expect(doc.version).toBeGreaterThan(0)
  })

  it('write returns a version field', async () => {
    const store = await makeStore()
    const doc = await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('b'), {
      format: 'json',
      data: { v: 1 },
    })
    expect(typeof doc.version).toBe('number')
    expect(doc.version).toBeGreaterThan(0)
  })

  it('write without expectedVersion always succeeds (backwards compat)', async () => {
    const store = await makeStore()
    // First write (new entry)
    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('c'), {
      format: 'json',
      data: { v: 1 },
    })
    // Second write, no expectedVersion — must not throw
    const doc = await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('c'), {
      format: 'json',
      data: { v: 2 },
    })
    expect((doc.data as Record<string, unknown>).v).toBe(2)
  })

  it('write with correct expectedVersion succeeds and returns updated version', async () => {
    const store = await makeStore()
    const first = await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('d'), {
      format: 'json',
      data: { v: 1 },
    })
    const second = await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('d'), {
      format: 'json',
      data: { v: 2 },
      expectedVersion: first.version,
    })
    expect((second.data as Record<string, unknown>).v).toBe(2)
    expect(typeof second.version).toBe('number')
  })

  it('write with stale expectedVersion throws ContentConflictError', async () => {
    const store = await makeStore()
    const first = await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('e'), {
      format: 'json',
      data: { v: 1 },
    })
    // Simulate a concurrent write that advances the mtime
    await new Promise((r) => setTimeout(r, 10))
    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('e'), {
      format: 'json',
      data: { v: 2 },
    })
    // Now try to write with the version from the first write — should conflict
    await expect(
      store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('e'), {
        format: 'json',
        data: { v: 3 },
        expectedVersion: first.version,
      }),
    ).rejects.toThrow(ContentConflictError)
  })

  it('read version matches the version returned by write', async () => {
    const store = await makeStore()
    const written = await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('f'), {
      format: 'json',
      data: { v: 1 },
    })
    const read = await store.read(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('f'))
    // Both should reflect the same file state
    expect(read.version).toBe(written.version)
  })

  it('write rethrows non-ENOENT stat errors, does not silently bypass OCC', async () => {
    const store = await makeStore()
    const written = await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('g'), {
      format: 'json',
      data: { v: 1 },
    })

    // Simulate a filesystem error (e.g. EACCES) on the OCC stat call
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const statSpy = vi.spyOn(fs, 'stat').mockRejectedValueOnce(eacces)

    try {
      await expect(
        store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('g'), {
          format: 'json',
          data: { v: 2 },
          expectedVersion: written.version,
        }),
      ).rejects.toThrow('EACCES')
    } finally {
      statSpy.mockRestore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ID index invalidation (in-process staleness after checkout/pull/rebase/sync)
// ─────────────────────────────────────────────────────────────────────────────

describe('ContentStore index invalidation', () => {
  const schema = {
    collections: [
      {
        name: 'posts',
        path: 'posts',
        entries: [
          {
            name: 'post',
            format: 'md' as const,
            schema: [{ name: 'title', type: 'string' as const }],
          },
        ],
      },
    ],
  } as const

  const makeStore = async (root?: string) => {
    const resolvedRoot = root ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-idx-')))
    const config = defineCanopyTestConfig({ schema })
    return {
      root: resolvedRoot,
      store: new ContentStore(resolvedRoot, flattenSchema(schema, config.contentRoot)),
    }
  }

  /** Write an entry, warm the index, then rename its file on disk behind the store's back. */
  const writeAndRenameOnDisk = async (store: ContentStore, oldSlug: string, newSlug: string) => {
    const doc = await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug(oldSlug), {
      format: 'md',
      data: { title: 'T' },
      body: 'Body',
    })
    const id = await store.getIdForEntry(
      unsafeAsLogicalPath('content/posts'),
      unsafeAsSlug(oldSlug),
    )
    if (!id) throw new Error('expected id for written entry')
    // Simulate a checkout/pullBase/rebase swapping files underneath the store:
    // rename the entry file to a new slug without going through the store.
    await fs.rename(doc.absolutePath, doc.absolutePath.replace(oldSlug, newSlug))
    return id
  }

  it('rebuilds the index after invalidateIndex so lookups return the new path', async () => {
    const { store } = await makeStore()
    const id = await writeAndRenameOnDisk(store, 'hello-world', 'renamed-entry')

    // Pre-invalidation the index is stale: it still resolves the old path.
    const staleLocation = (await store.idIndex()).findById(id)
    expect(staleLocation?.relativePath).toContain('hello-world')

    store.invalidateIndex()

    // Post-invalidation the lookup resolves the NEW on-disk path, not the stale one.
    const freshLocation = (await store.idIndex()).findById(id)
    expect(freshLocation?.relativePath).toContain('renamed-entry')
    expect(freshLocation?.relativePath).not.toContain('hello-world')
    expect(freshLocation?.slug).toBe('renamed-entry')

    // And readById follows the new path end to end.
    const doc = await store.readById(id)
    expect(doc?.relativePath).toContain('renamed-entry')
  })

  it('does not rebuild the index on repeated reads without an intervening invalidation', async () => {
    const buildSpy = vi.spyOn(ContentIdIndex.prototype, 'buildFromFilenames')
    try {
      const { store } = await makeStore()
      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('a'), {
        format: 'md',
        data: { title: 'A' },
        body: 'Body',
      })
      const buildsAfterWrite = buildSpy.mock.calls.length
      expect(buildsAfterWrite).toBe(1)

      // Ordinary repeated reads — including concurrent index accesses — reuse the index.
      await store.read(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('a'))
      await store.read(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('a'))
      await Promise.all([store.idIndex(), store.idIndex(), store.idIndex()])
      expect(buildSpy.mock.calls.length).toBe(buildsAfterWrite)

      // Invalidation triggers exactly one rebuild on next access.
      store.invalidateIndex()
      await store.idIndex()
      expect(buildSpy.mock.calls.length).toBe(buildsAfterWrite + 1)
      await store.idIndex()
      expect(buildSpy.mock.calls.length).toBe(buildsAfterWrite + 1)
    } finally {
      buildSpy.mockRestore()
    }
  })

  it('concurrent idIndex() calls after invalidation share one rebuild and do not collide', async () => {
    const { store } = await makeStore()
    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('b'), {
      format: 'md',
      data: { title: 'B' },
      body: 'Body',
    })
    await store.idIndex()

    const buildSpy = vi.spyOn(ContentIdIndex.prototype, 'buildFromFilenames')
    try {
      store.invalidateIndex()
      // Without clear-before-rebuild (or with interleaved scans) this would throw
      // "ID collision detected" for every unchanged file.
      await Promise.all([store.idIndex(), store.idIndex(), store.idIndex()])
      expect(buildSpy.mock.calls.length).toBe(1)
    } finally {
      buildSpy.mockRestore()
    }
  })

  it('invalidateContentIndexesForRoot invalidates stores at or under the root, not others', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-idx-reg-'))
    const nestedRoot = path.join(base, 'clone')
    await fs.mkdir(nestedRoot, { recursive: true })
    const { store: nestedStore } = await makeStore(nestedRoot)
    const { store: otherStore } = await makeStore()

    const nestedId = await writeAndRenameOnDisk(nestedStore, 'nested-old', 'nested-new')
    const otherId = await writeAndRenameOnDisk(otherStore, 'other-old', 'other-new')

    // Warm both indexes (both now stale relative to disk).
    expect((await nestedStore.idIndex()).findById(nestedId)?.relativePath).toContain('nested-old')
    expect((await otherStore.idIndex()).findById(otherId)?.relativePath).toContain('other-old')

    // Invalidating an ANCESTOR of the nested store's root reaches it (prefix match)...
    invalidateContentIndexesForRoot(base)
    expect((await nestedStore.idIndex()).findById(nestedId)?.relativePath).toContain('nested-new')

    // ...but leaves stores under unrelated roots untouched (still stale).
    expect((await otherStore.idIndex()).findById(otherId)?.relativePath).toContain('other-old')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cross-process index consistency (on-disk generation marker).
// Two ContentStore instances on the SAME root model two processes sharing a
// branch clone (Lambda + worker on EFS): ContentStore.write() never calls the
// in-process registry, and the registry/withLock module state is inert across
// same-root stores, so any second-store rebuild here provably comes from the
// on-disk marker (or the suspicious-lookup backstop where stated).

describe('ContentStore cross-process index consistency', () => {
  const schema = {
    collections: [
      {
        name: 'posts',
        path: 'posts',
        entries: [
          {
            name: 'post',
            format: 'md' as const,
            schema: [{ name: 'title', type: 'string' as const }],
          },
        ],
      },
    ],
  } as const

  const posts = unsafeAsLogicalPath('content/posts')

  const makeStore = async (root?: string, indexFreshnessIntervalMs = 0) => {
    const resolvedRoot = root ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-xproc-')))
    const config = defineCanopyTestConfig({ schema })
    return {
      root: resolvedRoot,
      store: new ContentStore(resolvedRoot, flattenSchema(schema, config.contentRoot), {
        indexFreshnessIntervalMs,
      }),
    }
  }

  const writeEntry = (store: ContentStore, slug: string, existingId?: string) =>
    store.write(
      posts,
      unsafeAsSlug(slug),
      { format: 'md', data: { title: 'T' }, body: 'Body' },
      undefined,
      existingId as Parameters<ContentStore['write']>[4],
    )

  const getId = async (store: ContentStore, slug: string) => {
    const id = await store.getIdForEntry(posts, unsafeAsSlug(slug))
    if (!id) throw new Error(`expected id for entry ${slug}`)
    return id
  }

  it('a write in one store becomes visible to a pre-built store on the same root', async () => {
    const { root, store: storeA } = await makeStore()
    const { store: storeB } = await makeStore(root)

    // B builds its index BEFORE A writes — a lazy first scan must not be
    // what makes the test pass.
    await storeB.idIndex()

    await writeEntry(storeA, 'fresh-entry')
    const id = await getId(storeA, 'fresh-entry')

    // B's next access probes the marker A bumped and rebuilds.
    // (findById directly — readById would also engage the backstop.)
    const location = (await storeB.idIndex()).findById(id)
    expect(location?.slug).toBe('fresh-entry')
  })

  it('negative control: without a marker bump the other store stays stale; the bump alone heals it', async () => {
    const { root, store: storeA } = await makeStore()
    const { store: storeB } = await makeStore(root)
    await writeEntry(storeA, 'seed') // creates content/posts on disk
    await storeB.idIndex()

    // Simulate a process that mutates files WITHOUT bumping the marker.
    const manualId = generateId()
    await fs.writeFile(
      path.join(root, 'content', 'posts', `post.manual-entry.${manualId}.md`),
      'Body',
      'utf-8',
    )

    // Probe runs (interval 0) but the token is unchanged — B must NOT rescan.
    expect((await storeB.idIndex()).findById(manualId)).toBeNull()

    // The bump alone (no in-process registry involvement) makes B rebuild.
    await bumpContentIndexGeneration(root)
    expect((await storeB.idIndex()).findById(manualId)?.slug).toBe('manual-entry')
  })

  it('a slug rename in one store is resolved at the new path by the other store', async () => {
    const { root, store: storeA } = await makeStore()
    const { store: storeB } = await makeStore(root)
    await writeEntry(storeA, 'old-slug')
    const id = await getId(storeA, 'old-slug')
    await storeB.idIndex()
    expect((await storeB.idIndex()).findById(id)?.slug).toBe('old-slug')

    await storeA.renameEntry(posts, unsafeAsSlug('old-slug'), unsafeAsSlug('new-slug'))

    const location = (await storeB.idIndex()).findById(id)
    expect(location?.slug).toBe('new-slug')
    expect(location?.relativePath).not.toContain('old-slug')
  })

  it('a git-style on-disk mutation plus invalidateContentIndexesDurable reaches other stores', async () => {
    const { root, store: storeA } = await makeStore()
    const { store: storeB } = await makeStore(root)
    const doc = await writeEntry(storeA, 'pre-rebase')
    const id = await getId(storeA, 'pre-rebase')
    await storeB.idIndex()

    // Simulate a rebase/checkout swapping files underneath both stores,
    // performed by a third process that calls the durable invalidation.
    await fs.rename(doc.absolutePath, doc.absolutePath.replace('pre-rebase', 'post-rebase'))
    await invalidateContentIndexesDurable(root)

    expect((await storeB.idIndex()).findById(id)?.slug).toBe('post-rebase')
  })

  it('does not rebuild while the marker is unchanged, and throttles probes at the default interval', async () => {
    const { root, store: storeA } = await makeStore()
    const { store: storeB } = await makeStore(root)
    await writeEntry(storeA, 'stable')
    await storeB.idIndex()

    const buildSpy = vi.spyOn(ContentIdIndex.prototype, 'buildFromFilenames')
    try {
      // Marker stable — repeated accesses on both stores probe (interval 0)
      // but never rebuild.
      await Promise.all([storeA.idIndex(), storeB.idIndex()])
      await storeA.idIndex()
      await storeB.idIndex()
      expect(buildSpy).not.toHaveBeenCalled()

      // A store with the default interval doesn't even see a fresh bump yet:
      // its probe is throttled after the initial build.
      const { store: throttled } = await makeStore(root, 1000)
      await throttled.idIndex() // initial build (counts as a probe)
      buildSpy.mockClear()
      await bumpContentIndexGeneration(root)
      await throttled.idIndex() // within the interval — probe throttled, no rebuild
      expect(buildSpy).not.toHaveBeenCalled()
    } finally {
      buildSpy.mockRestore()
    }
  })

  it('readById self-heals on an ID miss inside the residual window (no marker bump)', async () => {
    const { root, store } = await makeStore()
    await writeEntry(store, 'seed')
    await store.idIndex()

    // File appears without any bump — models the NFS attribute-cache window
    // where another host's bump is not visible yet.
    const manualId = generateId()
    await fs.writeFile(
      path.join(root, 'content', 'posts', `post.hidden-entry.${manualId}.md`),
      'Body',
      'utf-8',
    )

    const buildSpy = vi.spyOn(ContentIdIndex.prototype, 'buildFromFilenames')
    try {
      // Miss → one forced rebuild → resolves.
      const doc = await store.readById(manualId as Parameters<ContentStore['readById']>[0])
      expect(doc?.relativePath).toContain('hidden-entry')
      expect(buildSpy).toHaveBeenCalledTimes(1)

      // A genuinely dangling ID does not rebuild again within the allowance window.
      const dangling = await store.readById(generateId() as Parameters<ContentStore['readById']>[0])
      expect(dangling).toBeNull()
      expect(buildSpy).toHaveBeenCalledTimes(1)
    } finally {
      buildSpy.mockRestore()
    }
  })

  it('readById self-heals on a stale hit whose file moved (no marker bump)', async () => {
    const { store } = await makeStore()
    const doc = await writeEntry(store, 'moves-away')
    const id = await getId(store, 'moves-away')
    await store.idIndex()

    // Rename on disk without a bump: the index still hits, but the read ENOENTs.
    await fs.rename(doc.absolutePath, doc.absolutePath.replace('moves-away', 'moved-here'))

    const healed = await store.readById(id)
    expect(healed?.relativePath).toContain('moved-here')
  })

  it('write() with existingId refuses to recreate an entry another store renamed', async () => {
    const { root, store: storeA } = await makeStore()
    // Large interval: models a store whose probe hasn't fired (residual window).
    const { store: storeB } = await makeStore(root, 60_000)
    await writeEntry(storeA, 'contested')
    const id = await getId(storeA, 'contested')
    await storeB.idIndex() // B's index now maps id → contested

    await storeA.renameEntry(posts, unsafeAsSlug('contested'), unsafeAsSlug('relocated'))

    // B, still stale, saves "in place" at the old slug — must conflict, not
    // recreate the old file (which would leave two files with the same ID).
    await expect(writeEntry(storeB, 'contested', id)).rejects.toThrow(ContentConflictError)
    const files = await fs.readdir(path.join(root, 'content', 'posts'))
    expect(files.filter((f) => f.includes(id))).toHaveLength(1)
  })

  it('write() with existingId recreates an entry another store deleted (last writer wins)', async () => {
    const { root, store: storeA } = await makeStore()
    const { store: storeB } = await makeStore(root, 60_000)
    await writeEntry(storeA, 'doomed')
    const id = await getId(storeA, 'doomed')
    await storeB.idIndex()

    await storeA.delete(posts, unsafeAsSlug('doomed'))

    // The ID is nowhere on disk — recreating is an allowed last-writer-wins.
    const recreated = await writeEntry(storeB, 'doomed', id)
    expect(recreated.relativePath).toContain('doomed')
    const files = await fs.readdir(path.join(root, 'content', 'posts'))
    expect(files.filter((f) => f.includes(id))).toHaveLength(1)
  })

  it("a store's own writes never trigger a self-rescan (adopted token)", async () => {
    const { store } = await makeStore() // interval 0: probes on every access
    await writeEntry(store, 'first')
    const buildSpy = vi.spyOn(ContentIdIndex.prototype, 'buildFromFilenames')
    try {
      await writeEntry(store, 'second')
      await store.idIndex()
      await store.read(posts, unsafeAsSlug('second'))
      expect(buildSpy).not.toHaveBeenCalled()
    } finally {
      buildSpy.mockRestore()
    }
  })

  it('rebuilds swap in a fresh index; in-flight holders keep a queryable snapshot', async () => {
    const { store } = await makeStore()
    await writeEntry(store, 'snapshot')
    const id = await getId(store, 'snapshot')

    const before = await store.idIndex()
    store.invalidateIndex()
    const after = await store.idIndex()

    expect(after).not.toBe(before)
    // The old snapshot was not cleared in place — holders across awaits still
    // get consistent answers.
    expect(before.findById(id)?.slug).toBe('snapshot')
    expect(after.findById(id)?.slug).toBe('snapshot')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Write-boundary helpers: documentExists + countEntriesOfType (D4 / SCH-H3)
// ─────────────────────────────────────────────────────────────────────────────

describe('ContentStore documentExists / countEntriesOfType', () => {
  const schema = {
    collections: [
      {
        name: 'posts',
        path: 'posts',
        entries: [
          { name: 'post', format: 'json' as const, schema: [], default: true },
          { name: 'settings', format: 'json' as const, schema: [], maxItems: 1 },
        ],
      },
    ],
  } as const

  const makeStore = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-'))
    const config = defineCanopyTestConfig({ schema })
    return new ContentStore(root, flattenSchema(schema, config.contentRoot))
  }

  it('reports existence of a document before and after write', async () => {
    const store = await makeStore()
    const posts = unsafeAsLogicalPath('content/posts')
    expect(await store.documentExists(posts, unsafeAsSlug('hello'))).toBe(false)
    await store.write(posts, unsafeAsSlug('hello'), { format: 'json', data: { a: 1 } })
    expect(await store.documentExists(posts, unsafeAsSlug('hello'))).toBe(true)
    expect(await store.documentExists(posts, unsafeAsSlug('other'))).toBe(false)
  })

  it('counts only entries of the requested entry type', async () => {
    const store = await makeStore()
    const posts = unsafeAsLogicalPath('content/posts')
    expect(await store.countEntriesOfType(posts, 'post')).toBe(0)
    await store.write(posts, unsafeAsSlug('one'), { format: 'json', data: {} }, 'post')
    await store.write(posts, unsafeAsSlug('two'), { format: 'json', data: {} }, 'post')
    await store.write(posts, unsafeAsSlug('main'), { format: 'json', data: {} }, 'settings')
    expect(await store.countEntriesOfType(posts, 'post')).toBe(2)
    expect(await store.countEntriesOfType(posts, 'settings')).toBe(1)
    expect(await store.countEntriesOfType(posts, 'nope')).toBe(0)
  })

  it('returns 0 for a collection directory that does not exist yet', async () => {
    const store = await makeStore()
    expect(await store.countEntriesOfType(unsafeAsLogicalPath('content/posts'), 'post')).toBe(0)
  })
})
