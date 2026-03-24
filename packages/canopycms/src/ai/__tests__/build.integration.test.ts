import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import { defineCanopyTestConfig } from '../../config-test'
import { flattenSchema, type RootCollectionConfig } from '../../config'
import { ContentStore } from '../../content-store'
import { unsafeAsLogicalPath, unsafeAsEntrySlug } from '../../paths/test-utils'
import { generateAIContentFiles } from '../../build/generate-ai-content'
import type { AIManifest } from '../types'

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-ai-build-'))

const testSchema: RootCollectionConfig = {
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
          schema: [{ name: 'siteName', type: 'string' as const }],
        },
      ],
    },
  ],
}

async function setupContent(root: string, schema: RootCollectionConfig) {
  const config = defineCanopyTestConfig({ schema })
  const flat = flattenSchema(schema, config.contentRoot)
  const store = new ContentStore(root, flat)

  await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsEntrySlug('hello-world'), {
    format: 'md',
    data: { title: 'Hello World', published: true },
    body: '# Hello\n\nFirst post.',
  })

  await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsEntrySlug('second'), {
    format: 'md',
    data: { title: 'Second', published: false },
    body: 'Second post.',
  })

  await store.write(unsafeAsLogicalPath('content/settings'), unsafeAsEntrySlug('site'), {
    format: 'json',
    data: { siteName: 'TestSite' },
  })

  return { config, flat, store }
}

describe('generateAIContentFiles', () => {
  let contentRoot: string
  let outputDir: string

  beforeEach(async () => {
    contentRoot = await tmpDir()
    outputDir = await tmpDir()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes all expected files to disk', async () => {
    const { config, flat } = await setupContent(contentRoot, testSchema)
    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)

    const result = await generateAIContentFiles({
      config: { ...config, mode: 'dev' },
      entrySchemaRegistry: {},
      outputDir,
      _testFlatSchema: flat,
    })

    expect(result.fileCount).toBeGreaterThan(0)

    // manifest.json exists and is valid
    const manifestPath = path.join(outputDir, 'manifest.json')
    const manifestContent = await fs.readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(manifestContent) as AIManifest
    expect(manifest.generated).toBeTruthy()
    expect(manifest.collections.length).toBeGreaterThan(0)

    // Individual entry files
    const postFile = path.join(outputDir, 'posts', 'hello-world.md')
    const postContent = await fs.readFile(postFile, 'utf-8')
    expect(postContent).toContain('Hello World')

    // Collection all.md
    const allPostsFile = path.join(outputDir, 'posts', 'all.md')
    const allPostsContent = await fs.readFile(allPostsFile, 'utf-8')
    expect(allPostsContent).toContain('Hello World')
    expect(allPostsContent).toContain('Second')

    // Settings
    const settingFile = path.join(outputDir, 'settings', 'site.md')
    const settingContent = await fs.readFile(settingFile, 'utf-8')
    expect(settingContent).toContain('TestSite')
  })

  it('file count matches actual files on disk', async () => {
    const { config, flat } = await setupContent(contentRoot, testSchema)
    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)

    const result = await generateAIContentFiles({
      config: { ...config, mode: 'dev' },
      entrySchemaRegistry: {},
      outputDir,
      _testFlatSchema: flat,
    })

    // Count files recursively on disk
    const countFiles = async (dir: string): Promise<number> => {
      let count = 0
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          count += await countFiles(path.join(dir, entry.name))
        } else {
          count++
        }
      }
      return count
    }

    const filesOnDisk = await countFiles(outputDir)
    expect(filesOnDisk).toBe(result.fileCount)
  })

  it('writes bundles to bundles/ subdirectory', async () => {
    const { config, flat } = await setupContent(contentRoot, testSchema)
    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)

    await generateAIContentFiles({
      config: { ...config, mode: 'dev' },
      entrySchemaRegistry: {},
      outputDir,
      _testFlatSchema: flat,
      aiConfig: {
        bundles: [
          {
            name: 'published',
            description: 'Published posts',
            filter: {
              collections: ['posts'],
              where: (entry) => entry.data.published === true,
            },
          },
        ],
      },
    })

    const bundleFile = path.join(outputDir, 'bundles', 'published.md')
    const bundleContent = await fs.readFile(bundleFile, 'utf-8')
    expect(bundleContent).toContain('Hello World')
    expect(bundleContent).not.toContain('Second')
  })

  it('creates correct directory structure', async () => {
    const { config, flat } = await setupContent(contentRoot, testSchema)
    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)

    await generateAIContentFiles({
      config: { ...config, mode: 'dev' },
      entrySchemaRegistry: {},
      outputDir,
      _testFlatSchema: flat,
    })

    // Check directory structure
    const topLevel = await fs.readdir(outputDir)
    expect(topLevel).toContain('manifest.json')
    expect(topLevel).toContain('posts')
    expect(topLevel).toContain('settings')

    const postsDir = await fs.readdir(path.join(outputDir, 'posts'))
    expect(postsDir).toContain('all.md')
    expect(postsDir).toContain('hello-world.md')
    expect(postsDir).toContain('second.md')
  })
})
