import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mockConsole } from '../../test-utils/console-spy'

import { defineCanopyTestConfig } from '../../config-test'
import { flattenSchema, type RootCollectionConfig } from '../../config'
import { ContentStore } from '../../content-store'
import { unsafeAsLogicalPath, unsafeAsSlug } from '../../paths/test-utils'
import { createAIContentHandler } from '../handler'
import type { AIManifest } from '../types'

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-ai-handler-'))

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
    data: { title: 'Second Post', published: false },
    body: '# Second\n\nAnother post.',
  })

  return { config, flat, store }
}

/** Helper to invoke the handler with path segments */
async function callHandler(
  handler: (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>,
  pathStr: string,
): Promise<Response> {
  const segments = pathStr.split('/').filter(Boolean)
  const req = new Request(`http://localhost/ai/${pathStr}`)
  return handler(req, { params: Promise.resolve({ path: segments }) })
}

describe('createAIContentHandler', () => {
  let root: string
  let handler: ReturnType<typeof createAIContentHandler>

  beforeEach(async () => {
    root = await tmpDir()
    const { config, flat } = await setupContent(root, testSchema)

    // Mock process.cwd to return our temp dir (handler uses it in dev mode)
    vi.spyOn(process, 'cwd').mockReturnValue(root)

    handler = createAIContentHandler({
      config: { ...config, mode: 'dev', deployedAs: 'static' },
      entrySchemaRegistry: {},
      _testFlatSchema: flat,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serves manifest.json with correct Content-Type', async () => {
    const response = await callHandler(handler, 'manifest.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')

    const manifest = (await response.json()) as AIManifest
    expect(manifest.generated).toBeTruthy()
    expect(Array.isArray(manifest.collections)).toBe(true)
  })

  it('ignores the build-stamp environment entirely — the runtime route keeps a live clock', async () => {
    // The invariant is "the build path stamps, the handler clocks". `resolveBuildStamp` lives at
    // the build boundary precisely so this route cannot be frozen by an ambient variable, and
    // several build systems (Nix among them) export SOURCE_DATE_EPOCH process-wide. Without this
    // test, moving that resolution into `generateAIContent` would pass every other test in the
    // suite and silently serve a months-old timestamp from a warm CMS server.
    const saved = {
      buildId: process.env.CANOPY_BUILD_ID,
      epoch: process.env.SOURCE_DATE_EPOCH,
    }
    process.env.CANOPY_BUILD_ID = 'deadbeef'
    process.env.SOURCE_DATE_EPOCH = '1700000000'
    try {
      const response = await callHandler(handler, 'manifest.json')
      const manifest = (await response.json()) as AIManifest & { buildId?: string }
      expect(manifest.buildId).toBeUndefined()
      expect(manifest.generated).toBeTruthy()
      expect(manifest.generated).not.toBe('2023-11-14T22:13:20.000Z')
    } finally {
      if (saved.buildId === undefined) delete process.env.CANOPY_BUILD_ID
      else process.env.CANOPY_BUILD_ID = saved.buildId
      if (saved.epoch === undefined) delete process.env.SOURCE_DATE_EPOCH
      else process.env.SOURCE_DATE_EPOCH = saved.epoch
    }
  })

  it('serves individual entry markdown with correct Content-Type', async () => {
    const response = await callHandler(handler, 'posts/hello-world.md')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')

    const text = await response.text()
    expect(text).toContain('Hello World')
    expect(text).toContain('# Hello')
  })

  it('serves collection all.md', async () => {
    const response = await callHandler(handler, 'posts/all.md')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')

    const text = await response.text()
    expect(text).toContain('Hello World')
    expect(text).toContain('Second Post')
  })

  it('returns 404 for nonexistent paths', async () => {
    const response = await callHandler(handler, 'nonexistent/path.md')
    expect(response.status).toBe(404)
  })

  it('sets Cache-Control: no-cache in dev mode', async () => {
    const response = await callHandler(handler, 'manifest.json')
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
  })

  it('all manifest paths resolve to 200', async () => {
    const manifestResponse = await callHandler(handler, 'manifest.json')
    const manifest = (await manifestResponse.json()) as AIManifest

    // Check collection entries
    for (const collection of manifest.collections) {
      for (const entry of collection.entries) {
        const response = await callHandler(handler, entry.file)
        expect(response.status).toBe(200)
      }
      // Check all.md (only present when collection has entries)
      if (collection.allFile) {
        const allResponse = await callHandler(handler, collection.allFile)
        expect(allResponse.status).toBe(200)
      }
    }

    // Check root entries
    for (const entry of manifest.entries) {
      const response = await callHandler(handler, entry.file)
      expect(response.status).toBe(200)
    }

    // Check bundles
    for (const bundle of manifest.bundles) {
      const response = await callHandler(handler, bundle.file)
      expect(response.status).toBe(200)
    }
  })

  it('returns 500 with generic message on internal error (no info leakage)', async () => {
    const consoleSpy = mockConsole()

    // Point cwd at nonexistent dir and don't provide test schema,
    // forcing BranchSchemaCache to try to read .collection.json files that don't exist
    vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent/path/that/does/not/exist')

    const badHandler = createAIContentHandler({
      config: defineCanopyTestConfig({ schema: testSchema, mode: 'dev' }),
      entrySchemaRegistry: {},
      // No _testFlatSchema — forces real schema resolution, which will fail
    })

    const response = await callHandler(badHandler, 'manifest.json')
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: string }
    // Must not contain internal paths or detailed error info
    expect(body.error).toBe('Internal server error')
    expect(body.error).not.toContain('/nonexistent')
    // Error was logged server-side
    expect(consoleSpy).toHaveErrored('AI content handler error')

    consoleSpy.restore()
  })

  it('serves bundles when configured', async () => {
    const testConfig = defineCanopyTestConfig({
      schema: testSchema,
      mode: 'dev',
      deployedAs: 'static',
    })
    const testFlat = flattenSchema(testSchema, testConfig.contentRoot)
    // Re-create handler with bundle config
    handler = createAIContentHandler({
      config: testConfig,
      entrySchemaRegistry: {},
      _testFlatSchema: testFlat,
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

    const response = await callHandler(handler, 'bundles/published.md')
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('Hello World')
    expect(text).not.toContain('Second Post')
  })
})
