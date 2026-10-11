import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../../config-test'
import { flattenSchema, type RootCollectionConfig } from '../../config'
import { ContentStore } from '../../content-store'
import { extractIdFromFilename } from '../../content-id-index'
import { listEntries, type ListEntriesOptions } from '../../content-listing'
import { unsafeAsLogicalPath, unsafeAsSlug } from '../../paths/test-utils'
import { collectStaticPaths } from '../../static'
import { generateAIContent } from '../generate'
import { createAIContentHandler } from '../handler'
import type { AIContentConfig, AIEntry, AIManifest } from '../types'

const schema: RootCollectionConfig = {
  collections: [
    {
      name: 'guides',
      path: 'guides',
      entries: [
        {
          name: 'guide',
          format: 'md',
          default: true,
          schema: [
            { name: 'title', type: 'string' },
            { name: 'noindex', type: 'boolean' },
            { name: 'hideFromSearch', type: 'boolean' },
            { name: 'related', type: 'reference', label: 'Related', collections: ['guides'] },
          ],
        },
      ],
    },
  ],
}

const config = defineCanopyTestConfig({ schema })
const flat = flattenSchema(schema, config.contentRoot)

async function idOf(store: ContentStore, slug: string): Promise<string> {
  const listed = await store.getCollectionEntryPaths(unsafeAsLogicalPath('content/guides'))
  const entry = listed.find((e) => e.slug === slug)
  if (!entry) throw new Error(`entry not found: ${slug}`)
  return extractIdFromFilename(path.basename(entry.relativePath)) as string
}

/**
 * `stub` is noindex, `custom` sets only `hideFromSearch`, `broken` fails to render in one test, and `overview` links to each of them from its body and fields.
 */
async function setup(root: string) {
  const store = new ContentStore(root, flat)
  const guide = (slug: string, data: Record<string, unknown>, body = `${slug} body.`) =>
    store.write(unsafeAsLogicalPath('content/guides'), unsafeAsSlug(slug), {
      format: 'md',
      data: { title: slug, ...data },
      body,
    })

  await guide('stub', { title: 'Stub', noindex: true }, 'Stub-only text.')
  await guide('custom', { title: 'Custom', hideFromSearch: true })
  await guide('internal', { title: 'Internal' })
  await guide('broken', { title: 'Broken' })
  await guide('basics', { title: 'Basics' })
  const ids = {
    stub: await idOf(store, 'stub'),
    custom: await idOf(store, 'custom'),
    internal: await idOf(store, 'internal'),
    broken: await idOf(store, 'broken'),
    basics: await idOf(store, 'basics'),
  }
  await guide(
    'overview',
    { title: 'Overview', related: ids.stub },
    [
      `Read [the stub section](entry:${ids.stub}).`,
      `Read [the internal notes](entry:${ids.internal}).`,
      `Read [the broken page](entry:${ids.broken}).`,
      `Read [the basics](entry:${ids.basics}).`,
    ].join('\n'),
  )
  return { store, ids }
}

