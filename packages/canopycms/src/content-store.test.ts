import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { defineCanopyTestConfig } from './config-test'
import { flattenSchema } from './config'
import { ContentStore, ContentStoreError } from './content-store'

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
              fields: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await store.write('content/posts', 'hello-world', {
      format: 'md',
      data: { title: 'Hello' },
      body: 'Body text',
    })

    const doc = await store.read('content/posts', 'hello-world')
    if (doc.format === 'json') throw new Error('expected markdown')
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
              fields: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await store.write('content/pages', 'landing', {
      format: 'mdx',
      data: { title: 'Landing' },
      body: '<Hero title="Hi" />',
    })

    const doc = await store.read('content/pages', 'landing')
    if (doc.format === 'json') throw new Error('expected mdx')
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
              fields: [{ name: 'siteName', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await store.write('content/config', 'site', {
      format: 'json',
      data: { siteName: 'CanopyCMS' },
    })

    const doc = await store.read('content/config', 'site')
    expect(doc.data.siteName).toBe('CanopyCMS')
    expect(doc.relativePath.endsWith('.json')).toBe(true)
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
              fields: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await expect(
      store.write('content/posts', '../escape', {
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
              fields: [{ name: 'siteName', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await store.write('content/settings', 'site', {
      format: 'json',
      data: { siteName: 'CanopyCMS' },
    })

    const doc = await store.read('content/settings', 'site')
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
              fields: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await expect(
      store.write('content/posts', '2024/hello', {
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
              fields: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    } as const

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    await expect(
      store.write('content/posts', 'bad\\slug', {
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
              fields: [{ name: 'title', type: 'string' as const }],
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
              fields: [{ name: 'siteName', type: 'string' as const }],
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
              fields: [{ name: 'title', type: 'string' as const }],
            },
          ],
          collections: [
            {
              name: 'guides',
              path: 'guides',
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
                      fields: [{ name: 'title', type: 'string' as const }],
                    },
                  ],
                  collections: [
                    {
                      name: 'endpoints',
                      path: 'endpoints',
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

    const config = defineCanopyTestConfig({ schema })
    const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

    // Write to 3-level nested collection
    await store.write('content/docs/api/v2', 'authentication', {
      format: 'md',
      data: { title: 'Authentication Guide' },
      body: '# Authentication\n\nHow to authenticate.',
    })

    // Read it back
    const doc = await store.read('content/docs/api/v2', 'authentication')
    if (doc.format === 'json') throw new Error('expected markdown')
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
                fields: [{ name: 'title', type: 'string' as const }],
              },
            ],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create an entry
      await store.write('content/posts', 'old-slug', {
        format: 'md',
        data: { title: 'Test Post' },
        body: 'Content here',
      })

      // Rename it
      const result = await store.renameEntry('content/posts', 'old-slug', 'new-slug')

      // Verify new path is returned
      expect(result.newPath).toBe('content/posts/new-slug')

      // Verify old path doesn't exist anymore
      await expect(store.read('content/posts', 'old-slug')).rejects.toThrow()

      // Verify new path works
      const doc = await store.read('content/posts', 'new-slug')
      if (doc.format === 'json') throw new Error('expected markdown')
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
            entries: [{ name: 'post', format: 'json' as const, fields: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      await expect(store.renameEntry('content/posts', 'nonexistent', 'new-slug')).rejects.toThrow(
        'Entry not found: nonexistent',
      )
    })

    it('throws when new slug already exists', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'json' as const, fields: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create two entries
      await store.write('content/posts', 'first-post', {
        format: 'json',
        data: { title: 'First' },
      })
      await store.write('content/posts', 'second-post', {
        format: 'json',
        data: { title: 'Second' },
      })

      // Try to rename first-post to second-post (conflict)
      await expect(store.renameEntry('content/posts', 'first-post', 'second-post')).rejects.toThrow(
        'already exists',
      )
    })

    it('validates slug format', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'json' as const, fields: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create an entry
      await store.write('content/posts', 'test-post', {
        format: 'json',
        data: { title: 'Test' },
      })

      // Try invalid slug with slash
      await expect(store.renameEntry('content/posts', 'test-post', 'invalid/slug')).rejects.toThrow(
        'cannot contain forward slashes',
      )

      // Try invalid slug with uppercase
      await expect(store.renameEntry('content/posts', 'test-post', 'Invalid-Slug')).rejects.toThrow(
        'must start with a letter or number',
      )
    })

    it('handles no-op when slug is unchanged', async () => {
      const root = await tmpDir()
      const schema = {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'json' as const, fields: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create an entry
      await store.write('content/posts', 'same-slug', {
        format: 'json',
        data: { title: 'Test' },
      })

      // Rename to same slug (no-op)
      const result = await store.renameEntry('content/posts', 'same-slug', 'same-slug')

      // Should return the same path
      expect(result.newPath).toBe('content/posts/same-slug')

      // Entry should still be readable
      const doc = await store.read('content/posts', 'same-slug')
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
            entries: [{ name: 'post', format: 'json' as const, fields: [] }],
          },
        ],
      } as const

      const config = defineCanopyTestConfig({ schema })
      const store = new ContentStore(root, flattenSchema(schema, config.contentRoot))

      // Create an entry
      await store.write('content/posts', 'original', {
        format: 'json',
        data: { title: 'Test' },
      })

      // Get the content ID before rename
      const idBefore = await store.getIdForEntry('content/posts', 'original')

      // Rename the entry
      await store.renameEntry('content/posts', 'original', 'renamed')

      // Get the content ID after rename
      const idAfter = await store.getIdForEntry('content/posts', 'renamed')

      // IDs should match (preserved through rename)
      expect(idBefore).toBe(idAfter)
      expect(idBefore).toBeTruthy()
    })
  })
})
