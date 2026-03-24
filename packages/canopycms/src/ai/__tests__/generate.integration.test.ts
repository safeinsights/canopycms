import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, beforeEach } from 'vitest'

import { defineCanopyTestConfig } from '../../config-test'
import { flattenSchema } from '../../config'
import { ContentStore } from '../../content-store'
import { unsafeAsLogicalPath, unsafeAsEntrySlug } from '../../paths/test-utils'
import { generateAIContent } from '../generate'
import type { AIContentConfig, AIManifest } from '../types'

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-ai-'))

// Shared schema for most tests
const testSchema = {
  entries: [
    {
      name: 'page',
      format: 'md' as const,
      schema: [{ name: 'title', type: 'string' as const }],
    },
  ],
  collections: [
    {
      name: 'posts',
      path: 'posts',
      description: 'Blog posts collection',
      entries: [
        {
          name: 'post',
          format: 'md' as const,
          schema: [
            { name: 'title', type: 'string' as const },
            { name: 'published', type: 'boolean' as const },
          ],
          default: true,
        },
      ],
    },
    {
      name: 'settings',
      path: 'settings',
      entries: [
        {
          name: 'setting',
          format: 'json' as const,
          schema: [
            { name: 'siteName', type: 'string' as const },
            { name: 'logo', type: 'image' as const },
          ],
        },
      ],
    },
    {
      name: 'docs',
      path: 'docs',
      entries: [
        {
          name: 'doc',
          format: 'md' as const,
          schema: [{ name: 'title', type: 'string' as const }],
          default: true,
        },
      ],
      collections: [
        {
          name: 'api',
          path: 'docs/api',
          entries: [
            {
              name: 'doc',
              format: 'md' as const,
              schema: [{ name: 'title', type: 'string' as const }],
              default: true,
            },
          ],
        },
      ],
    },
    {
      name: 'drafts',
      path: 'drafts',
      entries: [
        {
          name: 'draft',
          format: 'md' as const,
          schema: [{ name: 'title', type: 'string' as const }],
        },
      ],
    },
  ],
} as const

async function setupContentTree(root: string, flatSchema: ReturnType<typeof flattenSchema>) {
  const store = new ContentStore(root, flatSchema)

  // Root-level entry
  await store.write(
    unsafeAsLogicalPath('content'),
    unsafeAsEntrySlug('home'),
    {
      format: 'md',
      data: { title: 'Home' },
      body: 'Welcome to our site.',
    },
    'page',
  )

  // Posts
  await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsEntrySlug('hello-world'), {
    format: 'md',
    data: { title: 'Hello World', published: true },
    body: '# Hello\n\nFirst post.',
  })

  await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsEntrySlug('second-post'), {
    format: 'md',
    data: { title: 'Second Post', published: false },
    body: '# Second\n\nAnother post.',
  })

  // Settings (JSON)
  await store.write(unsafeAsLogicalPath('content/settings'), unsafeAsEntrySlug('site'), {
    format: 'json',
    data: { siteName: 'TestSite', logo: '/images/logo.png' },
  })

  // Docs
  await store.write(unsafeAsLogicalPath('content/docs'), unsafeAsEntrySlug('overview'), {
    format: 'md',
    data: { title: 'Overview' },
    body: 'Documentation overview.',
  })

  // Docs > API (subcollection)
  await store.write(unsafeAsLogicalPath('content/docs/api'), unsafeAsEntrySlug('authentication'), {
    format: 'md',
    data: { title: 'Authentication' },
    body: 'Auth docs.',
  })

  // Drafts (will be excluded in some tests)
  await store.write(unsafeAsLogicalPath('content/drafts'), unsafeAsEntrySlug('wip'), {
    format: 'md',
    data: { title: 'Work in Progress' },
    body: 'Draft content.',
  })

  return store
}

