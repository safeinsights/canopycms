import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import { defineCanopyTestConfig } from '../../config-test'
import { flattenSchema, type RootCollectionConfig } from '../../config'
import { ContentStore } from '../../content-store'
import { unsafeAsLogicalPath, unsafeAsSlug } from '../../paths/test-utils'
import { GENERATED_RECORD_FILENAME, generateAIContentFiles } from '../../build/generate-ai-content'
import type { AIManifest } from '../types'

const scaffoldSchema: RootCollectionConfig = {
  collections: [
    {
      name: 'posts',
      path: 'posts',
      entries: [
        {
          name: 'post',
          format: 'md' as const,
          schema: [{ name: 'title', type: 'string' as const, required: true }],
          default: true,
        },
      ],
    },
  ],
}

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

  await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('hello-world'), {
    format: 'md',
    data: { title: 'Hello World', published: true },
    body: '# Hello\n\nFirst post.',
  })

  await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('second'), {
    format: 'md',
    data: { title: 'Second', published: false },
    body: 'Second post.',
  })

  await store.write(unsafeAsLogicalPath('content/settings'), unsafeAsSlug('site'), {
    format: 'json',
    data: { siteName: 'TestSite' },
  })

  return { config, flat, store }
}

// `generateAIContentFiles` reads CANOPY_BUILD_ID / SOURCE_DATE_EPOCH from the ambient environment,
// so EVERY test in this file — not just the build-stamp ones — is sensitive to them. Scrubbed at
// file level because the README now tells adopters to export CANOPY_BUILD_ID, which makes "a
// developer exercising this feature has it set in their shell" the expected case rather than an
// exotic one; without this, unrelated pre-existing assertions fail on their machine and not in CI.
const BUILD_STAMP_ENV = ['CANOPY_BUILD_ID', 'SOURCE_DATE_EPOCH'] as const
const savedBuildStampEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of BUILD_STAMP_ENV) {
    savedBuildStampEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of BUILD_STAMP_ENV) {
    const value = savedBuildStampEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

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
      config: { ...config, mode: 'dev', deployedAs: 'static' },
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
      config: { ...config, mode: 'dev', deployedAs: 'static' },
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
        } else if (entry.name !== GENERATED_RECORD_FILENAME) {
          // Bookkeeping, not generated content: it records which files the run produced so a
          // later run can prune what it no longer produces. It is not part of `fileCount`.
          count++
        }
      }
      return count
    }

    const filesOnDisk = await countFiles(outputDir)
    expect(filesOnDisk).toBe(result.fileCount)
  })

  describe('pruning output from a previous run', () => {
    // Seeding and generating are deliberately separate: a prune only happens when a LATER run
    // produces less than an earlier one, so a helper that re-seeds content on every call would
    // make every run identical and quietly assert nothing.
    const seed = () => setupContent(contentRoot, testSchema)

    const generate = async (
      config: Awaited<ReturnType<typeof seed>>['config'],
      flat: Awaited<ReturnType<typeof seed>>['flat'],
    ) => {
      vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)
      return generateAIContentFiles({
        config: { ...config, mode: 'dev', deployedAs: 'static' },
        entrySchemaRegistry: {},
        outputDir,
        _testFlatSchema: flat,
      })
    }

    const exists = async (p: string): Promise<boolean> => {
      try {
        await fs.stat(p)
        return true
      } catch {
        return false
      }
    }

    it('removes a file the current run no longer produces', async () => {
      const { config, flat, store } = await seed()
      const first = await generate(config, flat)
      expect(first.removedCount).toBe(0)
      const renamedAway = path.join(outputDir, 'posts', 'hello-world.md')
      expect(await exists(renamedAway)).toBe(true)

      // Re-model the content the way a slug rename or an IA restructure would: the entry still
      // exists, but under a different path. The old output file is what used to be left behind,
      // advertising a URL the site no longer serves.
      await store.delete(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('hello-world'))
      await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('hello-world-renamed'), {
        format: 'md',
        data: { title: 'Hello World', published: true },
        body: '# Hello\n\nFirst post.',
      })

      const second = await generate(config, flat)
      expect(await exists(renamedAway)).toBe(false)
      expect(await exists(path.join(outputDir, 'posts', 'hello-world-renamed.md'))).toBe(true)
      expect(second.removedCount).toBeGreaterThan(0)
    })

    it('never removes a file it did not write', async () => {
      const { config, flat } = await seed()
      await generate(config, flat)

      // The output directory belongs to the adopter, not to this tool. Anything the tool cannot
      // prove it created must survive — which is why this prunes from its own record rather than
      // clearing the directory.
      const foreign = path.join(outputDir, 'adopter-owned.txt')
      await fs.writeFile(foreign, 'not ours', 'utf-8')
      const foreignNested = path.join(outputDir, 'hand-written', 'notes.md')
      await fs.mkdir(path.dirname(foreignNested), { recursive: true })
      await fs.writeFile(foreignNested, 'also not ours', 'utf-8')

      await generate(config, flat)

      expect(await exists(foreign)).toBe(true)
      expect(await exists(foreignNested)).toBe(true)
    })

    it('survives a missing or malformed record without failing the build', async () => {
      const { config, flat } = await seed()
      await generate(config, flat)
      await fs.writeFile(
        path.join(outputDir, GENERATED_RECORD_FILENAME),
        'this is not json',
        'utf-8',
      )

      // Pruning is an optimisation; a corrupt bookkeeping file must degrade to the old behaviour
      // (leave strays) rather than take the build down.
      const result = await generate(config, flat)
      expect(result.fileCount).toBeGreaterThan(0)
      expect(result.removedCount).toBe(0)
      expect(await exists(path.join(outputDir, 'manifest.json'))).toBe(true)
    })

    it('keeps the output directory itself even when everything under it is pruned', async () => {
      const { config, flat } = await seed()
      await generate(config, flat)
      expect(await exists(outputDir)).toBe(true)
      const record = JSON.parse(
        await fs.readFile(path.join(outputDir, GENERATED_RECORD_FILENAME), 'utf-8'),
      ) as { files: string[] }
      expect(record.files.length).toBeGreaterThan(0)
      expect(record.files).not.toContain(GENERATED_RECORD_FILENAME)
    })
  })

  it('writes bundles to bundles/ subdirectory', async () => {
    const { config, flat } = await setupContent(contentRoot, testSchema)
    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)

    await generateAIContentFiles({
      config: { ...config, mode: 'dev', deployedAs: 'static' },
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

  it('rejects path traversal in bundle names', async () => {
    const { config, flat } = await setupContent(contentRoot, testSchema)
    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)

    await expect(
      generateAIContentFiles({
        config: { ...config, mode: 'dev', deployedAs: 'static' },
        entrySchemaRegistry: {},
        outputDir,
        _testFlatSchema: flat,
        aiConfig: {
          bundles: [
            {
              name: '../../etc/malicious',
              filter: { collections: ['posts'] },
            },
          ],
        },
      }),
    ).rejects.toThrow('Invalid bundle name')
  })

  it('creates correct directory structure', async () => {
    const { config, flat } = await setupContent(contentRoot, testSchema)
    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)

    await generateAIContentFiles({
      config: { ...config, mode: 'dev', deployedAs: 'static' },
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

  it('rejects an abandoned create-scaffold (schema-invalid empty entry)', async () => {
    const config = defineCanopyTestConfig({ schema: scaffoldSchema })
    const flat = flattenSchema(scaffoldSchema, config.contentRoot)
    const store = new ContentStore(contentRoot, flat)

    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('hello-world'), {
      format: 'md',
      data: { title: 'Hello World' },
      body: '# Hello',
    })
    // Abandoned create-scaffold: the editor's create flow writes this before the user fills it
    // in, and nothing else re-validates it once it's on disk.
    const scaffoldSlug = unsafeAsSlug('untitled')
    await store.write(unsafeAsLogicalPath('content/posts'), scaffoldSlug, {
      format: 'md',
      data: {},
      body: '',
    })

    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)

    await expect(
      generateAIContentFiles({
        config: { ...config, mode: 'dev', deployedAs: 'static' },
        entrySchemaRegistry: {},
        outputDir,
        _testFlatSchema: flat,
      }),
    ).rejects.toThrow(/CanopyCMS static build:.*content\/posts\/untitled/s)
  })

  it('resolves once the abandoned scaffold is fixed', async () => {
    const config = defineCanopyTestConfig({ schema: scaffoldSchema })
    const flat = flattenSchema(scaffoldSchema, config.contentRoot)
    const store = new ContentStore(contentRoot, flat)

    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('hello-world'), {
      format: 'md',
      data: { title: 'Hello World' },
      body: '# Hello',
    })
    const scaffoldSlug = unsafeAsSlug('untitled')
    await store.write(unsafeAsLogicalPath('content/posts'), scaffoldSlug, {
      format: 'md',
      data: {},
      body: '',
    })

    // Fix the scaffold by filling in the required field.
    await store.write(unsafeAsLogicalPath('content/posts'), scaffoldSlug, {
      format: 'md',
      data: { title: 'Untitled No More' },
      body: '# Untitled No More',
    })

    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)

    const result = await generateAIContentFiles({
      config: { ...config, mode: 'dev', deployedAs: 'static' },
      entrySchemaRegistry: {},
      outputDir,
      _testFlatSchema: flat,
    })

    expect(result.fileCount).toBeGreaterThan(0)
  })
})