describe('AI content and noindex', () => {
  let root: string
  let store: ContentStore
  let ids: Awaited<ReturnType<typeof setup>>['ids']

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-ai-noindex-'))
    ;({ store, ids } = await setup(root))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  const generate = (aiConfig?: AIContentConfig) =>
    generateAIContent({
      store,
      flatSchema: flat,
      contentRoot: config.contentRoot,
      config: aiConfig,
    })

  const bundled: AIContentConfig = {
    bundles: [{ name: 'everything', filter: { collections: ['guides'] } }],
  }

  it('leaves a noindex entry out of its file, all.md, bundles and the manifest', async () => {
    const { files, manifest } = await generate(bundled)

    expect(files.has('guides/stub.md')).toBe(false)
    expect(files.has('guides/basics.md')).toBe(true)
    for (const file of ['guides/all.md', 'bundles/everything.md']) {
      expect(files.get(file)).toContain('basics body.')
      expect(files.get(file)).not.toContain('Stub-only text.')
    }
    const slugs = manifest.collections[0].entries.map((e) => e.slug)
    expect(slugs).toContain('basics')
    expect(slugs).not.toContain('stub')
  })

  it('masks a reference to a noindex entry like any left-out target', async () => {
    const overview = (await generate()).files.get('guides/overview.md')!
    expect(overview).toContain(`(unavailable entry ${ids.stub})`)
    expect(overview).not.toContain('/guides/stub')
  })

  it('exports a noindex entry when exclude.noindex is false', async () => {
    const { files } = await generate({ ...bundled, exclude: { noindex: false } })
    expect(files.get('guides/stub.md')).toContain('Stub-only text.')
    expect(files.get('guides/all.md')).toContain('Stub-only text.')
    expect(files.get('guides/overview.md')).toContain('[the stub section](/guides/stub)')
  })

  it('reads the flag at the configured SEO field names', async () => {
    const custom = await generate({ seo: { fields: { noindex: 'hideFromSearch' } } })
    expect(custom.files.has('guides/custom.md')).toBe(false)
    expect(custom.files.has('guides/stub.md')).toBe(true)

    const defaults = await generate()
    expect(defaults.files.has('guides/custom.md')).toBe(true)
  })

  it('refuses an exclude.noindex that is not a boolean', async () => {
    const aiConfig = { exclude: { noindex: 'false' } } as unknown as AIContentConfig
    await expect(generate(aiConfig)).rejects.toThrow('exclude.noindex must be a boolean')
  })

  it('reads the flag inside a configured SEO group', async () => {
    await store.write(unsafeAsLogicalPath('content/guides'), unsafeAsSlug('grouped'), {
      format: 'md',
      data: { title: 'Grouped', seo: { noindex: true } },
      body: 'Grouped text.',
    })
    expect((await generate({ seo: { group: 'seo' } })).files.has('guides/grouped.md')).toBe(false)
    expect((await generate()).files.has('guides/grouped.md')).toBe(true)
  })

  it('refuses an unknown seo.fields key', async () => {
    const aiConfig = { seo: { fields: { noIndex: 'hidden' } } } as unknown as AIContentConfig
    await expect(generate(aiConfig)).rejects.toThrow('unknown seo.fields key(s): noIndex')
  })

  it('shows exclude.where the body with its links resolved', async () => {
    const { files } = await generate({
      exclude: { where: (entry) => Boolean((entry as AIEntry).body?.includes('/guides/basics')) },
    })
    expect(files.has('guides/overview.md')).toBe(false)
    expect(files.has('guides/basics.md')).toBe(true)
  })

  it('refuses a misshapen seo location', async () => {
    const aiConfig = { seo: { fields: { noindex: true } } } as unknown as AIContentConfig
    await expect(generate(aiConfig)).rejects.toThrow('seo.fields must map')
  })

  it('renders a body link to a noindex or excluded entry as its text, with no URL', async () => {
    const overview = (
      await generate({ exclude: { where: (entry) => entry.slug === 'internal' } })
    ).files.get('guides/overview.md')!

    expect(overview).toContain('Read the stub section.')
    expect(overview).toContain('Read the internal notes.')
    expect(overview).not.toMatch(/\/guides\/(stub|internal)/)
    expect(overview).toContain('[the basics](/guides/basics)')
  })

  it('renders a body link to an entry whose render failed as its text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { files } = await generate({
      bodyTransforms: {
        guide: (body, entry) => {
          if (entry.slug === 'broken') throw new Error('boom')
          return body
        },
      },
    })

    expect(files.has('guides/broken.md')).toBe(false)
    const overview = files.get('guides/overview.md')!
    expect(overview).toContain('Read the broken page.')
    expect(overview).not.toContain('/guides/broken')
  })

  it('serves no noindex entry from the route handler', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    const handler = createAIContentHandler({
      config: { ...config, mode: 'dev', deployedAs: 'static' },
      entrySchemaRegistry: {},
      _testFlatSchema: flat,
    })
    const get = (requestPath: string) =>
      handler(new Request(`http://localhost/ai/${requestPath}`), {
        params: Promise.resolve({ path: requestPath.split('/') }),
      })

    expect((await get('guides/stub.md')).status).toBe(404)
    expect((await get('guides/basics.md')).status).toBe(200)
    expect(await (await get('guides/all.md')).text()).not.toContain('Stub-only text.')
    const manifest = (await (await get('manifest.json')).json()) as AIManifest
    expect(manifest.collections[0].entries.map((e) => e.slug)).not.toContain('stub')
  })

  it('still enumerates a noindex entry for the build', async () => {
    const paths = await collectStaticPaths({
      listEntries: <T>(options?: ListEntriesOptions<T>) =>
        listEntries<T>(root, flat, config.contentRoot, options),
    })
    expect(paths.map((p) => p.urlPath)).toContain('/guides/stub')
  })
})