describe('generateAIContent', () => {
  let root: string
  let config: ReturnType<typeof defineCanopyTestConfig>
  let flat: ReturnType<typeof flattenSchema>
  let store: ContentStore

  beforeEach(async () => {
    root = await tmpDir()
    config = defineCanopyTestConfig({ schema: testSchema })
    flat = flattenSchema(testSchema, config.contentRoot)
    store = await setupContentTree(root, flat)
  })

  it('generates files for all collections and entries', async () => {
    const result = await generateAIContent({
      store,
      flatSchema: flat,
      contentRoot: config.contentRoot,
    })

    // Should have manifest
    expect(result.files.has('manifest.json')).toBe(true)

    // Per-entry files
    expect(result.files.has('posts/hello-world.md')).toBe(true)
    expect(result.files.has('posts/second-post.md')).toBe(true)
    expect(result.files.has('settings/site.md')).toBe(true)
    expect(result.files.has('docs/overview.md')).toBe(true)
    expect(result.files.has('docs/api/authentication.md')).toBe(true)
    expect(result.files.has('drafts/wip.md')).toBe(true)

    // Per-collection all.md
    expect(result.files.has('posts/all.md')).toBe(true)
    expect(result.files.has('settings/all.md')).toBe(true)
    expect(result.files.has('docs/all.md')).toBe(true)

    // Root entry
    expect(result.files.has('home.md')).toBe(true)
  })

  it('produces correct manifest structure', async () => {
    const result = await generateAIContent({
      store,
      flatSchema: flat,
      contentRoot: config.contentRoot,
    })

    const manifest = result.manifest
    expect(manifest.generated).toBeTruthy()

    // Root entries
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.entries[0].slug).toBe('home')

    // Collections
    const posts = manifest.collections.find((c) => c.name === 'posts')
    expect(posts).toBeDefined()
    expect(posts!.description).toBe('Blog posts collection')
    expect(posts!.entries).toHaveLength(2)
    expect(posts!.path).toBe('posts')
    expect(posts!.allFile).toBe('posts/all.md')

    const docs = manifest.collections.find((c) => c.name === 'docs')
    expect(docs).toBeDefined()
    expect(docs!.subcollections).toHaveLength(1)
    expect(docs!.subcollections![0].name).toBe('api')
  })

  it('manifest entry counts match actual files', async () => {
    const result = await generateAIContent({
      store,
      flatSchema: flat,
      contentRoot: config.contentRoot,
    })

    for (const collection of result.manifest.collections) {
      // Verify every entry referenced in manifest exists in files
      for (const entry of collection.entries) {
        expect(result.files.has(entry.file)).toBe(true)
      }
    }

    for (const entry of result.manifest.entries) {
      expect(result.files.has(entry.file)).toBe(true)
    }
  })

  it('strips content root from all output paths', async () => {
    const result = await generateAIContent({
      store,
      flatSchema: flat,
      contentRoot: config.contentRoot,
    })

    for (const filePath of result.files.keys()) {
      expect(filePath.startsWith('content/')).toBe(false)
    }
  })

  it('no embedded IDs appear in output paths or file keys', async () => {
    const result = await generateAIContent({
      store,
      flatSchema: flat,
      contentRoot: config.contentRoot,
    })

    // Embedded IDs are 12-char alphanumeric patterns in filenames like "post.slug.bChqT78gcaLd.md"
    const idPattern = /\.[A-Za-z0-9_]{12}\./
    for (const filePath of result.files.keys()) {
      expect(filePath).not.toMatch(idPattern)
    }
  })

  it('all.md contains concatenated entries', async () => {
    const result = await generateAIContent({
      store,
      flatSchema: flat,
      contentRoot: config.contentRoot,
    })

    const allPosts = result.files.get('posts/all.md')!
    expect(allPosts).toContain('Hello World')
    expect(allPosts).toContain('Second Post')
    // Entries separated by ---
    expect(allPosts).toContain('---')
  })

  describe('exclusion', () => {
    it('excludes collections by path', async () => {
      const aiConfig: AIContentConfig = {
        exclude: { collections: ['drafts'] },
      }

      const result = await generateAIContent({
        store,
        flatSchema: flat,
        contentRoot: config.contentRoot,
        config: aiConfig,
      })

      expect(result.files.has('drafts/wip.md')).toBe(false)
      expect(result.files.has('drafts/all.md')).toBe(false)
      const draftCollection = result.manifest.collections.find((c) => c.name === 'drafts')
      expect(draftCollection).toBeUndefined()

      // Other collections still present
      expect(result.files.has('posts/hello-world.md')).toBe(true)
    })

    it('excludes entry types', async () => {
      const aiConfig: AIContentConfig = {
        exclude: { entryTypes: ['setting'] },
      }

      const result = await generateAIContent({
        store,
        flatSchema: flat,
        contentRoot: config.contentRoot,
        config: aiConfig,
      })

      expect(result.files.has('settings/site.md')).toBe(false)
      // Posts still present
      expect(result.files.has('posts/hello-world.md')).toBe(true)
    })

    it('excludes entries by predicate', async () => {
      const aiConfig: AIContentConfig = {
        exclude: {
          where: (entry) => entry.data.published === false,
        },
      }

      const result = await generateAIContent({
        store,
        flatSchema: flat,
        contentRoot: config.contentRoot,
        config: aiConfig,
      })

      expect(result.files.has('posts/second-post.md')).toBe(false)
      expect(result.files.has('posts/hello-world.md')).toBe(true)
    })
  })

  describe('bundles', () => {
    it('creates bundle files from filtered entries', async () => {
      const aiConfig: AIContentConfig = {
        bundles: [
          {
            name: 'published-posts',
            description: 'All published blog posts',
            filter: {
              collections: ['posts'],
              where: (entry) => entry.data.published === true,
            },
          },
        ],
      }

      const result = await generateAIContent({
        store,
        flatSchema: flat,
        contentRoot: config.contentRoot,
        config: aiConfig,
      })

      expect(result.files.has('bundles/published-posts.md')).toBe(true)
      const bundleContent = result.files.get('bundles/published-posts.md')!
      expect(bundleContent).toContain('Hello World')
      expect(bundleContent).not.toContain('Second Post')

      // Manifest bundle
      const bundleMeta = result.manifest.bundles.find((b) => b.name === 'published-posts')
      expect(bundleMeta).toBeDefined()
      expect(bundleMeta!.entryCount).toBe(1)
      expect(bundleMeta!.description).toBe('All published blog posts')
    })

    it('creates bundle filtered by entry type', async () => {
      const aiConfig: AIContentConfig = {
        bundles: [
          {
            name: 'all-settings',
            filter: { entryTypes: ['setting'] },
          },
        ],
      }

      const result = await generateAIContent({
        store,
        flatSchema: flat,
        contentRoot: config.contentRoot,
        config: aiConfig,
      })

      expect(result.files.has('bundles/all-settings.md')).toBe(true)
      const bundleContent = result.files.get('bundles/all-settings.md')!
      expect(bundleContent).toContain('TestSite')
    })
  })

  describe('content correctness', () => {
    it('MD entry markdown contains frontmatter and body', async () => {
      const result = await generateAIContent({
        store,
        flatSchema: flat,
        contentRoot: config.contentRoot,
      })

      const postMd = result.files.get('posts/hello-world.md')!
      // Frontmatter
      expect(postMd).toContain('slug: hello-world')
      expect(postMd).toContain('collection: posts')
      expect(postMd).toContain('type: post')
      // Body
      expect(postMd).toContain('# Hello')
      expect(postMd).toContain('First post.')
    })

    it('JSON entry markdown contains schema-driven fields', async () => {
      const result = await generateAIContent({
        store,
        flatSchema: flat,
        contentRoot: config.contentRoot,
      })

      const settingMd = result.files.get('settings/site.md')!
      expect(settingMd).toContain('slug: site')
      expect(settingMd).toContain('TestSite')
      expect(settingMd).toContain('![') // image field
    })

    it('manifest.json is valid JSON', async () => {
      const result = await generateAIContent({
        store,
        flatSchema: flat,
        contentRoot: config.contentRoot,
      })

      const manifestJson = result.files.get('manifest.json')!
      const parsed = JSON.parse(manifestJson) as AIManifest
      expect(parsed.generated).toBeTruthy()
      expect(Array.isArray(parsed.collections)).toBe(true)
      expect(Array.isArray(parsed.bundles)).toBe(true)
    })
  })

  describe('field transforms', () => {
    it('applies field transform in generated output', async () => {
      const aiConfig: AIContentConfig = {
        fieldTransforms: {
          setting: {
            siteName: (value) => `## Site Name\n\nCustom: ${String(value)}`,
          },
        },
      }

      const result = await generateAIContent({
        store,
        flatSchema: flat,
        contentRoot: config.contentRoot,
        config: aiConfig,
      })

      const settingMd = result.files.get('settings/site.md')!
      expect(settingMd).toContain('Custom: TestSite')
    })
  })
})
