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
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

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
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'pages',
            path: 'pages',
            entries: [{ name: 'page', format: 'mdx', fields: [{ name: 'title', type: 'string' }] }],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

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
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'settings',
            path: 'config',
            entries: [{ name: 'setting', format: 'json', fields: [{ name: 'siteName', type: 'string' }] }],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

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
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

    await expect(
      store.write('content/posts', '../escape', { format: 'md', data: { title: 'bad' }, body: 'x' })
    ).rejects.toBeInstanceOf(ContentStoreError)
  })

  it('reads and writes entry items with a slug', async () => {
    const root = await tmpDir()
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'settings',
            path: 'settings',
            entries: [{ name: 'setting', format: 'json', fields: [{ name: 'siteName', type: 'string' }] }],
          },
        ],
      },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

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
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

    await expect(
      store.write('content/posts', '2024/hello', {
        format: 'md',
        data: { title: 'Bad Slug' },
        body: 'Content',
      })
    ).rejects.toThrow('Slugs cannot contain forward slashes')
  })

  it('rejects slugs with backslashes', async () => {
    const root = await tmpDir()
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

    await expect(
      store.write('content/posts', 'bad\\slug', {
        format: 'md',
        data: { title: 'Bad Slug' },
        body: 'Content',
      })
    ).rejects.toThrow('Slugs cannot contain backslashes')
  })

  it('resolves paths using trivial algorithm: collection + slug', async () => {
    const root = await tmpDir()
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: [{ name: 'post', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

    // Path: content/posts/hello -> collection=content/posts, slug=hello
    const result = store.resolvePath(['content', 'posts', 'hello'])
    expect(result.schemaItem.fullPath).toBe('content/posts')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('hello')
  })

  it('resolves paths for collection entries with slug', async () => {
    const root = await tmpDir()
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'settings',
            path: 'settings',
            entries: [{ name: 'setting', format: 'json', fields: [{ name: 'siteName', type: 'string' }] }],
          },
        ],
      },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

    // Path: content/settings/site -> collection entry with slug
    const result = store.resolvePath(['content', 'settings', 'site'])
    expect(result.schemaItem.fullPath).toBe('content/settings')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('site')
  })

  it('resolves nested collection paths', async () => {
    const root = await tmpDir()
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
            collections: [
              {
                name: 'guides',
                path: 'guides',
                entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
              },
            ],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

    // Path: content/docs/guides/getting-started
    // -> collection=content/docs/guides, slug=getting-started
    const result = store.resolvePath(['content', 'docs', 'guides', 'getting-started'])
    expect(result.schemaItem.fullPath).toBe('content/docs/guides')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('getting-started')
  })

  it('resolves 3-level nested collection paths', async () => {
    const root = await tmpDir()
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
            collections: [
              {
                name: 'api',
                path: 'api',
                entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
                collections: [
                  {
                    name: 'v2',
                    path: 'v2',
                    entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
                  },
                ],
              },
            ],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

    // Path: content/docs/api/v2/authentication
    // -> collection=content/docs/api/v2, slug=authentication
    const result = store.resolvePath(['content', 'docs', 'api', 'v2', 'authentication'])
    expect(result.schemaItem.fullPath).toBe('content/docs/api/v2')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('authentication')
  })

  it('resolves 4-level nested collection paths', async () => {
    const root = await tmpDir()
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
            collections: [
              {
                name: 'api',
                path: 'api',
                entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
                collections: [
                  {
                    name: 'v2',
                    path: 'v2',
                    entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
                    collections: [
                      {
                        name: 'endpoints',
                        path: 'endpoints',
                        entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
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
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

    // Path: content/docs/api/v2/endpoints/users
    // -> collection=content/docs/api/v2/endpoints, slug=users
    const result = store.resolvePath(['content', 'docs', 'api', 'v2', 'endpoints', 'users'])
    expect(result.schemaItem.fullPath).toBe('content/docs/api/v2/endpoints')
    expect(result.schemaItem.type).toBe('collection')
    expect(result.slug).toBe('users')
  })

  it('writes and reads content in deeply nested collections', async () => {
    const root = await tmpDir()
    const config = defineCanopyTestConfig({
      schema: {
        collections: [
          {
            name: 'docs',
            path: 'docs',
            entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
            collections: [
              {
                name: 'api',
                path: 'api',
                entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
                collections: [
                  {
                    name: 'v2',
                    path: 'v2',
                    entries: [{ name: 'entry', format: 'md', fields: [{ name: 'title', type: 'string' }] }],
                  },
                ],
              },
            ],
          },
        ],
              },
    })
    const store = new ContentStore(root, flattenSchema(config.schema!, config.contentRoot))

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
    expect(doc.relativePath).toMatch(/^content\/docs\/api\/v2\/entry\.authentication\.[a-zA-Z0-9]{12}\.md$/)
  })
})