describe('manifest build stamp', () => {
  let contentRoot: string

  beforeEach(async () => {
    contentRoot = await tmpDir()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Fake timers are NOT undone by restoreAllMocks. Restored here rather than in the one test
    // that installs them, so a throw mid-test cannot leave the rest of the file frozen in 2026.
    vi.useRealTimers()
  })

  /** Generate into a fresh output dir and return the manifest file's RAW bytes. */
  async function generateManifestRaw(): Promise<string> {
    const { config, flat } = await setupContent(contentRoot, testSchema)
    vi.spyOn(process, 'cwd').mockReturnValue(contentRoot)
    const out = await tmpDir()
    await generateAIContentFiles({
      config: { ...config, mode: 'dev', deployedAs: 'static' },
      entrySchemaRegistry: {},
      outputDir: out,
      _testFlatSchema: flat,
    })
    return await fs.readFile(path.join(out, 'manifest.json'), 'utf-8')
  }

  /** The same, parsed. Read from the FILE rather than the in-memory object: key omission is the
   * behaviour under test, and only the serialized form can show a key is genuinely absent. */
  async function generateManifest(): Promise<Record<string, unknown>> {
    return JSON.parse(await generateManifestRaw()) as Record<string, unknown>
  }

  it('emits a live timestamp and no buildId when neither variable is set', async () => {
    const manifest = await generateManifest()
    expect(typeof manifest.generated).toBe('string')
    expect(Date.parse(manifest.generated as string)).not.toBeNaN()
    expect(manifest).not.toHaveProperty('buildId')
  })

  it('emits buildId and OMITS generated when only CANOPY_BUILD_ID is set', async () => {
    process.env.CANOPY_BUILD_ID = 'fd91b36c'
    const manifest = await generateManifest()
    // Positive assertion paired with the absence one on purpose: `not.toHaveProperty` alone also
    // passes against a manifest that failed to build, or a renamed key.
    expect(manifest.buildId).toBe('fd91b36c')
    expect(manifest).not.toHaveProperty('generated')
  })

  it('emits both, with generated pinned, when SOURCE_DATE_EPOCH is also set', async () => {
    process.env.CANOPY_BUILD_ID = 'fd91b36c'
    process.env.SOURCE_DATE_EPOCH = '1700000000'
    const manifest = await generateManifest()
    expect(manifest.buildId).toBe('fd91b36c')
    expect(manifest.generated).toBe('2023-11-14T22:13:20.000Z')
  })

  it('pins generated from SOURCE_DATE_EPOCH with no build id at all', async () => {
    process.env.SOURCE_DATE_EPOCH = '1700000000'
    const manifest = await generateManifest()
    expect(manifest.generated).toBe('2023-11-14T22:13:20.000Z')
    expect(manifest).not.toHaveProperty('buildId')
  })

  it('produces byte-identical manifests across two runs when pinned', async () => {
    process.env.CANOPY_BUILD_ID = 'fd91b36c'
    process.env.SOURCE_DATE_EPOCH = '1700000000'
    // Raw bytes, not JSON.stringify(parse(...)): a round trip would hide any difference the
    // serializer normalises away, and byte-equality on disk is the actual promise being made.
    expect(await generateManifestRaw()).toBe(await generateManifestRaw())
  })

  it('differs across two runs when nothing is pinned', async () => {
    // The control for the test above: proves byte-equality there comes from the pin rather than
    // from the manifest being trivially stable anyway.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const first = (await generateManifest()).generated
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
    const second = (await generateManifest()).generated
    expect(first).not.toBe(second)
  })

  it.each(['not-a-number', '0x10', '17e8', '-1700000000', '99999999999999999999'])(
    'ignores a malformed SOURCE_DATE_EPOCH (%s) without throwing, and does not resurrect generated',
    async (bad) => {
      process.env.CANOPY_BUILD_ID = 'fd91b36c'
      process.env.SOURCE_DATE_EPOCH = bad
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const manifest = await generateManifest()
      expect(manifest.buildId).toBe('fd91b36c')
      expect(manifest).not.toHaveProperty('generated')
      expect(warn).toHaveBeenCalled()
    },
  )

  it('trims a padded CANOPY_BUILD_ID so it matches the id Next stores for the same artifact', async () => {
    process.env.CANOPY_BUILD_ID = '  fd91b36c  '
    const manifest = await generateManifest()
    expect(manifest.buildId).toBe('fd91b36c')
  })

  it('treats a whitespace-only CANOPY_BUILD_ID as unset, and warns that it did', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.CANOPY_BUILD_ID = '   '
    const manifest = await generateManifest()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('set but blank'))
    expect(manifest).not.toHaveProperty('buildId')
    // And therefore `generated` must come back — the omission is keyed on a real build id.
    expect(typeof manifest.generated).toBe('string')
  })

  it.each(['heads/main', '..', 'has space'])(
    'rejects an unusable CANOPY_BUILD_ID (%s) and records none',
    async (value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.CANOPY_BUILD_ID = value
      const manifest = await generateManifest()
      expect(manifest).not.toHaveProperty('buildId')
      // Rejected, so `generated` comes back: the omission is keyed on a USABLE build id.
      expect(typeof manifest.generated).toBe('string')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[A-Za-z0-9._-]+'))
    },
  )

  it('warns when SOURCE_DATE_EPOCH is set but blank, matching CANOPY_BUILD_ID', async () => {
    // Both variables treat set-but-unusable as a broken pipeline. This one matters more than it
    // looks: with a build id also set, an unpinned timestamp means `generated` is OMITTED, so the
    // field disappears with no other signal.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.SOURCE_DATE_EPOCH = '  '
    const manifest = await generateManifest()
    expect(typeof manifest.generated).toBe('string')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SOURCE_DATE_EPOCH is set but blank'))
  })

  it('tolerates surrounding whitespace in SOURCE_DATE_EPOCH', async () => {
    // Trimmed, not rejected: the intent of a shell-exported ` 1700000000 ` is unambiguous.
    process.env.SOURCE_DATE_EPOCH = ' 1700000000 '
    const manifest = await generateManifest()
    expect(manifest.generated).toBe('2023-11-14T22:13:20.000Z')
  })

  it('falls back to a live clock for a malformed value when no build id is set', async () => {
    process.env.SOURCE_DATE_EPOCH = 'not-a-number'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const manifest = await generateManifest()
    expect(typeof manifest.generated).toBe('string')
    expect(Date.parse(manifest.generated as string)).not.toBeNaN()
  })
})
